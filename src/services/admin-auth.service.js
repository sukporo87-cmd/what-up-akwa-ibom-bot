const crypto = require('crypto');
const pool = require('../config/database');
const { logger } = require('../utils/logger');

class AdminAuthService {
  /**
   * Generate a secure session token
   */
  generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Create a new admin session
   */
  async createSession(adminId, ipAddress, userAgent) {
    try {
      const sessionToken = this.generateSessionToken();
      const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours

      const result = await pool.query(
        `INSERT INTO admin_sessions 
         (admin_id, session_token, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [adminId, sessionToken, ipAddress, userAgent, expiresAt]
      );

      // Log login activity
      await this.logActivity(adminId, 'login', { ip_address: ipAddress }, ipAddress, userAgent);

      logger.info(`Admin session created for ${adminId}`);
      return result.rows[0];
    } catch (error) {
      logger.error('Error creating admin session:', error);
      throw error;
    }
  }

  /**
   * Validate a session token
   */
  async validateSession(sessionToken) {
    try {
      const result = await pool.query(
        `SELECT * FROM admin_sessions
         WHERE session_token = $1
           AND is_active = true
           AND expires_at > NOW()`,
        [sessionToken]
      );

      if (result.rows.length === 0) {
        return { valid: false, reason: 'Invalid or expired session' };
      }

      const session = result.rows[0];

      // Update last activity
      await pool.query(
        'UPDATE admin_sessions SET last_activity = NOW() WHERE id = $1',
        [session.id]
      );

      return { valid: true, session };
    } catch (error) {
      logger.error('Error validating session:', error);
      return { valid: false, reason: 'Validation error' };
    }
  }

  /**
   * Logout - invalidate session
   */
  async logout(sessionToken) {
    try {
      const session = await pool.query(
        'SELECT * FROM admin_sessions WHERE session_token = $1',
        [sessionToken]
      );

      if (session.rows.length > 0) {
        await pool.query(
          'UPDATE admin_sessions SET is_active = false WHERE session_token = $1',
          [sessionToken]
        );

        // Log logout activity
        await this.logActivity(
          session.rows[0].admin_id, 
          'logout', 
          { session_duration: Date.now() - new Date(session.rows[0].created_at).getTime() },
          session.rows[0].ip_address,
          session.rows[0].user_agent
        );

        logger.info(`Admin ${session.rows[0].admin_id} logged out`);
      }

      return true;
    } catch (error) {
      logger.error('Error logging out:', error);
      return false;
    }
  }

  /**
   * Login with admin token
   */
  async login(providedToken, ipAddress, userAgent) {
    try {
      // Verify against environment token
      if (providedToken !== process.env.ADMIN_TOKEN) {
        await this.logActivity('unknown', 'failed_login', { reason: 'Invalid token' }, ipAddress, userAgent);
        return { success: false, error: 'Invalid credentials' };
      }

      // Create session
      const session = await this.createSession('admin', ipAddress, userAgent);

      return { 
        success: true, 
        sessionToken: session.session_token,
        expiresAt: session.expires_at
      };
    } catch (error) {
      logger.error('Error during login:', error);
      return { success: false, error: 'Login failed' };
    }
  }

  /**
   * Log admin activity
   */
  async logActivity(adminId, action, details = {}, ipAddress = null, userAgent = null) {
    try {
      await pool.query(
        `INSERT INTO admin_activity_log 
         (admin_id, action, details, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [adminId, action, JSON.stringify(details), ipAddress, userAgent]
      );
    } catch (error) {
      logger.error('Error logging admin activity:', error);
    }
  }

  /**
   * Get admin activity log
   */
  async getActivityLog(limit = 100, offset = 0) {
    try {
      const result = await pool.query(
        `SELECT * FROM admin_activity_log
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting activity log:', error);
      return [];
    }
  }

  /**
   * Clean up expired sessions (run periodically)
   */
  async cleanupExpiredSessions() {
    try {
      const result = await pool.query(
        `UPDATE admin_sessions
         SET is_active = false
         WHERE expires_at < NOW() AND is_active = true
         RETURNING admin_id`
      );

      if (result.rows.length > 0) {
        logger.info(`Cleaned up ${result.rows.length} expired admin sessions`);
      }
    } catch (error) {
      logger.error('Error cleaning up sessions:', error);
    }
  }
}

module.exports = AdminAuthService;