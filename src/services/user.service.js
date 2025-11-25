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

  async createUser(phoneNumber, fullName, lga) {
    try {
      const result = await pool.query(
        `INSERT INTO users (phone_number, full_name, lga)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [phoneNumber, fullName, lga]
      );
      logger.info(`New user created: ${fullName} (${phoneNumber})`);
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
}

module.exports = UserService;