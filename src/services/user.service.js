// ============================================
// FILE: src/services/user.service.js
// FIXED: Added getUserByIdentifier + simplified create for Telegram
// Full multi-platform support (WhatsApp + Telegram)
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

class UserService {
  /**
   * Get user by unified identifier (phone or tg_ prefixed)
   * This is the CRITICAL method needed by MessagingService
   */
  async getUserByIdentifier(identifier) {
    if (!identifier) return null;

    try {
      const result = await pool.query(
        'SELECT * FROM users WHERE phone_number = $1',
        [identifier]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error fetching user by identifier:', error);
      throw error;
    }
  }

  /**
   * Get user by phone number (legacy WhatsApp support)
   */
  async getUserByPhone(phoneNumber) {
    return this.getUserByIdentifier(phoneNumber);
  }

  /**
   * Create new user — simplified for initial Telegram flow
   * Full registration (city, username, age) can happen later via game flow
   */
  async createUser({ identifier, full_name, platform = 'whatsapp', telegram_chat_id = null, referrerId = null }) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Generate referral code
      const referralCode = this.generateReferralCode();

      // Insert user with minimal data
      const userResult = await client.query(
        `INSERT INTO users (
          phone_number, 
          full_name, 
          referral_code, 
          referred_by, 
          platform,
          telegram_chat_id,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [identifier, full_name || 'Player', referralCode, referrerId, platform, telegram_chat_id]
      );

      const user = userResult.rows[0];

      // Handle referral if provided
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
      
      logger.info(`New user created: ${full_name || 'Player'} (${identifier}), platform: ${platform}`);
      
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
   * Legacy createUser with full registration fields (for WhatsApp flow)
   */
  async createFullUser(phoneNumber, fullName, city, username, age, referrerId = null, platform = 'whatsapp') {
    const identifier = platform === 'telegram' ? `tg_${phoneNumber}` : phoneNumber;
    
    return this.createUser({
      identifier,
      full_name: fullName,
      platform,
      referrerId
    });
  }

  /**
   * Generate unique 8-character referral code
   */
  generateReferralCode() {
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return code;
  }

  /**
   * Extract platform from identifier
   */
  getPlatformFromIdentifier(identifier) {
    return identifier?.startsWith('tg_') ? 'telegram' : 'whatsapp';
  }

  /**
   * Strip tg_ prefix
   */
  stripPlatformPrefix(identifier) {
    return identifier?.replace(/^tg_/, '') || '';
  }

  // === State Management (Redis) ===
  async setUserState(identifier, state, data = {}) {
    try {
      const stateData = { state, data, timestamp: Date.now() };
      await redis.setex(`user_state:${identifier}`, 1800, JSON.stringify(stateData));
    } catch (error) {
      logger.error('Error setting user state:', error);
    }
  }

  async getUserState(identifier) {
    try {
      const stateJson = await redis.get(`user_state:${identifier}`);
      return stateJson ? JSON.parse(stateJson) : null;
    } catch (error) {
      logger.error('Error getting user state:', error);
      return null;
    }
  }

  async clearUserState(identifier) {
    try {
      await redis.del(`user_state:${identifier}`);
    } catch (error) {
      logger.error('Error clearing user state:', error);
    }
  }

  // === Stats ===
  async getUserStats(userId) {
    try {
      const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length === 0) return null;

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

      const rankResult = await pool.query(
        `SELECT COUNT(*) + 1 as rank
         FROM users
         WHERE total_winnings > $1`,
        [user.total_winnings || 0]
      );

      const totalGames = parseInt(gameStats.total_games) || 0;
      const gamesWon = parseInt(gameStats.games_won) || 0;
      const winRate = totalGames > 0 ? ((gamesWon / totalGames) * 100).toFixed(1) : 0;

      return {
        fullName: user.full_name || 'Player',
        username: user.username || '@unknown',
        city: user.city || 'Unknown',
        age: user.age || '??',
        platform: this.getPlatformFromIdentifier(user.phone_number),
        totalGamesPlayed: user.total_games_played || 0,
        totalWinnings: parseFloat(user.total_winnings) || 0,
        highestQuestionReached: user.highest_question_reached || 0,
        gamesRemaining: user.games_remaining || 0,
        gamesWon,
        winRate,
        highestWin: parseFloat(gameStats.highest_win) || 0,
        avgScore: parseFloat(gameStats.avg_score) || 0,
        rank: parseInt(rankResult.rows[0].rank),
        joinedDate: user.created_at
      };
    } catch (error) {
      logger.error('Error getting user stats:', error);
      throw error;
    }
  }
}

module.exports = UserService;