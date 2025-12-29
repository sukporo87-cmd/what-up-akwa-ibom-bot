// ============================================
// FILE: src/services/streak.service.js
// Daily Streak System Service
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

// Streak reward milestones
const STREAK_REWARDS = {
    3: { freeGames: 1, badge: 'fire1', emoji: '🔥', description: '3-Day Streak!' },
    7: { freeGames: 2, badge: 'fire2', emoji: '🔥🔥', description: '7-Day Streak!' },
    14: { freeGames: 3, badge: 'fire3', emoji: '🔥🔥🔥', description: '14-Day Streak!', bonusTournament: true },
    30: { freeGames: 5, badge: 'trophy', emoji: '🏆', description: 'Dedicated Player - 30 Days!' },
    60: { freeGames: 10, badge: 'diamond', emoji: '💎', description: 'Streak Champion - 60 Days!', featured: true }
};

class StreakService {
    
    /**
     * Get current date in Nigerian timezone (WAT/UTC+1)
     */
    getNigerianDate() {
        const now = new Date();
        // Convert to Nigerian time (UTC+1)
        const nigerianTime = new Date(now.getTime() + (1 * 60 * 60 * 1000));
        return nigerianTime.toISOString().split('T')[0]; // Returns YYYY-MM-DD
    }

    /**
     * Get yesterday's date in Nigerian timezone
     */
    getNigerianYesterday() {
        const now = new Date();
        const nigerianTime = new Date(now.getTime() + (1 * 60 * 60 * 1000));
        nigerianTime.setDate(nigerianTime.getDate() - 1);
        return nigerianTime.toISOString().split('T')[0];
    }

    /**
     * Check and update user's streak when they play a qualifying game
     * Called when a Classic or Tournament game STARTS
     * @param {number} userId 
     * @param {string} gameType - 'classic' or 'tournament'
     * @returns {object} Streak update result with any rewards earned
     */
    async updateStreak(userId, gameType) {
        // Only Classic and Tournament games count
        if (gameType !== 'classic' && gameType !== 'tournament') {
            return { updated: false, reason: 'Practice mode does not count toward streak' };
        }

        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');

            // Get user's current streak data
            const userResult = await client.query(
                'SELECT current_streak, longest_streak, last_play_date FROM users WHERE id = $1 FOR UPDATE',
                [userId]
            );

            if (userResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return { updated: false, reason: 'User not found' };
            }

            const user = userResult.rows[0];
            const today = this.getNigerianDate();
            const yesterday = this.getNigerianYesterday();
            const lastPlayDate = user.last_play_date ? user.last_play_date.toISOString().split('T')[0] : null;

            let newStreak = user.current_streak || 0;
            let streakContinued = false;
            let streakStarted = false;
            let streakReset = false;
            let reward = null;

            // Already played today - no streak update needed
            if (lastPlayDate === today) {
                await client.query('ROLLBACK');
                return { 
                    updated: false, 
                    reason: 'Already played today',
                    currentStreak: newStreak
                };
            }

            // Check streak status
            if (lastPlayDate === yesterday) {
                // Played yesterday - continue streak!
                newStreak += 1;
                streakContinued = true;
            } else if (lastPlayDate === null) {
                // First time playing
                newStreak = 1;
                streakStarted = true;
            } else {
                // Missed a day - streak resets
                newStreak = 1;
                streakReset = true;
            }

            // Update longest streak if needed
            const newLongestStreak = Math.max(user.longest_streak || 0, newStreak);

            // Determine badge
            let badge = null;
            if (newStreak >= 60) badge = 'diamond';
            else if (newStreak >= 30) badge = 'trophy';
            else if (newStreak >= 14) badge = 'fire3';
            else if (newStreak >= 7) badge = 'fire2';
            else if (newStreak >= 3) badge = 'fire1';

            // Update user's streak data
            await client.query(
                `UPDATE users 
                 SET current_streak = $1, 
                     longest_streak = $2, 
                     last_play_date = $3,
                     streak_badge = $4
                 WHERE id = $5`,
                [newStreak, newLongestStreak, today, badge, userId]
            );

            // Check if user hit a reward milestone
            if (STREAK_REWARDS[newStreak]) {
                reward = await this.grantStreakReward(client, userId, newStreak);
            }

            await client.query('COMMIT');

            logger.info(`Streak updated for user ${userId}: ${newStreak} days (${streakContinued ? 'continued' : streakStarted ? 'started' : 'reset'})`);

            return {
                updated: true,
                currentStreak: newStreak,
                longestStreak: newLongestStreak,
                streakContinued,
                streakStarted,
                streakReset,
                previousStreak: user.current_streak || 0,
                badge,
                reward
            };

        } catch (error) {
            await client.query('ROLLBACK');
            logger.error('Error updating streak:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Grant streak reward to user
     */
    async grantStreakReward(client, userId, streakDays) {
        const rewardConfig = STREAK_REWARDS[streakDays];
        if (!rewardConfig) return null;

        // Check if user already received this reward for this streak
        const existingReward = await client.query(
            `SELECT id FROM streak_rewards 
             WHERE user_id = $1 AND streak_days = $2 
             AND created_at > NOW() - INTERVAL '30 days'`,
            [userId, streakDays]
        );

        if (existingReward.rows.length > 0) {
            logger.info(`User ${userId} already received ${streakDays}-day streak reward recently`);
            return null;
        }

        // Grant free games
        if (rewardConfig.freeGames > 0) {
            await client.query(
                'UPDATE users SET games_remaining = COALESCE(games_remaining, 0) + $1 WHERE id = $2',
                [rewardConfig.freeGames, userId]
            );
        }

        // Log the reward
        await client.query(
            `INSERT INTO streak_rewards (user_id, streak_days, reward_type, reward_amount, reward_description)
             VALUES ($1, $2, $3, $4, $5)`,
            [userId, streakDays, 'free_games', rewardConfig.freeGames, rewardConfig.description]
        );

        logger.info(`Granted streak reward to user ${userId}: ${streakDays} days - ${rewardConfig.freeGames} free games`);

        return {
            streakDays,
            freeGames: rewardConfig.freeGames,
            badge: rewardConfig.badge,
            emoji: rewardConfig.emoji,
            description: rewardConfig.description,
            bonusTournament: rewardConfig.bonusTournament || false,
            featured: rewardConfig.featured || false
        };
    }

    /**
     * Get user's streak info
     */
    async getStreakInfo(userId) {
        try {
            const result = await pool.query(
                `SELECT current_streak, longest_streak, last_play_date, streak_badge
                 FROM users WHERE id = $1`,
                [userId]
            );

            if (result.rows.length === 0) {
                return null;
            }

            const user = result.rows[0];
            const today = this.getNigerianDate();
            const yesterday = this.getNigerianYesterday();
            const lastPlayDate = user.last_play_date ? user.last_play_date.toISOString().split('T')[0] : null;

            // Check if streak is still active
            let isActive = lastPlayDate === today || lastPlayDate === yesterday;
            let playedToday = lastPlayDate === today;

            // Get badge emoji
            let badgeEmoji = '';
            switch (user.streak_badge) {
                case 'diamond': badgeEmoji = '💎'; break;
                case 'trophy': badgeEmoji = '🏆'; break;
                case 'fire3': badgeEmoji = '🔥🔥🔥'; break;
                case 'fire2': badgeEmoji = '🔥🔥'; break;
                case 'fire1': badgeEmoji = '🔥'; break;
            }

            // Calculate next milestone
            const milestones = [3, 7, 14, 30, 60];
            let nextMilestone = null;
            let daysToNextMilestone = null;
            
            for (const milestone of milestones) {
                if (user.current_streak < milestone) {
                    nextMilestone = milestone;
                    daysToNextMilestone = milestone - user.current_streak;
                    break;
                }
            }

            return {
                currentStreak: user.current_streak || 0,
                longestStreak: user.longest_streak || 0,
                lastPlayDate,
                isActive,
                playedToday,
                badge: user.streak_badge,
                badgeEmoji,
                nextMilestone,
                daysToNextMilestone,
                nextReward: nextMilestone ? STREAK_REWARDS[nextMilestone] : null
            };

        } catch (error) {
            logger.error('Error getting streak info:', error);
            throw error;
        }
    }

    /**
     * Get streak leaderboard
     * @param {number} limit - Number of users to return
     */
    async getStreakLeaderboard(limit = 10) {
        try {
            const result = await pool.query(
                `SELECT u.id, u.username, u.city, u.current_streak, u.longest_streak, u.streak_badge
                 FROM users u
                 WHERE u.current_streak > 0
                 ORDER BY u.current_streak DESC, u.longest_streak DESC
                 LIMIT $1`,
                [limit]
            );

            return result.rows.map((user, index) => {
                let badgeEmoji = '';
                switch (user.streak_badge) {
                    case 'diamond': badgeEmoji = '💎'; break;
                    case 'trophy': badgeEmoji = '🏆'; break;
                    case 'fire3': badgeEmoji = '🔥🔥🔥'; break;
                    case 'fire2': badgeEmoji = '🔥🔥'; break;
                    case 'fire1': badgeEmoji = '🔥'; break;
                    default: badgeEmoji = '🔥';
                }

                return {
                    rank: index + 1,
                    username: user.username,
                    city: user.city,
                    currentStreak: user.current_streak,
                    longestStreak: user.longest_streak,
                    badge: user.streak_badge,
                    badgeEmoji
                };
            });

        } catch (error) {
            logger.error('Error getting streak leaderboard:', error);
            throw error;
        }
    }

    /**
     * Get streak champions (60+ day streaks) for featuring on main leaderboard
     */
    async getStreakChampions(limit = 5) {
        try {
            const result = await pool.query(
                `SELECT u.id, u.username, u.current_streak
                 FROM users u
                 WHERE u.current_streak >= 60
                 ORDER BY u.current_streak DESC
                 LIMIT $1`,
                [limit]
            );

            return result.rows;

        } catch (error) {
            logger.error('Error getting streak champions:', error);
            return [];
        }
    }

    /**
     * Format streak message for display
     */
    formatStreakMessage(streakInfo) {
        if (!streakInfo || streakInfo.currentStreak === 0) {
            return `🔥 Streak: 0 days\n   Start playing to build your streak!`;
        }

        let message = `🔥 Streak: ${streakInfo.currentStreak} days ${streakInfo.badgeEmoji}\n`;
        
        if (streakInfo.playedToday) {
            message += `   ✅ Played today!\n`;
        } else if (streakInfo.isActive) {
            message += `   ⚠️ Play today to keep your streak!\n`;
        } else {
            message += `   ❌ Streak expired - play to start new!\n`;
        }

        if (streakInfo.nextMilestone) {
            message += `   📍 ${streakInfo.daysToNextMilestone} day(s) to next reward!`;
        }

        return message;
    }

    /**
     * Format streak reward notification
     */
    formatRewardMessage(reward) {
        if (!reward) return null;

        let message = `🎉 *STREAK MILESTONE!* 🎉\n\n`;
        message += `${reward.emoji} ${reward.description}\n\n`;
        message += `🎁 Reward: ${reward.freeGames} FREE GAME${reward.freeGames > 1 ? 'S' : ''}!\n`;
        
        if (reward.bonusTournament) {
            message += `🏆 BONUS: Free tournament entry!\n`;
        }
        
        if (reward.featured) {
            message += `⭐ You're now featured on the Streak Leaderboard!\n`;
        }

        message += `\nKeep the streak going! 🔥`;

        return message;
    }
}

module.exports = new StreakService();
