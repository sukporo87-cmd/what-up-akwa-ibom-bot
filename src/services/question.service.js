const pool = require('../config/database');
const { logger } = require('../utils/logger');

class QuestionService {
  async getQuestionByDifficulty(difficulty) {
    try {
      const result = await pool.query(
        `SELECT * FROM questions 
         WHERE difficulty = $1 AND is_active = true
         ORDER BY RANDOM()
         LIMIT 1`,
        [difficulty]
      );
      return result.rows[0] || null;
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