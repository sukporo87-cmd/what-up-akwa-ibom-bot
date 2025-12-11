// ============================================
// FILE: src/routes/admin.routes.js - COMPLETE WITH AUTHENTICATION
// ============================================

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const PayoutService = require('../services/payout.service');
const WhatsAppService = require('../services/whatsapp.service');
const AdminAuthService = require('../services/admin-auth.service');
const { logger } = require('../utils/logger');

const payoutService = new PayoutService();
const whatsappService = new WhatsAppService();
const adminAuthService = new AdminAuthService();

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

const authenticateAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized - No token provided' });
  }

  // Validate session token
  const validation = await adminAuthService.validateSession(token);
  
  if (!validation.valid) {
    return res.status(401).json({ error: 'Unauthorized - ' + validation.reason });
  }

  req.adminSession = validation.session;
  next();
};

// Get IP address from request
const getIpAddress = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress;
};

// ============================================
// PUBLIC ROUTES (No Auth Required)
// ============================================

// Serve admin login page
router.get('/', (req, res) => {
  res.sendFile('admin.html', { root: './src/views' });
});

// Login endpoint
router.post('/api/login', async (req, res) => {
  try {
    const { token } = req.body;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    const result = await adminAuthService.login(token, ipAddress, userAgent);

    if (result.success) {
      res.json({
        success: true,
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt
      });
    } else {
      res.status(401).json({ success: false, error: result.error });
    }
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// ============================================
// PROTECTED ROUTES (Auth Required)
// ============================================

// Logout endpoint
router.post('/api/logout', authenticateAdmin, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    await adminAuthService.logout(token);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({ success: false, error: 'Logout failed' });
  }
});

// Get dashboard stats
router.get('/api/stats', authenticateAdmin, async (req, res) => {
  try {
    // Log activity
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_stats',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

    const payoutStats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE payout_status IN ('pending', 'details_collected', 'approved')) as pending_count,
        COALESCE(SUM(amount) FILTER (WHERE payout_status IN ('pending', 'details_collected', 'approved')), 0) as pending_amount,
        COUNT(*) FILTER (WHERE payout_status = 'paid' AND DATE(paid_at) = CURRENT_DATE) as paid_today_count,
        COALESCE(SUM(amount) FILTER (WHERE payout_status = 'paid' AND DATE(paid_at) = CURRENT_DATE), 0) as paid_today_amount,
        COUNT(*) FILTER (WHERE payout_status = 'confirmed') as confirmed_count,
        COALESCE(SUM(amount) FILTER (WHERE payout_status = 'confirmed'), 0) as confirmed_amount
      FROM transactions
      WHERE transaction_type = 'prize'
    `);
    
    const totalUsers = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalGames = await pool.query('SELECT COUNT(*) as count FROM game_sessions WHERE status = \'completed\'');
    const totalQuestions = await pool.query('SELECT COUNT(*) as count FROM questions WHERE is_active = true');
    
    res.json({
      pending_count: parseInt(payoutStats.rows[0].pending_count) || 0,
      pending_amount: parseFloat(payoutStats.rows[0].pending_amount) || 0,
      paid_today_count: parseInt(payoutStats.rows[0].paid_today_count) || 0,
      paid_today_amount: parseFloat(payoutStats.rows[0].paid_today_amount) || 0,
      confirmed_count: parseInt(payoutStats.rows[0].confirmed_count) || 0,
      confirmed_amount: parseFloat(payoutStats.rows[0].confirmed_amount) || 0,
      total_users: parseInt(totalUsers.rows[0].count),
      total_games: parseInt(totalGames.rows[0].count),
      total_questions: parseInt(totalQuestions.rows[0].count)
    });
  } catch (error) {
    logger.error('Error getting admin stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get activity log
router.get('/api/activity-log', authenticateAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const activities = await adminAuthService.getActivityLog(limit, offset);
    
    res.json({ activities });
  } catch (error) {
    logger.error('Error getting activity log:', error);
    res.status(500).json({ error: 'Failed to fetch activity log' });
  }
});

// Get pending payouts with proper filtering
router.get('/api/payouts/pending', authenticateAdmin, async (req, res) => {
  try {
    // Log activity
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_payouts',
      { filter: req.query.status || 'all' },
      getIpAddress(req),
      req.headers['user-agent']
    );

    const status = req.query.status;
    
    let whereClause = "t.transaction_type = 'prize' AND t.payout_status != 'confirmed'";
    const params = [];
    
    if (status && status !== '') {
      params.push(status);
      whereClause += ` AND t.payout_status = $${params.length}`;
    } else {
      whereClause += " AND t.payout_status IN ('pending', 'details_collected', 'approved', 'paid')";
    }

    const query = `
      SELECT 
        t.id as transaction_id,
        t.user_id,
        u.full_name,
        u.phone_number,
        u.lga,
        t.amount,
        t.payout_status,
        t.transaction_type,
        t.created_at as win_date,
        t.paid_at,
        t.payment_reference,
        pd.id as payout_detail_id,
        pd.account_name,
        pd.account_number,
        pd.bank_name,
        pd.bank_code,
        pd.verified,
        pd.created_at as details_submitted_at,
        gs.current_question as questions_answered,
        gs.session_key
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN payout_details pd ON t.id = pd.transaction_id
      LEFT JOIN game_sessions gs ON t.session_id = gs.id
      WHERE ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT 100
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    logger.error('Error getting pending payouts:', error);
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

// Get payout history with date filters
router.get('/api/payouts/history', authenticateAdmin, async (req, res) => {
  try {
    // Log activity
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_history',
      { period: req.query.period || 'all' },
      getIpAddress(req),
      req.headers['user-agent']
    );

    const period = req.query.period || 'all';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    let dateFilter = '';
    switch(period) {
      case 'daily':
        dateFilter = "AND DATE(t.paid_at) = CURRENT_DATE";
        break;
      case 'weekly':
        dateFilter = "AND t.paid_at >= CURRENT_DATE - INTERVAL '7 days'";
        break;
      case 'monthly':
        dateFilter = "AND t.paid_at >= CURRENT_DATE - INTERVAL '30 days'";
        break;
      case 'all':
      default:
        dateFilter = '';
    }

    const query = `
      SELECT 
        t.id as transaction_id,
        t.user_id,
        u.full_name,
        u.phone_number,
        u.lga,
        t.amount,
        t.payout_status,
        t.payment_reference,
        t.payment_method,
        t.paid_at,
        t.confirmed_at,
        pd.account_name,
        pd.account_number,
        pd.bank_name
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN payout_details pd ON t.id = pd.transaction_id
      WHERE t.transaction_type = 'prize' 
        AND t.payout_status IN ('paid', 'confirmed')
        ${dateFilter}
      ORDER BY t.paid_at DESC
      LIMIT $1 OFFSET $2
    `;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM transactions t
      WHERE t.transaction_type = 'prize' 
        AND t.payout_status IN ('paid', 'confirmed')
        ${dateFilter}
    `;

    const [result, countResult] = await Promise.all([
      pool.query(query, [limit, offset]),
      pool.query(countQuery)
    ]);

    res.json({
      payouts: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].total),
        totalPages: Math.ceil(parseInt(countResult.rows[0].total) / limit)
      }
    });
  } catch (error) {
    logger.error('Error getting payout history:', error);
    res.status(500).json({ error: 'Failed to fetch payout history' });
  }
});

// Get payout details
router.get('/api/payouts/:id', authenticateAdmin, async (req, res) => {
  try {
    const transactionId = req.params.id;
    
    // Log activity
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_payout_details',
      { transaction_id: transactionId },
      getIpAddress(req),
      req.headers['user-agent']
    );
    
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
        pd.verified,
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

    const success = await payoutService.approvePayout(transactionId, req.adminSession.admin_id);

    if (success) {
      // Log activity
      await adminAuthService.logActivity(
        req.adminSession.admin_id,
        'approve_payout',
        { transaction_id: transactionId },
        getIpAddress(req),
        req.headers['user-agent']
      );

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
    const { paymentReference, paymentMethod } = req.body;

    if (!paymentReference) {
      return res.status(400).json({ error: 'Payment reference is required' });
    }

    const success = await payoutService.markAsPaid(
      transactionId,
      req.adminSession.admin_id,
      paymentReference,
      paymentMethod || 'bank_transfer'
    );

    if (success) {
      // Log activity
      await adminAuthService.logActivity(
        req.adminSession.admin_id,
        'mark_paid',
        { transaction_id: transactionId, payment_reference: paymentReference },
        getIpAddress(req),
        req.headers['user-agent']
      );

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

// Re-verify payout
router.post('/api/payouts/:id/reverify', authenticateAdmin, async (req, res) => {
  try {
    const transactionId = req.params.id;

    const result = await payoutService.reverifyPayout(transactionId);

    if (result.success) {
      // Log activity
      await adminAuthService.logActivity(
        req.adminSession.admin_id,
        'reverify_payout',
        { transaction_id: transactionId, account_name: result.accountName },
        getIpAddress(req),
        req.headers['user-agent']
      );

      res.json({ 
        success: true, 
        message: 'Account re-verified successfully',
        accountName: result.accountName 
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    logger.error('Error re-verifying payout:', error);
    res.status(500).json({ error: 'Failed to re-verify payout' });
  }
});

// Get all users
router.get('/api/users', authenticateAdmin, async (req, res) => {
  try {
    // Log activity
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_users',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

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
    // Log activity
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_questions',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

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

    if (!question_text || !option_a || !option_b || !option_c || !option_d || !correct_answer || !difficulty) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!['A', 'B', 'C', 'D'].includes(correct_answer.toUpperCase())) {
      return res.status(400).json({ error: 'Correct answer must be A, B, C, or D' });
    }

    const difficultyNum = parseInt(difficulty);
    if (isNaN(difficultyNum) || difficultyNum < 1 || difficultyNum > 15) {
      return res.status(400).json({ error: 'Difficulty must be between 1 and 15' });
    }

    const result = await pool.query(
      `INSERT INTO questions 
       (question_text, option_a, option_b, option_c, option_d, correct_answer, difficulty, category, fun_fact)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [question_text, option_a, option_b, option_c, option_d, correct_answer.toUpperCase(), difficultyNum, category || 'General', fun_fact]
    );

    // Log activity
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'add_question',
      { question_id: result.rows[0].id, difficulty: difficultyNum },
      getIpAddress(req),
      req.headers['user-agent']
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

    // Log activity
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'update_question',
      { question_id: questionId },
      getIpAddress(req),
      req.headers['user-agent']
    );

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

    // Log activity
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'delete_question',
      { question_id: questionId },
      getIpAddress(req),
      req.headers['user-agent']
    );

    res.json({ success: true, message: 'Question deleted' });
  } catch (error) {
    logger.error('Error deleting question:', error);
    res.status(500).json({ error: 'Failed to delete question' });
  }
});

module.exports = router;