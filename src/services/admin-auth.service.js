// ============================================
// FILE: src/services/admin-auth.service.js - WITH RBAC
// ============================================

const crypto = require('crypto');
const bcrypt = require('bcrypt');
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

      // Update last login
      await pool.query(
        'UPDATE admins SET last_login = NOW() WHERE id = $1',
        [adminId]
      );

      // Log login activity
      await this.logActivity(adminId, 'login', { ip_address: ipAddress }, ipAddress, userAgent);

      logger.info(`Admin session created for admin ID: ${adminId}`);
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
        `SELECT s.*, a.id as admin_id, a.username, a.full_name, a.email, 
                a.is_active as admin_active, r.role_name, r.permissions
         FROM admin_sessions s
         JOIN admins a ON s.admin_id = a.id
         JOIN admin_roles r ON a.role_id = r.id
         WHERE s.session_token = $1
         AND s.is_active = true
         AND s.expires_at > NOW()`,
        [sessionToken]
      );

      if (result.rows.length === 0) {
        return { valid: false, reason: 'Invalid or expired session' };
      }

      const session = result.rows[0];

      // Check if admin is active
      if (!session.admin_active) {
        return { valid: false, reason: 'Admin account is disabled' };
      }

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
   * Check if admin has specific permission
   */
  hasPermission(permissions, resource, action) {
    if (!permissions || !permissions[resource]) {
      return false;
    }
    return permissions[resource][action] === true;
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
   * Login with username/password (RBAC)
   */
  async login(username, password, ipAddress, userAgent) {
    try {
      // Get admin with role
      const result = await pool.query(
        `SELECT a.*, r.role_name, r.permissions, r.display_name as role_display_name
         FROM admins a
         JOIN admin_roles r ON a.role_id = r.id
         WHERE a.username = $1 AND a.is_active = true`,
        [username]
      );

      if (result.rows.length === 0) {
        await this.logActivity(null, 'failed_login', 
          { reason: 'Invalid username', username }, ipAddress, userAgent);
        return { success: false, error: 'Invalid credentials' };
      }

      const admin = result.rows[0];

      // Verify password
      const passwordMatch = await bcrypt.compare(password, admin.password_hash);

      if (!passwordMatch) {
        await this.logActivity(admin.id, 'failed_login', 
          { reason: 'Invalid password' }, ipAddress, userAgent);
        return { success: false, error: 'Invalid credentials' };
      }

      // Create session
      const session = await this.createSession(admin.id, ipAddress, userAgent);

      return {
        success: true,
        sessionToken: session.session_token,
        expiresAt: session.expires_at,
        admin: {
          id: admin.id,
          username: admin.username,
          fullName: admin.full_name,
          email: admin.email,
          role: admin.role_name,
          roleDisplayName: admin.role_display_name,
          permissions: admin.permissions
        }
      };
    } catch (error) {
      logger.error('Error during login:', error);
      return { success: false, error: 'Login failed' };
    }
  }

  /**
   * Login with legacy token (for backward compatibility)
   */
  async loginWithToken(providedToken, ipAddress, userAgent) {
    try {
      // Verify against environment token
      if (providedToken !== process.env.ADMIN_TOKEN) {
        await this.logActivity(null, 'failed_login', 
          { reason: 'Invalid token' }, ipAddress, userAgent);
        return { success: false, error: 'Invalid credentials' };
      }

      // Get or create default super admin
      let admin = await pool.query(
        `SELECT a.*, r.role_name, r.permissions
         FROM admins a
         JOIN admin_roles r ON a.role_id = r.id
         WHERE a.username = 'token_admin'`
      );

      if (admin.rows.length === 0) {
        // Create token admin if doesn't exist
        const superAdminRole = await pool.query(
          `SELECT id FROM admin_roles WHERE role_name = 'super_admin'`
        );

        admin = await pool.query(
          `INSERT INTO admins (username, full_name, email, password_hash, role_id)
           VALUES ('token_admin', 'Token Admin', 'token@admin.local', '', $1)
           RETURNING *`,
          [superAdminRole.rows[0].id]
        );
      }

      const adminData = admin.rows[0];

      // Create session
      const session = await this.createSession(adminData.id, ipAddress, userAgent);

      return {
        success: true,
        sessionToken: session.session_token,
        expiresAt: session.expires_at,
        admin: {
          id: adminData.id,
          username: adminData.username,
          fullName: adminData.full_name,
          role: adminData.role_name || 'super_admin'
        }
      };
    } catch (error) {
      logger.error('Error during token login:', error);
      return { success: false, error: 'Login failed' };
    }
  }

  /**
   * Log admin activity - FIXED TO PROPERLY STORE DETAILS
   */
  async logActivity(adminId, actionType, details = {}, ipAddress = null, userAgent = null) {
    try {
      // Ensure details is a valid JSON object
      const safeDetails = details && typeof details === 'object' ? details : {};
      
      await pool.query(
        `INSERT INTO admin_activity_log
         (admin_id, action_type, action_details, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [adminId, actionType, JSON.stringify(safeDetails), ipAddress, userAgent]
      );

      logger.debug(`Activity logged: ${actionType} by admin ${adminId}`);
    } catch (error) {
      logger.error('Error logging admin activity:', error);
      // Don't throw - logging should not break main flow
    }
  }

  /**
   * Get admin activity log
   */
  async getActivityLog(limit = 100, offset = 0) {
    try {
      const result = await pool.query(
        `SELECT 
           al.*,
           a.username,
           a.full_name
         FROM admin_activity_log al
         LEFT JOIN admins a ON al.admin_id = a.id
         ORDER BY al.created_at DESC
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
   * Create new admin (Super Admin only)
   */
  async createAdmin(username, fullName, email, password, roleId, createdBy) {
    try {
      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      const result = await pool.query(
        `INSERT INTO admins (username, full_name, email, password_hash, role_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, username, full_name, email, role_id, is_active, created_at`,
        [username, fullName, email, passwordHash, roleId, createdBy]
      );

      logger.info(`New admin created: ${username} by admin ${createdBy}`);
      return { success: true, admin: result.rows[0] };
    } catch (error) {
      logger.error('Error creating admin:', error);
      if (error.code === '23505') { // Unique violation
        return { success: false, error: 'Username or email already exists' };
      }
      return { success: false, error: 'Failed to create admin' };
    }
  }

  /**
   * Get all admins
   */
  async getAllAdmins() {
    try {
      const result = await pool.query(
        `SELECT 
           a.id, a.username, a.full_name, a.email, a.is_active, 
           a.last_login, a.created_at,
           r.role_name, r.display_name as role_display_name
         FROM admins a
         JOIN admin_roles r ON a.role_id = r.id
         ORDER BY a.created_at DESC`
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting admins:', error);
      return [];
    }
  }

  /**
   * Get all roles
   */
  async getAllRoles() {
    try {
      const result = await pool.query(
        'SELECT id, role_name, display_name, description, permissions FROM admin_roles ORDER BY id'
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting roles:', error);
      return [];
    }
  }

  /**
   * Update admin status
   */
  async updateAdminStatus(adminId, isActive, updatedBy) {
    try {
      await pool.query(
        'UPDATE admins SET is_active = $1 WHERE id = $2',
        [isActive, adminId]
      );

      await this.logActivity(updatedBy, 'update_admin_status', 
        { target_admin_id: adminId, is_active: isActive });

      return { success: true };
    } catch (error) {
      logger.error('Error updating admin status:', error);
      return { success: false, error: 'Failed to update admin status' };
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