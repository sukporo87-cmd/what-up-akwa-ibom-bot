const pool = require('../config/database');
const { logger } = require('../utils/logger');

class QuestionService {

  // Fetch a single question by ID
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

  // Fetch a question by difficulty (for legacy use, optional)
  async getQuestionByDifficulty(difficulty) {
    try {
      const result = await pool.query(
        `SELECT * FROM questions 
         WHERE difficulty = $1
         ORDER BY RANDOM()
         LIMIT 1`,
        [difficulty]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error fetching question by difficulty:', error);
      throw error;
    }
  }

  // Fetch N random questions
  async getRandomQuestions(limit = 15) {
    try {
      const result = await pool.query(
        `SELECT * FROM questions 
         ORDER BY RANDOM()
         LIMIT $1`,
        [limit]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error fetching random questions:', error);
      throw error;
    }
  }

  // Update question stats (correct/wrong answer count)
  async updateQuestionStats(questionId, isCorrect) {
    try {
      if (isCorrect) {
        await pool.query(
          `UPDATE questions
           SET times_answered_correctly = times_answered_correctly + 1
           WHERE id = $1`,
          [questionId]
        );
      } else {
        await pool.query(
          `UPDATE questions
           SET times_answered_wrongly = times_answered_wrongly + 1
           WHERE id = $1`,
          [questionId]
        );
      }
    } catch (error) {
      logger.error('Error updating question stats:', error);
      throw error;
    }
  }

}

module.exports = QuestionService;
