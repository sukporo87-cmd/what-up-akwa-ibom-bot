// src/services/question.service.js - FIXED VERSION

const pool = require('../config/database');
const logger = require('../utils/logger');

class QuestionService {
  /**
   * Get a random question by difficulty level with tournament support
   * @param {number} difficulty - The difficulty level (1-15)
   * @param {Array<number>} excludeIds - Array of question IDs to exclude
   * @param {string|null} tournamentCategory - Optional tournament category/bank
   * @returns {Promise<Object>} Question object
   */
  async getQuestionByDifficulty(difficulty, excludeIds = [], tournamentCategory = null) {
    try {
      let query;
      let params;

      // TOURNAMENT MODE: Use tournament-specific questions if category is provided
      if (tournamentCategory) {
        logger.info(`Fetching tournament question for category: ${tournamentCategory}, difficulty: ${difficulty}`);
        
        // Build exclude clause
        const excludeClause = excludeIds.length > 0 
          ? `AND id != ALL($3::int[])` 
          : '';

        query = `
          SELECT id, question_text, option_a, option_b, option_c, option_d, 
                 correct_answer, difficulty, category, fun_fact
          FROM questions
          WHERE difficulty = $1 
            AND category = $2 
            AND is_active = true
            ${excludeClause}
          ORDER BY RANDOM()
          LIMIT 1
        `;
        
        params = excludeIds.length > 0 
          ? [difficulty, tournamentCategory, excludeIds]
          : [difficulty, tournamentCategory];

        const result = await pool.query(query, params);

        // If no tournament-specific question found, try general fallback
        if (result.rows.length === 0) {
          logger.warn(`No tournament questions found for category: ${tournamentCategory}, difficulty: ${difficulty}. Trying general questions.`);
          
          // Fallback to general questions (no category filter)
          query = `
            SELECT id, question_text, option_a, option_b, option_c, option_d, 
                   correct_answer, difficulty, category, fun_fact
            FROM questions
            WHERE difficulty = $1 
              AND is_active = true
              ${excludeIds.length > 0 ? `AND id != ALL($2::int[])` : ''}
            ORDER BY RANDOM()
            LIMIT 1
          `;
          
          params = excludeIds.length > 0 ? [difficulty, excludeIds] : [difficulty];
          const fallbackResult = await pool.query(query, params);
          
          if (fallbackResult.rows.length === 0) {
            throw new Error(`No questions available for difficulty ${difficulty}`);
          }
          
          return fallbackResult.rows[0];
        }

        return result.rows[0];
      }

      // REGULAR MODE: Standard question fetching (no tournament)
      const excludeClause = excludeIds.length > 0 
        ? `AND id != ALL($2::int[])` 
        : '';

      query = `
        SELECT id, question_text, option_a, option_b, option_c, option_d, 
               correct_answer, difficulty, category, fun_fact
        FROM questions
        WHERE difficulty = $1 
          AND is_active = true
          ${excludeClause}
        ORDER BY RANDOM()
        LIMIT 1
      `;

      params = excludeIds.length > 0 ? [difficulty, excludeIds] : [difficulty];

      const result = await pool.query(query, params);

      if (result.rows.length === 0) {
        throw new Error(`No questions available for difficulty ${difficulty}`);
      }

      return result.rows[0];

    } catch (error) {
      logger.error('Error fetching question:', error);
      throw error;
    }
  }

  /**
   * Get questions for a specific difficulty range
   * Used for tournament initialization to verify question availability
   */
  async getQuestionsForDifficultyRange(minDifficulty, maxDifficulty, category = null) {
    try {
      let query;
      let params;

      if (category) {
        query = `
          SELECT COUNT(*) as count, difficulty
          FROM questions
          WHERE difficulty BETWEEN $1 AND $2
            AND category = $3
            AND is_active = true
          GROUP BY difficulty
          ORDER BY difficulty
        `;
        params = [minDifficulty, maxDifficulty, category];
      } else {
        query = `
          SELECT COUNT(*) as count, difficulty
          FROM questions
          WHERE difficulty BETWEEN $1 AND $2
            AND is_active = true
          GROUP BY difficulty
          ORDER BY difficulty
        `;
        params = [minDifficulty, maxDifficulty];
      }

      const result = await pool.query(query, params);
      return result.rows;

    } catch (error) {
      logger.error('Error checking question availability:', error);
      throw error;
    }
  }

  /**
   * Get a question by ID (for answer verification)
   */
  async getQuestionById(questionId) {
    try {
      const query = `
        SELECT id, question_text, option_a, option_b, option_c, option_d, 
               correct_answer, difficulty, category, fun_fact
        FROM questions
        WHERE id = $1 AND is_active = true
      `;

      const result = await pool.query(query, [questionId]);

      if (result.rows.length === 0) {
        throw new Error(`Question not found: ${questionId}`);
      }

      return result.rows[0];

    } catch (error) {
      logger.error('Error fetching question by ID:', error);
      throw error;
    }
  }

  /**
   * Add a new question (for admin)
   */
  async addQuestion(questionData) {
    const {
      question_text,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_answer,
      difficulty,
      category = 'General',
      fun_fact = null
    } = questionData;

    try {
      const query = `
        INSERT INTO questions 
        (question_text, option_a, option_b, option_c, option_d, correct_answer, difficulty, category, fun_fact, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
        RETURNING *
      `;

      const result = await pool.query(query, [
        question_text,
        option_a,
        option_b,
        option_c,
        option_d,
        correct_answer,
        difficulty,
        category,
        fun_fact
      ]);

      logger.info(`New question added: ID ${result.rows[0].id}`);
      return result.rows[0];

    } catch (error) {
      logger.error('Error adding question:', error);
      throw error;
    }
  }

  /**
   * Get all questions (for admin)
   */
  async getAllQuestions() {
    try {
      const query = `
        SELECT id, question_text, option_a, option_b, option_c, option_d, 
               correct_answer, difficulty, category, fun_fact, is_active, created_at
        FROM questions
        ORDER BY difficulty ASC, created_at DESC
      `;

      const result = await pool.query(query);
      return result.rows;

    } catch (error) {
      logger.error('Error fetching all questions:', error);
      throw error;
    }
  }

  /**
   * Update question (for admin)
   */
  async updateQuestion(questionId, questionData) {
    const {
      question_text,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_answer,
      difficulty,
      category,
      fun_fact,
      is_active
    } = questionData;

    try {
      const query = `
        UPDATE questions
        SET question_text = $1,
            option_a = $2,
            option_b = $3,
            option_c = $4,
            option_d = $5,
            correct_answer = $6,
            difficulty = $7,
            category = $8,
            fun_fact = $9,
            is_active = $10,
            updated_at = NOW()
        WHERE id = $11
        RETURNING *
      `;

      const result = await pool.query(query, [
        question_text,
        option_a,
        option_b,
        option_c,
        option_d,
        correct_answer,
        difficulty,
        category,
        fun_fact,
        is_active,
        questionId
      ]);

      if (result.rows.length === 0) {
        throw new Error('Question not found');
      }

      logger.info(`Question updated: ID ${questionId}`);
      return result.rows[0];

    } catch (error) {
      logger.error('Error updating question:', error);
      throw error;
    }
  }

  /**
   * Delete question (soft delete by setting is_active to false)
   */
  async deleteQuestion(questionId) {
    try {
      const query = `
        UPDATE questions
        SET is_active = false,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id
      `;

      const result = await pool.query(query, [questionId]);

      if (result.rows.length === 0) {
        throw new Error('Question not found');
      }

      logger.info(`Question deleted: ID ${questionId}`);
      return true;

    } catch (error) {
      logger.error('Error deleting question:', error);
      throw error;
    }
  }
}

module.exports =  QuestionService();