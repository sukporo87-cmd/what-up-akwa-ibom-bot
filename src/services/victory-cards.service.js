// ============================================
// FILE: src/services/victory-cards.service.js
// Handles: Victory card generation, tracking, admin regeneration
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class VictoryCardsService {
    
    // ============================================
    // CREATE VICTORY CARD RECORD
    // ============================================
    
    async createVictoryCardRecord(userId, transactionId, gameSessionId, winData) {
        try {
            const result = await pool.query(`
                INSERT INTO victory_cards (user_id, transaction_id, game_session_id, amount, questions_answered, total_questions, card_data)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id
            `, [
                userId,
                transactionId,
                gameSessionId,
                winData.amount,
                winData.questionsAnswered,
                winData.totalQuestions || 15,
                JSON.stringify(winData)
            ]);
            
            logger.info(`Victory card record created: ${result.rows[0].id} for user ${userId}`);
            return result.rows[0].id;
        } catch (error) {
            logger.error('Error creating victory card record:', error);
            return null;
        }
    }
    
    // ============================================
    // MARK CARD AS SHARED
    // ============================================
    
    async markCardAsShared(transactionId) {
        try {
            await pool.query(`
                UPDATE transactions 
                SET victory_card_shared = true, victory_card_shared_at = NOW()
                WHERE id = $1
            `, [transactionId]);
            
            await pool.query(`
                UPDATE victory_cards 
                SET created_at = NOW()
                WHERE transaction_id = $1
            `, [transactionId]);
            
            logger.info(`Victory card marked as shared for transaction ${transactionId}`);
            return true;
        } catch (error) {
            logger.error('Error marking card as shared:', error);
            return false;
        }
    }
    
    // ============================================
    // MARK ALL PENDING CARDS AS SHARED FOR USER
    // ============================================
    
    async markAllCardsAsShared(userId) {
        try {
            const result = await pool.query(`
                UPDATE transactions 
                SET victory_card_shared = true, victory_card_shared_at = NOW()
                WHERE user_id = $1
                AND transaction_type IN ('prize', 'challenge_prize')
                AND amount > 0
                AND (victory_card_shared = false OR victory_card_shared IS NULL)
                RETURNING id
            `, [userId]);
            
            const count = result.rowCount;
            if (count > 0) {
                logger.info(`Marked ${count} victory card(s) as shared for user ${userId}`);
            }
            
            return count;
        } catch (error) {
            logger.error('Error marking all cards as shared:', error);
            return 0;
        }
    }
    
    // ============================================
    // CHECK IF VICTORY CARD SHARED
    // ============================================
    
    async isVictoryCardShared(transactionId) {
        try {
            const result = await pool.query(
                'SELECT victory_card_shared FROM transactions WHERE id = $1',
                [transactionId]
            );
            
            return result.rows[0]?.victory_card_shared === true;
        } catch (error) {
            logger.error('Error checking victory card status:', error);
            return true; // Default to true to not block in case of error
        }
    }
    
    // ============================================
    // GET PENDING VICTORY CARDS (not shared)
    // ============================================
    
    async getPendingVictoryCard(userId) {
        try {
            const result = await pool.query(`
                SELECT t.id, t.amount, t.created_at, t.win_data, t.transaction_type,
                       vc.questions_answered, vc.card_data
                FROM transactions t
                LEFT JOIN victory_cards vc ON t.id = vc.transaction_id
                WHERE t.user_id = $1 
                -- CLASSIC WINS ONLY.
                --
                -- A challenge produces and sends its OWN result card the
                -- moment the match ends, to every player. Gating a challenge
                -- prize on a separate Classic-style victory card asked the
                -- winner to share a second card for the same win — and the
                -- share flow could not even build one, because it looks up a
                -- Classic session that a challenge round does not leave
                -- behind. The result was a claim button that led to "Card is
                -- taking a while" and no way through.
                --
                -- Challenge prizes stay ungated for that reason.
                --
                -- TOURNAMENT PRIZES ARE GATED, but only while still
                -- claimable. A tournament winner plays many games, and the
                -- one card they never got was the card for the game that
                -- actually won: every post-game card is the game just
                -- played. Gating the claim means the winner is asked for
                -- the right card at the one moment it matters. The extra
                -- conditions keep every tournament prize already claimed
                -- (details given, approved, paid, cancelled) out of the
                -- gate, so no past winner is stopped for a card on money
                -- that is already settled.
                AND (
                      t.transaction_type = 'prize'
                   OR (t.transaction_type = 'tournament_prize'
                       AND COALESCE(t.payout_status, 'pending') = 'pending'
                       AND t.confirmed_at IS NULL
                       AND NOT EXISTS (SELECT 1 FROM payout_details pd
                                       WHERE pd.transaction_id = t.id))
                )
                AND t.amount > 0
                AND (t.victory_card_shared = false OR t.victory_card_shared IS NULL)
                ORDER BY t.created_at DESC
                LIMIT 1
            `, [userId]);
            
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting pending victory card:', error);
            return null;
        }
    }
    
    // ============================================
    // CHECK IF USER CAN CLAIM (must share card first)
    // ============================================
    
    async canUserClaim(userId) {
        try {
            // Check if there are any unshared victory cards
            const pendingCard = await this.getPendingVictoryCard(userId);
            
            if (pendingCard) {
                return {
                    canClaim: false,
                    reason: 'victory_card_required',
                    transaction: pendingCard
                };
            }
            
            return { canClaim: true };
        } catch (error) {
            logger.error('Error checking if user can claim:', error);
            return { canClaim: true }; // Default to allow in case of error
        }
    }
    
    getVictoryCardRequiredMessage(transactionAmount) {
        return `🎴 *VICTORY CARD REQUIRED* 🎴\n\n` +
               `Congratulations on winning ₦${transactionAmount.toLocaleString()}! 🎉\n\n` +
               `Before you can claim your prize, please share your victory card.\n\n` +
               `This helps us celebrate winners and promotes the game! 📣\n\n` +
               `Reply *SHARE* or *4* to generate and share your victory card.\n\n` +
               `_After sharing, you can claim your prize._`;
    }
    
    // ============================================
    // GET WIN DATA FOR SHARE (from transaction)
    // ============================================
    
    async getWinDataForShare(userId) {
        try {
            // The card asked for must be the card for the win the gate is
            // holding. If that is a tournament prize, it is drawn from the
            // tournament's own record of the player's best game — the game
            // that earned the placing — never from whichever game was last.
            const gated = await this.getPendingVictoryCard(userId);
            if (gated && gated.transaction_type === 'tournament_prize') {
                return await this.getTournamentPrizeWinData(gated.id);
            }

            // Get the pending (unshared) transaction
            const result = await pool.query(`
                SELECT t.id, t.amount, t.win_data, t.created_at,
                       gs.current_question, gs.game_mode
                FROM transactions t
                LEFT JOIN game_sessions gs ON t.user_id = gs.user_id 
                    AND DATE(gs.completed_at) = DATE(t.created_at)
                    AND gs.current_score = t.amount
                WHERE t.user_id = $1 
                AND t.transaction_type = 'prize'
                AND t.amount > 0
                AND (t.victory_card_shared = false OR t.victory_card_shared IS NULL)
                ORDER BY t.created_at DESC
                LIMIT 1
            `, [userId]);
            
            if (result.rows.length === 0) {
                return null;
            }
            
            const tx = result.rows[0];
            
            // Try to get from win_data first, then calculate
            let questionsAnswered = 15;
            if (tx.win_data) {
                const winData = typeof tx.win_data === 'string' ? JSON.parse(tx.win_data) : tx.win_data;
                questionsAnswered = winData.questionsAnswered || tx.current_question || this.estimateQuestionsFromAmount(tx.amount);
            } else if (tx.current_question) {
                questionsAnswered = tx.current_question - 1;
            } else {
                questionsAnswered = this.estimateQuestionsFromAmount(tx.amount);
            }
            
            return {
                amount: parseFloat(tx.amount),
                questionsAnswered: questionsAnswered,
                totalQuestions: 15,
                transactionId: tx.id
            };
        } catch (error) {
            logger.error('Error getting win data for share:', error);
            return null;
        }
    }
    
    estimateQuestionsFromAmount(amount) {
        const amt = parseFloat(amount);
        const prizeTiers = {
            50000: 15, 35000: 14, 25000: 13, 20000: 12, 15000: 11,
            10000: 10, 7500: 9, 5000: 8, 3000: 7, 2000: 6, 1000: 5
        };
        return prizeTiers[amt] || Math.min(Math.floor(amt / 3000) + 5, 15);
    }

    // ============================================
    // TOURNAMENT PRIZE → CARD DATA (the winning game)
    // ============================================
    // tournament_participants.best_* are written together, from one game,
    // only when that game beats the player's previous best (see
    // tournament.service updateParticipantScore). They are therefore the
    // winning session itself, and they are exactly what the settlement
    // ranked on. The placing is read from the prize row's own description,
    // which the settlement wrote ("... - Rank #2"), so the card states the
    // place that was paid; the live rank column is the fallback.
    async getTournamentPrizeWinData(transactionId) {
        try {
            const r = await pool.query(`
                SELECT t.id, t.amount, t.description, t.tournament_id,
                       tr.tournament_name,
                       tp.rank, tp.best_questions_answered, tp.best_time_taken
                FROM transactions t
                LEFT JOIN tournaments tr ON tr.id = t.tournament_id
                LEFT JOIN tournament_participants tp
                       ON tp.tournament_id = t.tournament_id AND tp.user_id = t.user_id
                WHERE t.id = $1 AND t.transaction_type = 'tournament_prize'
            `, [transactionId]);
            const row = r.rows[0];
            if (!row) return null;

            const m = /Rank #(\d+)/.exec(row.description || '');
            const rank = m ? parseInt(m[1], 10) : (parseInt(row.rank, 10) || null);
            const secs = Number(row.best_time_taken);

            return {
                isTournament: true,
                isTournamentPrize: true,
                transactionId: row.id,
                tournamentId: row.tournament_id,
                tournamentName: row.tournament_name || 'Tournament',
                rank,
                rankPrize: Number(row.amount) || 0,
                amount: Number(row.amount) || 0,
                questionsAnswered: parseInt(row.best_questions_answered, 10) || 0,
                // 999 is the column's "never finished" default, not a time.
                timeTaken: (secs > 0 && secs < 999) ? secs.toFixed(1) : '0',
                totalQuestions: 15
            };
        } catch (error) {
            logger.error('Error building tournament prize card data:', error);
            return null;
        }
    }
    
    // ============================================
    // GET VICTORY CARD DATA FOR REGENERATION
    // ============================================
    
    async getVictoryCardData(victoryCardId) {
        try {
            const result = await pool.query(`
                SELECT vc.*, u.username, u.full_name, u.city,
                       t.created_at as win_date
                FROM victory_cards vc
                JOIN users u ON vc.user_id = u.id
                JOIN transactions t ON vc.transaction_id = t.id
                WHERE vc.id = $1
            `, [victoryCardId]);
            
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting victory card data:', error);
            return null;
        }
    }
    
    async getVictoryCardByTransaction(transactionId) {
        try {
            const result = await pool.query(`
                SELECT vc.*, u.username, u.full_name, u.city,
                       t.created_at as win_date
                FROM victory_cards vc
                JOIN users u ON vc.user_id = u.id
                JOIN transactions t ON vc.transaction_id = t.id
                WHERE vc.transaction_id = $1
            `, [transactionId]);
            
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting victory card by transaction:', error);
            return null;
        }
    }
    
    // ============================================
    // GET ALL VICTORY CARDS (for admin)
    // ============================================
    
    async getAllVictoryCards(options = {}) {
        try {
            const { limit = 50, offset = 0, userId = null, minAmount = null, dateFrom = null, dateTo = null } = options;
            
            let query = `
                SELECT vc.*, u.username, u.full_name, u.city, u.phone_number,
                       t.created_at as win_date, t.victory_card_shared
                FROM victory_cards vc
                JOIN users u ON vc.user_id = u.id
                JOIN transactions t ON vc.transaction_id = t.id
                WHERE 1=1
            `;
            const params = [];
            let paramIndex = 1;
            
            if (userId) {
                query += ` AND vc.user_id = $${paramIndex}`;
                params.push(userId);
                paramIndex++;
            }
            
            if (minAmount) {
                query += ` AND vc.amount >= $${paramIndex}`;
                params.push(minAmount);
                paramIndex++;
            }
            
            if (dateFrom) {
                query += ` AND t.created_at >= $${paramIndex}`;
                params.push(dateFrom);
                paramIndex++;
            }
            
            if (dateTo) {
                query += ` AND t.created_at <= $${paramIndex}`;
                params.push(dateTo);
                paramIndex++;
            }
            
            query += ` ORDER BY t.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);
            
            const result = await pool.query(query, params);
            return result.rows;
        } catch (error) {
            logger.error('Error getting all victory cards:', error);
            return [];
        }
    }
    
    // ============================================
    // LOG ADMIN REGENERATION
    // ============================================
    
    async logAdminRegeneration(victoryCardId, adminId) {
        try {
            await pool.query(`
                UPDATE victory_cards 
                SET regenerated_at = NOW(), regenerated_by = $1
                WHERE id = $2
            `, [adminId, victoryCardId]);
            
            logger.info(`Victory card ${victoryCardId} regenerated by admin ${adminId}`);
            return true;
        } catch (error) {
            logger.error('Error logging admin regeneration:', error);
            return false;
        }
    }
    
    // ============================================
    // GET RECENT WINNERS (for admin dashboard)
    // ============================================
    
    async getRecentWinners(limit = 20) {
        try {
            const result = await pool.query(`
                SELECT 
                    t.id as transaction_id,
                    t.amount,
                    t.created_at as win_date,
                    t.victory_card_shared,
                    u.id as user_id,
                    u.username,
                    u.full_name,
                    u.city,
                    u.phone_number,
                    vc.id as victory_card_id,
                    vc.questions_answered,
                    gs.game_mode,
                    gs.tournament_id
                FROM transactions t
                JOIN users u ON t.user_id = u.id
                LEFT JOIN victory_cards vc ON t.id = vc.transaction_id
                LEFT JOIN game_sessions gs ON u.id = gs.user_id 
                    AND DATE(gs.completed_at) = DATE(t.created_at)
                    AND gs.current_score = t.amount
                WHERE t.transaction_type = 'prize'
                AND t.amount > 0
                ORDER BY t.created_at DESC
                LIMIT $1
            `, [limit]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting recent winners:', error);
            return [];
        }
    }
    
    // ============================================
    // STORE WIN DATA IN TRANSACTION
    // ============================================
    
    async storeWinData(transactionId, winData) {
        try {
            await pool.query(`
                UPDATE transactions 
                SET win_data = $1, victory_card_shared = false
                WHERE id = $2
            `, [JSON.stringify(winData), transactionId]);
            
            return true;
        } catch (error) {
            logger.error('Error storing win data:', error);
            return false;
        }
    }
    
    // ============================================
    // GET WIN STATISTICS
    // ============================================
    
    async getWinStatistics(period = 'today') {
        try {
            let dateCondition = 'DATE(created_at) = CURRENT_DATE';
            
            switch (period) {
                case 'week':
                    dateCondition = "created_at >= CURRENT_DATE - INTERVAL '7 days'";
                    break;
                case 'month':
                    dateCondition = "created_at >= CURRENT_DATE - INTERVAL '30 days'";
                    break;
                case 'all':
                    dateCondition = '1=1';
                    break;
            }
            
            const result = await pool.query(`
                SELECT 
                    COUNT(*) as total_wins,
                    COUNT(DISTINCT user_id) as unique_winners,
                    SUM(amount) as total_amount,
                    AVG(amount) as avg_amount,
                    MAX(amount) as max_amount,
                    COUNT(*) FILTER (WHERE victory_card_shared = true) as cards_shared,
                    COUNT(*) FILTER (WHERE victory_card_shared = false OR victory_card_shared IS NULL) as cards_pending
                FROM transactions
                -- Every kind of win, so these totals agree with the winners
                -- list below them. Counting only 'prize' meant the cards said
                -- "today's wins" while ignoring every tournament and challenge
                -- prize on the same page.
                WHERE transaction_type IN ('prize', 'tournament_prize', 'challenge_prize')
                AND amount > 0
                -- A cancelled payout is not a win: the money was never paid
                -- and never will be.
                AND COALESCE(payout_status, 'pending') <> 'cancelled'
                AND ${dateCondition}
            `);
            
            return result.rows[0];
        } catch (error) {
            logger.error('Error getting win statistics:', error);
            return null;
        }
    }
}

module.exports = new VictoryCardsService();