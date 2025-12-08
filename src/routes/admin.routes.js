// ============================================
// FILE: src/routes/admin.routes.js
// ============================================

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const PayoutService = require('../services/payout.service');
const WhatsAppService = require('../services/whatsapp.service');
const { logger } = require('../utils/logger');

const payoutService = new PayoutService();
const whatsappService = new WhatsAppService();

// Simple authentication middleware
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
};

// Serve admin dashboard HTML
router.get('/', (req, res) => {
  res.sendFile('admin.html', { root: './src/views' });
});

// Get dashboard stats
router.get('/api/stats', authenticateAdmin, async (req, res) => {
  try {
    const stats = await payoutService.getPayoutStats();
    
    // Get total users and games
    const totalUsers = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalGames = await pool.query('SELECT COUNT(*) as count FROM game_sessions WHERE status = \'completed\'');
    const totalQuestions = await pool.query('SELECT COUNT(*) as count FROM questions WHERE is_active = true');
    
    res.json({
      ...stats,
      total_users: parseInt(totalUsers.rows[0].count),
      total_games: parseInt(totalGames.rows[0].count),
      total_questions: parseInt(totalQuestions.rows[0].count)
    });
  } catch (error) {
    logger.error('Error getting admin stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get pending payouts
router.get('/api/payouts/pending', authenticateAdmin, async (req, res) => {
  try {
    const status = req.query.status || null;
    const payouts = await payoutService.getAllPendingPayouts(status);
    res.json(payouts);
  } catch (error) {
    logger.error('Error getting pending payouts:', error);
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

// Get payout details
router.get('/api/payouts/:id', authenticateAdmin, async (req, res) => {
  try {
    const transactionId = req.params.id;
    
    const result = await pool.query(
      `SELECT 
        t.*,
        u.full_name,
        u.phone_number,
        u.lga,
        pd.account_name,
        pd.account_number,
        pd.bank_name,
        pd.bank_code,
        gs.current_question as questions_answered
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       LEFT JOIN payout_details pd ON t.id = pd.transaction_id
       LEFT JOIN game_sessions gs ON t.session_id = gs.id
       WHERE t.id = $1`,
      [transactionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Error getting payout details:', error);
    res.status(500).json({ error: 'Failed to fetch payout details' });
  }
});

// Approve payout
router.post('/api/payouts/:id/approve', authenticateAdmin, async (req, res) => {
  try {
    const transactionId = req.params.id;
    const adminId = req.body.adminId || 'admin';

    const success = await payoutService.approvePayout(transactionId, adminId);

    if (success) {
      res.json({ success: true, message: 'Payout approved' });
    } else {
      res.status(500).json({ error: 'Failed to approve payout' });
    }
  } catch (error) {
    logger.error('Error approving payout:', error);
    res.status(500).json({ error: 'Failed to approve payout' });
  }
});

// Mark payout as paid
router.post('/api/payouts/:id/mark-paid', authenticateAdmin, async (req, res) => {
  try {
    const transactionId = req.params.id;
    const { paymentReference, paymentMethod, adminId } = req.body;

    if (!paymentReference) {
      return res.status(400).json({ error: 'Payment reference is required' });
    }

    const success = await payoutService.markAsPaid(
      transactionId,
      adminId || 'admin',
      paymentReference,
      paymentMethod || 'bank_transfer'
    );

    if (success) {
      // Get transaction and user details
      const result = await pool.query(
        `SELECT t.*, u.phone_number, u.full_name, pd.account_name, pd.bank_name, pd.account_number
         FROM transactions t
         JOIN users u ON t.user_id = u.id
         LEFT JOIN payout_details pd ON t.id = pd.transaction_id
         WHERE t.id = $1`,
        [transactionId]
      );

      if (result.rows.length > 0) {
        const transaction = result.rows[0];

        // Send WhatsApp notification to winner
        await whatsappService.sendMessage(
          transaction.phone_number,
          `✅ PAYMENT SENT! 🎉\n\n` +
          `₦${parseFloat(transaction.amount).toLocaleString()} has been sent to:\n` +
          `${transaction.account_name}\n` +
          `${transaction.bank_name} (${transaction.account_number})\n\n` +
          `Transaction Reference: ${paymentReference}\n\n` +
          `Please check your account within 2 hours and confirm receipt.\n\n` +
          `Reply "RECEIVED" to confirm!\n\n` +
          `Keep playing to win more! 🏆`
        );

        logger.info(`Payment notification sent to ${transaction.phone_number}`);
      }

      res.json({ success: true, message: 'Payout marked as paid and user notified' });
    } else {
      res.status(500).json({ error: 'Failed to mark payout as paid' });
    }
  } catch (error) {
    logger.error('Error marking payout as paid:', error);
    res.status(500).json({ error: 'Failed to mark payout as paid' });
  }
});

// Get all users
router.get('/api/users', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT 
        id, full_name, phone_number, lga, 
        total_games_played, total_winnings, 
        games_remaining, created_at, last_active
       FROM users
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query('SELECT COUNT(*) as total FROM users');
    const total = parseInt(countResult.rows[0].total);

    res.json({
      users: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    logger.error('Error getting users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get all questions
router.get('/api/questions', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT *
       FROM questions
       ORDER BY difficulty ASC, id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query('SELECT COUNT(*) as total FROM questions WHERE is_active = true');
    const total = parseInt(countResult.rows[0].total);

    res.json({
      questions: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    logger.error('Error getting questions:', error);
    res.status(500).json({ error: 'Failed to fetch questions' });
  }
});

// Add new question
router.post('/api/questions', authenticateAdmin, async (req, res) => {
  try {
    const {
      question_text,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_answer,
      difficulty,
      category,
      fun_fact
    } = req.body;

    // Validate required fields
    if (!question_text || !option_a || !option_b || !option_c || !option_d || !correct_answer || !difficulty) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await pool.query(
      `INSERT INTO questions 
       (question_text, option_a, option_b, option_c, option_d, correct_answer, difficulty, category, fun_fact)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [question_text, option_a, option_b, option_c, option_d, correct_answer, difficulty, category || 'General', fun_fact]
    );

    res.json({ success: true, question: result.rows[0] });
  } catch (error) {
    logger.error('Error adding question:', error);
    res.status(500).json({ error: 'Failed to add question' });
  }
});

// Update question
router.put('/api/questions/:id', authenticateAdmin, async (req, res) => {
  try {
    const questionId = req.params.id;
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
    } = req.body;

    const result = await pool.query(
      `UPDATE questions 
       SET question_text = $1, option_a = $2, option_b = $3, option_c = $4, 
           option_d = $5, correct_answer = $6, difficulty = $7, category = $8, 
           fun_fact = $9, is_active = $10
       WHERE id = $11
       RETURNING *`,
      [question_text, option_a, option_b, option_c, option_d, correct_answer, 
       difficulty, category, fun_fact, is_active, questionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    res.json({ success: true, question: result.rows[0] });
  } catch (error) {
    logger.error('Error updating question:', error);
    res.status(500).json({ error: 'Failed to update question' });
  }
});

// Delete question (soft delete)
router.delete('/api/questions/:id', authenticateAdmin, async (req, res) => {
  try {
    const questionId = req.params.id;

    await pool.query(
      'UPDATE questions SET is_active = false WHERE id = $1',
      [questionId]
    );

    res.json({ success: true, message: 'Question deleted' });
  } catch (error) {
    logger.error('Error deleting question:', error);
    res.status(500).json({ error: 'Failed to delete question' });
  }
});

// Get payout history
router.get('/api/payouts/history', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        ph.*,
        t.amount,
        u.full_name,
        u.phone_number
       FROM payout_history ph
       JOIN transactions t ON ph.transaction_id = t.id
       JOIN users u ON t.user_id = u.id
       ORDER BY ph.created_at DESC
       LIMIT 100`
    );

    res.json(result.rows);
  } catch (error) {
    logger.error('Error getting payout history:', error);
    res.status(500).json({ error: 'Failed to fetch payout history' });
  }
});

module.exports = router;