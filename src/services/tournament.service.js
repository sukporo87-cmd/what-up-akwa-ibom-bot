// ============================================
// FILE: src/services/tournament.service.js
// COMPLETE: Tournament Service with Payment Integration
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class TournamentService {
    /**
     * Get all active tournaments with payment info
     */
    async getActiveTournaments() {
        try {
            const result = await pool.query(`
                SELECT 
                    t.*,
                    COUNT(DISTINCT tp.user_id) as participant_count,
                    COUNT(DISTINCT tep.user_id) FILTER (WHERE tep.payment_status = 'success') as paid_entries
                FROM tournaments t
                LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
                LEFT JOIN tournament_entry_payments tep ON t.id = tep.tournament_id
                WHERE t.status = 'active'
                    AND t.start_date <= NOW()
                    AND t.end_date > NOW()
                GROUP BY t.id
                ORDER BY 
                    CASE t.payment_type WHEN 'free' THEN 0 ELSE 1 END,
                    t.prize_pool DESC
            `);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting active tournaments:', error);
            return [];
        }
    }

    /**
     * Get upcoming tournaments
     */
    async getUpcomingTournaments() {
        try {
            const result = await pool.query(
                `SELECT * FROM tournaments
                 WHERE status = 'upcoming'
                 AND start_date > NOW()
                 ORDER BY start_date ASC
                 LIMIT 5`
            );

            return result.rows;
        } catch (error) {
            logger.error('Error getting upcoming tournaments:', error);
            return [];
        }
    }

    /**
     * Get tournament by ID with full details
     */
    async getTournamentById(tournamentId) {
        try {
            const result = await pool.query(`
                SELECT 
                    t.*,
                    COUNT(DISTINCT tp.user_id) as participant_count,
                    COUNT(DISTINCT tep.user_id) FILTER (WHERE tep.payment_status = 'success') as paid_entries,
                    ti.welcome_message,
                    ti.instructions,
                    ti.prize_structure,
                    ti.sponsor_branding,
                    ti.rules
                FROM tournaments t
                LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
                LEFT JOIN tournament_entry_payments tep ON t.id = tep.tournament_id
                LEFT JOIN tournament_instructions ti ON t.id = ti.tournament_id
                WHERE t.id = $1
                GROUP BY t.id, ti.id
            `, [tournamentId]);
            
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting tournament by ID:', error);
            return null;
        }
    }

    /**
     * Check if user is in a tournament
     */
    async isUserInTournament(userId, tournamentId) {
        try {
            const result = await pool.query(
                'SELECT id FROM tournament_participants WHERE user_id = $1 AND tournament_id = $2',
                [userId, tournamentId]
            );

            return result.rows.length > 0;
        } catch (error) {
            logger.error('Error checking tournament participation:', error);
            return false;
        }
    }

    /**
     * Check if user can play in tournament
     */
    async canUserPlay(userId, tournamentId) {
        try {
            const result = await pool.query(
                'SELECT can_user_play_tournament($1, $2) as can_play',
                [userId, tournamentId]
            );
            
            return result.rows[0]?.can_play || false;
        } catch (error) {
            logger.error('Error checking user play eligibility:', error);
            return false;
        }
    }

    /**
     * Get user's tournament status
     */
    async getUserTournamentStatus(userId, tournamentId) {
        try {
            const result = await pool.query(`
                SELECT 
                    tp.*,
                    t.payment_type,
                    t.uses_tokens,
                    t.unlimited_plays,
                    t.tokens_per_entry,
                    tep.payment_status,
                    tep.paid_at
                FROM tournament_participants tp
                JOIN tournaments t ON tp.tournament_id = t.id
                LEFT JOIN tournament_entry_payments tep 
                    ON tp.tournament_id = tep.tournament_id 
                    AND tp.user_id = tep.user_id
                WHERE tp.user_id = $1 AND tp.tournament_id = $2
            `, [userId, tournamentId]);
            
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting user tournament status:', error);
            return null;
        }
    }

    /**
     * Join tournament (FREE)
     */
    async joinFreeTournament(userId, tournamentId) {
        try {
            const tournament = await this.getTournamentById(tournamentId);
            
            if (!tournament) {
                return { success: false, error: 'Tournament not found' };
            }
            
            if (tournament.payment_type !== 'free') {
                return { success: false, error: 'This is a paid tournament' };
            }
            
            if (tournament.status !== 'active') {
                return { success: false, error: 'Tournament is not active' };
            }
            
            // Check if already joined
            const alreadyJoined = await pool.query(
                'SELECT id FROM tournament_participants WHERE user_id = $1 AND tournament_id = $2',
                [userId, tournamentId]
            );
            
            if (alreadyJoined.rows.length > 0) {
                return { success: false, error: 'Already joined' };
            }
            
            // Check max participants
            if (tournament.max_participants && 
                tournament.participant_count >= tournament.max_participants) {
                return { success: false, error: 'Tournament is full' };
            }
            
            // Join tournament
            const tokensRemaining = tournament.uses_tokens ? tournament.tokens_per_entry : null;
            
            const result = await pool.query(`
                INSERT INTO tournament_participants 
                    (tournament_id, user_id, entry_paid, tokens_remaining, can_play)
                VALUES ($1, $2, true, $3, true)
                RETURNING *
            `, [tournamentId, userId, tokensRemaining]);
            
            logger.info(`User ${userId} joined free tournament ${tournamentId}`);
            
            return { 
                success: true, 
                participant: result.rows[0],
                tokensRemaining
            };
        } catch (error) {
            logger.error('Error joining free tournament:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Initialize payment for paid tournament
     */
    async initializeTournamentPayment(userId, tournamentId) {
        const PaymentService = require('./payment.service');
        const paymentService = new PaymentService();
        
        try {
            const tournament = await this.getTournamentById(tournamentId);
            
            if (!tournament) {
                throw new Error('Tournament not found');
            }
            
            if (tournament.payment_type !== 'paid') {
                throw new Error('This is a free tournament');
            }
            
            // Check if already paid
            const existingPayment = await pool.query(`
                SELECT * FROM tournament_entry_payments 
                WHERE user_id = $1 AND tournament_id = $2 
                AND payment_status = 'success'
            `, [userId, tournamentId]);
            
            if (existingPayment.rows.length > 0) {
                throw new Error('Already paid for this tournament');
            }
            
            // Get user info
            const userResult = await pool.query(
                'SELECT * FROM users WHERE id = $1',
                [userId]
            );
            
            const user = userResult.rows[0];
            
            // Generate payment reference
            const reference = `TRN-${tournamentId}-${userId}-${Date.now()}`;
            
            // Initialize Paystack payment
            const payment = await paymentService.paystack.transaction.initialize({
                email: `${user.phone_number}@whatsuptrivia.com`,
                amount: tournament.entry_fee * 100, // Convert to kobo
                reference: reference,
                callback_url: `${process.env.APP_URL}/payment/tournament-callback`,
                metadata: {
                    user_id: userId,
                    tournament_id: tournamentId,
                    tournament_name: tournament.tournament_name,
                    entry_fee: tournament.entry_fee,
                    user_name: user.full_name,
                    user_phone: user.phone_number,
                    custom_fields: [
                        { display_name: "Tournament", variable_name: "tournament", value: tournament.tournament_name },
                        { display_name: "User", variable_name: "user", value: user.full_name }
                    ]
                }
            });
            
            // Save payment record
            await pool.query(`
                INSERT INTO tournament_entry_payments 
                    (tournament_id, user_id, amount, payment_reference, payment_status)
                VALUES ($1, $2, $3, $4, 'pending')
                ON CONFLICT (tournament_id, user_id) 
                DO UPDATE SET 
                    payment_reference = EXCLUDED.payment_reference,
                    payment_status = 'pending'
            `, [tournamentId, userId, tournament.entry_fee, reference]);
            
            logger.info(`Tournament payment initialized: ${reference}`);
            
            return {
                success: true,
                authorization_url: payment.data.authorization_url,
                access_code: payment.data.access_code,
                reference: reference,
                amount: tournament.entry_fee
            };
        } catch (error) {
            logger.error('Error initializing tournament payment:', error);
            throw error;
        }
    }

    /**
     * Verify tournament payment
     */
    async verifyTournamentPayment(reference) {
        const PaymentService = require('./payment.service');
        const paymentService = new PaymentService();
        
        try {
            const axios = require('axios');
            
            // Check if already verified
            const existing = await pool.query(
                'SELECT * FROM tournament_entry_payments WHERE payment_reference = $1',
                [reference]
            );
            
            if (existing.rows.length === 0) {
                throw new Error('Payment not found');
            }
            
            const payment = existing.rows[0];
            
            if (payment.payment_status === 'success') {
                logger.info(`Tournament payment already verified: ${reference}`);
                return { success: true, payment };
            }
            
            // Verify with Paystack
            const response = await axios.get(
                `https://api.paystack.co/transaction/verify/${reference}`,
                {
                    headers: {
                        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
                    }
                }
            );
            
            if (response.data.status !== true || response.data.data.status !== 'success') {
                throw new Error('Payment verification failed');
            }
            
            const paymentData = response.data.data;
            
            // Update payment status
            await pool.query(`
                UPDATE tournament_entry_payments
                SET payment_status = 'success',
                    paystack_reference = $1,
                    payment_method = $2,
                    paid_at = NOW()
                WHERE payment_reference = $3
            `, [paymentData.reference, paymentData.channel, reference]);
            
            // Add user to tournament participants
            const tournament = await this.getTournamentById(payment.tournament_id);
            const tokensRemaining = tournament.uses_tokens ? tournament.tokens_per_entry : null;
            
            await pool.query(`
                INSERT INTO tournament_participants 
                    (tournament_id, user_id, entry_paid, entry_fee_paid, tokens_remaining, can_play)
                VALUES ($1, $2, true, $3, $4, true)
                ON CONFLICT (tournament_id, user_id) 
                DO UPDATE SET 
                    entry_paid = true,
                    entry_fee_paid = EXCLUDED.entry_fee_paid,
                    tokens_remaining = EXCLUDED.tokens_remaining,
                    can_play = true
            `, [payment.tournament_id, payment.user_id, payment.amount, tokensRemaining]);
            
            logger.info(`Tournament payment verified: ${reference} - User ${payment.user_id} can now play`);
            
            return {
                success: true,
                payment,
                tokensRemaining
            };
        } catch (error) {
            logger.error('Error verifying tournament payment:', error);
            
            // Mark as failed
            await pool.query(
                'UPDATE tournament_entry_payments SET payment_status = $1 WHERE payment_reference = $2',
                ['failed', reference]
            );
            
            throw error;
        }
    }

    /**
     * Record tournament game played
     */
    async recordTournamentGame(userId, tournamentId, gameSessionId, score, questionsAnswered) {
        try {
            // Insert tournament game session record
            await pool.query(`
                INSERT INTO tournament_game_sessions 
                    (tournament_id, user_id, game_session_id, score, questions_answered, completed, token_deducted)
                VALUES ($1, $2, $3, $4, $5, true, true)
            `, [tournamentId, userId, gameSessionId, score, questionsAnswered]);
            
            // Update participant's best score
            await pool.query(`
                UPDATE tournament_participants
                SET best_score = GREATEST(best_score, $1),
                    total_score = total_score + $1,
                    games_played = games_played + 1
                WHERE user_id = $2 AND tournament_id = $3
            `, [score, userId, tournamentId]);
            
            // Update rankings
            await this.updateTournamentRankings(tournamentId);
            
            logger.info(`Tournament game recorded: User ${userId}, Tournament ${tournamentId}, Score ${score}`);
            
            return { success: true };
        } catch (error) {
            logger.error('Error recording tournament game:', error);
            return { success: false };
        }
    }

    /**
     * Update tournament participant score
     */
    async updateParticipantScore(userId, tournamentId, score) {
        try {
            const result = await pool.query(
                `UPDATE tournament_participants
                 SET games_played = games_played + 1,
                     best_score = GREATEST(best_score, $1),
                     total_score = total_score + $1
                 WHERE user_id = $2 AND tournament_id = $3
                 RETURNING *`,
                [score, userId, tournamentId]
            );

            if (result.rows.length > 0) {
                // Recalculate rankings
                await this.updateTournamentRankings(tournamentId);
                logger.info(`Updated tournament score for user ${userId}: ${score}`);
            }

            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error updating participant score:', error);
            return null;
        }
    }

    /**
     * Update tournament rankings
     */
    async updateTournamentRankings(tournamentId) {
        try {
            await pool.query(`
                WITH ranked_participants AS (
                    SELECT 
                        id,
                        ROW_NUMBER() OVER (ORDER BY best_score DESC, joined_at ASC) as new_rank
                    FROM tournament_participants
                    WHERE tournament_id = $1
                )
                UPDATE tournament_participants tp
                SET rank = rp.new_rank
                FROM ranked_participants rp
                WHERE tp.id = rp.id
            `, [tournamentId]);
            
            logger.info(`Rankings updated for tournament ${tournamentId}`);
        } catch (error) {
            logger.error('Error updating tournament rankings:', error);
        }
    }

    /**
     * Get tournament leaderboard
     */
    async getTournamentLeaderboard(tournamentId, limit = 50) {
        try {
            const result = await pool.query(`
                SELECT 
                    tp.rank,
                    tp.best_score,
                    tp.games_played,
                    tp.prize_won,
                    u.username,
                    u.full_name,
                    u.city
                FROM tournament_participants tp
                JOIN users u ON tp.user_id = u.id
                WHERE tp.tournament_id = $1
                ORDER BY tp.rank ASC
                LIMIT $2
            `, [tournamentId, limit]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting tournament leaderboard:', error);
            return [];
        }
    }

    /**
     * Get user's tournaments
     */
    async getUserTournaments(userId) {
        try {
            const result = await pool.query(
                `SELECT 
                  t.*,
                  tp.rank,
                  tp.best_score,
                  tp.games_played,
                  tp.prize_won,
                  tp.entry_paid
                 FROM tournament_participants tp
                 JOIN tournaments t ON tp.tournament_id = t.id
                 WHERE tp.user_id = $1
                 ORDER BY t.end_date DESC
                 LIMIT 10`,
                [userId]
            );

            return result.rows;
        } catch (error) {
            logger.error('Error getting user tournaments:', error);
            return [];
        }
    }

    /**
     * Get custom tournament instructions
     */
    async getTournamentInstructions(tournamentId) {
        try {
            const result = await pool.query(`
                SELECT 
                    t.custom_instructions,
                    t.custom_branding,
                    ti.*
                FROM tournaments t
                LEFT JOIN tournament_instructions ti ON t.id = ti.tournament_id
                WHERE t.id = $1
            `, [tournamentId]);
            
            if (result.rows.length === 0) {
                return null;
            }
            
            const data = result.rows[0];
            
            // Return custom instructions if available, otherwise use default format
            if (data.custom_instructions) {
                return {
                    instructions: data.custom_instructions,
                    branding: data.custom_branding || 'Proudly brought to you by SummerIsland Systems'
                };
            }
            
            return {
                instructions: data.instructions,
                branding: data.sponsor_branding || data.custom_branding || 'Proudly brought to you by SummerIsland Systems',
                welcomeMessage: data.welcome_message,
                prizeStructure: data.prize_structure,
                rules: data.rules
            };
        } catch (error) {
            logger.error('Error getting tournament instructions:', error);
            return null;
        }
    }

    /**
     * Create a new tournament (Admin only)
     */
    async createTournament(tournamentData) {
        try {
            const {
                tournamentName,
                tournamentType,
                sponsorName,
                sponsorLogoUrl,
                description,
                entryFee,
                prizePool,
                maxParticipants,
                startDate,
                endDate,
                questionsCategory,
                difficultyRange,
                totalQuestions
            } = tournamentData;

            const result = await pool.query(
                `INSERT INTO tournaments (
                  tournament_name, tournament_type, sponsor_name, sponsor_logo_url,
                  description, entry_fee, prize_pool, max_participants,
                  start_date, end_date, questions_category, difficulty_range, total_questions
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                 RETURNING *`,
                [
                    tournamentName, tournamentType, sponsorName, sponsorLogoUrl,
                    description, entryFee, prizePool, maxParticipants,
                    startDate, endDate, questionsCategory, difficultyRange, totalQuestions || 15
                ]
            );

            logger.info(`Tournament created: ${result.rows[0].id} - ${tournamentName}`);

            return { success: true, tournament: result.rows[0] };
        } catch (error) {
            logger.error('Error creating tournament:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * End a tournament and distribute prizes
     */
    async endTournament(tournamentId) {
        try {
            const tournament = await this.getTournamentById(tournamentId);

            if (!tournament) {
                return { success: false, error: 'Tournament not found' };
            }

            // Get prize distribution (simple: top 10 split the pool)
            const leaderboard = await this.getTournamentLeaderboard(tournamentId, 10);
            
            if (leaderboard.length === 0) {
                // No participants, just mark as completed
                await pool.query(
                    'UPDATE tournaments SET status = $1 WHERE id = $2',
                    ['completed', tournamentId]
                );
                return { success: true, message: 'Tournament ended with no participants' };
            }

            // Prize distribution percentages (top 10)
            const prizeDistribution = [0.40, 0.20, 0.15, 0.10, 0.05, 0.03, 0.03, 0.02, 0.01, 0.01];
            
            for (let i = 0; i < Math.min(leaderboard.length, 10); i++) {
                const prize = Math.floor(tournament.prize_pool * prizeDistribution[i]);
                
                await pool.query(
                    `UPDATE tournament_participants
                     SET prize_won = $1
                     WHERE tournament_id = $2 AND rank = $3`,
                    [prize, tournamentId, i + 1]
                );

                // Create prize transaction
                const participant = leaderboard[i];
                await pool.query(
                    `INSERT INTO transactions (user_id, amount, transaction_type, payment_status, session_id)
                     SELECT $1, $2, 'prize', 'pending', 
                     (SELECT id FROM game_sessions WHERE user_id = $1 AND tournament_id = $3 ORDER BY completed_at DESC LIMIT 1)
                     WHERE NOT EXISTS (
                       SELECT 1 FROM transactions 
                       WHERE user_id = $1 
                       AND session_id = (SELECT id FROM game_sessions WHERE user_id = $1 AND tournament_id = $3 ORDER BY completed_at DESC LIMIT 1)
                     )`,
                    [participant.user_id, prize, tournamentId]
                );
            }

            // Mark tournament as completed
            await pool.query(
                'UPDATE tournaments SET status = $1 WHERE id = $2',
                ['completed', tournamentId]
            );

            logger.info(`Tournament ${tournamentId} ended. Prizes distributed to ${Math.min(leaderboard.length, 10)} winners.`);

            return { success: true, winnersCount: Math.min(leaderboard.length, 10) };
        } catch (error) {
            logger.error('Error ending tournament:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get tournament analytics
     */
    async getTournamentAnalytics() {
        try {
            const result = await pool.query(`
                SELECT 
                  COUNT(*) as total_tournaments,
                  COUNT(CASE WHEN status = 'active' THEN 1 END) as active_tournaments,
                  COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_tournaments,
                  SUM(prize_pool) as total_prize_pool,
                  SUM(CASE WHEN status = 'completed' THEN prize_pool ELSE 0 END) as distributed_prizes
                FROM tournaments
            `);

            return result.rows[0];
        } catch (error) {
            logger.error('Error getting tournament analytics:', error);
            throw error;
        }
    }
}

module.exports = TournamentService;