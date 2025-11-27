const pool = require('../config/database');
const { logger } = require('../utils/logger');

class QuestionService {
  async getQuestionByDifficulty(difficulty) {
    try {
      let categories = [];
      
      // Questions 1-5: Easy and Medium
      if (difficulty >= 1 && difficulty <= 5) {
        categories = ['Easy', 'Medium'];
      }
      // Questions 6-10: Medium and Hard
      else if (difficulty >= 6 && difficulty <= 10) {
        categories = ['Medium', 'Hard'];
      }
      // Questions 11-15: Hard only
      else if (difficulty >= 11 && difficulty <= 15) {
        categories = ['Hard'];
      }
      else {
        // Fallback for any unexpected difficulty values
        categories = ['Medium'];
      }

      // Randomly select one category from the available options
      const selectedCategory = categories[Math.floor(Math.random() * categories.length)];

      const result = await pool.query(
        `SELECT * FROM questions 
         WHERE category = $1 AND is_active = true
         ORDER BY RANDOM()
         LIMIT 1`,
        [selectedCategory]
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