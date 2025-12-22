// ============================================
// FILE: src/services/user.service.js
// UPDATED: Added platform support (WhatsApp & Telegram)
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

class UserService {
  /**
   * Get user by phone number or platform identifier
   * Handles both WhatsApp phone numbers and Telegram chat IDs
   */
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

  /**
   * Create user with platform and referral support
   * @param {string} phoneNumber - Phone number or platform identifier
   * @param {string} fullName - User's full name
   * @param {string} city - User's city
   * @param {string} username - User's username
   * @param {number} age - User's age
   * @param {number|null} referrerId - ID of referring user
   * @param {string} platform - Platform type: 'whatsapp' or 'telegram'
   */
  async createUser(phoneNumber, fullName, city, username, age, referrerId = null, platform = 'whatsapp') {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Generate referral code
      const referralCode = this.generateReferralCode();

      // Store platform info in phone_number field with prefix for Telegram
      const identifier = platform === 'telegram' ? `tg_${phoneNumber}` : phoneNumber;

      // Create user
      const userResult = await client.query(
        `INSERT INTO users (phone_number, full_name, city, username, age, referral_code, referred_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [identifier, fullName, city, username, age, referralCode, referrerId]
      );

      const user = userResult.rows[0];

      // If referred, create referral record
      if (referrerId) {
        const referrerResult = await client.query(
          'SELECT referral_code FROM users WHERE id = $1',
          [referrerId]
        );

        if (referrerResult.rows.length > 0) {
          await client.query(
            `INSERT INTO referrals (referrer_id, referred_user_id, referral_code)
             VALUES ($1, $2, $3)`,
            [referrerId, user.id, referrerResult.rows[0].referral_code]
          );

          logger.info(`Referral created: User ${user.id} referred by ${referrerId}`);
        }
      }

      await client.query('COMMIT');
      
      logger.info(`New user created: @${username} (${fullName}) from ${city}, age ${age}, platform: ${platform}. Referral code: ${referralCode}`);
      
      return user;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating user:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Generate unique referral code
   */
  generateReferralCode() {
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusing chars
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return code;
  }

  /**
   * Extract platform from identifier
   * @param {string} identifier - Phone number or platform identifier
   * @returns {string} - 'telegram' or 'whatsapp'
   */
  getPlatformFromIdentifier(identifier) {
    return identifier.startsWith('tg_') ? 'telegram' : 'whatsapp';
  }

  /**
   * Strip platform prefix from identifier
   * @param {string} identifier - Phone number or platform identifier
   * @returns {string} - Clean identifier without prefix
   */
  stripPlatformPrefix(identifier) {
    return identifier.replace(/^tg_/, '');
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
      const userResult = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        return null;
      }

      const user = userResult.rows[0];

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

      const bestGameResult = await pool.query(
        `SELECT current_question, final_score, completed_at
         FROM game_sessions
         WHERE user_id = $1 AND status = 'completed'
         ORDER BY current_question DESC, final_score DESC
         LIMIT 1`,
        [userId]
      );

      const bestGame = bestGameResult.rows[0];

      const rankResult = await pool.query(
        `SELECT COUNT(*) + 1 as rank
         FROM users
         WHERE total_winnings > $1`,
        [user.total_winnings]
      );

      const rank = rankResult.rows[0].rank;

      const totalGames = parseInt(gameStats.total_games) || 0;
      const gamesWon = parseInt(gameStats.games_won) || 0;
      const winRate = totalGames > 0 ? ((gamesWon / totalGames) * 100).toFixed(1) : 0;

      return {
        fullName: user.full_name,
        username: user.username,
        city: user.city,
        age: user.age,
        platform: this.getPlatformFromIdentifier(user.phone_number),
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