// ============================================
// FILE: src/services/question.service.js
// UPDATED: Support for multiple question banks
// Batch 7: Question Service
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class QuestionService {
    /**
     * Get question by difficulty with question bank support
     * @param {number} difficulty - Question number (1-15)
     * @param {array} excludeIds - Already asked question IDs
     * @param {string} gameMode - Game mode ('classic', 'practice', 'tournament')
     * @param {number} tournamentId - Tournament ID (if tournament game)
     */
    async getQuestionByDifficulty(difficulty, excludeIds = [], gameMode = 'classic', tournamentId = null) {
        try {
            let minDifficulty, maxDifficulty;
            
            // Questions 1-5: Easy (difficulty 1-7)
            if (difficulty >= 1 && difficulty <= 5) {
                minDifficulty = 1;
                maxDifficulty = 7;
            }
            // Questions 6-10: Medium (difficulty 6-12)
            else if (difficulty >= 6 && difficulty <= 10) {
                minDifficulty = 6;
                maxDifficulty = 12;
            }
            // Questions 11-15: Hard (difficulty 11-15)
            else if (difficulty >= 11 && difficulty <= 15) {
                minDifficulty = 11;
                maxDifficulty = 15;
            }
            else {
                minDifficulty = 1;
                maxDifficulty = 15;
            }
            
            // Determine question bank
            let questionBankCondition = '';
            let params = [minDifficulty, maxDifficulty];
            let paramIndex = 3;
            
            if (gameMode === 'practice') {
                // Practice mode - use practice bank or classic bank
                questionBankCondition = `AND (qb.bank_name = 'practice_mode' OR qb.bank_name = 'classic_mode' OR q.is_practice = true)`;
            } else if (gameMode === 'tournament' && tournamentId) {
                // Tournament mode - check if tournament has custom question bank
                const tournament = await pool.query(
                    'SELECT question_category FROM tournaments WHERE id = $1',
                    [tournamentId]
                );
                
                if (tournament.rows.length > 0 && tournament.rows[0].question_category) {
                    const category = tournament.rows[0].question_category;
                    
                    // Try to find tournament-specific bank
                    const bankCheck = await pool.query(
                        `SELECT id FROM question_banks 
                         WHERE bank_name = $1 OR for_tournament_id = $2`,
                        [category, tournamentId]
                    );
                    
                    if (bankCheck.rows.length > 0) {
                        // Use tournament-specific bank
                        questionBankCondition = `AND q.question_bank_id = $${paramIndex}`;
                        params.push(bankCheck.rows[0].id);
                        paramIndex++;
                    } else {
                        // Fallback to category matching or tournament bank
                        questionBankCondition = `AND (q.category = $${paramIndex} OR qb.bank_name = 'tournaments')`;
                        params.push(category);
                        paramIndex++;
                    }
                } else {
                    // Use general tournament question bank
                    questionBankCondition = `AND qb.bank_name = 'tournaments'`;
                }
            } else {
                // Classic mode or other modes - use classic bank
                questionBankCondition = `AND qb.bank_name = 'classic_mode'`;
            }
            
            // Build query
            let query;
            if (excludeIds.length > 0) {
                const placeholders = excludeIds.map((_, i) => `$${i + paramIndex}`).join(',');
                query = `
                    SELECT q.* 
                    FROM questions q
                    LEFT JOIN question_banks qb ON q.question_bank_id = qb.id
                    WHERE q.difficulty BETWEEN $1 AND $2
                    AND q.is_active = true
                    ${questionBankCondition}
                    AND q.id NOT IN (${placeholders})
                    ORDER BY RANDOM()
                    LIMIT 1
                `;
                params = [...params, ...excludeIds];
            } else {
                query = `
                    SELECT q.* 
                    FROM questions q
                    LEFT JOIN question_banks qb ON q.question_bank_id = qb.id
                    WHERE q.difficulty BETWEEN $1 AND $2
                    AND q.is_active = true
                    ${questionBankCondition}
                    ORDER BY RANDOM()
                    LIMIT 1
                `;
            }
            
            const result = await pool.query(query, params);
            
            // If no question found, try fallback
            if (!result.rows[0]) {
                logger.warn(`No questions found for difficulty ${minDifficulty}-${maxDifficulty} in ${gameMode} mode, trying fallback`);
                
                let fallbackQuery;
                if (excludeIds.length > 0) {
                    const placeholders = excludeIds.map((_, i) => `$${i + 3}`).join(',');
                    fallbackQuery = `
                        SELECT * FROM questions
                        WHERE is_active = true
                        AND id NOT IN (${placeholders})
                        ORDER BY RANDOM()
                        LIMIT 1
                    `;
                    const fallbackResult = await pool.query(fallbackQuery, [minDifficulty, maxDifficulty, ...excludeIds]);
                    return fallbackResult.rows[0] || null;
                } else {
                    fallbackQuery = `
                        SELECT * FROM questions
                        WHERE is_active = true
                        ORDER BY RANDOM()
                        LIMIT 1
                    `;
                    const fallbackResult = await pool.query(fallbackQuery);
                    return fallbackResult.rows[0] || null;
                }
            }
            
            return result.rows[0];
            
        } catch (error) {
            logger.error('Error fetching question:', error);
            throw error;
        }
    }

    async getQuestionById(id) {
        try {
            const result = await pool.query(
                'SELECT * FROM questions WHERE id = $1',
                [id]
            );
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error fetching question by ID:', error);
            throw error;
        }
    }

    async updateQuestionStats(questionId, wasCorrect) {
        try {
            const updateQuery = wasCorrect
                ? 'UPDATE questions SET times_asked = times_asked + 1, times_correct = times_correct + 1 WHERE id = $1'
                : 'UPDATE questions SET times_asked = times_asked + 1 WHERE id = $1';
            
            await pool.query(updateQuery, [questionId]);
        } catch (error) {
            logger.error('Error updating question stats:', error);
        }
    }

    /**
     * Get all question banks
     */
    async getQuestionBanks() {
        try {
            const result = await pool.query(`
                SELECT 
                    qb.*,
                    COUNT(q.id) as question_count
                FROM question_banks qb
                LEFT JOIN questions q ON qb.id = q.question_bank_id
                WHERE qb.is_active = true
                GROUP BY qb.id
                ORDER BY qb.for_game_mode, qb.bank_name
            `);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting question banks:', error);
            return [];
        }
    }

    /**
     * Create new question bank
     */
    async createQuestionBank(bankName, displayName, description, forGameMode, forTournamentId = null) {
        try {
            const result = await pool.query(`
                INSERT INTO question_banks 
                    (bank_name, display_name, description, for_game_mode, for_tournament_id)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `, [bankName, displayName, description, forGameMode, forTournamentId]);
            
            logger.info(`Question bank created: ${bankName}`);
            return { success: true, bank: result.rows[0] };
        } catch (error) {
            logger.error('Error creating question bank:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Assign questions to a question bank
     */
    async assignQuestionsToBank(questionIds, bankId) {
        try {
            await pool.query(
                'UPDATE questions SET question_bank_id = $1 WHERE id = ANY($2)',
                [bankId, questionIds]
            );
            
            logger.info(`Assigned ${questionIds.length} questions to bank ${bankId}`);
            return { success: true };
        } catch (error) {
            logger.error('Error assigning questions to bank:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get questions by bank
     */
    async getQuestionsByBank(bankId, limit = 100, offset = 0) {
        try {
            const result = await pool.query(`
                SELECT * FROM questions
                WHERE question_bank_id = $1
                ORDER BY difficulty ASC, id DESC
                LIMIT $2 OFFSET $3
            `, [bankId, limit, offset]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting questions by bank:', error);
            return [];
        }
    }

    /**
     * Get question count by category for a bank
     */
    async getQuestionCountByCategory(bankId) {
        try {
            const result = await pool.query(`
                SELECT 
                    category,
                    COUNT(*) as count,
                    AVG(difficulty) as avg_difficulty
                FROM questions
                WHERE question_bank_id = $1 AND is_active = true
                GROUP BY category
                ORDER BY count DESC
            `, [bankId]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting question count by category:', error);
            return [];
        }
    }
}

module.exports = QuestionService;