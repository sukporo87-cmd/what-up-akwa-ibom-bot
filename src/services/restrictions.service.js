// ============================================
// FILE: src/services/restrictions.service.js
// Handles: Maintenance Mode, Suspensions, Daily Limits, Grand Prize Cooldown
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

class RestrictionsService {
    
    // ============================================
    // MAINTENANCE MODE
    // ============================================
    
    isMaintenanceMode() {
        return process.env.MAINTENANCE_MODE === 'true';
    }
    
    getMaintenanceMessage() {
        const customMessage = process.env.MAINTENANCE_MESSAGE;
        if (customMessage) {
            return customMessage;
        }
        
        return `🔧 *MAINTENANCE MODE* 🔧\n\n` +
               `What's Up Trivia is currently undergoing scheduled maintenance.\n\n` +
               `We'll be back shortly! Thank you for your patience. 🙏\n\n` +
               `_Follow us on social media for updates._`;
    }
    
    // ============================================
    // USER SUSPENSION
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
            
            // Log admin activity
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
            
            // Log admin activity
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
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
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
        // Practice mode bypasses most restrictions
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
        
        // Check suspension first
        const suspension = await this.isUserSuspended(userId);
        if (suspension.suspended) {
            return {
                canPlay: false,
                reason: 'suspended',
                message: this.getSuspensionMessage(suspension.reason)
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
                return {
                    limited: true,
                    current: current,
                    limit: maxRequests
                };
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
            // Match existing table structure: action_details instead of separate columns
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
    // GET ALL SUSPENDED USERS (for admin)
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
    
    // ============================================
    // GET USERS ON COOLDOWN (for admin)
    // ============================================
    
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
    
    // ============================================
    // GET USERS AT DAILY LIMIT (for admin)
    // ============================================
    
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