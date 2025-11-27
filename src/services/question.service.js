const pool = require('../config/database');
const { logger } = require('../utils/logger');

class QuestionService {

  async getQuestionById(id) {
    const result = await pool.query(
      'SELECT * FROM questions WHERE id = $1 AND is_active = true',
      [id]
    );
    return result.rows[0] || null;
  }

  async getQuestionByDifficulty(difficulty, excludeIds = []) {
    let query = 'SELECT * FROM questions WHERE difficulty = $1 AND is_active = true';
    const params = [difficulty];

    if (excludeIds.length > 0) {
      const placeholders = excludeIds.map((_, i) => `$${i + 2}`).join(',');
      query += ` AND id NOT IN (${placeholders})`;
      params.push(...excludeIds);
    }

    query += ' ORDER BY RANDOM() LIMIT 1';
    const result = await pool.query(query, params);
    return result.rows[0] || null;
  }

  async updateQuestionStats(questionId, isCorrect) {
    try {
      await pool.query(
        `UPDATE questions
         SET times_answered = times_answered + 1,
             times_correct = times_correct + $1
         WHERE id = $2`,
        [isCorrect ? 1 : 0, questionId]
      );
    } catch (error) {
      logger.error('Error updating question stats:', error);
    }
  }
}

module.exports = QuestionService;
