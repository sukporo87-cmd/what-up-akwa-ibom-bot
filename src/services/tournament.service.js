// ============================================
// FILE: src/services/tournament.service.js
// COMPLETE FILE - READY TO PASTE AND REPLACE
// CHANGES: Added platform tracking to tournament joins and payments
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class TournamentService {
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

    async joinFreeTournament(userId, tournamentId) {
        try {
            const tournament = await this.getTournamentById(tournamentId);
            if (!tournament) return { success: false, error: 'Tournament not found' };
            if (tournament.payment_type !== 'free') return { success: false, error: 'This is a paid tournament' };
            if (tournament.status !== 'active') return { success: false, error: 'Tournament is not active' };
            
            const alreadyJoined = await pool.query(
                'SELECT id FROM tournament_participants WHERE user_id = $1 AND tournament_id = $2',
                [userId, tournamentId]
            );
            if (alreadyJoined.rows.length > 0) return { success: false, error: 'Already joined' };
            
            if (tournament.max_participants && tournament.participant_count >= tournament.max_participants) {
                return { success: false, error: 'Tournament is full' };
            }
            
            const userResult = await pool.query('SELECT phone_number FROM users WHERE id = $1', [userId]);
            const platform = userResult.rows[0].phone_number.startsWith('tg_') ? 'telegram' : 'whatsapp';
            
            const tokensRemaining = tournament.uses_tokens ? tournament.tokens_per_entry : null;
            
            const result = await pool.query(`
                INSERT INTO tournament_participants 
                    (tournament_id, user_id, entry_paid, tokens_remaining, can_play, platform)
                VALUES ($1, $2, true, $3, true, $4)
                RETURNING *
            `, [tournamentId, userId, tokensRemaining, platform]);
            
            logger.info(`User ${userId} (${platform}) joined free tournament ${tournamentId}`);
            return { success: true, participant: result.rows[0], tokensRemaining };
        } catch (error) {
            logger.error('Error joining free tournament:', error);
            return { success: false, error: error.message };
        }
    }

    async initializeTournamentPayment(userId, tournamentId) {
        const PaymentService = require('./payment.service');
        const paymentService = new PaymentService();
        
        try {
            const tournament = await this.getTournamentById(tournamentId);
            if (!tournament) throw new Error('Tournament not found');
            if (tournament.payment_type !== 'paid') throw new Error('This is a free tournament');
            
            const existingPayment = await pool.query(`
                SELECT * FROM tournament_entry_payments 
                WHERE user_id = $1 AND tournament_id = $2 
                AND payment_status = 'success'
                AND payment_reference LIKE 'TRN-%'
            `, [userId, tournamentId]);
            
            if (existingPayment.rows.length > 0) throw new Error('Already paid for this tournament');
            
            const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
            const user = userResult.rows[0];
            const platform = user.phone_number.startsWith('tg_') ? 'telegram' : 'whatsapp';
            const reference = `TRN-${tournamentId}-${userId}-${Date.now()}`;
            
            const payment = await paymentService.paystack.transaction.initialize({
                email: `${user.phone_number}@whatsuptrivia.com`,
                amount: tournament.entry_fee * 100,
                reference: reference,
                callback_url: `${process.env.APP_URL}/payment/tournament-callback`,
                metadata: {
                    user_id: userId,
                    tournament_id: tournamentId,
                    tournament_name: tournament.tournament_name,
                    entry_fee: tournament.entry_fee,
                    user_name: user.full_name,
                    user_phone: user.phone_number,
                    platform: platform,
                    custom_fields: [
                        { display_name: "Tournament", variable_name: "tournament", value: tournament.tournament_name },
                        { display_name: "User", variable_name: "user", value: user.full_name },
                        { display_name: "Platform", variable_name: "platform", value: platform }
                    ]
                }
            });
            
            await pool.query(`
                INSERT INTO tournament_entry_payments 
                    (tournament_id, user_id, amount, payment_reference, payment_status, platform)
                VALUES ($1, $2, $3, $4, 'pending', $5)
                ON CONFLICT (payment_reference) DO NOTHING
            `, [tournamentId, userId, tournament.entry_fee, reference, platform]);
            
            logger.info(`Tournament payment initialized (${platform}): ${reference}`);
            
            return {
                success: true,
                authorization_url: payment.data.authorization_url,
                access_code: payment.data.access_code,
                reference: reference,
                amount: tournament.entry_fee,
                platform: platform
            };
        } catch (error) {
            logger.error('Error initializing tournament payment:', error);
            throw error;
        }
    }

    async verifyTournamentPayment(reference) {
        const PaymentService = require('./payment.service');
        const paymentService = new PaymentService();
        
        try {
            const axios = require('axios');
            
            const existing = await pool.query(
                'SELECT * FROM tournament_entry_payments WHERE payment_reference = $1',
                [reference]
            );
            
            if (existing.rows.length === 0) throw new Error('Payment not found');
            
            const payment = existing.rows[0];
            
            if (payment.payment_status === 'success') {
                logger.info(`Tournament payment already verified: ${reference}`);
                return { success: true, payment };
            }
            
            const response = await axios.get(
                `https://api.paystack.co/transaction/verify/${reference}`,
                { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
            );
            
            if (response.data.status !== true || response.data.data.status !== 'success') {
                throw new Error('Payment verification failed');
            }
            
            const paymentData = response.data.data;
            
            await pool.query(`
                UPDATE tournament_entry_payments
                SET payment_status = 'success',
                    paystack_reference = $1,
                    payment_method = $2,
                    paid_at = NOW()
                WHERE payment_reference = $3
            `, [paymentData.reference, paymentData.channel, reference]);
            
            const platform = paymentData.metadata.platform || payment.platform || 'whatsapp';
            const isRebuy = reference.startsWith('TRNR-');
            
            if (isRebuy) {
                const tokensToAdd = paymentData.metadata.tokens_to_add || tournament.tokens_per_entry;
                const rebuyResult = await this.processRebuyTokens(payment.tournament_id, payment.user_id, tokensToAdd);
                
                logger.info(`Tournament rebuy verified (${platform}): ${reference} - User ${payment.user_id} got ${tokensToAdd} tokens`);
                
                return {
                    success: true, payment, tokensRemaining: rebuyResult.tokensRemaining,
                    platform, isRebuy: true, tokensAdded: tokensToAdd
                };
            }
            
            const tournament = await this.getTournamentById(payment.tournament_id);
            const tokensRemaining = tournament.uses_tokens ? tournament.tokens_per_entry : null;
            
            await pool.query(`
                INSERT INTO tournament_participants 
                    (tournament_id, user_id, entry_paid, entry_fee_paid, tokens_remaining, can_play, platform)
                VALUES ($1, $2, true, $3, $4, true, $5)
                ON CONFLICT (tournament_id, user_id) 
                DO UPDATE SET 
                    entry_paid = true, entry_fee_paid = EXCLUDED.entry_fee_paid,
                    tokens_remaining = EXCLUDED.tokens_remaining, can_play = true,
                    platform = EXCLUDED.platform
            `, [payment.tournament_id, payment.user_id, payment.amount, tokensRemaining, platform]);
            
            logger.info(`Tournament payment verified (${platform}): ${reference} - User ${payment.user_id} can now play`);
            return { success: true, payment, tokensRemaining, platform };
        } catch (error) {
            logger.error('Error verifying tournament payment:', error);
            await pool.query(
                'UPDATE tournament_entry_payments SET payment_status = $1 WHERE payment_reference = $2',
                ['failed', reference]
            );
            throw error;
        }
    }

    async initializeRebuyPayment(userId, tournamentId) {
        const PaymentService = require('./payment.service');
        const paymentService = new PaymentService();
        
        try {
            const tournament = await this.getTournamentById(tournamentId);
            if (!tournament) throw new Error('Tournament not found');
            if (tournament.status !== 'active') throw new Error('Tournament is no longer active');
            if (!tournament.uses_tokens) throw new Error('This tournament has unlimited plays');
            
            const status = await this.getUserTournamentStatus(userId, tournamentId);
            if (!status || !status.entry_paid) throw new Error('You must join the tournament first');
            
            const user = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
            const userData = user.rows[0];
            const platform = userData.phone_number.startsWith('tg_') ? 'telegram' : 'whatsapp';
            
            const rebuyPrice = tournament.entry_fee;
            const reference = `TRNR-${tournamentId}-${userId}-${Date.now()}`;
            
            const payment = await paymentService.paystack.transaction.initialize({
                email: `${userData.phone_number}@whatsuptrivia.com`,
                amount: rebuyPrice * 100,
                reference: reference,
                callback_url: `${process.env.APP_URL}/payment/tournament-callback`,
                metadata: {
                    user_id: userId, tournament_id: tournamentId,
                    tournament_name: tournament.tournament_name,
                    entry_fee: rebuyPrice, is_rebuy: true,
                    tokens_to_add: tournament.tokens_per_entry,
                    user_name: userData.full_name, user_phone: userData.phone_number,
                    platform: platform,
                    custom_fields: [
                        { display_name: "Tournament", variable_name: "tournament", value: tournament.tournament_name },
                        { display_name: "Type", variable_name: "type", value: "Token Rebuy" },
                        { display_name: "Platform", variable_name: "platform", value: platform }
                    ]
                }
            });
            
            await pool.query(`
                INSERT INTO tournament_entry_payments 
                    (tournament_id, user_id, amount, payment_reference, payment_status, platform)
                VALUES ($1, $2, $3, $4, 'pending', $5)
            `, [tournamentId, userId, rebuyPrice, reference, platform]);
            
            logger.info(`Tournament rebuy payment initialized (${platform}): ${reference}`);
            
            return {
                success: true, authorization_url: payment.data.authorization_url,
                reference: reference, amount: rebuyPrice,
                tokensToAdd: tournament.tokens_per_entry, platform: platform
            };
        } catch (error) {
            logger.error('Error initializing rebuy payment:', error);
            throw error;
        }
    }

    async processRebuyTokens(tournamentId, userId, tokensToAdd) {
        try {
            const result = await pool.query(`
                UPDATE tournament_participants
                SET tokens_remaining = tokens_remaining + $1, can_play = true
                WHERE user_id = $2 AND tournament_id = $3
                RETURNING tokens_remaining
            `, [tokensToAdd, userId, tournamentId]);
            
            if (result.rows.length === 0) throw new Error('Participant not found');
            
            logger.info(`Rebuy processed: User ${userId} got ${tokensToAdd} tokens for tournament ${tournamentId}. New total: ${result.rows[0].tokens_remaining}`);
            return { success: true, tokensRemaining: result.rows[0].tokens_remaining };
        } catch (error) {
            logger.error('Error processing rebuy tokens:', error);
            throw error;
        }
    }

    async recordTournamentGame(userId, tournamentId, gameSessionId, score, questionsAnswered) {
        try {
            await pool.query(`
                INSERT INTO tournament_game_sessions 
                    (tournament_id, user_id, game_session_id, score, questions_answered, completed, token_deducted)
                VALUES ($1, $2, $3, $4, $5, true, true)
            `, [tournamentId, userId, gameSessionId, score, questionsAnswered]);
            
            await pool.query(`
                UPDATE tournament_participants
                SET best_score = GREATEST(best_score, $1),
                    total_score = total_score + $1,
                    games_played = games_played + 1
                WHERE user_id = $2 AND tournament_id = $3
            `, [score, userId, tournamentId]);
            
            await this.updateTournamentRankings(tournamentId);
            logger.info(`Tournament game recorded: User ${userId}, Tournament ${tournamentId}, Score ${score}`);
            return { success: true };
        } catch (error) {
            logger.error('Error recording tournament game:', error);
            return { success: false };
        }
    }

    async updateParticipantScore(userId, tournamentId, score, questionsAnswered = 0, timeTaken = 999) {
        try {
            const current = await pool.query(
                'SELECT best_questions_answered, best_time_taken FROM tournament_participants WHERE user_id = $1 AND tournament_id = $2',
                [userId, tournamentId]
            );
            
            const currentBest = current.rows[0] || { best_questions_answered: 0, best_time_taken: 999 };
            
            let isNewBest = false;
            if (questionsAnswered > (currentBest.best_questions_answered || 0)) {
                isNewBest = true;
            } else if (questionsAnswered === (currentBest.best_questions_answered || 0) && timeTaken < (currentBest.best_time_taken || 999)) {
                isNewBest = true;
            }
            
            let result;
            if (isNewBest) {
                result = await pool.query(
                    `UPDATE tournament_participants
                     SET games_played = games_played + 1, best_score = $1,
                         best_questions_answered = $2, best_time_taken = $3,
                         total_score = total_score + $1, last_played_at = NOW()
                     WHERE user_id = $4 AND tournament_id = $5
                     RETURNING *`,
                    [score, questionsAnswered, timeTaken, userId, tournamentId]
                );
            } else {
                result = await pool.query(
                    `UPDATE tournament_participants
                     SET games_played = games_played + 1, total_score = total_score + $1, last_played_at = NOW()
                     WHERE user_id = $2 AND tournament_id = $3
                     RETURNING *`,
                    [score, userId, tournamentId]
                );
            }

            if (result.rows.length > 0) {
                await this.updateTournamentRankings(tournamentId);
                logger.info(`Updated tournament score for user ${userId}: Q${questionsAnswered} in ${timeTaken.toFixed(1)}s (best: ${isNewBest})`);
            }
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error updating participant score:', error);
            return null;
        }
    }

    async updateTournamentRankings(tournamentId) {
        try {
            await pool.query(`
                WITH ranked_participants AS (
                    SELECT id,
                        ROW_NUMBER() OVER (
                            ORDER BY COALESCE(best_questions_answered, 0) DESC,
                                COALESCE(best_time_taken, 999) ASC, joined_at ASC
                        ) as new_rank
                    FROM tournament_participants WHERE tournament_id = $1
                )
                UPDATE tournament_participants tp
                SET rank = rp.new_rank
                FROM ranked_participants rp WHERE tp.id = rp.id
            `, [tournamentId]);
            logger.info(`Rankings updated for tournament ${tournamentId}`);
        } catch (error) {
            logger.error('Error updating tournament rankings:', error);
        }
    }

    async getTournamentLeaderboard(tournamentId, limit = 50) {
        try {
            const result = await pool.query(`
                SELECT tp.rank, tp.best_score, tp.games_played, tp.prize_won,
                    u.username, u.full_name, u.city
                FROM tournament_participants tp
                JOIN users u ON tp.user_id = u.id
                WHERE tp.tournament_id = $1
                ORDER BY tp.rank ASC LIMIT $2
            `, [tournamentId, limit]);
            return result.rows;
        } catch (error) {
            logger.error('Error getting tournament leaderboard:', error);
            return [];
        }
    }

    async getUserTournaments(userId) {
        try {
            const result = await pool.query(
                `SELECT t.*, tp.rank, tp.best_score, tp.games_played, tp.prize_won, tp.entry_paid
                 FROM tournament_participants tp
                 JOIN tournaments t ON tp.tournament_id = t.id
                 WHERE tp.user_id = $1 ORDER BY t.end_date DESC LIMIT 10`,
                [userId]
            );
            return result.rows;
        } catch (error) {
            logger.error('Error getting user tournaments:', error);
            return [];
        }
    }

    async getTournamentInstructions(tournamentId) {
        try {
            const result = await pool.query(`
                SELECT t.custom_instructions, t.custom_branding, ti.*
                FROM tournaments t
                LEFT JOIN tournament_instructions ti ON t.id = ti.tournament_id
                WHERE t.id = $1
            `, [tournamentId]);
            
            if (result.rows.length === 0) return null;
            const data = result.rows[0];
            
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

    async createTournament(tournamentData) {
        try {
            const { tournamentName, tournamentType, sponsorName, sponsorLogoUrl,
                description, entryFee, prizePool, maxParticipants,
                startDate, endDate, questionsCategory, difficultyRange, totalQuestions
            } = tournamentData;

            const result = await pool.query(
                `INSERT INTO tournaments (
                  tournament_name, tournament_type, sponsor_name, sponsor_logo_url,
                  description, entry_fee, prize_pool, max_participants,
                  start_date, end_date, questions_category, difficulty_range, total_questions
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                 RETURNING *`,
                [ tournamentName, tournamentType, sponsorName, sponsorLogoUrl,
                    description, entryFee, prizePool, maxParticipants,
                    startDate, endDate, questionsCategory, difficultyRange, totalQuestions || 15 ]
            );
            logger.info(`Tournament created: ${result.rows[0].id} - ${tournamentName}`);
            return { success: true, tournament: result.rows[0] };
        } catch (error) {
            logger.error('Error creating tournament:', error);
            return { success: false, error: error.message };
        }
    }

    async endTournament(tournamentId, options = {}) {
        const { preview = false, customDistribution = null, notifyWinners = true } = options;
        
        try {
            const tournament = await this.getTournamentById(tournamentId);
            if (!tournament) return { success: false, error: 'Tournament not found' };
            if (tournament.status === 'completed') return { success: false, error: 'Tournament already completed' };

            await this.updateTournamentRankings(tournamentId);

            const leaderboardResult = await pool.query(`
                SELECT 
                    tp.user_id, tp.rank, tp.best_score,
                    COALESCE(tp.best_questions_answered, 0) as questions_answered,
                    COALESCE(tp.best_time_taken, 999) as time_taken,
                    tp.games_played, tp.total_score,
                    u.username, u.full_name, u.phone_number,
                    CASE WHEN u.phone_number LIKE 'tg_%' THEN 'telegram' ELSE 'whatsapp' END as platform
                FROM tournament_participants tp
                JOIN users u ON tp.user_id = u.id
                WHERE tp.tournament_id = $1
                  AND (tp.best_questions_answered > 0 OR tp.best_score > 0 OR tp.games_played > 0)
                ORDER BY 
                    COALESCE(tp.best_questions_answered, 0) DESC,
                    COALESCE(tp.best_time_taken, 999) ASC,
                    tp.joined_at ASC
                LIMIT 20
            `, [tournamentId]);

            const leaderboard = leaderboardResult.rows;
            
            if (leaderboard.length === 0) {
                if (preview) {
                    return { success: true, preview: true, message: 'Tournament has no qualifying participants',
                        winners: [], totalPrizePool: tournament.prize_pool, distributed: 0 };
                }
                await pool.query('UPDATE tournaments SET status = $1, completed_at = NOW() WHERE id = $2', ['completed', tournamentId]);
                return { success: true, message: 'Tournament ended with no participants', winnersCount: 0 };
            }

            // Prize distribution: use customDistribution param > DB prize_structure > hardcoded default
            const defaultDistribution = [0.40, 0.20, 0.15, 0.10, 0.05, 0.03, 0.03, 0.02, 0.01, 0.01];
            let prizeDistribution = customDistribution || null;

            // If no custom distribution passed, check DB for prize_structure
            if (!prizeDistribution) {
                try {
                    const instrResult = await pool.query(
                        'SELECT prize_structure FROM tournament_instructions WHERE tournament_id = $1',
                        [tournamentId]
                    );
                    const prizeStructure = instrResult.rows[0]?.prize_structure;
                    if (prizeStructure && Array.isArray(prizeStructure) && prizeStructure.length > 0) {
                        prizeDistribution = prizeStructure
                            .sort((a, b) => a.position - b.position)
                            .map(p => {
                                if (p.percentage) return parseFloat(p.percentage) / 100;
                                if (p.amount && tournament.prize_pool) return p.amount / tournament.prize_pool;
                                return 0;
                            });
                        logger.info(`Using DB prize_structure for tournament ${tournamentId}: ${prizeDistribution.join(', ')}`);
                    }
                } catch (e) {
                    logger.error('Error reading prize_structure from DB, using default:', e.message);
                }
            }

            if (!prizeDistribution) prizeDistribution = defaultDistribution;
            
            const prizePool = tournament.prize_pool || 0;
            const winners = [];
            let totalDistributed = 0;

            for (let i = 0; i < Math.min(leaderboard.length, prizeDistribution.length); i++) {
                const participant = leaderboard[i];
                const prizePercentage = prizeDistribution[i] || 0;
                const prize = Math.floor(prizePool * prizePercentage);
                
                if (prize > 0) {
                    winners.push({
                        rank: i + 1, userId: participant.user_id,
                        username: participant.username, fullName: participant.full_name,
                        phoneNumber: participant.phone_number, platform: participant.platform,
                        questionsAnswered: participant.questions_answered,
                        timeTaken: parseFloat(participant.time_taken).toFixed(1),
                        gamesPlayed: participant.games_played, bestScore: participant.best_score,
                        prize: prize, percentage: (prizePercentage * 100).toFixed(1) + '%'
                    });
                    totalDistributed += prize;
                }
            }

            if (preview) {
                return {
                    success: true, preview: true,
                    tournament: { id: tournament.id, name: tournament.tournament_name,
                        prizePool: prizePool, participantCount: leaderboard.length, status: tournament.status },
                    winners: winners, totalDistributed: totalDistributed,
                    remaining: prizePool - totalDistributed,
                    message: `Preview: ${winners.length} winners will receive ₦${totalDistributed.toLocaleString()} total`
                };
            }

            const distributionResults = [];
            
            for (const winner of winners) {
                try {
                    await pool.query(
                        `UPDATE tournament_participants SET prize_won = $1 WHERE tournament_id = $2 AND user_id = $3`,
                        [winner.prize, tournamentId, winner.userId]
                    );

                    const txResult = await pool.query(`
                        INSERT INTO transactions (user_id, amount, transaction_type, payment_status, description, created_at)
                        VALUES ($1, $2, 'tournament_prize', 'pending', $3, NOW())
                        RETURNING id
                    `, [winner.userId, winner.prize,
                        `Tournament Prize: ${tournament.tournament_name} - Rank #${winner.rank}`]);

                    distributionResults.push({
                        userId: winner.userId, rank: winner.rank,
                        prize: winner.prize, transactionId: txResult.rows[0]?.id, status: 'success'
                    });
                    logger.info(`🏆 Tournament prize distributed: User ${winner.userId} (Rank #${winner.rank}) - ₦${winner.prize}`);
                } catch (distError) {
                    logger.error(`Error distributing prize to user ${winner.userId}:`, distError);
                    distributionResults.push({
                        userId: winner.userId, rank: winner.rank,
                        prize: winner.prize, status: 'failed', error: distError.message
                    });
                }
            }

            await pool.query(
                `UPDATE tournaments SET status = 'completed', completed_at = NOW(), actual_prize_distributed = $1 WHERE id = $2`,
                [totalDistributed, tournamentId]
            );

            if (notifyWinners) {
                await this.notifyTournamentWinners(tournament, winners);
            }

            logger.info(`🏆 Tournament ${tournamentId} (${tournament.tournament_name}) completed!`);
            logger.info(`   Total prize pool: ₦${prizePool.toLocaleString()}`);
            logger.info(`   Distributed: ₦${totalDistributed.toLocaleString()} to ${winners.length} winners`);

            return { 
                success: true, 
                message: `Tournament ended successfully. ${winners.length} winners received ₦${totalDistributed.toLocaleString()}`,
                winnersCount: winners.length, totalDistributed: totalDistributed,
                winners: winners, distributionResults: distributionResults
            };
        } catch (error) {
            logger.error('Error ending tournament:', error);
            return { success: false, error: error.message };
        }
    }

    async notifyTournamentWinners(tournament, winners) {
        const MessagingService = require('./messaging.service');
        const messagingService = new MessagingService();
        
        for (const winner of winners) {
            try {
                const message = this.formatWinnerNotification(tournament, winner);
                const userResult = await pool.query('SELECT phone_number FROM users WHERE id = $1', [winner.userId]);
                if (userResult.rows.length > 0) {
                    await messagingService.sendMessage(userResult.rows[0].phone_number, message);
                    logger.info(`Winner notification sent to user ${winner.userId} (Rank #${winner.rank})`);
                }
            } catch (notifyError) {
                logger.error(`Error notifying winner ${winner.userId}:`, notifyError);
            }
        }
    }

    formatWinnerNotification(tournament, winner) {
        const rankEmojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
        const rankEmoji = rankEmojis[winner.rank - 1] || '🏆';
        
        let message = `${rankEmoji} *CONGRATULATIONS!* ${rankEmoji}\n\n`;
        message += `You finished *#${winner.rank}* in the tournament:\n`;
        message += `*${tournament.tournament_name}*\n\n`;
        message += `📊 *Your Performance:*\n`;
        message += `• Questions Reached: Q${winner.questionsAnswered}\n`;
        message += `• Best Time: ${winner.timeTaken}s\n`;
        message += `• Games Played: ${winner.gamesPlayed}\n\n`;
        message += `💰 *Your Prize: ₦${winner.prize.toLocaleString()}*\n\n`;
        message += `Your winnings will be added to your payout balance.\n`;
        message += `Type WITHDRAW to cash out!\n\n`;
        message += `Thank you for playing What's Up Trivia! 🎮`;
        
        return message;
    }

    async getTournamentPrizePreview(tournamentId, customDistribution = null) {
        return await this.endTournament(tournamentId, { preview: true, customDistribution });
    }

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