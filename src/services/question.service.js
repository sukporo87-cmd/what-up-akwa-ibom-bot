const pool = require('../config/database');
const { logger } = require('../utils/logger');

class QuestionService {
  async getQuestionByDifficulty(difficulty, excludeIds = []) {
    try {
      let minDifficulty, maxDifficulty;
      
      // Questions 1-5: Easy (difficulty 1-5)
      if (difficulty >= 1 && difficulty <= 5) {
        minDifficulty = 1;
        maxDifficulty = 7;  // Include some medium for variety
      }
      // Questions 6-10: Medium (difficulty 6-10)
      else if (difficulty >= 6 && difficulty <= 10) {
        minDifficulty = 6;
        maxDifficulty = 12;  // Include some hard for variety
      }
      // Questions 11-15: Hard (difficulty 11-15)
      else if (difficulty >= 11 && difficulty <= 15) {
        minDifficulty = 11;
        maxDifficulty = 15;
      }
      else {
        // Fallback for any unexpected difficulty values
        minDifficulty = 1;
        maxDifficulty = 15;
      }

      // Build query with exclusion of already-asked questions
      let result;
      
      if (excludeIds.length > 0) {
        // Query with exclusions
        const placeholders = excludeIds.map((_, i) => `$${i + 3}`).join(',');
        const query = `SELECT * FROM questions 
                       WHERE difficulty BETWEEN $1 AND $2 
                       AND is_active = true
                       AND id NOT IN (${placeholders})
                       ORDER BY RANDOM() 
                       LIMIT 1`;
        const params = [minDifficulty, maxDifficulty, ...excludeIds];
        result = await pool.query(query, params);
      } else {
        // Query without exclusions (first question)
        const query = `SELECT * FROM questions 
                       WHERE difficulty BETWEEN $1 AND $2 
                       AND is_active = true
                       ORDER BY RANDOM() 
                       LIMIT 1`;
        result = await pool.query(query, [minDifficulty, maxDifficulty]);
      }

      // If no question found in the difficulty range, try any active question as fallback
      if (!result.rows[0]) {
        logger.warn(`No questions found for difficulty range ${minDifficulty}-${maxDifficulty}, trying fallback`);
        
        let fallbackResult;
        
        if (excludeIds.length > 0) {
          const placeholders = excludeIds.map((_, i) => `$${i + 1}`).join(',');
          const fallbackQuery = `SELECT * FROM questions 
                                 WHERE is_active = true
                                 AND id NOT IN (${placeholders})
                                 ORDER BY RANDOM() 
                                 LIMIT 1`;
          fallbackResult = await pool.query(fallbackQuery, excludeIds);
        } else {
          const fallbackQuery = `SELECT * FROM questions 
                                 WHERE is_active = true
                                 ORDER BY RANDOM() 
                                 LIMIT 1`;
          fallbackResult = await pool.query(fallbackQuery);
        }
        
        return fallbackResult.rows[0] || null;
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
}

module.exports = QuestionService;