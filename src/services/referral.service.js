// ============================================
// FILE: src/services/referral.service.js
// NEW: Referral system management
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class ReferralService {
  /**
   * Get referral statistics for a user
   */
  async getReferralStats(userId) {
    try {
      const result = await pool.query(
        `SELECT 
          referral_code,
          total_referrals,
          pending_referral_rewards as pending_rewards
         FROM users 
         WHERE id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return {
          referralCode: null,
          totalReferrals: 0,
          pendingRewards: 0
        };
      }

      const user = result.rows[0];
      return {
        referralCode: user.referral_code,
        totalReferrals: user.total_referrals || 0,
        pendingRewards: user.pending_referral_rewards || 0
      };
    } catch (error) {
      logger.error('Error getting referral stats:', error);
      throw error;
    }
  }

  /**
   * Get list of users referred by a specific user
   */
  async getReferredUsers(userId, limit = 10) {
    try {
      const result = await pool.query(
        `SELECT 
          u.username,
          u.full_name,
          u.city,
          r.referred_at,
          r.is_active
         FROM referrals r
         JOIN users u ON r.referred_user_id = u.id
         WHERE r.referrer_id = $1
         ORDER BY r.referred_at DESC
         LIMIT $2`,
        [userId, limit]
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting referred users:', error);
      throw error;
    }
  }

  /**
   * Validate referral code
   */
  async validateReferralCode(code) {
    try {
      const result = await pool.query(
        'SELECT id, username FROM users WHERE UPPER(referral_code) = $1',
        [code.toUpperCase()]
      );

      if (result.rows.length === 0) {
        return { valid: false, referrerId: null };
      }

      return { valid: true, referrerId: result.rows[0].id, username: result.rows[0].username };
    } catch (error) {
      logger.error('Error validating referral code:', error);
      return { valid: false, referrerId: null };
    }
  }

  /**
   * Create referral relationship
   * This is called during user registration
   */
  async createReferral(referrerId, referredUserId, referralCode) {
    try {
      // Check if already referred
      const existing = await pool.query(
        'SELECT id FROM referrals WHERE referred_user_id = $1',
        [referredUserId]
      );

      if (existing.rows.length > 0) {
        logger.warn(`User ${referredUserId} already has a referrer`);
        return { success: false, error: 'Already referred' };
      }

      // Create referral record
      const result = await pool.query(
        `INSERT INTO referrals (referrer_id, referred_user_id, referral_code)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [referrerId, referredUserId, referralCode.toUpperCase()]
      );

      logger.info(`Referral created: User ${referredUserId} referred by ${referrerId}`);

      // Trigger will automatically:
      // 1. Update referrer's total_referrals
      // 2. Give referrer 1 free game every 3 referrals
      // 3. Give referee 1 free game

      return { success: true, referral: result.rows[0] };
    } catch (error) {
      logger.error('Error creating referral:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if user was referred and apply bonus
   */
  async processReferralBonus(userId) {
    try {
      // Check if user has an active referral bonus (within 24 hours)
      const result = await pool.query(
        `SELECT r.*, u.username as referrer_username
         FROM referrals r
         JOIN users u ON r.referrer_id = u.id
         WHERE r.referred_user_id = $1
         AND r.is_active = true
         AND r.referred_at > NOW() - INTERVAL '24 hours'`,
        [userId]
      );

      if (result.rows.length === 0) {
        return { hasBonus: false };
      }

      return { hasBonus: true, referral: result.rows[0] };
    } catch (error) {
      logger.error('Error processing referral bonus:', error);
      return { hasBonus: false };
    }
  }

  /**
   * Deactivate expired referral bonuses (24hr limit)
   */
  async deactivateExpiredBonuses() {
    try {
      const result = await pool.query(
        `UPDATE referrals
         SET is_active = false
         WHERE is_active = true
         AND referred_at < NOW() - INTERVAL '24 hours'
         RETURNING referred_user_id`
      );

      if (result.rows.length > 0) {
        // Remove the free game from users who didn't use it within 24hrs
        const userIds = result.rows.map(r => r.referred_user_id);
        
        await pool.query(
          `UPDATE users
           SET games_remaining = GREATEST(games_remaining - 1, 0)
           WHERE id = ANY($1)
           AND games_remaining > 0`,
          [userIds]
        );

        logger.info(`Deactivated ${result.rows.length} expired referral bonuses`);
      }

      return result.rows.length;
    } catch (error) {
      logger.error('Error deactivating expired bonuses:', error);
      return 0;
    }
  }

  /**
   * Get leaderboard of top referrers
   */
  async getTopReferrers(limit = 10) {
    try {
      const result = await pool.query(
        `SELECT 
          u.username,
          u.full_name,
          u.city,
          u.total_referrals,
          u.referral_code
         FROM users u
         WHERE u.total_referrals > 0
         ORDER BY u.total_referrals DESC
         LIMIT $1`,
        [limit]
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting top referrers:', error);
      return [];
    }
  }

  /**
   * Get referral analytics
   */
  async getReferralAnalytics() {
    try {
      const result = await pool.query(`
        SELECT 
          COUNT(*) as total_referrals,
          COUNT(DISTINCT referrer_id) as total_referrers,
          COUNT(CASE WHEN is_active = true THEN 1 END) as active_referrals,
          COUNT(CASE WHEN reward_claimed = true THEN 1 END) as rewards_claimed,
          ROUND(AVG(CASE WHEN is_active = true THEN 1 ELSE 0 END) * 100, 2) as active_rate
        FROM referrals
      `);

      return result.rows[0];
    } catch (error) {
      logger.error('Error getting referral analytics:', error);
      throw error;
    }
  }
}

module.exports = ReferralService;