// ============================================================
// FILE: src/services/restrictions.service.js
// COMPLETE FILE - READY TO PASTE AND REPLACE
// CHANGES: Added Q1 timeout abuse detection, temp suspensions,
//          penalty games (10s timers), suspicious user flagging
// ============================================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

// ============================================
// Q1 TIMEOUT ABUSE CONFIGURATION
// ============================================
const Q1_TIMEOUT_CONFIG = {
    WARNING_AT_STREAK: 2,           // Warn after 2nd consecutive Q1 timeout
    SUSPEND_AT_STREAK: 3,           // Suspend after 3rd consecutive Q1 timeout
    SUSPENSION_HOURS: 36,           // 36-hour temporary suspension
    PENALTY_GAMES: 5,               // 5 penalty games after suspension lifts
    PENALTY_TIMER_SECONDS: 10,      // 10 seconds per question during penalty
    STREAK_RESET_HOURS: 24,         // Reset streak if no Q1 timeout for 24h
};

class RestrictionsService {
    
    // ============================================
    // MAINTENANCE MODE
    // ============================================
    
    isMaintenanceMode() {
        return process.env.MAINTENANCE_MODE === 'true';
    }
    
    getMaintenanceMessage() {
        const customMessage = process.env.MAINTENANCE_MESSAGE;
        if (customMessage) return customMessage;
        
        return `🔧 *MAINTENANCE MODE* 🔧\n\n` +
               `What's Up Trivia is currently undergoing scheduled maintenance.\n\n` +
               `We'll be back shortly! Thank you for your patience. 🙏\n\n` +
               `_Follow us on social media for updates._`;
    }
    
    // ============================================
    // USER SUSPENSION (Permanent / Admin)
    // ============================================
    
    async isUserSuspended(userId) {
        try {
            const result = await pool.query(
                'SELECT is_suspended, suspension_reason FROM users WHERE id = $1',
                [userId]
            );
            
            if (result.rows.length === 0) return { suspended: false };
            
            const user = result.rows[0];
            return {
                suspended: user.is_suspended === true,
                reason: user.suspension_reason
            };
        } catch (error) {
            logger.error('Error checking suspension:', error);
            return { suspended: false };
        }
    }
    
    async suspendUser(userId, reason, adminId = null) {
        try {
            await pool.query(`
                UPDATE users 
                SET is_suspended = true, 
                    suspension_reason = $1, 
                    suspended_at = NOW(),
                    suspended_by = $2
                WHERE id = $3
            `, [reason, adminId, userId]);
            
            await this.logAdminActivity(adminId, 'suspend_user', 'user', userId, { reason });
            
            logger.info(`User ${userId} suspended by admin ${adminId}: ${reason}`);
            return true;
        } catch (error) {
            logger.error('Error suspending user:', error);
            return false;
        }
    }
    
    async unsuspendUser(userId, adminId = null) {
        try {
            await pool.query(`
                UPDATE users 
                SET is_suspended = false, 
                    suspension_reason = NULL, 
                    suspended_at = NULL,
                    suspended_by = NULL
                WHERE id = $1
            `, [userId]);
            
            await this.logAdminActivity(adminId, 'unsuspend_user', 'user', userId, {});
            
            logger.info(`User ${userId} unsuspended by admin ${adminId}`);
            return true;
        } catch (error) {
            logger.error('Error unsuspending user:', error);
            return false;
        }
    }
    
    getSuspensionMessage(reason) {
        return `⛔ *ACCOUNT SUSPENDED* ⛔\n\n` +
               `Your account has been suspended.\n\n` +
               `Reason: ${reason || 'Suspicious activity detected'}\n\n` +
               `If you believe this is an error, please contact support.`;
    }

    // ============================================
    // TEMPORARY SUSPENSION (36h from Q1 abuse)
    // ============================================

    async isUserTempSuspended(userId) {
        try {
            const result = await pool.query(
                'SELECT temp_suspended_until, temp_suspension_reason FROM users WHERE id = $1',
                [userId]
            );

            if (result.rows.length === 0) return { suspended: false };

            const user = result.rows[0];
            if (!user.temp_suspended_until) return { suspended: false };

            const until = new Date(user.temp_suspended_until);
            const now = new Date();

            if (until > now) {
                const hoursRemaining = Math.ceil((until - now) / (1000 * 60 * 60));
                return {
                    suspended: true,
                    until: until,
                    hoursRemaining,
                    reason: user.temp_suspension_reason || 'Fair play violation'
                };
            }

            // Suspension expired — clear it
            await pool.query(`
                UPDATE users 
                SET temp_suspended_until = NULL, temp_suspension_reason = NULL
                WHERE id = $1
            `, [userId]);

            return { suspended: false };
        } catch (error) {
            logger.error('Error checking temp suspension:', error);
            return { suspended: false };
        }
    }

    async setTempSuspension(userId, reason) {
        try {
            const hours = Q1_TIMEOUT_CONFIG.SUSPENSION_HOURS;
            const penaltyGames = Q1_TIMEOUT_CONFIG.PENALTY_GAMES;
            const penaltyTimer = Q1_TIMEOUT_CONFIG.PENALTY_TIMER_SECONDS;

            await pool.query(`
                UPDATE users 
                SET temp_suspended_until = NOW() + INTERVAL '${hours} hours',
                    temp_suspension_reason = $1,
                    suspicious_user = true,
                    penalty_games_remaining = $2,
                    penalty_timer_seconds = $3
                WHERE id = $4
            `, [reason, penaltyGames, penaltyTimer, userId]);

            logger.warn(`⛔ Temp suspension set for user ${userId}: ${hours}h, reason: ${reason}`);
            return true;
        } catch (error) {
            logger.error('Error setting temp suspension:', error);
            return false;
        }
    }

    getTempSuspensionMessage(data) {
        return `⛔ *TEMPORARY SUSPENSION* ⛔\n\n` +
               `Your account has been temporarily suspended for *${data.hoursRemaining} hours*.\n\n` +
               `📋 *Reason:* ${data.reason}\n\n` +
               `At What's Up Trivia, we have a zero-tolerance policy for anything that undermines fair play. ` +
               `Every player deserves an equal chance to win.\n\n` +
               `⏳ *Suspension lifts:* ${data.until.toLocaleString('en-NG', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}\n\n` +
               `⚠️ When you return, your next *5 games* will have reduced timers as a probation measure.\n\n` +
               `✅ Practice mode is still available!\n\n` +
               `_Play fair, play smart. 🎯_`;
    }

    // ============================================
    // Q1 TIMEOUT ABUSE DETECTION
    // ============================================

    /**
     * Track when a user times out on Question 1
     * Returns action to take: 'none', 'warning', 'suspension'
     */
    async trackQ1Timeout(userId, sessionId) {
        try {
            // Check if last Q1 timeout was recent (within streak window)
            const userResult = await pool.query(
                'SELECT q1_timeout_streak, q1_timeout_last_game FROM users WHERE id = $1',
                [userId]
            );

            if (userResult.rows.length === 0) return { action: 'none' };

            const user = userResult.rows[0];
            let currentStreak = user.q1_timeout_streak || 0;
            const lastTimeout = user.q1_timeout_last_game;

            // Reset streak if last timeout was more than 24h ago
            if (lastTimeout) {
                const hoursSinceLastTimeout = (Date.now() - new Date(lastTimeout).getTime()) / (1000 * 60 * 60);
                if (hoursSinceLastTimeout > Q1_TIMEOUT_CONFIG.STREAK_RESET_HOURS) {
                    currentStreak = 0;
                }
            }

            // Increment streak
            currentStreak++;

            // Update user record
            await pool.query(`
                UPDATE users 
                SET q1_timeout_streak = $1, q1_timeout_last_game = NOW()
                WHERE id = $2
            `, [currentStreak, userId]);

            // Log the event
            await pool.query(`
                INSERT INTO q1_timeout_log (user_id, session_id, streak_count, action_taken)
                VALUES ($1, $2, $3, $4)
            `, [userId, sessionId, currentStreak, 
                currentStreak >= Q1_TIMEOUT_CONFIG.SUSPEND_AT_STREAK ? 'suspension' :
                currentStreak >= Q1_TIMEOUT_CONFIG.WARNING_AT_STREAK ? 'warning' : 'none'
            ]);

            logger.warn(`⚠️ Q1 Timeout: User ${userId}, streak: ${currentStreak}`);

            // Determine action
            if (currentStreak >= Q1_TIMEOUT_CONFIG.SUSPEND_AT_STREAK) {
                return { action: 'suspension', streak: currentStreak };
            } else if (currentStreak >= Q1_TIMEOUT_CONFIG.WARNING_AT_STREAK) {
                return { action: 'warning', streak: currentStreak };
            }

            return { action: 'none', streak: currentStreak };
        } catch (error) {
            logger.error('Error tracking Q1 timeout:', error);
            return { action: 'none' };
        }
    }

    /**
     * Reset Q1 timeout streak when user answers Q1 correctly
     */
    async resetQ1TimeoutStreak(userId) {
        try {
            await pool.query(`
                UPDATE users 
                SET q1_timeout_streak = 0, q1_timeout_warned = false
                WHERE id = $1
            `, [userId]);
        } catch (error) {
            logger.error('Error resetting Q1 timeout streak:', error);
        }
    }

    /**
     * Get the Q1 timeout warning message (shown at game start)
     */
    getQ1TimeoutWarningMessage() {
        return `⚠️ *FAIR PLAY REMINDER* ⚠️\n\n` +
               `We noticed you've timed out on the first question in your recent games.\n\n` +
               `At What's Up Trivia, we are committed to providing a level playing field for everyone. ` +
               `Using external help — search engines, voice assistants, or AI tools — goes against the spirit of the game.\n\n` +
               `🎯 *Fair play is non-negotiable.*\n\n` +
               `If you're not ready to experience the trivia challenge on your own knowledge, ` +
               `we recommend practicing first.\n\n` +
               `⚠️ *Continued violations will result in a temporary suspension.*\n\n` +
               `💡 _Tip: Try Practice mode to sharpen your skills!_`;
    }

    /**
     * Get the Q1 timeout suspension notification
     */
    getQ1SuspensionMessage() {
        const hours = Q1_TIMEOUT_CONFIG.SUSPENSION_HOURS;
        return `🚫 *ACCOUNT TEMPORARILY SUSPENDED* 🚫\n\n` +
               `Your account has been suspended for *${hours} hours* due to repeated fair play violations.\n\n` +
               `Our system detected a pattern of timing out on the first question across consecutive games, ` +
               `which is consistent with the use of external assistance.\n\n` +
               `📋 *What happens next:*\n` +
               `• Suspension lasts ${hours} hours\n` +
               `• After suspension: 5 games with reduced timers (10s per question)\n` +
               `• Practice mode remains available during suspension\n\n` +
               `We want every player to have a fair shot at winning. 🤝\n\n` +
               `_Play fair. Play smart. Play What's Up Trivia. 🎯_`;
    }

    // ============================================
    // PENALTY GAMES (10-second timers)
    // ============================================

    /**
     * Check if user is in penalty mode (reduced timers)
     */
    async isUserInPenaltyMode(userId) {
        try {
            const result = await pool.query(
                'SELECT penalty_games_remaining, penalty_timer_seconds FROM users WHERE id = $1',
                [userId]
            );

            if (result.rows.length === 0) return { inPenalty: false };

            const user = result.rows[0];
            const remaining = user.penalty_games_remaining || 0;

            if (remaining > 0) {
                return {
                    inPenalty: true,
                    gamesRemaining: remaining,
                    timerSeconds: user.penalty_timer_seconds || Q1_TIMEOUT_CONFIG.PENALTY_TIMER_SECONDS
                };
            }

            return { inPenalty: false };
        } catch (error) {
            logger.error('Error checking penalty mode:', error);
            return { inPenalty: false };
        }
    }

    /**
     * Decrement penalty games remaining (called when a game completes)
     */
    async decrementPenaltyGames(userId) {
        try {
            const result = await pool.query(`
                UPDATE users 
                SET penalty_games_remaining = GREATEST(penalty_games_remaining - 1, 0)
                WHERE id = $1
                RETURNING penalty_games_remaining
            `, [userId]);

            const remaining = result.rows[0]?.penalty_games_remaining || 0;
            
            if (remaining === 0) {
                // Reset penalty timer back to normal
                await pool.query(`
                    UPDATE users SET penalty_timer_seconds = 12 WHERE id = $1
                `, [userId]);
                logger.info(`✅ Penalty mode ended for user ${userId}`);
            } else {
                logger.info(`⚠️ Penalty games remaining for user ${userId}: ${remaining}`);
            }

            return remaining;
        } catch (error) {
            logger.error('Error decrementing penalty games:', error);
            return 0;
        }
    }

    /**
     * Get penalty mode notification message (shown at game start)
     */
    getPenaltyModeMessage(gamesRemaining) {
        return `⚠️ *PROBATION MODE* ⚠️\n\n` +
               `You are currently on probation.\n\n` +
               `⏱️ All questions will have a *10-second* timer.\n` +
               `📊 Games remaining on probation: *${gamesRemaining}*\n\n` +
               `Play fair and your timers will return to normal! 💪`;
    }

    // ============================================
    // SUSPICIOUS USER FLAGGING
    // ============================================

    async flagUserSuspicious(userId, flagType, details = {}) {
        try {
            // Get existing flags
            const result = await pool.query(
                'SELECT suspicious_flags FROM users WHERE id = $1',
                [userId]
            );

            let flags = [];
            if (result.rows.length > 0 && result.rows[0].suspicious_flags) {
                flags = result.rows[0].suspicious_flags;
                if (!Array.isArray(flags)) flags = [];
            }

            // Add new flag
            flags.push({
                type: flagType,
                details: details,
                timestamp: new Date().toISOString()
            });

            await pool.query(`
                UPDATE users 
                SET suspicious_user = true, suspicious_flags = $1
                WHERE id = $2
            `, [JSON.stringify(flags), userId]);

            logger.warn(`🚩 User ${userId} flagged suspicious: ${flagType}`);
            return true;
        } catch (error) {
            logger.error('Error flagging user suspicious:', error);
            return false;
        }
    }

    async isUserSuspicious(userId) {
        try {
            const result = await pool.query(
                'SELECT suspicious_user, suspicious_flags FROM users WHERE id = $1',
                [userId]
            );
            if (result.rows.length === 0) return { suspicious: false, flags: [] };

            return {
                suspicious: result.rows[0].suspicious_user === true,
                flags: result.rows[0].suspicious_flags || []
            };
        } catch (error) {
            logger.error('Error checking suspicious user:', error);
            return { suspicious: false, flags: [] };
        }
    }
    
    // ============================================
    // GRAND PRIZE COOLDOWN
    // ============================================
    
    getCooldownDays() {
        return parseInt(process.env.GRAND_PRIZE_COOLDOWN_DAYS) || 7;
    }
    
    async checkGrandPrizeCooldown(userId) {
        try {
            const result = await pool.query(
                'SELECT grand_prize_cooldown_until FROM users WHERE id = $1',
                [userId]
            );
            
            if (result.rows.length === 0) return { onCooldown: false };
            
            const cooldownUntil = result.rows[0].grand_prize_cooldown_until;
            if (!cooldownUntil) return { onCooldown: false };
            
            const now = new Date();
            const cooldownDate = new Date(cooldownUntil);
            
            if (cooldownDate > now) {
                return {
                    onCooldown: true,
                    until: cooldownDate,
                    daysRemaining: Math.ceil((cooldownDate - now) / (1000 * 60 * 60 * 24))
                };
            }
            
            return { onCooldown: false };
        } catch (error) {
            logger.error('Error checking grand prize cooldown:', error);
            return { onCooldown: false };
        }
    }
    
    async setGrandPrizeCooldown(userId) {
        try {
            const cooldownDays = this.getCooldownDays();
            
            await pool.query(`
                UPDATE users 
                SET last_grand_prize_win = NOW(),
                    grand_prize_cooldown_until = NOW() + INTERVAL '${cooldownDays} days'
                WHERE id = $1
            `, [userId]);
            
            logger.info(`Grand prize cooldown set for user ${userId}: ${cooldownDays} days`);
            return true;
        } catch (error) {
            logger.error('Error setting grand prize cooldown:', error);
            return false;
        }
    }
    
    async clearGrandPrizeCooldown(userId, adminId = null) {
        try {
            await pool.query(`
                UPDATE users 
                SET grand_prize_cooldown_until = NULL
                WHERE id = $1
            `, [userId]);
            
            if (adminId) {
                await this.logAdminActivity(adminId, 'clear_cooldown', 'user', userId, {});
            }
            
            logger.info(`Grand prize cooldown cleared for user ${userId}`);
            return true;
        } catch (error) {
            logger.error('Error clearing cooldown:', error);
            return false;
        }
    }
    
    getGrandPrizeCooldownMessage(cooldownData) {
        const dateStr = cooldownData.until.toLocaleDateString('en-NG', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        });
        
        return `🏆 *CHAMPION COOLDOWN* 🏆\n\n` +
               `Congratulations on your grand prize win! 🎉\n\n` +
               `To give others a fair chance, champions must wait before playing Classic/Tournament mode again.\n\n` +
               `⏳ *Cooldown ends:* ${dateStr}\n` +
               `📅 *Days remaining:* ${cooldownData.daysRemaining}\n\n` +
               `✅ Practice mode is still available!\n\n` +
               `_Thank you for being a champion!_`;
    }
    
    // ============================================
    // DAILY WIN LIMIT
    // ============================================
    
    getDailyWinLimit() {
        return parseInt(process.env.DAILY_WIN_LIMIT) || 30000;
    }
    
    async getDailyWinnings(userId, date = null) {
        try {
            const targetDate = date || new Date().toISOString().split('T')[0];
            
            const result = await pool.query(`
                SELECT COALESCE(SUM(amount), 0) as total
                FROM transactions 
                WHERE user_id = $1 
                AND transaction_type = 'prize'
                AND DATE(created_at) = $2
            `, [userId, targetDate]);
            
            return parseFloat(result.rows[0].total) || 0;
        } catch (error) {
            logger.error('Error getting daily winnings:', error);
            return 0;
        }
    }
    
    async checkDailyWinLimit(userId) {
        try {
            const dailyLimit = this.getDailyWinLimit();
            const dailyWinnings = await this.getDailyWinnings(userId);
            
            if (dailyWinnings >= dailyLimit) {
                return {
                    limitReached: true,
                    currentWinnings: dailyWinnings,
                    limit: dailyLimit,
                    remaining: 0
                };
            }
            
            return {
                limitReached: false,
                currentWinnings: dailyWinnings,
                limit: dailyLimit,
                remaining: dailyLimit - dailyWinnings
            };
        } catch (error) {
            logger.error('Error checking daily limit:', error);
            return { limitReached: false, remaining: this.getDailyWinLimit() };
        }
    }
    
    getDailyLimitMessage(limitData) {
        return `🎉 *DAILY LIMIT REACHED* 🎉\n\n` +
               `Amazing! You've won ₦${limitData.currentWinnings.toLocaleString()} today!\n\n` +
               `Our daily maximum is ₦${limitData.limit.toLocaleString()} to ensure fair play for everyone.\n\n` +
               `⏰ Come back tomorrow for more chances to win!\n\n` +
               `✅ Practice mode is still available!\n\n` +
               `_Keep up the great playing!_`;
    }
    
    // ============================================
    // COMPREHENSIVE CHECK (All restrictions)
    // ============================================
    
    async canUserPlay(userId, gameMode = 'classic') {
        // Practice mode bypasses most restrictions (except permanent suspension)
        if (gameMode === 'practice') {
            const suspension = await this.isUserSuspended(userId);
            if (suspension.suspended) {
                return {
                    canPlay: false,
                    reason: 'suspended',
                    message: this.getSuspensionMessage(suspension.reason)
                };
            }
            return { canPlay: true };
        }
        
        // Check permanent suspension
        const suspension = await this.isUserSuspended(userId);
        if (suspension.suspended) {
            return {
                canPlay: false,
                reason: 'suspended',
                message: this.getSuspensionMessage(suspension.reason)
            };
        }

        // Check temporary suspension (Q1 abuse)
        const tempSuspension = await this.isUserTempSuspended(userId);
        if (tempSuspension.suspended) {
            return {
                canPlay: false,
                reason: 'temp_suspended',
                message: this.getTempSuspensionMessage(tempSuspension)
            };
        }
        
        // Check grand prize cooldown
        const cooldown = await this.checkGrandPrizeCooldown(userId);
        if (cooldown.onCooldown) {
            return {
                canPlay: false,
                reason: 'cooldown',
                message: this.getGrandPrizeCooldownMessage(cooldown)
            };
        }
        
        // Check daily win limit
        const dailyLimit = await this.checkDailyWinLimit(userId);
        if (dailyLimit.limitReached) {
            return {
                canPlay: false,
                reason: 'daily_limit',
                message: this.getDailyLimitMessage(dailyLimit)
            };
        }
        
        return { canPlay: true };
    }
    
    // ============================================
    // RATE LIMITING
    // ============================================
    
    async checkRateLimit(identifier, actionType, maxRequests = 30, windowMinutes = 1) {
        try {
            const key = `rate_limit:${actionType}:${identifier}`;
            const current = await redis.incr(key);
            
            if (current === 1) {
                await redis.expire(key, windowMinutes * 60);
            }
            
            if (current > maxRequests) {
                return { limited: true, current, limit: maxRequests };
            }
            
            return { limited: false, current, limit: maxRequests };
        } catch (error) {
            logger.error('Error checking rate limit:', error);
            return { limited: false };
        }
    }
    
    getRateLimitMessage() {
        return `⚠️ *SLOW DOWN* ⚠️\n\n` +
               `You're sending messages too quickly.\n\n` +
               `Please wait a moment and try again.`;
    }
    
    // ============================================
    // ADMIN ACTIVITY LOGGING
    // ============================================
    
    async logAdminActivity(adminId, actionType, targetType, targetId, details, ipAddress = null) {
        try {
            const actionDetails = {
                target_type: targetType,
                target_id: targetId,
                ...details
            };
            
            await pool.query(`
                INSERT INTO admin_activity_log (admin_id, action_type, action_details, ip_address)
                VALUES ($1, $2, $3, $4)
            `, [adminId, actionType, JSON.stringify(actionDetails), ipAddress]);
        } catch (error) {
            logger.error('Error logging admin activity:', error);
        }
    }
    
    // ============================================
    // ADMIN QUERY HELPERS
    // ============================================
    
    async getSuspendedUsers() {
        try {
            const result = await pool.query(`
                SELECT id, username, full_name, phone_number, city, 
                       suspension_reason, suspended_at, suspended_by
                FROM users 
                WHERE is_suspended = true
                ORDER BY suspended_at DESC
            `);
            return result.rows;
        } catch (error) {
            logger.error('Error getting suspended users:', error);
            return [];
        }
    }

    async getTempSuspendedUsers() {
        try {
            const result = await pool.query(`
                SELECT id, username, full_name, phone_number, city,
                       temp_suspended_until, temp_suspension_reason,
                       q1_timeout_streak, penalty_games_remaining
                FROM users 
                WHERE temp_suspended_until > NOW()
                ORDER BY temp_suspended_until ASC
            `);
            return result.rows;
        } catch (error) {
            logger.error('Error getting temp suspended users:', error);
            return [];
        }
    }

    async getUsersInPenaltyMode() {
        try {
            const result = await pool.query(`
                SELECT id, username, full_name, phone_number, city,
                       penalty_games_remaining, penalty_timer_seconds,
                       suspicious_user, suspicious_flags
                FROM users 
                WHERE penalty_games_remaining > 0
                ORDER BY penalty_games_remaining DESC
            `);
            return result.rows;
        } catch (error) {
            logger.error('Error getting penalty mode users:', error);
            return [];
        }
    }

    async getSuspiciousUsers() {
        try {
            const result = await pool.query(`
                SELECT id, username, full_name, phone_number, city,
                       suspicious_user, suspicious_flags,
                       q1_timeout_streak, penalty_games_remaining,
                       temp_suspended_until
                FROM users 
                WHERE suspicious_user = true
                ORDER BY id DESC
                LIMIT 50
            `);
            return result.rows;
        } catch (error) {
            logger.error('Error getting suspicious users:', error);
            return [];
        }
    }
    
    async getUsersOnCooldown() {
        try {
            const result = await pool.query(`
                SELECT id, username, full_name, phone_number, city,
                       last_grand_prize_win, grand_prize_cooldown_until
                FROM users 
                WHERE grand_prize_cooldown_until > NOW()
                ORDER BY grand_prize_cooldown_until ASC
            `);
            return result.rows;
        } catch (error) {
            logger.error('Error getting users on cooldown:', error);
            return [];
        }
    }
    
    async getUsersAtDailyLimit() {
        try {
            const dailyLimit = this.getDailyWinLimit();
            
            const result = await pool.query(`
                SELECT u.id, u.username, u.full_name, u.phone_number, u.city,
                       SUM(t.amount) as today_winnings
                FROM users u
                JOIN transactions t ON u.id = t.user_id
                WHERE t.transaction_type = 'prize'
                AND DATE(t.created_at) = CURRENT_DATE
                GROUP BY u.id, u.username, u.full_name, u.phone_number, u.city
                HAVING SUM(t.amount) >= $1
                ORDER BY today_winnings DESC
            `, [dailyLimit]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting users at daily limit:', error);
            return [];
        }
    }
}

module.exports = new RestrictionsService();