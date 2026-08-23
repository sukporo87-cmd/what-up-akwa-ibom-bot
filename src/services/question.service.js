// ============================================
// FILE: src/services/question.service.js
// UPDATED: Support for multiple question banks with STRICT practice mode
// Batch 7: Question Service
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class QuestionService {

    constructor() {
        // Resolved once from question_banks and held for the process lifetime.
        this._challengeBankId = null;
    }

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
                // ✅ UPDATED: Practice mode - ONLY use practice_mode bank (strict)
                questionBankCondition = `AND qb.bank_name = 'practice_mode'`;
                logger.info(`Practice mode: Looking for questions with difficulty ${minDifficulty}-${maxDifficulty} from practice_mode bank`);
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
            
            // If no question found, handle fallback
            if (!result.rows[0]) {
                logger.warn(`No questions found for difficulty ${minDifficulty}-${maxDifficulty} in ${gameMode} mode`);
                
                // ✅ UPDATED: For practice mode, do NOT fallback to classic
                if (gameMode === 'practice') {
                    logger.error(`Practice mode has insufficient questions for difficulty ${minDifficulty}-${maxDifficulty}. Need to add more practice questions!`);
                    
                    // Check how many practice questions exist total
                    const countResult = await pool.query(`
                        SELECT COUNT(*) as total
                        FROM questions q
                        JOIN question_banks qb ON q.question_bank_id = qb.id
                        WHERE qb.bank_name = 'practice_mode'
                        AND q.is_active = true
                    `);
                    
                    logger.error(`Total practice questions available: ${countResult.rows[0].total}`);
                    return null; // Return null instead of falling back to classic
                }
                
                // For other modes, try fallback WITH difficulty range preserved
                logger.warn(`Trying fallback for ${gameMode} mode (widening difficulty to ${Math.max(1, minDifficulty - 1)}-${Math.min(5, maxDifficulty + 1)})`);
                const fallbackMin = Math.max(1, minDifficulty - 1);
                const fallbackMax = Math.min(5, maxDifficulty + 1);
                let fallbackQuery;
                if (excludeIds.length > 0) {
                    const placeholders = excludeIds.map((_, i) => `$${i + 3}`).join(',');
                    fallbackQuery = `
                        SELECT * FROM questions
                        WHERE is_active = true
                        AND difficulty BETWEEN $1 AND $2
                        AND id NOT IN (${placeholders})
                        ORDER BY RANDOM()
                        LIMIT 1
                    `;
                    const fallbackResult = await pool.query(fallbackQuery, [fallbackMin, fallbackMax, ...excludeIds]);
                    if (fallbackResult.rows[0]) return fallbackResult.rows[0];
                    
                    // Last resort: any difficulty, still exclude asked questions
                    const lastResort = await pool.query(`
                        SELECT * FROM questions
                        WHERE is_active = true
                        AND id NOT IN (${placeholders})
                        ORDER BY RANDOM() LIMIT 1
                    `, excludeIds);
                    return lastResort.rows[0] || null;
                } else {
                    fallbackQuery = `
                        SELECT * FROM questions
                        WHERE is_active = true
                        AND difficulty BETWEEN $1 AND $2
                        ORDER BY RANDOM()
                        LIMIT 1
                    `;
                    const fallbackResult = await pool.query(fallbackQuery, [fallbackMin, fallbackMax]);
                    if (fallbackResult.rows[0]) return fallbackResult.rows[0];
                    
                    // Last resort: any difficulty
                    const lastResort = await pool.query(`
                        SELECT * FROM questions WHERE is_active = true ORDER BY RANDOM() LIMIT 1
                    `);
                    return lastResort.rows[0] || null;
                }
            }
            
            return result.rows[0];
            
        } catch (error) {
            logger.error('Error fetching question:', error);
            throw error;
        }
    }

    // ============================================
    // CHALLENGE BANK
    // ============================================
    // Resolved by NAME and cached, never hardcoded. classic_mode is 1,
    // practice_mode is 2, tournaments is 3 — so challenge_mode is probably 4,
    // and "probably" is exactly how a hardcoded id ends up serving practice
    // questions in a duel.

    async getChallengeBankId() {
        if (this._challengeBankId) return this._challengeBankId;

        const result = await pool.query(
            `SELECT id FROM question_banks WHERE bank_name = 'challenge_mode' LIMIT 1`
        );

        if (!result.rows[0]) {
            throw new Error(
                'challenge_mode question bank is missing — run migrations/014-challenge-question-bank.sql'
            );
        }

        this._challengeBankId = result.rows[0].id;
        return this._challengeBankId;
    }

    // ============================================
    // POSITION -> DIFFICULTY
    // ============================================
    // Identical to game.service.getDifficultyLevelsForQuestion(). Duplicated
    // deliberately: challenge sets are materialised once per CHALLENGE, not
    // per user, so they cannot go through the per-user rotation path — and a
    // challenge whose ladder silently diverged from Classic's would be very
    // hard to notice. There is a test asserting the two maps stay identical.
    //
    // Nine of the fifteen positions accept exactly ONE difficulty value:
    // 3, 5, 8, 10, 11, 12, 13, 14, 15. That is why a category is only as deep
    // as its thinnest difficulty level, and why getChallengeBankReadiness()
    // reports the minimum rather than the total.

    difficultiesForPosition(position) {
        const mapping = {
            1: [1, 2], 2: [2, 3], 3: [3], 4: [4, 5], 5: [5],
            6: [6, 7], 7: [7, 8], 8: [8], 9: [9, 10], 10: [10],
            11: [11], 12: [12], 13: [13], 14: [14], 15: [15]
        };
        return mapping[position] || [position];
    }

    // ============================================
    // BANK READINESS — THE LAUNCH GATE
    // ============================================
    // A category with 400 questions can still be unable to run six challenges,
    // if only five of them sit at difficulty 14. Position 14 draws from
    // difficulty 14 and nothing else, so the sixth challenge either repeats a
    // question everyone has seen or falls through to the emergency query and
    // starts serving a difficulty-9 question at position 14 — silently.
    //
    // So the number that governs launch is the THINNEST difficulty level, not
    // the total. A category holding n questions at every level 1-15 can serve
    // n challenges before anything repeats.

    async getChallengeBankReadiness(minimumPerLevel = 10) {
        const bankId = await this.getChallengeBankId();

        const result = await pool.query(`
            SELECT category,
                   MIN(n)                AS thinnest_level,
                   SUM(n)                AS total,
                   COUNT(DISTINCT difficulty) AS levels_present,
                   ARRAY_AGG(difficulty ORDER BY n, difficulty) AS levels_by_supply,
                   ARRAY_AGG(n ORDER BY n, difficulty)          AS supply_by_level
            FROM (
                SELECT LOWER(category) AS category, difficulty, COUNT(*)::int AS n
                FROM questions
                WHERE question_bank_id = $1
                  AND is_active = true
                  AND (is_disabled = false OR is_disabled IS NULL)
                GROUP BY LOWER(category), difficulty
            ) per_level
            GROUP BY category
            ORDER BY MIN(n), category
        `, [bankId]);

        return result.rows.map(row => {
            const levelsPresent = parseInt(row.levels_present, 10);
            // A MISSING level is worse than a thin one and must not be
            // reported as a thin one: MIN() over the levels that exist says
            // nothing about the level that does not.
            const missingLevels = levelsPresent < 15;
            const thinnest = missingLevels ? 0 : parseInt(row.thinnest_level, 10);

            return {
                category: row.category,
                total: parseInt(row.total, 10),
                levelsPresent,
                missingLevels,
                thinnestLevel: thinnest,
                // How many challenges this category can run before repeating.
                challengesAvailable: thinnest,
                ready: !missingLevels && thinnest >= minimumPerLevel,
                weakest: (row.levels_by_supply || []).slice(0, 3).map((d, i) => ({
                    difficulty: d,
                    count: (row.supply_by_level || [])[i]
                }))
            };
        });
    }

    // ============================================
    // MATERIALISE A CHALLENGE SET
    // ============================================
    // Fifteen distinct questions, one per position, drawn from the chosen
    // categories. Called ONCE per challenge round when the FIRST participant
    // presses START — never at creation, or the second player could read the
    // answers early — and every participant then plays the identical set.
    //
    // ONE round trip, not fifteen: candidates for all positions come back in a
    // single query and the assignment happens here. Postgres is a network hop
    // from Render.
    //
    // Positions are filled MOST-CONSTRAINED FIRST — the nine single-difficulty
    // positions before the six that accept two — so a question that could
    // serve either is not spent on the position with alternatives.
    //
    // On failure it returns a structured shortfall naming the position and the
    // difficulty it could not fill. It NEVER substitutes a question of the
    // wrong difficulty; that is the silent failure this whole design is trying
    // to avoid.

    async buildChallengeQuestionSet(categories, excludeQuestionIds = [], candidatesPerSlot = 12) {
        const bankId = await this.getChallengeBankId();
        const positions = Array.from({ length: 15 }, (_, i) => i + 1);
        // Both sides lowercased: whatever case the bank rows were written in,
        // and whatever case the caller passes.
        const chosen = [...new Set(
            (categories || []).map(c => String(c || '').trim().toLowerCase()).filter(Boolean)
        )];

        const slots = positions.map(p => ({
            position: p,
            difficulties: this.difficultiesForPosition(p)
        }));

        const slotValues = slots
            .map((s, i) => `(${s.position}, $${i + 3}::int[])`)
            .join(', ');

        const params = [
            bankId,
            chosen,
            ...slots.map(s => s.difficulties),
            excludeQuestionIds.length ? excludeQuestionIds : [0]
        ];
        const excludeParam = `$${slots.length + 3}`;

        // candidatesPerSlot is 12 rather than 8 because balancing needs room to
        // manoeuvre: with only a few candidates per position, the greedy fill
        // has no alternative to offer when a category is already at quota.
        const result = await pool.query(`
            WITH slots(position, difficulties) AS (VALUES ${slotValues}),
            ranked AS (
                SELECT s.position,
                       q.id,
                       q.difficulty,
                       -- Lowercased so the quota bookkeeping below and the
                       -- stored challenge.categories agree. Categories are
                       -- lowercased when a challenge is created; matching on
                       -- the raw column would mean a bank row saved as
                       -- "Word Power" never matches a challenge asking for
                       -- "word power", and the set would fail to build with no
                       -- obvious cause.
                       LOWER(q.category) AS category,
                       ROW_NUMBER() OVER (PARTITION BY s.position ORDER BY RANDOM()) AS rn
                FROM slots s
                JOIN questions q
                  ON q.difficulty = ANY(s.difficulties)
                 AND q.question_bank_id = $1
                 AND LOWER(q.category) = ANY($2::text[])
                 AND q.is_active = true
                 AND (q.is_disabled = false OR q.is_disabled IS NULL)
                 AND NOT (q.id = ANY(${excludeParam}::int[]))
            )
            SELECT position, id, difficulty, category
            FROM ranked
            WHERE rn <= ${parseInt(candidatesPerSlot, 10) || 12}
            ORDER BY position, rn
        `, params);

        const byPosition = new Map(positions.map(p => [p, []]));
        for (const row of result.rows) {
            byPosition.get(row.position).push({ id: row.id, category: row.category });
        }

        // ============================================
        // CATEGORY QUOTAS
        // ============================================
        // A player who picks Sports and Bible Quiz and gets fifteen Sports
        // questions has not hit a bug \u2014 the set is valid, the ladder is right,
        // every question is from a category they chose. It is still a support
        // message, and it is the kind that makes people stop trusting the
        // picker.
        //
        // 15 positions over N categories: 3 -> 5/5/5, 2 -> 8/7, 1 -> 15. The
        // remainder goes to the earliest categories, which is arbitrary but
        // stable, and the shuffle below stops it always favouring the same one.
        const perCategory = Math.floor(15 / chosen.length);
        const remainder = 15 % chosen.length;
        const shuffled = [...chosen].sort(() => Math.random() - 0.5);

        const quota = new Map();
        shuffled.forEach((cat, i) => quota.set(cat, perCategory + (i < remainder ? 1 : 0)));
        const taken = new Map(chosen.map(c => [c, 0]));

        // Most constrained first: fewest allowed difficulties, then fewest
        // candidates actually available. Nine of the fifteen positions accept
        // exactly one difficulty value, so they must be served before the six
        // that have alternatives.
        const order = [...slots].sort((a, b) => {
            const byDifficulties = a.difficulties.length - b.difficulties.length;
            if (byDifficulties !== 0) return byDifficulties;
            return byPosition.get(a.position).length - byPosition.get(b.position).length;
        });

        const used = new Set();
        const assigned = new Map();
        const shortfall = [];

        for (const slot of order) {
            const available = byPosition.get(slot.position).filter(c => !used.has(c.id));

            if (available.length === 0) {
                shortfall.push({
                    position: slot.position,
                    difficulties: slot.difficulties,
                    candidates: byPosition.get(slot.position).length
                });
                continue;
            }

            // Prefer the category furthest below its quota. This is a SOFT
            // preference, not a hard filter: if the only question available at
            // difficulty 14 belongs to a category already at quota, we take it
            // rather than failing the whole set. A slightly lopsided challenge
            // beats no challenge.
            let best = available[0];
            let bestDeficit = -Infinity;
            for (const candidate of available) {
                const deficit = (quota.get(candidate.category) || 0) - (taken.get(candidate.category) || 0);
                if (deficit > bestDeficit) { bestDeficit = deficit; best = candidate; }
            }

            used.add(best.id);
            assigned.set(slot.position, best);
            taken.set(best.category, (taken.get(best.category) || 0) + 1);
        }

        if (shortfall.length > 0) {
            logger.error(
                `Challenge set could not be built from [${chosen.join(', ')}]: ` +
                shortfall.map(s => `position ${s.position} (difficulty ${s.difficulties.join('/')})`).join(', ')
            );
            return { ok: false, shortfall, questionIds: null, mix: null };
        }

        // ============================================
        // REPAIR: every chosen category must appear at least once
        // ============================================
        // The quota above is a preference and can still be defeated by thin
        // supply at a particular difficulty. Zero questions from a category the
        // player explicitly picked is the failure that actually generates the
        // support message, so it gets one explicit repair pass: find a position
        // whose current question belongs to an OVER-represented category and
        // which has an unused alternative from the missing one, and swap.
        for (const category of chosen) {
            if ((taken.get(category) || 0) > 0) continue;

            let swapped = false;
            for (const [position, current] of assigned) {
                if ((taken.get(current.category) || 0) <= (quota.get(current.category) || 0)) continue;

                const alternative = byPosition.get(position)
                    .find(c => c.category === category && !used.has(c.id));
                if (!alternative) continue;

                used.delete(current.id);
                used.add(alternative.id);
                assigned.set(position, alternative);
                taken.set(current.category, taken.get(current.category) - 1);
                taken.set(category, 1);
                swapped = true;
                break;
            }

            // Not a failure. The set is playable and every question is from a
            // category the player chose \u2014 there simply were not enough of this
            // one at the difficulties this ladder needs. Logged so it shows up
            // as a content gap rather than a mystery.
            if (!swapped) {
                logger.warn(
                    `Challenge set from [${chosen.join(', ')}] contains no "${category}" questions \u2014 ` +
                    `supply is too thin at the required difficulties`
                );
            }
        }

        return {
            ok: true,
            shortfall: [],
            // The actual per-category counts, so the caller can log or surface
            // the mix rather than guessing at it.
            mix: Object.fromEntries(chosen.map(c => [c, taken.get(c) || 0])),
            questionIds: positions.map(p => ({
                position: p,
                questionId: assigned.get(p).id,
                category: assigned.get(p).category
            }))
        };
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

    /**
     * ✅ NEW: Get question bank statistics
     */
    async getQuestionBankStats(bankName = null) {
        try {
            let query;
            let params = [];
            
            if (bankName) {
                query = `
                    SELECT 
                        qb.bank_name,
                        qb.for_game_mode,
                        COUNT(q.id) as total_questions,
                        COUNT(q.id) FILTER (WHERE q.difficulty BETWEEN 1 AND 5) as easy_count,
                        COUNT(q.id) FILTER (WHERE q.difficulty BETWEEN 6 AND 10) as medium_count,
                        COUNT(q.id) FILTER (WHERE q.difficulty BETWEEN 11 AND 15) as hard_count,
                        COUNT(q.id) FILTER (WHERE q.is_active = true) as active_count
                    FROM question_banks qb
                    LEFT JOIN questions q ON qb.id = q.question_bank_id
                    WHERE qb.bank_name = $1
                    GROUP BY qb.id, qb.bank_name, qb.for_game_mode
                `;
                params = [bankName];
            } else {
                query = `
                    SELECT 
                        qb.bank_name,
                        qb.for_game_mode,
                        COUNT(q.id) as total_questions,
                        COUNT(q.id) FILTER (WHERE q.difficulty BETWEEN 1 AND 5) as easy_count,
                        COUNT(q.id) FILTER (WHERE q.difficulty BETWEEN 6 AND 10) as medium_count,
                        COUNT(q.id) FILTER (WHERE q.difficulty BETWEEN 11 AND 15) as hard_count,
                        COUNT(q.id) FILTER (WHERE q.is_active = true) as active_count
                    FROM question_banks qb
                    LEFT JOIN questions q ON qb.id = q.question_bank_id
                    WHERE qb.is_active = true
                    GROUP BY qb.id, qb.bank_name, qb.for_game_mode
                    ORDER BY qb.for_game_mode
                `;
            }
            
            const result = await pool.query(query, params);
            return bankName ? result.rows[0] : result.rows;
        } catch (error) {
            logger.error('Error getting question bank stats:', error);
            return null;
        }
    }

    /**
     * ✅ NEW: Validate if a game mode has enough questions for a full game
     */
    async validateGameModeQuestions(gameMode) {
        try {
            let bankName;
            
            if (gameMode === 'practice') {
                bankName = 'practice_mode';
            } else if (gameMode === 'classic') {
                bankName = 'classic_mode';
            } else if (gameMode === 'tournament') {
                bankName = 'tournaments';
            } else {
                return { valid: false, message: 'Invalid game mode' };
            }
            
            const stats = await this.getQuestionBankStats(bankName);
            
            if (!stats) {
                return { 
                    valid: false, 
                    message: `Question bank '${bankName}' not found` 
                };
            }
            
            // A full game needs at least 1 question in each difficulty range
            const issues = [];
            
            if (stats.easy_count < 1) {
                issues.push(`Need at least 1 easy question (1-7), currently have ${stats.easy_count}`);
            }
            if (stats.medium_count < 1) {
                issues.push(`Need at least 1 medium question (6-12), currently have ${stats.medium_count}`);
            }
            if (stats.hard_count < 1) {
                issues.push(`Need at least 1 hard question (11-15), currently have ${stats.hard_count}`);
            }
            
            if (issues.length > 0) {
                return {
                    valid: false,
                    message: `Insufficient questions for ${gameMode} mode`,
                    details: issues,
                    stats: stats
                };
            }
            
            return {
                valid: true,
                message: `${gameMode} mode has sufficient questions`,
                stats: stats
            };
        } catch (error) {
            logger.error('Error validating game mode questions:', error);
            return { valid: false, message: 'Validation error', error: error.message };
        }
    }
}

module.exports = QuestionService;