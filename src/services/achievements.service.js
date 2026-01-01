// ============================================
// FILE: src/services/achievements.service.js
// Handles: User achievements, badges, milestones
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

// Achievement definitions
const ACHIEVEMENTS = {
    // Game achievements
    first_win: {
        name: 'First Victory',
        description: 'Won your first game',
        emoji: '🎯',
        check: async (userId) => {
            const result = await pool.query(
                `SELECT COUNT(*) FROM game_sessions WHERE user_id = $1 AND status = 'won'`,
                [userId]
            );
            return parseInt(result.rows[0].count) >= 1;
        }
    },
    five_games_day: {
        name: 'Marathon Player',
        description: 'Played 5 games in one day',
        emoji: '🏃',
        check: async (userId) => {
            const result = await pool.query(`
                SELECT COUNT(*) FROM game_sessions 
                WHERE user_id = $1 AND DATE(started_at) = CURRENT_DATE
            `, [userId]);
            return parseInt(result.rows[0].count) >= 5;
        }
    },
    perfect_game: {
        name: 'Perfect Score',
        description: 'Answered all 15 questions correctly',
        emoji: '💯',
        check: async (userId) => {
            const result = await pool.query(`
                SELECT COUNT(*) FROM game_sessions 
                WHERE user_id = $1 AND current_question > 15 AND status = 'won'
            `, [userId]);
            return parseInt(result.rows[0].count) >= 1;
        }
    },
    
    // Streak achievements
    streak_3: {
        name: 'Getting Started',
        description: '3-day streak achieved',
        emoji: '🔥',
        check: async (userId) => {
            const result = await pool.query(
                'SELECT longest_streak FROM users WHERE id = $1',
                [userId]
            );
            return result.rows[0]?.longest_streak >= 3;
        }
    },
    streak_7: {
        name: 'Week Warrior',
        description: '7-day streak achieved',
        emoji: '🔥🔥',
        check: async (userId) => {
            const result = await pool.query(
                'SELECT longest_streak FROM users WHERE id = $1',
                [userId]
            );
            return result.rows[0]?.longest_streak >= 7;
        }
    },
    streak_14: {
        name: 'Fortnight Fighter',
        description: '14-day streak achieved',
        emoji: '🔥🔥🔥',
        check: async (userId) => {
            const result = await pool.query(
                'SELECT longest_streak FROM users WHERE id = $1',
                [userId]
            );
            return result.rows[0]?.longest_streak >= 14;
        }
    },
    streak_30: {
        name: 'Monthly Master',
        description: '30-day streak achieved',
        emoji: '🏆',
        check: async (userId) => {
            const result = await pool.query(
                'SELECT longest_streak FROM users WHERE id = $1',
                [userId]
            );
            return result.rows[0]?.longest_streak >= 30;
        }
    },
    streak_60: {
        name: 'Diamond Dedication',
        description: '60-day streak achieved',
        emoji: '💎',
        check: async (userId) => {
            const result = await pool.query(
                'SELECT longest_streak FROM users WHERE id = $1',
                [userId]
            );
            return result.rows[0]?.longest_streak >= 60;
        }
    },
    
    // Referral achievements
    referral_1: {
        name: 'Influencer',
        description: 'First successful referral',
        emoji: '👥',
        check: async (userId) => {
            const result = await pool.query(
                'SELECT COUNT(*) FROM users WHERE referred_by = $1',
                [userId]
            );
            return parseInt(result.rows[0].count) >= 1;
        }
    },
    referral_5: {
        name: 'Team Builder',
        description: '5 successful referrals',
        emoji: '👥👥',
        check: async (userId) => {
            const result = await pool.query(
                'SELECT COUNT(*) FROM users WHERE referred_by = $1',
                [userId]
            );
            return parseInt(result.rows[0].count) >= 5;
        }
    },
    referral_10: {
        name: 'Community Champion',
        description: '10 successful referrals',
        emoji: '🌟',
        check: async (userId) => {
            const result = await pool.query(
                'SELECT COUNT(*) FROM users WHERE referred_by = $1',
                [userId]
            );
            return parseInt(result.rows[0].count) >= 10;
        }
    },
    
    // Winning achievements
    big_winner: {
        name: 'Big Winner',
        description: 'Won ₦10,000 or more in a single game',
        emoji: '💰',
        check: async (userId) => {
            const result = await pool.query(`
                SELECT COUNT(*) FROM transactions 
                WHERE user_id = $1 AND transaction_type = 'prize' AND amount >= 10000
            `, [userId]);
            return parseInt(result.rows[0].count) >= 1;
        }
    },
    grand_champion: {
        name: 'Grand Champion',
        description: 'Won the grand prize (₦50,000)',
        emoji: '👑',
        check: async (userId) => {
            const result = await pool.query(`
                SELECT COUNT(*) FROM transactions 
                WHERE user_id = $1 AND transaction_type = 'prize' AND amount >= 50000
            `, [userId]);
            return parseInt(result.rows[0].count) >= 1;
        }
    },
    
    // Loyalty achievements
    loyal_player: {
        name: 'Loyal Player',
        description: '30 days since registration with regular activity',
        emoji: '❤️',
        check: async (userId) => {
            const result = await pool.query(`
                SELECT created_at, 
                       (SELECT COUNT(DISTINCT DATE(started_at)) FROM game_sessions WHERE user_id = $1) as play_days
                FROM users WHERE id = $1
            `, [userId]);
            
            if (result.rows.length === 0) return false;
            
            const daysSinceJoin = Math.floor((Date.now() - new Date(result.rows[0].created_at)) / (1000 * 60 * 60 * 24));
            const playDays = parseInt(result.rows[0].play_days);
            
            return daysSinceJoin >= 30 && playDays >= 10;
        }
    },
    
    // Speed achievement
    speed_demon: {
        name: 'Speed Demon',
        description: 'Average response time under 5 seconds',
        emoji: '⚡',
        check: async (userId) => {
            const result = await pool.query(`
                SELECT AVG(avg_response_time_ms) as avg_time
                FROM game_sessions 
                WHERE user_id = $1 AND avg_response_time_ms IS NOT NULL
            `, [userId]);
            
            const avgTime = result.rows[0]?.avg_time;
            return avgTime && avgTime < 5000;
        }
    },
    
    // Comeback achievement
    comeback_king: {
        name: 'Comeback King',
        description: 'Won after reaching a safe checkpoint',
        emoji: '💪',
        check: async (userId) => {
            const result = await pool.query(`
                SELECT COUNT(*) FROM game_sessions 
                WHERE user_id = $1 
                AND status = 'won' 
                AND current_question > 5
            `, [userId]);
            return parseInt(result.rows[0].count) >= 1;
        }
    }
};

class AchievementsService {
    
    // ============================================
    // CHECK AND AWARD ACHIEVEMENTS
    // ============================================
    
    async checkAndAwardAchievements(userId) {
        const newAchievements = [];
        
        try {
            // Get user's existing achievements
            const existingResult = await pool.query(
                'SELECT achievement_type FROM user_achievements WHERE user_id = $1',
                [userId]
            );
            const existingTypes = existingResult.rows.map(r => r.achievement_type);
            
            // Check each achievement
            for (const [type, achievement] of Object.entries(ACHIEVEMENTS)) {
                if (existingTypes.includes(type)) continue;
                
                try {
                    const earned = await achievement.check(userId);
                    
                    if (earned) {
                        await this.awardAchievement(userId, type, achievement);
                        newAchievements.push({
                            type,
                            name: achievement.name,
                            description: achievement.description,
                            emoji: achievement.emoji
                        });
                    }
                } catch (checkError) {
                    logger.error(`Error checking achievement ${type}:`, checkError);
                }
            }
            
            return newAchievements;
        } catch (error) {
            logger.error('Error checking achievements:', error);
            return [];
        }
    }
    
    async awardAchievement(userId, type, achievement) {
        try {
            await pool.query(`
                INSERT INTO user_achievements (user_id, achievement_type, achievement_name, description, metadata)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (user_id, achievement_type) DO NOTHING
            `, [userId, type, achievement.name, achievement.description, JSON.stringify({ emoji: achievement.emoji })]);
            
            logger.info(`Achievement awarded: ${type} to user ${userId}`);
        } catch (error) {
            logger.error('Error awarding achievement:', error);
        }
    }
    
    // ============================================
    // GET USER ACHIEVEMENTS
    // ============================================
    
    async getUserAchievements(userId) {
        try {
            const result = await pool.query(`
                SELECT achievement_type, achievement_name, description, earned_at, metadata
                FROM user_achievements
                WHERE user_id = $1
                ORDER BY earned_at DESC
            `, [userId]);
            
            return result.rows.map(row => ({
                type: row.achievement_type,
                name: row.achievement_name,
                description: row.description,
                earnedAt: row.earned_at,
                emoji: row.metadata?.emoji || '🏅'
            }));
        } catch (error) {
            logger.error('Error getting user achievements:', error);
            return [];
        }
    }
    
    // ============================================
    // GET ALL POSSIBLE ACHIEVEMENTS
    // ============================================
    
    getAllAchievements() {
        return Object.entries(ACHIEVEMENTS).map(([type, achievement]) => ({
            type,
            name: achievement.name,
            description: achievement.description,
            emoji: achievement.emoji
        }));
    }
    
    // ============================================
    // FORMAT ACHIEVEMENTS MESSAGE
    // ============================================
    
    formatAchievementsMessage(achievements, title = 'YOUR ACHIEVEMENTS') {
        if (!achievements || achievements.length === 0) {
            return `🏅 *${title}* 🏅\n\n` +
                   `No achievements yet!\n\n` +
                   `Keep playing to unlock badges and rewards! 🎯`;
        }
        
        let message = `🏅 *${title}* 🏅\n\n`;
        
        achievements.forEach(a => {
            message += `${a.emoji} *${a.name}*\n`;
            message += `   ${a.description}\n\n`;
        });
        
        message += `_${achievements.length} achievement${achievements.length > 1 ? 's' : ''} earned!_`;
        
        return message;
    }
    
    // ============================================
    // FORMAT NEW ACHIEVEMENT NOTIFICATION
    // ============================================
    
    formatNewAchievementMessage(achievement) {
        return `🎊 *ACHIEVEMENT UNLOCKED!* 🎊\n\n` +
               `${achievement.emoji} *${achievement.name}*\n\n` +
               `${achievement.description}\n\n` +
               `_Keep playing to unlock more!_`;
    }
    
    // ============================================
    // GET ACHIEVEMENT LEADERBOARD
    // ============================================
    
    async getAchievementLeaderboard(limit = 10) {
        try {
            const result = await pool.query(`
                SELECT u.id, u.username, u.city, COUNT(a.id) as achievement_count
                FROM users u
                LEFT JOIN user_achievements a ON u.id = a.user_id
                GROUP BY u.id, u.username, u.city
                HAVING COUNT(a.id) > 0
                ORDER BY achievement_count DESC, MAX(a.earned_at) DESC
                LIMIT $1
            `, [limit]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting achievement leaderboard:', error);
            return [];
        }
    }
    
    // ============================================
    // CHECK SPECIFIC ACHIEVEMENT CATEGORIES
    // ============================================
    
    async checkGameAchievements(userId) {
        return this.checkAndAwardAchievements(userId);
    }
    
    async checkStreakAchievements(userId) {
        const streakTypes = ['streak_3', 'streak_7', 'streak_14', 'streak_30', 'streak_60'];
        const newAchievements = [];
        
        const existingResult = await pool.query(
            'SELECT achievement_type FROM user_achievements WHERE user_id = $1',
            [userId]
        );
        const existingTypes = existingResult.rows.map(r => r.achievement_type);
        
        for (const type of streakTypes) {
            if (existingTypes.includes(type)) continue;
            
            const achievement = ACHIEVEMENTS[type];
            const earned = await achievement.check(userId);
            
            if (earned) {
                await this.awardAchievement(userId, type, achievement);
                newAchievements.push({
                    type,
                    name: achievement.name,
                    description: achievement.description,
                    emoji: achievement.emoji
                });
            }
        }
        
        return newAchievements;
    }
    
    async checkReferralAchievements(userId) {
        const referralTypes = ['referral_1', 'referral_5', 'referral_10'];
        const newAchievements = [];
        
        const existingResult = await pool.query(
            'SELECT achievement_type FROM user_achievements WHERE user_id = $1',
            [userId]
        );
        const existingTypes = existingResult.rows.map(r => r.achievement_type);
        
        for (const type of referralTypes) {
            if (existingTypes.includes(type)) continue;
            
            const achievement = ACHIEVEMENTS[type];
            const earned = await achievement.check(userId);
            
            if (earned) {
                await this.awardAchievement(userId, type, achievement);
                newAchievements.push({
                    type,
                    name: achievement.name,
                    description: achievement.description,
                    emoji: achievement.emoji
                });
            }
        }
        
        return newAchievements;
    }
}

module.exports = new AchievementsService();
