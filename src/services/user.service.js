// ============================================
// FILE: src/services/user.service.js
// UPDATED: Added username, city, age support
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

class UserService {
  async getUserByPhone(phoneNumber) {
    try {
      const result = await pool.query(
        'SELECT * FROM users WHERE phone_number = $1',
        [phoneNumber]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error fetching user by phone:', error);
      throw error;
    }
  }

  async createUser(phoneNumber, fullName, city, username, age) {
    try {
      const result = await pool.query(
        `INSERT INTO users (phone_number, full_name, city, username, age)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [phoneNumber, fullName, city, username, age]
      );
      
      logger.info(`New user created: @${username} (${fullName}) from ${city}, age ${age}`);
      return result.rows[0];
    } catch (error) {
      logger.error('Error creating user:', error);
      throw error;
    }
  }

  async setUserState(phone, state, data = {}) {
    try {
      const stateData = {
        state,
        data,
        timestamp: Date.now()
      };
      await redis.setex(`user_state:${phone}`, 1800, JSON.stringify(stateData));
    } catch (error) {
      logger.error('Error setting user state:', error);
    }
  }

  async getUserState(phone) {
    try {
      const stateJson = await redis.get(`user_state:${phone}`);
      if (!stateJson) return null;
      return JSON.parse(stateJson);
    } catch (error) {
      logger.error('Error getting user state:', error);
      return null;
    }
  }

  async clearUserState(phone) {
    try {
      await redis.del(`user_state:${phone}`);
    } catch (error) {
      logger.error('Error clearing user state:', error);
    }
  }

  async getUserStats(userId) {
    try {
      // Get user basic info
      const userResult = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        return null;
      }

      const user = userResult.rows[0];

      // Get total games and win rate
      const gamesResult = await pool.query(
        `SELECT
          COUNT(*) as total_games,
          COUNT(CASE WHEN final_score > 0 THEN 1 END) as games_won,
          MAX(final_score) as highest_win,
          AVG(final_score) as avg_score
         FROM game_sessions
         WHERE user_id = $1 AND status = 'completed'`,
        [userId]
      );

      const gameStats = gamesResult.rows[0];

      // Get highest question reached details
      const bestGameResult = await pool.query(
        `SELECT current_question, final_score, completed_at
         FROM game_sessions
         WHERE user_id = $1 AND status = 'completed'
         ORDER BY current_question DESC, final_score DESC
         LIMIT 1`,
        [userId]
      );

      const bestGame = bestGameResult.rows[0];

      // Get ranking position
      const rankResult = await pool.query(
        `SELECT COUNT(*) + 1 as rank
         FROM users
         WHERE total_winnings > $1`,
        [user.total_winnings]
      );

      const rank = rankResult.rows[0].rank;

      // Calculate win rate
      const totalGames = parseInt(gameStats.total_games) || 0;
      const gamesWon = parseInt(gameStats.games_won) || 0;
      const winRate = totalGames > 0 ? ((gamesWon / totalGames) * 100).toFixed(1) : 0;

      return {
        fullName: user.full_name,
        username: user.username,
        city: user.city,
        age: user.age,
        totalGamesPlayed: user.total_games_played,
        totalWinnings: parseFloat(user.total_winnings) || 0,
        highestQuestionReached: user.highest_question_reached || 0,
        gamesRemaining: user.games_remaining || 0,
        totalGamesPurchased: user.total_games_purchased || 0,
        gamesWon: gamesWon,
        winRate: winRate,
        highestWin: parseFloat(gameStats.highest_win) || 0,
        avgScore: parseFloat(gameStats.avg_score) || 0,
        rank: parseInt(rank),
        bestGameDate: bestGame ? bestGame.completed_at : null,
        joinedDate: user.created_at
      };
    } catch (error) {
      logger.error('Error getting user stats:', error);
      throw error;
    }
  }
}

module.exports = UserService;