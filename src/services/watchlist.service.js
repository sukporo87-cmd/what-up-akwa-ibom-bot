// ============================================
// FILE: src/services/watchlist.service.js
// Fraud Watchlist - Per-user targeted anti-fraud measures
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

// Cache TTL: 5 minutes (balance freshness vs DB load)
const CACHE_TTL = 300;

class WatchlistService {

    // ============================================
    // GET WATCHLIST CONFIG FOR A USER
    // Returns null if not on watchlist, or config object
    // Cached in Redis for performance
    // ============================================

    async getUserWatchlistConfig(userId) {
        try {
            const cacheKey = `watchlist:${userId}`;
            const cached = await redis.get(cacheKey);
            if (cached) {
                const parsed = JSON.parse(cached);
                // null means "checked, not on list" — also cached
                return parsed;
            }

            const result = await pool.query(`
                SELECT * FROM fraud_watchlist 
                WHERE user_id = $1 AND is_active = true
            `, [userId]);

            if (result.rows.length === 0) {
                // Cache the miss too — prevents hammering DB
                await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(null));
                return null;
            }

            const config = result.rows[0];
            await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(config));
            return config;

        } catch (error) {
            logger.error('Error getting watchlist config:', error);
            return null;
        }
    }

    // ============================================
    // CLEAR CACHE (call after watchlist changes)
    // ============================================

    async clearCache(userId) {
        try {
            await redis.del(`watchlist:${userId}`);
        } catch (error) {
            logger.error('Error clearing watchlist cache:', error);
        }
    }

    // ============================================
    // ADD USER TO WATCHLIST
    // ============================================

    async addToWatchlist(userId, measures, adminId, reason = '') {
        try {
            // Upsert — if already exists, update measures
            const result = await pool.query(`
                INSERT INTO fraud_watchlist (user_id, measures, added_by_admin_id, reason, is_active)
                VALUES ($1, $2, $3, $4, true)
                ON CONFLICT (user_id) 
                DO UPDATE SET 
                    measures = $2, 
                    reason = $4, 
                    is_active = true,
                    updated_at = NOW()
                RETURNING *
            `, [userId, JSON.stringify(measures), adminId, reason]);

            await this.clearCache(userId);
            logger.info(`🎯 User ${userId} added to fraud watchlist by admin ${adminId}`);
            return result.rows[0];

        } catch (error) {
            logger.error('Error adding to watchlist:', error);
            throw error;
        }
    }

    // ============================================
    // REMOVE USER FROM WATCHLIST
    // ============================================

    async removeFromWatchlist(userId, adminId) {
        try {
            await pool.query(`
                UPDATE fraud_watchlist 
                SET is_active = false, removed_at = NOW(), removed_by_admin_id = $2
                WHERE user_id = $1
            `, [userId, adminId]);

            await this.clearCache(userId);
            logger.info(`✅ User ${userId} removed from fraud watchlist by admin ${adminId}`);
            return true;

        } catch (error) {
            logger.error('Error removing from watchlist:', error);
            throw error;
        }
    }

    // ============================================
    // UPDATE MEASURES FOR A USER
    // ============================================

    async updateMeasures(userId, measures, adminId) {
        try {
            const result = await pool.query(`
                UPDATE fraud_watchlist 
                SET measures = $1, updated_at = NOW()
                WHERE user_id = $2 AND is_active = true
                RETURNING *
            `, [JSON.stringify(measures), userId]);

            await this.clearCache(userId);
            return result.rows[0] || null;

        } catch (error) {
            logger.error('Error updating watchlist measures:', error);
            throw error;
        }
    }

    // ============================================
    // GET FULL WATCHLIST (admin view)
    // ============================================

    async getFullWatchlist() {
        try {
            const result = await pool.query(`
                SELECT fw.*, u.username, u.full_name, u.phone_number, u.fraud_flags,
                       u.is_suspended, a.username as admin_username
                FROM fraud_watchlist fw
                JOIN users u ON fw.user_id = u.id
                LEFT JOIN admins a ON fw.added_by_admin_id = a.id
                WHERE fw.is_active = true
                ORDER BY fw.created_at DESC
            `);

            return result.rows;

        } catch (error) {
            logger.error('Error getting full watchlist:', error);
            return [];
        }
    }

    // ============================================
    // GET WATCHLIST HISTORY (including removed)
    // ============================================

    async getWatchlistHistory(limit = 50) {
        try {
            const result = await pool.query(`
                SELECT fw.*, u.username, u.full_name, 
                       a1.username as added_by, a2.username as removed_by
                FROM fraud_watchlist fw
                JOIN users u ON fw.user_id = u.id
                LEFT JOIN admins a1 ON fw.added_by_admin_id = a1.id
                LEFT JOIN admins a2 ON fw.removed_by_admin_id = a2.id
                ORDER BY fw.created_at DESC
                LIMIT $1
            `, [limit]);

            return result.rows;

        } catch (error) {
            logger.error('Error getting watchlist history:', error);
            return [];
        }
    }

    // ============================================
    // HELPER: Get specific measure value
    // ============================================

    getMeasure(config, measureName) {
        if (!config || !config.measures) return null;
        const measures = typeof config.measures === 'string' 
            ? JSON.parse(config.measures) 
            : config.measures;
        return measures[measureName] !== undefined ? measures[measureName] : null;
    }

    isEnabled(config, measureName) {
        const value = this.getMeasure(config, measureName);
        return value === true;
    }
}

module.exports = new WatchlistService();