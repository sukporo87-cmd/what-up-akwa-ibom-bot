// ============================================
// FILE: src/services/promo-code.service.js
// Manage promo codes for free tournament entry
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class PromoCodeService {

    /**
     * Validate a code for a specific user + tournament.
     * Returns { valid: bool, reason?: string, code?: object }
     * Does NOT redeem — just checks if redemption would succeed.
     */
    async validateCode(rawCode, userId, tournamentId) {
        try {
            const code = (rawCode || '').trim().toUpperCase();
            if (!code) return { valid: false, reason: 'Empty code' };

            const r = await pool.query(`
                SELECT * FROM promo_codes WHERE code = $1
            `, [code]);

            if (r.rows.length === 0) {
                return { valid: false, reason: 'Code not found' };
            }

            const promo = r.rows[0];

            if (!promo.is_active) {
                return { valid: false, reason: 'Code is deactivated' };
            }

            if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
                return { valid: false, reason: 'Code has expired' };
            }

            if (promo.tournament_id && promo.tournament_id !== tournamentId) {
                return { valid: false, reason: 'Code is not valid for this tournament' };
            }

            if (promo.max_redemptions !== null && promo.redemption_count >= promo.max_redemptions) {
                return { valid: false, reason: 'Code redemption limit reached' };
            }

            // Per-user limit
            const userUses = await pool.query(`
                SELECT COUNT(*) as count FROM promo_code_redemptions
                WHERE promo_code_id = $1 AND user_id = $2
            `, [promo.id, userId]);
            
            if (parseInt(userUses.rows[0].count) >= promo.max_per_user) {
                return { valid: false, reason: 'You have already used this code' };
            }

            // Check if user is already paid into this tournament
            const existing = await pool.query(`
                SELECT id FROM tournament_entry_payments
                WHERE user_id = $1 AND tournament_id = $2 AND payment_status = 'success'
                AND payment_reference LIKE 'TRN-%'
            `, [userId, tournamentId]);

            if (existing.rows.length > 0) {
                return { valid: false, reason: 'You are already registered for this tournament' };
            }

            return { valid: true, code: promo };
        } catch (error) {
            logger.error('Error validating promo code:', error);
            return { valid: false, reason: 'Error validating code' };
        }
    }

    /**
     * Redeem a code: grant tournament entry as if the user had paid.
     * Returns { success: bool, tokensRemaining: number|null, reason?: string }
     */
    async redeemCode(rawCode, userId, tournamentId) {
        const TournamentService = require('./tournament.service');
        const tournamentService = new TournamentService();
        
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Re-validate inside transaction with row lock
            const codeUpper = (rawCode || '').trim().toUpperCase();
            const lockResult = await client.query(`
                SELECT * FROM promo_codes WHERE code = $1 FOR UPDATE
            `, [codeUpper]);

            if (lockResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return { success: false, reason: 'Code not found' };
            }

            const promo = lockResult.rows[0];

            // Final validation (locked)
            if (!promo.is_active) {
                await client.query('ROLLBACK');
                return { success: false, reason: 'Code is deactivated' };
            }
            if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
                await client.query('ROLLBACK');
                return { success: false, reason: 'Code has expired' };
            }
            if (promo.tournament_id && promo.tournament_id !== tournamentId) {
                await client.query('ROLLBACK');
                return { success: false, reason: 'Code is not valid for this tournament' };
            }
            if (promo.max_redemptions !== null && promo.redemption_count >= promo.max_redemptions) {
                await client.query('ROLLBACK');
                return { success: false, reason: 'Code redemption limit reached' };
            }
            const userUses = await client.query(`
                SELECT COUNT(*) as count FROM promo_code_redemptions
                WHERE promo_code_id = $1 AND user_id = $2
            `, [promo.id, userId]);
            if (parseInt(userUses.rows[0].count) >= promo.max_per_user) {
                await client.query('ROLLBACK');
                return { success: false, reason: 'You have already used this code' };
            }

            // Get tournament details
            const tournamentResult = await client.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
            if (tournamentResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return { success: false, reason: 'Tournament not found' };
            }
            const tournament = tournamentResult.rows[0];

            // Get user platform
            const userResult = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
            if (userResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return { success: false, reason: 'User not found' };
            }
            const user = userResult.rows[0];
            const platform = user.phone_number.startsWith('tg_') ? 'telegram' : 'whatsapp';
            
            // Create a synthetic payment record so the tournament treats this like a regular entry
            const reference = `PROMO-${promo.id}-${tournamentId}-${userId}-${Date.now()}`;
            await client.query(`
                INSERT INTO tournament_entry_payments
                    (tournament_id, user_id, amount, payment_reference, payment_status, platform, gateway_used, paid_at)
                VALUES ($1, $2, 0, $3, 'success', $4, 'promo', NOW())
            `, [tournamentId, userId, reference, platform]);

            // Create the participant record with the same logic as paid entry
            const tokensRemaining = tournament.uses_tokens ? tournament.tokens_per_entry : null;
            await client.query(`
                INSERT INTO tournament_participants
                    (tournament_id, user_id, entry_paid, entry_fee_paid, tokens_remaining, can_play, platform)
                VALUES ($1, $2, true, 0, $3, true, $4)
                ON CONFLICT (tournament_id, user_id)
                DO UPDATE SET
                    entry_paid = true,
                    entry_fee_paid = 0,
                    tokens_remaining = EXCLUDED.tokens_remaining,
                    can_play = true,
                    platform = EXCLUDED.platform
            `, [tournamentId, userId, tokensRemaining, platform]);

            // Record the redemption
            await client.query(`
                INSERT INTO promo_code_redemptions (promo_code_id, user_id, tournament_id)
                VALUES ($1, $2, $3)
            `, [promo.id, userId, tournamentId]);

            // Increment the code's usage counter
            await client.query(`
                UPDATE promo_codes SET redemption_count = redemption_count + 1, updated_at = NOW()
                WHERE id = $1
            `, [promo.id]);

            await client.query('COMMIT');
            
            logger.info(`🎟️ Promo code ${codeUpper} redeemed by user ${userId} for tournament ${tournamentId}`);

            return {
                success: true,
                tokensRemaining,
                tournament,
                code: promo
            };
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error('Error redeeming promo code:', error);
            return { success: false, reason: 'Error redeeming code' };
        } finally {
            client.release();
        }
    }

    // ============================================
    // ADMIN OPERATIONS
    // ============================================

    async createCode({ code, description, tournament_id, max_redemptions, max_per_user, expires_at, admin_id }) {
        try {
            const codeUpper = code.trim().toUpperCase();
            if (!/^[A-Z0-9_-]{3,50}$/.test(codeUpper)) {
                throw new Error('Code must be 3-50 chars, letters/numbers/underscore/hyphen only');
            }
            
            const result = await pool.query(`
                INSERT INTO promo_codes 
                    (code, description, tournament_id, max_redemptions, max_per_user, expires_at, created_by_admin_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *
            `, [
                codeUpper, 
                description || '', 
                tournament_id || null, 
                max_redemptions || null, 
                max_per_user || 1, 
                expires_at || null, 
                admin_id || null
            ]);
            
            logger.info(`Promo code created: ${codeUpper} by admin ${admin_id}`);
            return result.rows[0];
        } catch (error) {
            if (error.code === '23505') {
                throw new Error('A code with that name already exists');
            }
            logger.error('Error creating promo code:', error);
            throw error;
        }
    }

    async listCodes() {
        try {
            const result = await pool.query(`
                SELECT pc.*, t.tournament_name, a.username as created_by
                FROM promo_codes pc
                LEFT JOIN tournaments t ON pc.tournament_id = t.id
                LEFT JOIN admins a ON pc.created_by_admin_id = a.id
                ORDER BY pc.created_at DESC
            `);
            return result.rows;
        } catch (error) {
            logger.error('Error listing promo codes:', error);
            return [];
        }
    }

    async toggleCode(codeId, isActive) {
        try {
            await pool.query(`
                UPDATE promo_codes SET is_active = $1, updated_at = NOW() WHERE id = $2
            `, [isActive, codeId]);
            return true;
        } catch (error) {
            logger.error('Error toggling promo code:', error);
            throw error;
        }
    }

    async deleteCode(codeId) {
        try {
            // Only allow delete if no redemptions yet
            const r = await pool.query('SELECT redemption_count FROM promo_codes WHERE id = $1', [codeId]);
            if (r.rows.length === 0) throw new Error('Code not found');
            if (r.rows[0].redemption_count > 0) {
                throw new Error('Cannot delete a code that has been redeemed. Deactivate it instead.');
            }
            await pool.query('DELETE FROM promo_codes WHERE id = $1', [codeId]);
            return true;
        } catch (error) {
            logger.error('Error deleting promo code:', error);
            throw error;
        }
    }

    async getRedemptions(codeId) {
        try {
            const result = await pool.query(`
                SELECT pcr.*, u.username, u.full_name, u.phone_number, t.tournament_name
                FROM promo_code_redemptions pcr
                JOIN users u ON pcr.user_id = u.id
                JOIN tournaments t ON pcr.tournament_id = t.id
                WHERE pcr.promo_code_id = $1
                ORDER BY pcr.redeemed_at DESC
            `, [codeId]);
            return result.rows;
        } catch (error) {
            logger.error('Error getting redemptions:', error);
            return [];
        }
    }
}

module.exports = new PromoCodeService();