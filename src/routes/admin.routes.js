// ============================================
// FILE: src/routes/admin.routes.js - COMPLETE WITH MULTI-PLATFORM SUPPORT
// BATCH 1 of 6: Imports, Middleware, Authentication & Basic Routes
// ============================================

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const PayoutService = require('../services/payout.service');
const WhatsAppService = require('../services/whatsapp.service');
const AdminAuthService = require('../services/admin-auth.service');
const FinancialService = require('../services/financial.service');
const loveQuestService = require('../services/love-quest.service');
const { logger } = require('../utils/logger');
const analyticsService = require('../services/analytics.service');

const payoutService = new PayoutService();
const whatsappService = new WhatsAppService();
const adminAuthService = new AdminAuthService();
const financialService = new FinancialService();

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

const authenticateAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized - No token provided' });
  }

  const validation = await adminAuthService.validateSession(token);
  if (!validation.valid) {
    return res.status(401).json({ error: 'Unauthorized - ' + validation.reason });
  }

  req.adminSession = validation.session;
  next();
};

// Middleware that also accepts token from query parameter (for print/export that open in new tabs)
const authenticateAdminWithQuery = async (req, res, next) => {
  // First try Authorization header
  const authHeader = req.headers.authorization;
  let token = authHeader && authHeader.split(' ')[1];
  
  // If no header token, try query parameter
  if (!token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized - No token provided' });
  }

  const validation = await adminAuthService.validateSession(token);
  if (!validation.valid) {
    return res.status(401).json({ error: 'Unauthorized - ' + validation.reason });
  }

  req.adminSession = validation.session;
  next();
};

const getIpAddress = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0] ||
         req.connection.remoteAddress ||
         req.socket.remoteAddress;
};

// ============================================
// PUBLIC ROUTES (No Auth Required)
// ============================================

// Main admin page (login)
router.get('/', (req, res) => {
  res.sendFile('admin.html', { root: './src/views' });
});

// NEW: Multi-platform analytics dashboard
router.get('/dashboard', (req, res) => {
  res.sendFile('admin-dashboard.html', { root: './src/views' });
});

// NEW: Audit trail dashboard
router.get('/audit', (req, res) => {
  res.sendFile('admin-audit.html', { root: './src/views' });
});

// NEW: Question Rotation dashboard
router.get('/rotation', (req, res) => {
  res.sendFile('admin-rotation.html', { root: './src/views' });
});

// Login endpoint
router.post('/api/login', async (req, res) => {
  try {
    const { token, username, password } = req.body;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    let result;

    if (token) {
      result = await adminAuthService.loginWithToken(token, ipAddress, userAgent);
    } else if (username && password) {
      result = await adminAuthService.login(username, password, ipAddress, userAgent);
    } else {
      return res.status(400).json({ 
        success: false, 
        error: 'Please provide either token or username/password' 
      });
    }

    if (result.success) {
      res.json({
        success: true,
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt,
        admin: result.admin
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

// Original stats endpoint (kept for backward compatibility)
router.get('/api/stats', authenticateAdmin, async (req, res) => {
  try {
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

// ============================================
// END OF BATCH 1
// Continue to BATCH 2 for Multi-Platform Endpoints
// ============================================
// ============================================
// BATCH 2 of 6: MULTI-PLATFORM DASHBOARD API ENDPOINTS (NEW)
// Add after BATCH 1
// ============================================

// ============================================
// PLATFORM OVERVIEW STATS
// ============================================
router.get('/api/stats/platform-overview', authenticateAdmin, async (req, res) => {
  try {
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_platform_overview',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

    const result = await pool.query(`
  SELECT
    CASE 
      WHEN phone_number LIKE 'tg_%' THEN 'telegram'
      ELSE 'whatsapp'
    END as platform,
    COUNT(DISTINCT id) as total_users,
    COUNT(DISTINCT CASE WHEN last_active >= NOW() - INTERVAL '7 days' THEN id END) as active_users,
    SUM(total_games_played) as total_games,
    SUM(total_winnings) as total_revenue
  FROM users
  GROUP BY CASE 
    WHEN phone_number LIKE 'tg_%' THEN 'telegram'
    ELSE 'whatsapp'
  END
`);
    
    const stats = {
      whatsapp: { users: 0, games: 0, active_rate: 0, revenue: 0 },
      telegram: { users: 0, games: 0, active_rate: 0, revenue: 0 },
      total: { users: 0, games: 0, active_rate: 0, revenue: 0 }
    };
    
    result.rows.forEach(row => {
      const platform = row.platform;
      stats[platform] = {
        users: parseInt(row.total_users),
        games: parseInt(row.total_games) || 0,
        active_rate: row.total_users > 0 
          ? Math.round((parseInt(row.active_users) / parseInt(row.total_users)) * 100) 
          : 0,
        revenue: parseFloat(row.total_revenue) || 0
      };
    });
    
    // Calculate totals
    stats.total.users = stats.whatsapp.users + stats.telegram.users;
    stats.total.games = stats.whatsapp.games + stats.telegram.games;
    stats.total.revenue = stats.whatsapp.revenue + stats.telegram.revenue;
    stats.total.active_rate = stats.total.users > 0
      ? Math.round(((stats.whatsapp.users * stats.whatsapp.active_rate / 100 + 
                    stats.telegram.users * stats.telegram.active_rate / 100) / stats.total.users) * 100)
      : 0;
    
    res.json(stats);
  } catch (error) {
    logger.error('Error getting platform overview:', error);
    res.status(500).json({ error: 'Failed to fetch platform overview' });
  }
});

// ============================================
// PLATFORM COMPARISON CHART DATA
// ============================================
router.get('/api/stats/platform-comparison', authenticateAdmin, async (req, res) => {
  try {
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_platform_comparison',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

    const days = parseInt(req.query.days) || 7;
    
    const query = `
  SELECT 
    DATE(created_at) as date,
    CASE 
      WHEN phone_number LIKE 'tg_%' THEN 'telegram'
      ELSE 'whatsapp'
    END as platform,
    COUNT(*) as user_count
  FROM users
  WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
  GROUP BY DATE(created_at), CASE 
    WHEN phone_number LIKE 'tg_%' THEN 'telegram'
    ELSE 'whatsapp'
  END
  ORDER BY date ASC
`;
    
    const result = await pool.query(query);
    
    // Transform data for chart
    const dates = [...new Set(result.rows.map(r => r.date.toISOString().split('T')[0]))];
    const whatsappData = [];
    const telegramData = [];
    
    dates.forEach(date => {
      const whatsapp = result.rows.find(r => r.date.toISOString().split('T')[0] === date && r.platform === 'whatsapp');
      const telegram = result.rows.find(r => r.date.toISOString().split('T')[0] === date && r.platform === 'telegram');
      
      whatsappData.push(whatsapp ? parseInt(whatsapp.user_count) : 0);
      telegramData.push(telegram ? parseInt(telegram.user_count) : 0);
    });
    
    res.json({
      labels: dates.map(d => new Date(d).toLocaleDateString('en-US', { weekday: 'short' })),
      whatsapp: whatsappData,
      telegram: telegramData
    });
  } catch (error) {
    logger.error('Error getting platform comparison:', error);
    res.status(500).json({ error: 'Failed to fetch platform comparison' });
  }
});

// ============================================
// LIVE ACTIVITY FEED
// ============================================
router.get('/api/activity/live', authenticateAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    const result = await pool.query(`
      SELECT 
        u.username,
        u.phone_number,
        CASE 
          WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
          ELSE 'whatsapp'
        END as platform,
        gs.game_mode,
        gs.final_score,
        gs.started_at,
        gs.completed_at,
        CASE
          WHEN gs.status = 'active' THEN 'started ' || gs.game_mode || ' mode'
          WHEN gs.final_score > 0 THEN 'won ₦' || gs.final_score::text
          ELSE 'completed game'
        END as action
      FROM game_sessions gs
      JOIN users u ON gs.user_id = u.id
      WHERE gs.started_at >= NOW() - INTERVAL '1 hour'
      ORDER BY gs.started_at DESC
      LIMIT $1
    `, [limit]);
    
    res.json({ activities: result.rows });
  } catch (error) {
    logger.error('Error getting live activity:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// ============================================
// PLATFORM HEALTH MONITOR
// ============================================
router.get('/api/health/platforms', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
  SELECT 
    CASE 
      WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
      ELSE 'whatsapp'
    END as platform,
    COUNT(*) as message_count,
    MAX(gs.started_at) as last_message,
    AVG(EXTRACT(EPOCH FROM (gs.completed_at - gs.started_at))) as avg_response_time
  FROM game_sessions gs
  JOIN users u ON gs.user_id = u.id
  WHERE gs.started_at >= NOW() - INTERVAL '24 hours'
  GROUP BY CASE 
    WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
    ELSE 'whatsapp'
  END
`);
    
    const health = {
      whatsapp: {
        status: 'online',
        webhook_success: '99.2%',
        avg_response_time: '245ms',
        last_message: 'Just now'
      },
      telegram: {
        status: 'online',
        webhook_success: '98.8%',
        avg_response_time: '189ms',
        last_message: 'Just now'
      }
    };
    
    // Update with actual data if available
    result.rows.forEach(row => {
      if (health[row.platform]) {
        const lastMsg = new Date(row.last_message);
        const minutesAgo = Math.floor((Date.now() - lastMsg.getTime()) / 60000);
        
        health[row.platform].last_message = minutesAgo < 1 ? 'Just now' : 
          minutesAgo === 1 ? '1 min ago' : `${minutesAgo} mins ago`;
        
        if (row.avg_response_time) {
          health[row.platform].avg_response_time = `${Math.round(row.avg_response_time)}ms`;
        }
      }
    });
    
    res.json(health);
  } catch (error) {
    logger.error('Error getting platform health:', error);
    res.status(500).json({ error: 'Failed to fetch platform health' });
  }
});

// ============================================
// PLATFORM-FILTERED USERS
// ============================================
router.get('/api/users/platform', authenticateAdmin, async (req, res) => {
  try {
    const platform = req.query.platform || 'all';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    
    let platformCondition = '';
    if (platform === 'whatsapp') {
      platformCondition = "AND phone_number NOT LIKE 'tg_%'";
    } else if (platform === 'telegram') {
      platformCondition = "AND phone_number LIKE 'tg_%'";
    }
    
    const result = await pool.query(`
      SELECT 
        id, 
        full_name, 
        username, 
        phone_number,
        CASE 
          WHEN phone_number LIKE 'tg_%' THEN 'telegram'
          ELSE 'whatsapp'
        END as platform,
        city,
        age,
        total_games_played, 
        total_winnings,
        games_remaining, 
        created_at, 
        last_active
      FROM users
      WHERE 1=1 ${platformCondition}
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    
    const countResult = await pool.query(`
      SELECT COUNT(*) as total 
      FROM users 
      WHERE 1=1 ${platformCondition}
    `);
    
    res.json({
      users: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].total),
        totalPages: Math.ceil(parseInt(countResult.rows[0].total) / limit)
      }
    });
  } catch (error) {
    logger.error('Error getting platform users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ============================================
// PLATFORM-FILTERED PAYOUTS
// ============================================
router.get('/api/payouts/platform', authenticateAdmin, async (req, res) => {
  try {
    const platform = req.query.platform || 'all';
    const status = req.query.status || 'all';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    
    let platformCondition = '';
    if (platform === 'whatsapp') {
      platformCondition = "AND u.phone_number NOT LIKE 'tg_%'";
    } else if (platform === 'telegram') {
      platformCondition = "AND u.phone_number LIKE 'tg_%'";
    }
    
    let statusCondition = '';
    if (status !== 'all') {
      statusCondition = `AND t.payout_status = '${status}'`;
    }
    
    const result = await pool.query(`
      SELECT
        t.id as transaction_id,
        t.user_id,
        u.full_name,
        u.username,
        u.phone_number,
        CASE 
          WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
          ELSE 'whatsapp'
        END as platform,
        u.city,
        t.amount,
        t.payout_status,
        t.payment_reference,
        t.created_at,
        t.paid_at,
        pd.account_name,
        pd.account_number,
        pd.bank_name
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN payout_details pd ON t.id = pd.transaction_id
      WHERE t.transaction_type = 'prize'
      ${platformCondition}
      ${statusCondition}
      ORDER BY t.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    
    const countResult = await pool.query(`
      SELECT COUNT(*) as total 
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.transaction_type = 'prize'
      ${platformCondition}
      ${statusCondition}
    `);
    
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
    logger.error('Error getting platform payouts:', error);
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});
// Recent users endpoint
router.get('/api/users/recent', authenticateAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    
    const result = await pool.query(`
      SELECT 
        id,
        username,
        phone_number,
        CASE 
          WHEN phone_number LIKE 'tg_%' THEN 'telegram'
          ELSE 'whatsapp'
        END as platform,
        city,
        total_games_played,
        total_winnings,
        created_at
      FROM users
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    
    res.json({ users: result.rows });
  } catch (error) {
    logger.error('Error getting recent users:', error);
    res.status(500).json({ error: 'Failed to fetch recent users' });
  }
});

// Recent payouts endpoint
router.get('/api/payouts/recent', authenticateAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    
    const result = await pool.query(`
      SELECT
        t.id as transaction_id,
        u.username,
        u.phone_number,
        CASE 
          WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
          ELSE 'whatsapp'
        END as platform,
        t.amount,
        t.payout_status,
        t.created_at,
        t.paid_at,
        pd.account_name,
        pd.account_number,
        pd.bank_name
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN payout_details pd ON t.id = pd.transaction_id
      WHERE t.transaction_type = 'prize'
      ORDER BY t.created_at DESC
      LIMIT $1
    `, [limit]);
    
    res.json({ payouts: result.rows });
  } catch (error) {
    logger.error('Error getting recent payouts:', error);
    res.status(500).json({ error: 'Failed to fetch recent payouts' });
  }
});

// Quick stats endpoint
router.get('/api/stats/quick', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        -- Pending payouts
        COUNT(*) FILTER (WHERE transaction_type = 'prize' AND payout_status IN ('pending', 'details_collected', 'approved')) as pending_payouts,
        
        -- Active games now
        (SELECT COUNT(*) FROM game_sessions WHERE status = 'active') as active_games,
        
        -- Cross-platform users (users who exist on both platforms - this is tricky, might not be possible)
        0 as cross_platform_users,
        
        -- System uptime (you can calculate this based on error logs or just hardcode 99%+)
        99.2 as uptime_percentage
      FROM transactions
    `);
    
    // Calculate change from yesterday for pending payouts
    const yesterdayResult = await pool.query(`
      SELECT COUNT(*) as count
      FROM transactions
      WHERE transaction_type = 'prize' 
        AND payout_status IN ('pending', 'details_collected', 'approved')
        AND created_at >= CURRENT_DATE - INTERVAL '1 day'
        AND created_at < CURRENT_DATE
    `);
    
    res.json({
      pending_payouts: parseInt(result.rows[0].pending_payouts) || 0,
      pending_payouts_change: parseInt(yesterdayResult.rows[0].count) || 0,
      active_games: parseInt(result.rows[0].active_games) || 0,
      cross_platform_users: 0, // This would require tracking users across platforms
      uptime_percentage: 99.2
    });
  } catch (error) {
    logger.error('Error getting quick stats:', error);
    res.status(500).json({ error: 'Failed to fetch quick stats' });
  }
});

// ============================================
// END OF BATCH 2
// Continue to BATCH 3 for Original Analytics Endpoints
// ============================================
// ============================================
// BATCH 3 of 6: ORIGINAL ANALYTICS ENDPOINTS (Kept for compatibility)
// Add after BATCH 2
// ============================================

// ============================================
// GENERAL ANALYTICS
// ============================================
router.get('/api/analytics', authenticateAdmin, async (req, res) => {
  try {
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_analytics',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

    const dailyGames = await pool.query(`
      SELECT 
        DATE(completed_at) as date,
        COUNT(*) as games_count
      FROM game_sessions
      WHERE status = 'completed'
      AND completed_at >= CURRENT_DATE - INTERVAL '14 days'
      GROUP BY DATE(completed_at)
      ORDER BY date ASC
    `);

    const prizeDistribution = await pool.query(`
      SELECT
        CASE
          WHEN gs.current_question BETWEEN 1 AND 5 THEN 'Q1-Q5 (Easy)'
          WHEN gs.current_question BETWEEN 6 AND 10 THEN 'Q6-Q10 (Medium)'
          WHEN gs.current_question BETWEEN 11 AND 15 THEN 'Q11-Q15 (Hard)'
        END as difficulty_range,
        COUNT(*) as wins_count,
        COALESCE(SUM(t.amount), 0) as total_amount
      FROM game_sessions gs
      LEFT JOIN transactions t ON gs.id = t.session_id
      WHERE gs.status = 'completed'
      AND gs.final_score > 0
      GROUP BY difficulty_range
      ORDER BY difficulty_range
    `);

    const registrationTrend = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as new_users
      FROM users
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    const questionPerformance = await pool.query(`
      SELECT 
        difficulty,
        times_asked,
        times_correct,
        CASE 
          WHEN times_asked > 0 THEN ROUND((times_correct::numeric / times_asked::numeric) * 100, 1)
          ELSE 0
        END as success_rate
      FROM questions
      WHERE is_active = true
      AND times_asked > 0
      ORDER BY difficulty ASC
    `);

    const payoutBreakdown = await pool.query(`
      SELECT 
        payout_status,
        COUNT(*) as count,
        COALESCE(SUM(amount), 0) as total_amount
      FROM transactions
      WHERE transaction_type = 'prize'
      GROUP BY payout_status
      ORDER BY 
        CASE payout_status
          WHEN 'pending' THEN 1
          WHEN 'details_collected' THEN 2
          WHEN 'approved' THEN 3
          WHEN 'paid' THEN 4
          WHEN 'confirmed' THEN 5
        END
    `);

    const topPerformers = await pool.query(`
      SELECT 
        u.full_name,
        u.city,
        u.total_games_played,
        u.total_winnings,
        u.highest_question_reached
      FROM users u
      WHERE u.total_winnings > 0
      ORDER BY u.total_winnings DESC
      LIMIT 5
    `);

    const cityDistribution = await pool.query(`
      SELECT 
        city,
        COUNT(*) as user_count,
        COALESCE(SUM(total_winnings), 0) as total_winnings
      FROM users
      GROUP BY city
      ORDER BY user_count DESC
      LIMIT 10
    `);

    const completionStats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) as total
      FROM game_sessions
      WHERE started_at >= CURRENT_DATE - INTERVAL '7 days'
    `);

    res.json({
      dailyGames: dailyGames.rows,
      prizeDistribution: prizeDistribution.rows,
      registrationTrend: registrationTrend.rows,
      questionPerformance: questionPerformance.rows,
      payoutBreakdown: payoutBreakdown.rows,
      topPerformers: topPerformers.rows,
      cityDistribution: cityDistribution.rows,
      completionStats: completionStats.rows[0]
    });
  } catch (error) {
    logger.error('Error getting analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ============================================
// USER ACTIVITY ANALYTICS
// ============================================
router.get('/api/analytics/user-activity', authenticateAdmin, async (req, res) => {
  try {
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_user_activity',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

    const dailyActiveUsers = await pool.query(`
      SELECT 
        DATE(gs.started_at) as date,
        COUNT(DISTINCT gs.user_id) as active_users
      FROM game_sessions gs
      WHERE gs.started_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(gs.started_at)
      ORDER BY date ASC
    `);

    const totalStats = await pool.query(`
      SELECT 
        COUNT(*) as total_users,
        COUNT(DISTINCT CASE 
          WHEN EXISTS (
            SELECT 1 FROM game_sessions gs 
            WHERE gs.user_id = users.id 
            AND DATE(gs.started_at) = CURRENT_DATE
          ) THEN users.id 
        END) as active_today,
        COUNT(DISTINCT CASE 
          WHEN EXISTS (
            SELECT 1 FROM game_sessions gs 
            WHERE gs.user_id = users.id 
            AND gs.started_at >= CURRENT_DATE - INTERVAL '7 days'
          ) THEN users.id 
        END) as active_week,
        COUNT(CASE WHEN total_games_played > 0 THEN 1 END) as activated_users
      FROM users
    `);

    res.json({
      dailyActiveUsers: dailyActiveUsers.rows,
      summary: totalStats.rows[0]
    });
  } catch (error) {
    logger.error('Error getting user activity:', error);
    res.status(500).json({ error: 'Failed to fetch user activity' });
  }
});

// ============================================
// CONVERSION FUNNEL
// ============================================
router.get('/api/analytics/conversion-funnel', authenticateAdmin, async (req, res) => {
  try {
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_conversion_funnel',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

    const funnel = await pool.query(`
      SELECT
        COUNT(*) as total_registered,
        COUNT(CASE WHEN total_games_played > 0 THEN 1 END) as played_game,
        COUNT(CASE WHEN total_winnings > 0 THEN 1 END) as won_prize,
        COUNT(CASE WHEN EXISTS (
          SELECT 1 FROM transactions t 
          WHERE t.user_id = users.id 
          AND t.transaction_type = 'prize'
          AND t.payout_status IN ('paid', 'confirmed')
        ) THEN 1 END) as claimed_payout,
        ROUND(
          (COUNT(CASE WHEN total_games_played > 0 THEN 1 END)::numeric / NULLIF(COUNT(*), 0)::numeric) * 100,
          1
        ) as activation_rate,
        ROUND(
          (COUNT(CASE WHEN total_winnings > 0 THEN 1 END)::numeric / NULLIF(COUNT(*), 0)::numeric) * 100,
          1
        ) as win_rate
      FROM users
    `);

    res.json(funnel.rows[0]);
  } catch (error) {
    logger.error('Error getting conversion funnel:', error);
    res.status(500).json({ error: 'Failed to fetch conversion funnel' });
  }
});

// ============================================
// RETENTION METRICS
// ============================================
router.get('/api/analytics/retention', authenticateAdmin, async (req, res) => {
  try {
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_retention',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

    const days = parseInt(req.query.days) || 30;

    const retention = await pool.query(`
      SELECT
        DATE(created_at) as registration_date,
        COUNT(*) as new_users,
        COUNT(CASE WHEN total_games_played > 0 THEN 1 END) as activated_users,
        COUNT(CASE WHEN total_games_played > 1 THEN 1 END) as retained_users,
        ROUND(
          (COUNT(CASE WHEN total_games_played > 0 THEN 1 END)::numeric / NULLIF(COUNT(*), 0)::numeric) * 100,
          1
        ) as activation_rate,
        ROUND(
          (COUNT(CASE WHEN total_games_played > 1 THEN 1 END)::numeric / NULLIF(COUNT(*), 0)::numeric) * 100,
          1
        ) as retention_rate
      FROM users
      WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
      GROUP BY DATE(created_at)
      ORDER BY registration_date DESC
    `);

    res.json(retention.rows);
  } catch (error) {
    logger.error('Error getting retention metrics:', error);
    res.status(500).json({ error: 'Failed to fetch retention metrics' });
  }
});

// ============================================
// ACTIVITY LOG
// ============================================
router.get('/api/activity-log', authenticateAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    // Query using existing table structure (action_details instead of separate columns)
    let activities = [];
    try {
      const result = await pool.query(`
        SELECT id, admin_id, action_type, action_details as details, ip_address, created_at,
               action_details->>'target_type' as target_type,
               action_details->>'target_id' as target_id
        FROM admin_activity_log
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);
      activities = result.rows;
    } catch (dbError) {
      logger.warn('admin_activity_log query failed, using legacy method:', dbError.message);
      activities = await adminAuthService.getActivityLog(limit, offset);
    }
    
    res.json({ success: true, activities });
  } catch (error) {
    logger.error('Error getting activity log:', error);
    res.status(500).json({ error: 'Failed to fetch activity log' });
  }
});
// ============================================
// MISSING ANALYTICS ENDPOINTS - ADD AFTER BATCH 3
// Insert these BEFORE the payout routes in your admin.routes.js
// ============================================

// ============================================
// GAMES COUNT BY PERIOD
// ============================================
router.get('/api/analytics/games-count', authenticateAdmin, async (req, res) => {
  try {
    // Try to get from materialized view first
    const viewResult = await pool.query(`
      SELECT * FROM games_count_by_period LIMIT 1
    `).catch(() => null);
    
    if (viewResult && viewResult.rows.length > 0) {
      return res.json(viewResult.rows[0]);
    }
    
    // Fallback: Calculate directly
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE completed_at >= CURRENT_DATE) as today,
        COUNT(*) FILTER (WHERE completed_at >= CURRENT_DATE - INTERVAL '7 days') as this_week,
        COUNT(*) FILTER (WHERE completed_at >= CURRENT_DATE - INTERVAL '30 days') as this_month,
        COUNT(*) as all_time
      FROM game_sessions
      WHERE status = 'completed'
    `);
    
    res.json(result.rows[0] || { today: 0, this_week: 0, this_month: 0, all_time: 0 });
  } catch (error) {
    logger.error('Error getting games count:', error);
    res.status(500).json({ error: 'Failed to fetch games count' });
  }
});

// ============================================
// PEAK TIMES ANALYTICS
// ============================================
router.get('/api/analytics/peak-times', authenticateAdmin, async (req, res) => {
  try {
    // Check if hourly stats table exists and has data
    const checkData = await pool.query(`
      SELECT COUNT(*) as count FROM game_session_hourly_stats
    `).catch(() => ({ rows: [{ count: 0 }] }));

    if (parseInt(checkData.rows[0].count) === 0) {
      logger.info('Populating hourly stats for the first time...');
      
      // Try to create the table if it doesn't exist
      await pool.query(`
        CREATE TABLE IF NOT EXISTS game_session_hourly_stats (
          id SERIAL PRIMARY KEY,
          date DATE NOT NULL,
          hour_of_day INTEGER NOT NULL,
          day_of_week INTEGER NOT NULL,
          games_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(date, hour_of_day, day_of_week)
        )
      `).catch(err => logger.warn('Table might already exist:', err.message));
      
      // Populate with historical data
      await pool.query(`
        INSERT INTO game_session_hourly_stats (date, hour_of_day, day_of_week, games_count)
        SELECT
          DATE(completed_at) as date,
          EXTRACT(HOUR FROM completed_at)::INTEGER as hour_of_day,
          EXTRACT(DOW FROM completed_at)::INTEGER as day_of_week,
          COUNT(*) as games_count
        FROM game_sessions
        WHERE status = 'completed'
        AND completed_at IS NOT NULL
        GROUP BY DATE(completed_at), EXTRACT(HOUR FROM completed_at), EXTRACT(DOW FROM completed_at)
        ON CONFLICT (date, hour_of_day, day_of_week) 
        DO UPDATE SET games_count = EXCLUDED.games_count
      `).catch(err => logger.error('Error populating hourly stats:', err));
    }

    const result = await pool.query(`
      SELECT 
        hour_of_day,
        day_of_week,
        SUM(games_count) as total_games,
        CASE day_of_week
          WHEN 0 THEN 'Sunday'
          WHEN 1 THEN 'Monday'
          WHEN 2 THEN 'Tuesday'
          WHEN 3 THEN 'Wednesday'
          WHEN 4 THEN 'Thursday'
          WHEN 5 THEN 'Friday'
          WHEN 6 THEN 'Saturday'
        END as day_name
      FROM game_session_hourly_stats
      WHERE date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY hour_of_day, day_of_week
      ORDER BY day_of_week, hour_of_day
    `).catch(() => ({ rows: [] }));

    res.json(result.rows);
  } catch (error) {
    logger.error('Error getting peak times:', error);
    res.status(500).json({ error: 'Failed to fetch peak times' });
  }
});

// ============================================
// LGA/CITY PERFORMANCE
// ============================================
router.get('/api/analytics/lga-performance', authenticateAdmin, async (req, res) => {
  try {
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_lga_performance',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

    // Use 'city' field since that's what exists in your schema
    const lgaStats = await pool.query(`
      SELECT
        city as lga,
        COUNT(*) as user_count,
        COALESCE(SUM(total_games_played), 0) as total_games,
        COALESCE(SUM(total_winnings), 0) as total_winnings,
        COALESCE(AVG(total_winnings), 0) as avg_winnings_per_user,
        ROUND(
          COALESCE(AVG(total_games_played), 0),
          1
        ) as avg_games_per_user
      FROM users
      WHERE city IS NOT NULL
      GROUP BY city
      ORDER BY total_games DESC
      LIMIT 15
    `);

    res.json(lgaStats.rows);
  } catch (error) {
    logger.error('Error getting LGA performance:', error);
    res.status(500).json({ error: 'Failed to fetch LGA performance' });
  }
});

// ============================================
// ENHANCED ANALYTICS (COMPREHENSIVE)
// ============================================
router.get('/api/analytics/enhanced', authenticateAdmin, async (req, res) => {
  try {
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_enhanced_analytics',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

    // Games count by period
    const gamesCount = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE completed_at >= CURRENT_DATE) as today,
        COUNT(*) FILTER (WHERE completed_at >= CURRENT_DATE - INTERVAL '7 days') as this_week,
        COUNT(*) FILTER (WHERE completed_at >= CURRENT_DATE - INTERVAL '30 days') as this_month,
        COUNT(*) as all_time
      FROM game_sessions
      WHERE status = 'completed'
    `);
    
    // Peak times (simplified)
    const peakTimes = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM started_at)::INTEGER as hour_of_day,
        EXTRACT(DOW FROM started_at)::INTEGER as day_of_week,
        COUNT(*) as total_games
      FROM game_sessions
      WHERE started_at >= CURRENT_DATE - INTERVAL '30 days'
      AND status = 'completed'
      GROUP BY hour_of_day, day_of_week
      ORDER BY hour_of_day, day_of_week
    `).catch(() => ({ rows: [] }));

    // Question categories (if exists)
    const questionCategories = await pool.query(`
      SELECT 
        category,
        COUNT(*) as question_count,
        SUM(times_asked) as total_times_asked,
        SUM(times_correct) as total_times_correct,
        CASE 
          WHEN SUM(times_asked) > 0 THEN
            ROUND((SUM(times_correct)::numeric / SUM(times_asked)::numeric) * 100, 1)
          ELSE 0
        END as success_rate
      FROM questions
      WHERE is_active = true
      GROUP BY category
      ORDER BY total_times_asked DESC
      LIMIT 10
    `).catch(() => ({ rows: [] }));

    // Daily active users
    const dailyActiveUsers = await pool.query(`
      SELECT 
        DATE(last_active) as date,
        COUNT(DISTINCT id) as active_users
      FROM users
      WHERE last_active >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(last_active)
      ORDER BY date ASC
    `);

    // Engagement funnel
    const engagementFunnel = await pool.query(`
      SELECT 
        COUNT(*) as total_registered,
        COUNT(CASE WHEN total_games_played > 0 THEN 1 END) as started_game,
        COUNT(CASE WHEN total_games_played >= 3 THEN 1 END) as played_3_games,
        COUNT(CASE WHEN total_winnings > 0 THEN 1 END) as won_prize,
        COUNT(CASE WHEN total_games_played >= 10 THEN 1 END) as power_users
      FROM users
    `);

    // City performance
    const lgaPerformance = await pool.query(`
      SELECT 
        city as lga,
        COUNT(*) as user_count,
        COALESCE(SUM(total_games_played), 0) as total_games,
        COALESCE(SUM(total_winnings), 0) as total_winnings,
        COALESCE(AVG(total_winnings), 0) as avg_winnings_per_user
      FROM users
      WHERE city IS NOT NULL
      GROUP BY city
      ORDER BY total_games DESC
      LIMIT 10
    `);

    // Difficulty trends
    const difficultyTrends = await pool.query(`
      SELECT 
        difficulty,
        COUNT(*) as question_count,
        SUM(times_asked) as total_asked,
        SUM(times_correct) as total_correct,
        CASE 
          WHEN SUM(times_asked) > 0 THEN 
            ROUND((SUM(times_correct)::numeric / SUM(times_asked)::numeric) * 100, 1)
          ELSE 0
        END as success_rate
      FROM questions
      WHERE is_active = true AND times_asked > 0
      GROUP BY difficulty
      ORDER BY difficulty ASC
    `);

    // Conversion rate
    const conversionRate = await pool.query(`
      SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN total_games_played > 0 THEN 1 END) as converted_users,
        ROUND(
          (COUNT(CASE WHEN total_games_played > 0 THEN 1 END)::numeric / NULLIF(COUNT(*), 0)::numeric) * 100,
          1
        ) as conversion_rate_percentage
      FROM users
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
    `);

    // Session duration
    const sessionDuration = await pool.query(`
      SELECT 
        AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_duration_seconds,
        MIN(EXTRACT(EPOCH FROM (completed_at - started_at))) as min_duration_seconds,
        MAX(EXTRACT(EPOCH FROM (completed_at - started_at))) as max_duration_seconds
      FROM game_sessions
      WHERE status = 'completed'
        AND completed_at IS NOT NULL
        AND started_at IS NOT NULL
        AND completed_at >= CURRENT_DATE - INTERVAL '7 days'
    `).catch(() => ({ rows: [{ avg_duration_seconds: 0, min_duration_seconds: 0, max_duration_seconds: 0 }] }));

    // Win rate by question
    const winRateByQuestion = await pool.query(`
      SELECT 
        current_question,
        COUNT(*) as attempts,
        COUNT(CASE WHEN final_score > 0 THEN 1 END) as wins,
        ROUND(
          (COUNT(CASE WHEN final_score > 0 THEN 1 END)::numeric / NULLIF(COUNT(*), 0)::numeric) * 100,
          1
        ) as win_rate_percentage
      FROM game_sessions
      WHERE status = 'completed'
        AND current_question BETWEEN 1 AND 15
      GROUP BY current_question
      ORDER BY current_question ASC
    `);

    // Returning users
    const returningUsers = await pool.query(`
      SELECT 
        COUNT(DISTINCT CASE 
          WHEN last_active >= CURRENT_DATE - INTERVAL '7 days' THEN id 
        END) as active_last_7_days,
        COUNT(DISTINCT CASE 
          WHEN last_active >= CURRENT_DATE - INTERVAL '14 days' 
          AND last_active < CURRENT_DATE - INTERVAL '7 days' THEN id 
        END) as active_7_to_14_days_ago
      FROM users
      WHERE last_active IS NOT NULL
    `);

    res.json({
      gamesCount: gamesCount.rows[0],
      peakTimes: peakTimes.rows,
      questionCategories: questionCategories.rows,
      dailyActiveUsers: dailyActiveUsers.rows,
      engagementFunnel: engagementFunnel.rows[0],
      lgaPerformance: lgaPerformance.rows,
      difficultyTrends: difficultyTrends.rows,
      conversionRate: conversionRate.rows[0],
      sessionDuration: sessionDuration.rows[0],
      winRateByQuestion: winRateByQuestion.rows,
      returningUsers: returningUsers.rows[0]
    });
  } catch (error) {
    logger.error('Error getting enhanced analytics:', error);
    res.status(500).json({ error: 'Failed to fetch enhanced analytics' });
  }
});

// ============================================
// QUESTION CATEGORIES ANALYTICS
// ============================================
router.get('/api/analytics/categories', authenticateAdmin, async (req, res) => {
  try {
    // Try materialized view first, fallback to direct query
    const result = await pool.query(`
      SELECT 
        category,
        COUNT(*) as question_count,
        SUM(times_asked) as total_times_asked,
        SUM(times_correct) as total_times_correct,
        CASE 
          WHEN SUM(times_asked) > 0 THEN
            ROUND((SUM(times_correct)::numeric / SUM(times_asked)::numeric) * 100, 1)
          ELSE 0
        END as success_rate
      FROM questions
      WHERE is_active = true
      GROUP BY category
      ORDER BY total_times_asked DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    logger.error('Error getting category performance:', error);
    res.status(500).json({ error: 'Failed to fetch category performance' });
  }
});

// ============================================
// END OF MISSING ENDPOINTS
// ============================================

// ============================================
// END OF BATCH 3
// Continue to BATCH 4 for Payout Management
// ============================================
// ============================================
// BATCH 4 of 6: PAYOUT & USER MANAGEMENT
// Add after BATCH 3
// ============================================

// ============================================
// PAYOUT ROUTES
// ============================================

router.get('/api/payouts/pending', authenticateAdmin, async (req, res) => {
  try {
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_payouts',
      { filter: req.query.status || 'all' },
      getIpAddress(req),
      req.headers['user-agent']
    );

    const status = req.query.status;
    const payouts = await payoutService.getAllPendingPayouts(status);
    res.json(payouts);
  } catch (error) {
    logger.error('Error getting pending payouts:', error);
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

router.get('/api/payouts/history', authenticateAdmin, async (req, res) => {
  try {
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
        u.city,
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

router.get('/api/payouts/:id', authenticateAdmin, async (req, res) => {
  try {
    const transactionId = req.params.id;

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
        u.city,
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

router.post('/api/payouts/:id/approve', authenticateAdmin, async (req, res) => {
  try {
    const transactionId = req.params.id;
    const success = await payoutService.approvePayout(transactionId, req.adminSession.admin_id);

    if (success) {
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
        
        // Use MessagingService to handle both platforms
        const MessagingService = require('../services/messaging.service');
        const messagingService = new MessagingService();
        
        await messagingService.sendMessage(
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

router.post('/api/payouts/:id/reverify', authenticateAdmin, async (req, res) => {
  try {
    const transactionId = req.params.id;
    const result = await payoutService.reverifyPayout(transactionId);

    if (result.success) {
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

// ============================================
// USER ROUTES
// ============================================

router.get('/api/users', authenticateAdmin, async (req, res) => {
  try {
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
        id, full_name, username, phone_number, city, age,
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

// ============================================
// END OF BATCH 4
// Continue to BATCH 5 for Question Management
// ============================================
// ============================================
// BATCH 5 of 6: QUESTION MANAGEMENT
// Add after BATCH 4
// ============================================

router.get('/api/questions', authenticateAdmin, async (req, res) => {
  try {
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

router.delete('/api/questions/:id', authenticateAdmin, async (req, res) => {
  try {
    const questionId = req.params.id;

    await pool.query(
      'UPDATE questions SET is_active = false WHERE id = $1',
      [questionId]
    );

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

// ============================================
// END OF BATCH 5
// Continue to BATCH 6 for Tournament Management & Export
// ============================================
// ============================================
// BATCH 6 of 6: TOURNAMENT MANAGEMENT & MODULE EXPORT (FINAL)
// Add after BATCH 5
// ============================================

// ============================================
// TOURNAMENT MANAGEMENT ROUTES
// ============================================

router.get('/api/tournaments', authenticateAdmin, async (req, res) => {
    try {
        await adminAuthService.logActivity(
            req.adminSession.admin_id,
            'view_tournaments',
            {},
            getIpAddress(req),
            req.headers['user-agent']
        );
        
        const result = await pool.query(`
            SELECT 
                t.*,
                COUNT(DISTINCT tp.user_id) as participant_count,
                COUNT(DISTINCT tep.user_id) FILTER (WHERE tep.payment_status = 'success') as paid_entries,
                COALESCE(SUM(tep.amount) FILTER (WHERE tep.payment_status = 'success'), 0) as total_revenue
            FROM tournaments t
            LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
            LEFT JOIN tournament_entry_payments tep ON t.id = tep.tournament_id
            GROUP BY t.id
            ORDER BY t.created_at DESC
        `);
        
        res.json({ tournaments: result.rows });
    } catch (error) {
        logger.error('Error getting tournaments:', error);
        res.status(500).json({ error: 'Failed to fetch tournaments' });
    }
});

router.get('/api/tournaments/:id(\\d+)', authenticateAdmin, async (req, res) => {
    try {
        const tournamentId = req.params.id;
        
        const result = await pool.query(`
            SELECT 
                t.*,
                COUNT(DISTINCT tp.user_id) as participant_count,
                COUNT(DISTINCT tep.user_id) FILTER (WHERE tep.payment_status = 'success') as paid_entries,
                ti.welcome_message,
                ti.instructions,
                ti.prize_structure,
                ti.sponsor_branding,
                ti.rules
            FROM tournaments t
            LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
            LEFT JOIN tournament_entry_payments tep ON t.id = tep.tournament_id
            LEFT JOIN tournament_instructions ti ON t.id = ti.tournament_id
            WHERE t.id = $1
            GROUP BY t.id, ti.id
        `, [tournamentId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Tournament not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        logger.error('Error getting tournament:', error);
        res.status(500).json({ error: 'Failed to fetch tournament' });
    }
});

router.post('/api/tournaments', authenticateAdmin, async (req, res) => {
    try {
        const {
            tournamentName,
            tournamentType,
            sponsorName,
            sponsorLogoUrl,
            description,
            paymentType,
            usesTokens,
            tokensPerEntry,
            unlimitedPlays,
            entryFee,
            prizePool,
            maxParticipants,
            startDate,
            endDate,
            questionCategory,
            customInstructions,
            customBranding,
            status
        } = req.body;
        
        // Validation
        if (!tournamentName || !startDate || !endDate || !prizePool) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        if (paymentType === 'paid' && !entryFee) {
            return res.status(400).json({ error: 'Entry fee required for paid tournaments' });
        }
        
        if (usesTokens && !tokensPerEntry) {
            return res.status(400).json({ error: 'Tokens per entry required when using token system' });
        }
        
        // Create tournament
        const result = await pool.query(`
            INSERT INTO tournaments (
                tournament_name, tournament_type, sponsor_name, sponsor_logo_url,
                description, payment_type, uses_tokens, tokens_per_entry, 
                unlimited_plays, entry_fee, prize_pool, max_participants,
                start_date, end_date, question_category, custom_instructions,
                custom_branding, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            RETURNING *
        `, [
            tournamentName, tournamentType || 'sponsored', sponsorName, sponsorLogoUrl,
            description, paymentType || 'free', usesTokens || false, tokensPerEntry,
            unlimitedPlays !== false, entryFee || 0, prizePool, maxParticipants,
            startDate, endDate, questionCategory, customInstructions,
            customBranding, status || 'upcoming'
        ]);
        
        await adminAuthService.logActivity(
            req.adminSession.admin_id,
            'create_tournament',
            { tournament_id: result.rows[0].id, tournament_name: tournamentName },
            getIpAddress(req),
            req.headers['user-agent']
        );
        
        logger.info(`Tournament created: ${result.rows[0].id} - ${tournamentName}`);
        
        res.json({ success: true, tournament: result.rows[0] });
    } catch (error) {
        logger.error('Error creating tournament:', error);
        res.status(500).json({ error: 'Failed to create tournament' });
    }
});

router.put('/api/tournaments/:id', authenticateAdmin, async (req, res) => {
    try {
        const tournamentId = req.params.id;
        const {
            tournamentName,
            tournamentType,
            sponsorName,
            sponsorLogoUrl,
            description,
            paymentType,
            usesTokens,
            tokensPerEntry,
            unlimitedPlays,
            entryFee,
            prizePool,
            maxParticipants,
            startDate,
            endDate,
            questionCategory,
            customInstructions,
            customBranding,
            status
        } = req.body;
        
        const result = await pool.query(`
            UPDATE tournaments
            SET tournament_name = $1,
                tournament_type = $2,
                sponsor_name = $3,
                sponsor_logo_url = $4,
                description = $5,
                payment_type = $6,
                uses_tokens = $7,
                tokens_per_entry = $8,
                unlimited_plays = $9,
                entry_fee = $10,
                prize_pool = $11,
                max_participants = $12,
                start_date = $13,
                end_date = $14,
                question_category = $15,
                custom_instructions = $16,
                custom_branding = $17,
                status = $18
            WHERE id = $19
            RETURNING *
        `, [
            tournamentName, tournamentType, sponsorName, sponsorLogoUrl,
            description, paymentType, usesTokens, tokensPerEntry,
            unlimitedPlays, entryFee, prizePool, maxParticipants,
            startDate, endDate, questionCategory, customInstructions,
            customBranding, status, tournamentId
        ]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Tournament not found' });
        }
        
        await adminAuthService.logActivity(
            req.adminSession.admin_id,
            'update_tournament',
            { tournament_id: tournamentId },
            getIpAddress(req),
            req.headers['user-agent']
        );
        
        res.json({ success: true, tournament: result.rows[0] });
    } catch (error) {
        logger.error('Error updating tournament:', error);
        res.status(500).json({ error: 'Failed to update tournament' });
    }
});

router.delete('/api/tournaments/:id', authenticateAdmin, async (req, res) => {
    try {
        const tournamentId = req.params.id;
        
        // Check if tournament has participants
        const participantCheck = await pool.query(
            'SELECT COUNT(*) as count FROM tournament_participants WHERE tournament_id = $1',
            [tournamentId]
        );
        
        if (parseInt(participantCheck.rows[0].count) > 0) {
            return res.status(400).json({ 
                error: 'Cannot delete tournament with participants. Set status to cancelled instead.' 
            });
        }
        
        await pool.query('DELETE FROM tournaments WHERE id = $1', [tournamentId]);
        
        await adminAuthService.logActivity(
            req.adminSession.admin_id,
            'delete_tournament',
            { tournament_id: tournamentId },
            getIpAddress(req),
            req.headers['user-agent']
        );
        
        res.json({ success: true });
    } catch (error) {
        logger.error('Error deleting tournament:', error);
        res.status(500).json({ error: 'Failed to delete tournament' });
    }
});

router.get('/api/tournaments/:id/participants', authenticateAdmin, async (req, res) => {
    try {
        const tournamentId = req.params.id;
        
        const result = await pool.query(`
            SELECT 
                tp.*,
                u.full_name,
                u.username,
                u.phone_number,
                u.city,
                tep.payment_status,
                tep.paid_at,
                tep.amount as paid_amount
            FROM tournament_participants tp
            JOIN users u ON tp.user_id = u.id
            LEFT JOIN tournament_entry_payments tep 
                ON tp.tournament_id = tep.tournament_id 
                AND tp.user_id = tep.user_id
            WHERE tp.tournament_id = $1
            ORDER BY tp.rank ASC NULLS LAST, tp.best_score DESC
        `, [tournamentId]);
        
        res.json({ participants: result.rows });
    } catch (error) {
        logger.error('Error getting tournament participants:', error);
        res.status(500).json({ error: 'Failed to fetch participants' });
    }
});

router.post('/api/tournaments/:id/end', authenticateAdmin, async (req, res) => {
    try {
        const tournamentId = req.params.id;
        const { preview = false, notifyWinners = true, customDistribution = null } = req.body;
        
        const TournamentService = require('../services/tournament.service');
        const tournamentService = new TournamentService();
        
        const result = await tournamentService.endTournament(tournamentId, {
            preview,
            notifyWinners,
            customDistribution
        });
        
        if (result.success) {
            if (!preview) {
                await adminAuthService.logActivity(
                    req.adminSession.admin_id,
                    'end_tournament',
                    { 
                        tournament_id: tournamentId, 
                        winners_count: result.winnersCount,
                        total_distributed: result.totalDistributed 
                    },
                    getIpAddress(req),
                    req.headers['user-agent']
                );
            }
            
            res.json(result);
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        logger.error('Error ending tournament:', error);
        res.status(500).json({ error: 'Failed to end tournament' });
    }
});

// Preview tournament prize distribution
router.get('/api/tournaments/:id/prize-preview', authenticateAdmin, async (req, res) => {
    try {
        const tournamentId = req.params.id;
        const TournamentService = require('../services/tournament.service');
        const tournamentService = new TournamentService();
        
        const result = await tournamentService.getTournamentPrizePreview(tournamentId);
        
        res.json(result);
    } catch (error) {
        logger.error('Error getting prize preview:', error);
        res.status(500).json({ error: 'Failed to get prize preview' });
    }
});
// ============================================
// ANALYTICS ENDPOINTS - ADD BEFORE module.exports
// ============================================

// Get daily user growth
router.get('/api/analytics/users/daily', authenticateAdmin, async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const data = await analyticsService.getDailyUserGrowth(days);
        res.json({ success: true, data });
    } catch (error) {
        logger.error('Error getting daily user growth:', error);
        res.status(500).json({ error: 'Failed to get user growth data' });
    }
});

// Get weekly user growth
router.get('/api/analytics/users/weekly', authenticateAdmin, async (req, res) => {
    try {
        const weeks = parseInt(req.query.weeks) || 12;
        const data = await analyticsService.getWeeklyUserGrowth(weeks);
        res.json({ success: true, data });
    } catch (error) {
        logger.error('Error getting weekly user growth:', error);
        res.status(500).json({ error: 'Failed to get user growth data' });
    }
});

// Get monthly user growth
router.get('/api/analytics/users/monthly', authenticateAdmin, async (req, res) => {
    try {
        const months = parseInt(req.query.months) || 12;
        const data = await analyticsService.getMonthlyUserGrowth(months);
        res.json({ success: true, data });
    } catch (error) {
        logger.error('Error getting monthly user growth:', error);
        res.status(500).json({ error: 'Failed to get user growth data' });
    }
});

// Get user growth summary (all periods)
router.get('/api/analytics/users/growth-summary', authenticateAdmin, async (req, res) => {
    try {
        const data = await analyticsService.getUserGrowthSummary();
        res.json({ success: true, data });
    } catch (error) {
        logger.error('Error getting user growth summary:', error);
        res.status(500).json({ error: 'Failed to get user growth summary' });
    }
});

// Get global leaderboard (all platforms)
router.get('/api/leaderboard/global', authenticateAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;
        const data = await analyticsService.getGlobalLeaderboard(limit, offset);
        res.json({ success: true, data, total: data.length });
    } catch (error) {
        logger.error('Error getting global leaderboard:', error);
        res.status(500).json({ error: 'Failed to get leaderboard' });
    }
});

// Get platform-specific leaderboard
router.get('/api/leaderboard/:platform', authenticateAdmin, async (req, res) => {
    try {
        const platform = req.params.platform;
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;
        
        if (!['whatsapp', 'telegram'].includes(platform.toLowerCase())) {
            return res.status(400).json({ error: 'Invalid platform. Use "whatsapp" or "telegram"' });
        }
        
        const data = await analyticsService.getPlatformLeaderboard(platform, limit, offset);
        res.json({ success: true, platform, data, total: data.length });
    } catch (error) {
        logger.error(`Error getting ${req.params.platform} leaderboard:`, error);
        res.status(500).json({ error: 'Failed to get leaderboard' });
    }
});

// Get leaderboard by timeframe
router.get('/api/leaderboard/timeframe/:timeframe', authenticateAdmin, async (req, res) => {
    try {
        const timeframe = req.params.timeframe;
        const platform = req.query.platform || null;
        const limit = parseInt(req.query.limit) || 100;
        
        if (!['daily', 'weekly', 'monthly', 'all-time'].includes(timeframe)) {
            return res.status(400).json({ 
                error: 'Invalid timeframe. Use "daily", "weekly", "monthly", or "all-time"' 
            });
        }
        
        const data = await analyticsService.getLeaderboardByTimeframe(timeframe, platform, limit);
        res.json({ success: true, timeframe, platform: platform || 'all', data });
    } catch (error) {
        logger.error(`Error getting ${req.params.timeframe} leaderboard:`, error);
        res.status(500).json({ error: 'Failed to get leaderboard' });
    }
});

// Get all tournaments with stats
router.get('/api/tournaments/stats', authenticateAdmin, async (req, res) => {
    try {
        const data = await analyticsService.getTournamentsWithStats();
        res.json({ success: true, data });
    } catch (error) {
        logger.error('Error getting tournaments stats:', error);
        res.status(500).json({ error: 'Failed to get tournament statistics' });
    }
});

// Get tournament leaderboard by tournament ID
router.get('/api/tournaments/:id/leaderboard', authenticateAdmin, async (req, res) => {
    try {
        const tournamentId = parseInt(req.params.id);
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;
        
        const data = await analyticsService.getTournamentLeaderboard(tournamentId, limit, offset);
        res.json({ 
            success: true, 
            tournament_id: tournamentId,
            data,
            total: data.length 
        });
    } catch (error) {
        logger.error(`Error getting tournament ${req.params.id} leaderboard:`, error);
        res.status(500).json({ error: 'Failed to get tournament leaderboard' });
    }
});

// Get referral statistics
router.get('/api/analytics/referrals/stats', authenticateAdmin, async (req, res) => {
    try {
        const data = await analyticsService.getReferralStats();
        res.json({ success: true, data });
    } catch (error) {
        logger.error('Error getting referral stats:', error);
        res.status(500).json({ error: 'Failed to get referral statistics' });
    }
});

// Get top referrers
router.get('/api/analytics/referrals/top', authenticateAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const data = await analyticsService.getTopReferrers(limit);
        res.json({ success: true, data });
    } catch (error) {
        logger.error('Error getting top referrers:', error);
        res.status(500).json({ error: 'Failed to get top referrers' });
    }
});

// Get revenue statistics
router.get('/api/analytics/revenue/stats', authenticateAdmin, async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const data = await analyticsService.getRevenueStats(days);
        res.json({ success: true, data });
    } catch (error) {
        logger.error('Error getting revenue stats:', error);
        res.status(500).json({ error: 'Failed to get revenue statistics' });
    }
});

// Get daily revenue trend
router.get('/api/analytics/revenue/daily', authenticateAdmin, async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const data = await analyticsService.getDailyRevenue(days);
        res.json({ success: true, data });
    } catch (error) {
        logger.error('Error getting daily revenue:', error);
        res.status(500).json({ error: 'Failed to get daily revenue data' });
    }
});

// Get game statistics
router.get('/api/analytics/games/stats', authenticateAdmin, async (req, res) => {
    try {
        const data = await analyticsService.getGameStats();
        res.json({ success: true, data });
    } catch (error) {
        logger.error('Error getting game stats:', error);
        res.status(500).json({ error: 'Failed to get game statistics' });
    }
});

// Refresh leaderboard cache manually
router.post('/api/leaderboard/refresh', authenticateAdmin, async (req, res) => {
    try {
        await analyticsService.refreshLeaderboardCache();
        res.json({ success: true, message: 'Leaderboard cache refreshed successfully' });
    } catch (error) {
        logger.error('Error refreshing leaderboard:', error);
        res.status(500).json({ error: 'Failed to refresh leaderboard cache' });
    }
});

// ============================================
// GAME AUDIT TRAIL ENDPOINTS
// ============================================

const auditService = require('../services/audit.service');

// Get audit statistics overview
router.get('/api/audit/stats', authenticateAdmin, async (req, res) => {
    try {
        const stats = await auditService.getAuditStats();
        res.json({ success: true, stats });
    } catch (error) {
        logger.error('Error getting audit stats:', error);
        res.status(500).json({ error: 'Failed to get audit statistics' });
    }
});

// Search game sessions for audit
router.get('/api/audit/sessions', authenticateAdmin, async (req, res) => {
    try {
        const { 
            page = 1, 
            limit = 20, 
            username, 
            phone, 
            user_id,
            game_mode,
            platform,
            status,
            min_score,
            max_score,
            date_from,
            date_to 
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        // Base WHERE clause that will be shared between count and data queries
        let whereClause = `WHERE gs.started_at > NOW() - INTERVAL '7 days'`;
        const params = [];
        let paramIndex = 1;

        if (username) {
            whereClause += ` AND LOWER(u.username) LIKE LOWER($${paramIndex})`;
            params.push(`%${username}%`);
            paramIndex++;
        }

        if (phone) {
            whereClause += ` AND u.phone_number LIKE $${paramIndex}`;
            params.push(`%${phone}%`);
            paramIndex++;
        }

        if (user_id) {
            whereClause += ` AND gs.user_id = $${paramIndex}`;
            params.push(parseInt(user_id));
            paramIndex++;
        }

        if (game_mode) {
            whereClause += ` AND gs.game_mode = $${paramIndex}`;
            params.push(game_mode);
            paramIndex++;
        }

        if (platform) {
            whereClause += ` AND gs.platform = $${paramIndex}`;
            params.push(platform);
            paramIndex++;
        }

        if (status) {
            whereClause += ` AND gs.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (min_score) {
            whereClause += ` AND gs.final_score >= $${paramIndex}`;
            params.push(parseInt(min_score));
            paramIndex++;
        }

        if (max_score) {
            whereClause += ` AND gs.final_score <= $${paramIndex}`;
            params.push(parseInt(max_score));
            paramIndex++;
        }

        if (date_from) {
            whereClause += ` AND gs.started_at >= $${paramIndex}`;
            params.push(date_from);
            paramIndex++;
        }

        if (date_to) {
            whereClause += ` AND gs.started_at <= $${paramIndex}`;
            params.push(date_to);
            paramIndex++;
        }

        // Count query
        const countQuery = `
            SELECT COUNT(*) as total
            FROM game_sessions gs
            JOIN users u ON gs.user_id = u.id
            ${whereClause}
        `;
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].total);

        // Data query with pagination
        const dataQuery = `
            SELECT 
                gs.id as session_id,
                gs.user_id,
                u.username,
                u.full_name,
                u.phone_number,
                gs.game_mode,
                gs.platform,
                gs.final_score,
                gs.status,
                gs.started_at,
                gs.completed_at,
                gs.current_question as questions_reached,
                gs.lifeline_5050_used,
                gs.lifeline_skip_used,
                gs.is_tournament_game,
                gs.tournament_id,
                (SELECT COUNT(*) FROM game_audit_logs WHERE session_id = gs.id) as audit_events_count
            FROM game_sessions gs
            JOIN users u ON gs.user_id = u.id
            ${whereClause}
            ORDER BY gs.started_at DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;
        
        const dataParams = [...params, parseInt(limit), offset];
        const result = await pool.query(dataQuery, dataParams);

        res.json({
            success: true,
            sessions: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        logger.error('Error searching audit sessions:', error);
        res.status(500).json({ error: 'Failed to search sessions' });
    }
});

// Get detailed audit trail for a specific session
router.get('/api/audit/session/:sessionId', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const report = await auditService.generateSessionReport(parseInt(sessionId));

        if (!report) {
            return res.status(404).json({ error: 'Session not found or no audit data available' });
        }

        res.json({ success: true, report });
    } catch (error) {
        logger.error('Error getting session audit:', error);
        res.status(500).json({ error: 'Failed to get session audit trail' });
    }
});

// Get raw audit events for a session (for detailed inspection)
router.get('/api/audit/session/:sessionId/events', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const events = await auditService.getSessionAuditTrail(parseInt(sessionId));

        res.json({ success: true, events });
    } catch (error) {
        logger.error('Error getting audit events:', error);
        res.status(500).json({ error: 'Failed to get audit events' });
    }
});

// Get audit trail for a specific user
router.get('/api/audit/user/:userId', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { date_from, date_to } = req.query;

        const events = await auditService.getUserAuditTrail(
            parseInt(userId),
            date_from || null,
            date_to || null
        );

        // Get user info
        const userResult = await pool.query(
            'SELECT id, username, full_name, phone_number FROM users WHERE id = $1',
            [parseInt(userId)]
        );

        res.json({
            success: true,
            user: userResult.rows[0] || null,
            events,
            eventCount: events.length
        });
    } catch (error) {
        logger.error('Error getting user audit:', error);
        res.status(500).json({ error: 'Failed to get user audit trail' });
    }
});

// Generate printable audit report (HTML format)
// Uses authenticateAdminWithQuery to accept token from query param (for new tab)
router.get('/api/audit/session/:sessionId/print', authenticateAdminWithQuery, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const report = await auditService.generateSessionReport(parseInt(sessionId));

        if (!report) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Generate HTML report
        const html = generatePrintableAuditReport(report);
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        logger.error('Error generating printable report:', error);
        res.status(500).json({ error: 'Failed to generate printable report' });
    }
});

// Export audit report as JSON (for download)
// Uses authenticateAdminWithQuery to accept token from query param (for new tab)
router.get('/api/audit/session/:sessionId/export', authenticateAdminWithQuery, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const report = await auditService.generateSessionReport(parseInt(sessionId));

        if (!report) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=audit_session_${sessionId}.json`);
        res.send(JSON.stringify(report, null, 2));
    } catch (error) {
        logger.error('Error exporting audit report:', error);
        res.status(500).json({ error: 'Failed to export audit report' });
    }
});

// Find suspicious sessions (fast correct answers, possible cheating)
router.get('/api/audit/suspicious', authenticateAdmin, async (req, res) => {
    try {
        const { min_correct = 5, max_response_time_ms = 2000 } = req.query;

        const result = await pool.query(`
            SELECT 
                gal.session_id,
                gs.user_id,
                u.username,
                u.phone_number,
                gs.game_mode,
                gs.platform,
                gs.final_score,
                gs.started_at,
                COUNT(*) as fast_correct_answers,
                AVG((gal.event_data->>'response_time_ms')::int) as avg_response_time_ms,
                MIN((gal.event_data->>'response_time_ms')::int) as min_response_time_ms
            FROM game_audit_logs gal
            JOIN game_sessions gs ON gal.session_id = gs.id
            JOIN users u ON gs.user_id = u.id
            WHERE gal.event_type = 'ANSWER_GIVEN'
            AND (gal.event_data->>'is_correct')::boolean = true
            AND (gal.event_data->>'response_time_ms')::int < $1
            AND gal.created_at > NOW() - INTERVAL '7 days'
            GROUP BY gal.session_id, gs.user_id, u.username, u.phone_number, 
                     gs.game_mode, gs.platform, gs.final_score, gs.started_at
            HAVING COUNT(*) >= $2
            ORDER BY COUNT(*) DESC, AVG((gal.event_data->>'response_time_ms')::int) ASC
            LIMIT 50
        `, [parseInt(max_response_time_ms), parseInt(min_correct)]);

        res.json({
            success: true,
            suspicious_sessions: result.rows,
            criteria: {
                max_response_time_ms: parseInt(max_response_time_ms),
                min_fast_correct_answers: parseInt(min_correct)
            }
        });
    } catch (error) {
        logger.error('Error finding suspicious sessions:', error);
        res.status(500).json({ error: 'Failed to find suspicious sessions' });
    }
});

// Manual audit cleanup (admin triggered)
router.post('/api/audit/cleanup', authenticateAdmin, async (req, res) => {
    try {
        const { retention_days = 7 } = req.body;

        // Validate retention days (minimum 1, maximum 30)
        const days = Math.max(1, Math.min(30, parseInt(retention_days)));

        const result = await auditService.cleanupOldAuditLogs(days);

        res.json({
            success: true,
            message: `Cleaned up audit logs older than ${days} days`,
            deleted: result.deleted
        });
    } catch (error) {
        logger.error('Error cleaning up audit logs:', error);
        res.status(500).json({ error: 'Failed to cleanup audit logs' });
    }
});

// ============================================
// HELPER FUNCTION: Generate Printable HTML Report
// ============================================

function generatePrintableAuditReport(report) {
    const formatDate = (date) => new Date(date).toLocaleString();
    const formatMs = (ms) => ms ? `${(ms / 1000).toFixed(2)}s` : 'N/A';

    let questionsHtml = '';
    let questionNum = 0;
    
    for (const event of report.timeline) {
        if (event.event === 'QUESTION_ASKED') {
            questionNum++;
            const q = event.data;
            questionsHtml += `
                <div class="question-block">
                    <h4>Question ${q.question_number} - ₦${q.prize_at_stake?.toLocaleString() || 0}</h4>
                    <p class="question-text">${q.question_text}</p>
                    <div class="options">
                        <div class="option ${q.correct_answer === 'A' ? 'correct' : ''}">A) ${q.option_a}</div>
                        <div class="option ${q.correct_answer === 'B' ? 'correct' : ''}">B) ${q.option_b}</div>
                        <div class="option ${q.correct_answer === 'C' ? 'correct' : ''}">C) ${q.option_c}</div>
                        <div class="option ${q.correct_answer === 'D' ? 'correct' : ''}">D) ${q.option_d}</div>
                    </div>
                    <p class="meta">Correct Answer: <strong>${q.correct_answer}</strong> | Difficulty: ${q.difficulty || 'N/A'} | Category: ${q.category || 'General'}</p>
                </div>
            `;
        } else if (event.event === 'ANSWER_GIVEN') {
            const a = event.data;
            questionsHtml += `
                <div class="answer-block ${a.is_correct ? 'correct-answer' : 'wrong-answer'}">
                    <p>
                        <strong>User Answer:</strong> ${a.user_answer} 
                        ${a.is_correct ? '✅ CORRECT' : '❌ WRONG'} 
                        | <strong>Response Time:</strong> ${formatMs(a.response_time_ms)}
                    </p>
                </div>
            `;
        } else if (event.event === 'LIFELINE_USED') {
            const l = event.data;
            questionsHtml += `
                <div class="lifeline-block">
                    <p>💎 <strong>Lifeline Used:</strong> ${l.lifeline_type} on Question ${l.question_number}</p>
                </div>
            `;
        } else if (event.event === 'TIMEOUT') {
            questionsHtml += `
                <div class="timeout-block">
                    <p>⏰ <strong>TIMEOUT</strong> on Question ${event.data.question_number}</p>
                </div>
            `;
        } else if (event.event === 'TURBO_MODE_ACTIVATED') {
            questionsHtml += `
                <div class="turbo-block" style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 10px 0; border-radius: 5px;">
                    <p>⚡🚨 <strong>TURBO MODE ACTIVATED</strong> at Question ${event.data.question_number}</p>
                    <p style="font-size: 12px; color: #856404;">Reason: ${event.data.trigger_reason}</p>
                    <p style="font-size: 12px; color: #856404;">Next ${event.data.turbo_questions} questions reduced to ${event.data.reduced_timeout}</p>
                </div>
            `;
        } else if (event.event === 'TURBO_MODE_COMPLETED') {
            questionsHtml += `
                <div class="turbo-complete-block" style="background: #d1ecf1; border-left: 4px solid #17a2b8; padding: 15px; margin: 10px 0; border-radius: 5px;">
                    <p>⚡✅ <strong>TURBO MODE COMPLETED</strong> - User passed the speed test</p>
                </div>
            `;
        } else if (event.event === 'TURBO_MODE_GO_RECEIVED') {
            questionsHtml += `
                <div class="turbo-go-block" style="background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin: 10px 0; border-radius: 5px;">
                    <p>⚡🏃 <strong>USER TYPED GO</strong> - Continuing with turbo questions</p>
                </div>
            `;
        } else if (event.event === 'TURBO_MODE_GO_TIMEOUT') {
            questionsHtml += `
                <div class="turbo-timeout-block" style="background: #f8d7da; border-left: 4px solid #dc3545; padding: 15px; margin: 10px 0; border-radius: 5px;">
                    <p>⚡⏰ <strong>TURBO MODE TIMEOUT</strong> - User failed to type GO within 30 seconds</p>
                    <p style="font-size: 12px; color: #721c24;">Game ended due to inactivity during turbo mode challenge</p>
                </div>
            `;
        }
    }

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Audit Report - Session #${report.session_id}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            line-height: 1.6; 
            padding: 20px;
            max-width: 900px;
            margin: 0 auto;
            color: #333;
        }
        .header { 
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 30px;
        }
        .header h1 { margin-bottom: 10px; }
        .header .session-id { 
            font-size: 14px; 
            opacity: 0.8;
            background: rgba(255,255,255,0.1);
            padding: 5px 10px;
            border-radius: 5px;
            display: inline-block;
        }
        .section {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 20px;
            margin-bottom: 20px;
            border-left: 4px solid #007bff;
        }
        .section h3 {
            color: #007bff;
            margin-bottom: 15px;
            border-bottom: 1px solid #dee2e6;
            padding-bottom: 10px;
        }
        .info-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
        }
        .info-item {
            background: white;
            padding: 10px 15px;
            border-radius: 5px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .info-item label {
            font-size: 12px;
            color: #666;
            text-transform: uppercase;
        }
        .info-item .value {
            font-size: 16px;
            font-weight: 600;
            color: #333;
        }
        .question-block {
            background: white;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 15px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        .question-block h4 {
            color: #007bff;
            margin-bottom: 10px;
        }
        .question-text {
            font-size: 16px;
            font-weight: 500;
            margin-bottom: 15px;
            color: #333;
        }
        .options {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
            margin-bottom: 10px;
        }
        .option {
            padding: 10px;
            background: #f8f9fa;
            border-radius: 5px;
            border: 1px solid #dee2e6;
        }
        .option.correct {
            background: #d4edda;
            border-color: #28a745;
            color: #155724;
        }
        .meta {
            font-size: 12px;
            color: #666;
        }
        .answer-block {
            padding: 10px 20px;
            border-radius: 5px;
            margin: -10px 0 15px 0;
        }
        .correct-answer {
            background: #d4edda;
            border-left: 4px solid #28a745;
        }
        .wrong-answer {
            background: #f8d7da;
            border-left: 4px solid #dc3545;
        }
        .lifeline-block {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 10px 20px;
            border-radius: 5px;
            margin-bottom: 15px;
        }
        .timeout-block {
            background: #f8d7da;
            border-left: 4px solid #dc3545;
            padding: 10px 20px;
            border-radius: 5px;
            margin-bottom: 15px;
        }
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 15px;
        }
        .summary-item {
            text-align: center;
            background: white;
            padding: 15px;
            border-radius: 8px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        .summary-item .number {
            font-size: 28px;
            font-weight: bold;
            color: #007bff;
        }
        .summary-item .label {
            font-size: 12px;
            color: #666;
            text-transform: uppercase;
        }
        .print-button {
            position: fixed;
            top: 20px;
            right: 20px;
            background: #007bff;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
        }
        .print-button:hover {
            background: #0056b3;
        }
        .footer {
            text-align: center;
            padding: 20px;
            color: #666;
            font-size: 12px;
            border-top: 1px solid #dee2e6;
            margin-top: 30px;
        }
        @media print {
            .print-button { display: none; }
            body { padding: 0; }
            .header { 
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
            }
        }
    </style>
</head>
<body>
    <button class="print-button" onclick="window.print()">🖨️ Print Report</button>

    <div class="header">
        <h1>🎮 Game Session Audit Report</h1>
        <span class="session-id">Session ID: #${report.session_id}</span>
    </div>

    <div class="section">
        <h3>👤 Player Information</h3>
        <div class="info-grid">
            <div class="info-item">
                <label>Username</label>
                <div class="value">@${report.user.username}</div>
            </div>
            <div class="info-item">
                <label>Full Name</label>
                <div class="value">${report.user.full_name}</div>
            </div>
            <div class="info-item">
                <label>Phone Number</label>
                <div class="value">${report.user.phone}</div>
            </div>
            <div class="info-item">
                <label>User ID</label>
                <div class="value">#${report.user.id}</div>
            </div>
        </div>
    </div>

    <div class="section">
        <h3>🎯 Game Information</h3>
        <div class="info-grid">
            <div class="info-item">
                <label>Game Mode</label>
                <div class="value">${report.game_info.mode?.toUpperCase() || 'N/A'}</div>
            </div>
            <div class="info-item">
                <label>Final Score</label>
                <div class="value">₦${report.game_info.final_score?.toLocaleString() || 0}</div>
            </div>
            <div class="info-item">
                <label>Status</label>
                <div class="value">${report.game_info.status?.toUpperCase() || 'N/A'}</div>
            </div>
            <div class="info-item">
                <label>Started At</label>
                <div class="value">${formatDate(report.game_info.started)}</div>
            </div>
            <div class="info-item">
                <label>Completed At</label>
                <div class="value">${report.game_info.completed ? formatDate(report.game_info.completed) : 'N/A'}</div>
            </div>
            <div class="info-item">
                <label>Duration</label>
                <div class="value">${report.game_info.started && report.game_info.completed ? 
                    Math.round((new Date(report.game_info.completed) - new Date(report.game_info.started)) / 1000) + 's' : 'N/A'}</div>
            </div>
        </div>
    </div>

    <div class="section">
        <h3>📊 Session Summary</h3>
        <div class="summary-grid">
            <div class="summary-item">
                <div class="number">${report.summary.total_questions}</div>
                <div class="label">Questions Asked</div>
            </div>
            <div class="summary-item">
                <div class="number" style="color: #28a745;">${report.summary.correct_answers}</div>
                <div class="label">Correct</div>
            </div>
            <div class="summary-item">
                <div class="number" style="color: #dc3545;">${report.summary.wrong_answers}</div>
                <div class="label">Wrong</div>
            </div>
            <div class="summary-item">
                <div class="number">${formatMs(report.summary.average_response_time_ms)}</div>
                <div class="label">Avg Response</div>
            </div>
        </div>
        ${report.summary.lifelines_used.length > 0 ? `
        <p style="margin-top: 15px; text-align: center;">
            <strong>Lifelines Used:</strong> ${report.summary.lifelines_used.join(', ')}
        </p>
        ` : ''}
        ${report.summary.timeouts > 0 ? `
        <p style="margin-top: 10px; text-align: center; color: #dc3545;">
            <strong>Timeouts:</strong> ${report.summary.timeouts}
        </p>
        ` : ''}
    </div>

    <div class="section">
        <h3>📝 Question-by-Question Timeline</h3>
        ${questionsHtml}
    </div>

    <div class="footer">
        <p>What's Up Trivia - Game Audit Report</p>
        <p>Generated on ${new Date().toLocaleString()}</p>
        <p>This report is for internal use and dispute resolution purposes.</p>
    </div>
</body>
</html>
    `;
}


// ============================================
// STREAK ADMIN ENDPOINTS
// ============================================

// Get streak overview statistics
router.get('/api/streaks/stats', authenticateAdmin, async (req, res) => {
    try {
        // Total users with active streaks
        const activeStreaksResult = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE current_streak > 0) as active_streaks,
                COUNT(*) FILTER (WHERE current_streak >= 3) as streak_3_plus,
                COUNT(*) FILTER (WHERE current_streak >= 7) as streak_7_plus,
                COUNT(*) FILTER (WHERE current_streak >= 14) as streak_14_plus,
                COUNT(*) FILTER (WHERE current_streak >= 30) as streak_30_plus,
                COUNT(*) FILTER (WHERE current_streak >= 60) as streak_60_plus,
                MAX(current_streak) as highest_current_streak,
                MAX(longest_streak) as highest_ever_streak,
                AVG(current_streak) FILTER (WHERE current_streak > 0) as avg_active_streak,
                COUNT(*) FILTER (WHERE last_play_date = CURRENT_DATE) as played_today,
                COUNT(*) FILTER (WHERE last_play_date = CURRENT_DATE - 1) as at_risk
            FROM users
        `);

        // Streak distribution (for chart)
        const distributionResult = await pool.query(`
            SELECT streak_range, COUNT(*) as count
            FROM (
                SELECT 
                    CASE 
                        WHEN current_streak = 0 THEN '0'
                        WHEN current_streak BETWEEN 1 AND 2 THEN '1-2'
                        WHEN current_streak BETWEEN 3 AND 6 THEN '3-6'
                        WHEN current_streak BETWEEN 7 AND 13 THEN '7-13'
                        WHEN current_streak BETWEEN 14 AND 29 THEN '14-29'
                        WHEN current_streak BETWEEN 30 AND 59 THEN '30-59'
                        ELSE '60+'
                    END as streak_range
                FROM users
            ) sub
            GROUP BY streak_range
            ORDER BY 
                CASE streak_range
                    WHEN '0' THEN 1
                    WHEN '1-2' THEN 2
                    WHEN '3-6' THEN 3
                    WHEN '7-13' THEN 4
                    WHEN '14-29' THEN 5
                    WHEN '30-59' THEN 6
                    ELSE 7
                END
        `);

        // Recent streak activity (last 7 days)
        const recentActivityResult = await pool.query(`
            SELECT 
                last_play_date as date,
                COUNT(*) as players
            FROM users
            WHERE last_play_date >= CURRENT_DATE - 7
            AND last_play_date IS NOT NULL
            GROUP BY last_play_date
            ORDER BY last_play_date DESC
        `);

        // Total rewards given - check if table exists first
        let rewards = { total_rewards: 0, total_games_given: 0, rewards_today: 0, rewards_this_week: 0 };
        try {
            const rewardsResult = await pool.query(`
                SELECT 
                    COUNT(*) as total_rewards,
                    COALESCE(SUM(reward_amount), 0) as total_games_given,
                    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as rewards_today,
                    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as rewards_this_week
                FROM streak_rewards
            `);
            rewards = rewardsResult.rows[0] || rewards;
        } catch (e) {
            // streak_rewards table might not exist yet
            logger.warn('streak_rewards table not found, using defaults');
        }

        const stats = activeStreaksResult.rows[0];

        res.json({
            success: true,
            stats: {
                activeStreaks: parseInt(stats.active_streaks) || 0,
                streak3Plus: parseInt(stats.streak_3_plus) || 0,
                streak7Plus: parseInt(stats.streak_7_plus) || 0,
                streak14Plus: parseInt(stats.streak_14_plus) || 0,
                streak30Plus: parseInt(stats.streak_30_plus) || 0,
                streak60Plus: parseInt(stats.streak_60_plus) || 0,
                highestCurrentStreak: parseInt(stats.highest_current_streak) || 0,
                highestEverStreak: parseInt(stats.highest_ever_streak) || 0,
                avgActiveStreak: parseFloat(stats.avg_active_streak || 0).toFixed(1),
                playedToday: parseInt(stats.played_today) || 0,
                atRisk: parseInt(stats.at_risk) || 0,
                totalRewardsGiven: parseInt(rewards.total_rewards) || 0,
                totalGamesGiven: parseInt(rewards.total_games_given) || 0,
                rewardsToday: parseInt(rewards.rewards_today) || 0,
                rewardsThisWeek: parseInt(rewards.rewards_this_week) || 0
            },
            distribution: distributionResult.rows,
            recentActivity: recentActivityResult.rows
        });
    } catch (error) {
        logger.error('Error getting streak stats:', error);
        res.status(500).json({ error: 'Failed to get streak statistics' });
    }
});

// Get streak leaderboard
router.get('/api/streaks/leaderboard', authenticateAdmin, async (req, res) => {
    try {
        const { limit = 20, type = 'current' } = req.query;

        let orderBy = 'current_streak DESC, longest_streak DESC';
        if (type === 'longest') {
            orderBy = 'longest_streak DESC, current_streak DESC';
        }

        const result = await pool.query(`
            SELECT 
                u.id,
                u.username,
                u.full_name,
                u.phone_number,
                u.city,
                u.platform,
                u.current_streak,
                u.longest_streak,
                u.last_play_date,
                u.streak_badge,
                u.created_at as member_since,
                (SELECT COUNT(*) FROM game_sessions WHERE user_id = u.id AND status = 'completed') as total_games
            FROM users u
            WHERE u.current_streak > 0 OR u.longest_streak > 0
            ORDER BY ${orderBy}
            LIMIT $1
        `, [parseInt(limit)]);

        const leaderboard = result.rows.map((user, index) => {
            let badgeEmoji = '';
            switch (user.streak_badge) {
                case 'diamond': badgeEmoji = '💎'; break;
                case 'trophy': badgeEmoji = '🏆'; break;
                case 'fire3': badgeEmoji = '🔥🔥🔥'; break;
                case 'fire2': badgeEmoji = '🔥🔥'; break;
                case 'fire1': badgeEmoji = '🔥'; break;
            }

            return {
                rank: index + 1,
                id: user.id,
                username: user.username,
                fullName: user.full_name,
                phone: user.phone_number,
                city: user.city,
                platform: user.platform,
                currentStreak: user.current_streak,
                longestStreak: user.longest_streak,
                lastPlayDate: user.last_play_date,
                badge: user.streak_badge,
                badgeEmoji,
                totalGames: parseInt(user.total_games) || 0,
                memberSince: user.member_since
            };
        });

        res.json({
            success: true,
            leaderboard,
            type
        });
    } catch (error) {
        logger.error('Error getting streak leaderboard:', error);
        res.status(500).json({ error: 'Failed to get streak leaderboard' });
    }
});

// Get recent streak rewards
router.get('/api/streaks/rewards', authenticateAdmin, async (req, res) => {
    try {
        const { limit = 20 } = req.query;

        // Check if table exists
        let rewards = [];
        try {
            const result = await pool.query(`
                SELECT 
                    sr.id,
                    sr.user_id,
                    sr.streak_days,
                    sr.reward_type,
                    sr.reward_amount,
                    sr.reward_description,
                    sr.created_at,
                    u.username,
                    u.full_name,
                    u.phone_number,
                    u.platform
                FROM streak_rewards sr
                JOIN users u ON sr.user_id = u.id
                ORDER BY sr.created_at DESC
                LIMIT $1
            `, [parseInt(limit)]);
            
            rewards = result.rows.map(r => ({
                id: r.id,
                userId: r.user_id,
                username: r.username,
                fullName: r.full_name,
                phone: r.phone_number,
                platform: r.platform,
                streakDays: r.streak_days,
                rewardType: r.reward_type,
                rewardAmount: r.reward_amount,
                description: r.reward_description,
                createdAt: r.created_at
            }));
        } catch (e) {
            logger.warn('streak_rewards table not found');
        }

        res.json({
            success: true,
            rewards
        });
    } catch (error) {
        logger.error('Error getting streak rewards:', error);
        res.status(500).json({ error: 'Failed to get streak rewards' });
    }
});

// Get streak champions (60+ days)
router.get('/api/streaks/champions', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                u.id,
                u.username,
                u.full_name,
                u.city,
                u.platform,
                u.current_streak,
                u.longest_streak,
                u.last_play_date,
                (SELECT COALESCE(SUM(final_score), 0) FROM game_sessions WHERE user_id = u.id AND status = 'completed') as total_winnings
            FROM users u
            WHERE u.current_streak >= 60
            ORDER BY u.current_streak DESC
        `);

        res.json({
            success: true,
            champions: result.rows.map(u => ({
                id: u.id,
                username: u.username,
                fullName: u.full_name,
                city: u.city,
                platform: u.platform,
                currentStreak: u.current_streak,
                longestStreak: u.longest_streak,
                lastPlayDate: u.last_play_date,
                totalWinnings: parseInt(u.total_winnings) || 0
            })),
            count: result.rows.length
        });
    } catch (error) {
        logger.error('Error getting streak champions:', error);
        res.status(500).json({ error: 'Failed to get streak champions' });
    }
});


// ============================================
// RESTRICTIONS & SUSPENSION ENDPOINTS
// ============================================

// Get all suspended users
router.get('/api/users/suspended', authenticateAdmin, async (req, res) => {
    try {
        const restrictionsService = require('../services/restrictions.service');
        const users = await restrictionsService.getSuspendedUsers();
        res.json({ success: true, users });
    } catch (error) {
        logger.error('Error getting suspended users:', error);
        res.status(500).json({ error: 'Failed to get suspended users' });
    }
});

// Suspend a user
router.post('/api/users/:id/suspend', authenticateAdmin, async (req, res) => {
    try {
        const restrictionsService = require('../services/restrictions.service');
        const { reason } = req.body;
        const userId = parseInt(req.params.id);
        const adminId = req.session?.adminId || null;
        
        const success = await restrictionsService.suspendUser(userId, reason, adminId);
        
        if (success) {
            res.json({ success: true, message: 'User suspended successfully' });
        } else {
            res.status(500).json({ error: 'Failed to suspend user' });
        }
    } catch (error) {
        logger.error('Error suspending user:', error);
        res.status(500).json({ error: 'Failed to suspend user' });
    }
});

// Unsuspend a user
router.post('/api/users/:id/unsuspend', authenticateAdmin, async (req, res) => {
    try {
        const restrictionsService = require('../services/restrictions.service');
        const userId = parseInt(req.params.id);
        const adminId = req.session?.adminId || null;
        
        const success = await restrictionsService.unsuspendUser(userId, adminId);
        
        if (success) {
            res.json({ success: true, message: 'User unsuspended successfully' });
        } else {
            res.status(500).json({ error: 'Failed to unsuspend user' });
        }
    } catch (error) {
        logger.error('Error unsuspending user:', error);
        res.status(500).json({ error: 'Failed to unsuspend user' });
    }
});

// Get users on grand prize cooldown
router.get('/api/users/cooldown', authenticateAdmin, async (req, res) => {
    try {
        const restrictionsService = require('../services/restrictions.service');
        const users = await restrictionsService.getUsersOnCooldown();
        res.json({ success: true, users });
    } catch (error) {
        logger.error('Error getting users on cooldown:', error);
        res.status(500).json({ error: 'Failed to get users on cooldown' });
    }
});

// Clear grand prize cooldown
router.post('/api/users/:id/clear-cooldown', authenticateAdmin, async (req, res) => {
    try {
        const restrictionsService = require('../services/restrictions.service');
        const userId = parseInt(req.params.id);
        const adminId = req.session?.adminId || null;
        
        const success = await restrictionsService.clearGrandPrizeCooldown(userId, adminId);
        
        if (success) {
            res.json({ success: true, message: 'Cooldown cleared successfully' });
        } else {
            res.status(500).json({ error: 'Failed to clear cooldown' });
        }
    } catch (error) {
        logger.error('Error clearing cooldown:', error);
        res.status(500).json({ error: 'Failed to clear cooldown' });
    }
});

// Get users at daily limit
router.get('/api/users/daily-limit', authenticateAdmin, async (req, res) => {
    try {
        const restrictionsService = require('../services/restrictions.service');
        const users = await restrictionsService.getUsersAtDailyLimit();
        res.json({ success: true, users });
    } catch (error) {
        logger.error('Error getting users at daily limit:', error);
        res.status(500).json({ error: 'Failed to get users at daily limit' });
    }
});

// ============================================
// ENHANCED USER MANAGEMENT ENDPOINTS
// ============================================

// Get user details with full profile
router.get('/api/users/:id/profile', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        
        // Get user basic info
        const userResult = await pool.query(`
            SELECT u.*, 
                   r.username as referrer_username,
                   r.full_name as referrer_name
            FROM users u
            LEFT JOIN users r ON u.referred_by = r.id
            WHERE u.id = $1
        `, [userId]);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        
        // Get game stats
        const statsResult = await pool.query(`
            SELECT 
                COUNT(*) as total_games,
                COUNT(*) FILTER (WHERE status = 'won') as games_won,
                COUNT(*) FILTER (WHERE status = 'lost') as games_lost,
                MAX(current_question) as highest_question,
                AVG(avg_response_time_ms) FILTER (WHERE avg_response_time_ms IS NOT NULL) as avg_response_time,
                COUNT(*) FILTER (WHERE suspicious_flag = true) as suspicious_games
            FROM game_sessions
            WHERE user_id = $1
        `, [userId]);
        
        // Get financial stats
        const financialResult = await pool.query(`
            SELECT 
                COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'prize'), 0) as total_winnings,
                COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'purchase'), 0) as total_purchases,
                COUNT(*) FILTER (WHERE transaction_type = 'prize') as prize_count,
                MAX(amount) FILTER (WHERE transaction_type = 'prize') as highest_win
            FROM transactions
            WHERE user_id = $1
        `, [userId]);
        
        // Get referral stats
        const referralResult = await pool.query(`
            SELECT COUNT(*) as referral_count
            FROM users
            WHERE referred_by = $1
        `, [userId]);
        
        // Get recent games
        const recentGamesResult = await pool.query(`
            SELECT id, game_mode, game_type, current_question, current_score, status,
                   started_at, completed_at, avg_response_time_ms, suspicious_flag
            FROM game_sessions
            WHERE user_id = $1
            ORDER BY started_at DESC
            LIMIT 20
        `, [userId]);
        
        // Get recent transactions
        const recentTransactionsResult = await pool.query(`
            SELECT id, transaction_type, amount, payment_status as status, created_at
            FROM transactions
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 20
        `, [userId]);
        
        // Get achievements
        const achievementsResult = await pool.query(`
            SELECT achievement_type, achievement_name, description, earned_at, metadata
            FROM user_achievements
            WHERE user_id = $1
            ORDER BY earned_at DESC
        `, [userId]);
        
        res.json({
            success: true,
            user,
            stats: statsResult.rows[0],
            financial: financialResult.rows[0],
            referrals: referralResult.rows[0],
            recentGames: recentGamesResult.rows,
            recentTransactions: recentTransactionsResult.rows,
            achievements: achievementsResult.rows
        });
    } catch (error) {
        logger.error('Error getting user profile:', error);
        res.status(500).json({ error: 'Failed to get user profile' });
    }
});

// Search users with multiple parameters
router.get('/api/users/search', authenticateAdmin, async (req, res) => {
    try {
        const { 
            query, username, phone, city, 
            minWinnings, maxWinnings, 
            minGames, maxGames,
            suspended, platform,
            dateFrom, dateTo,
            sortBy = 'created_at', sortOrder = 'DESC',
            limit = 50, offset = 0
        } = req.query;
        
        let sql = `
            SELECT u.*, 
                   COALESCE(t.total_winnings, 0) as total_winnings,
                   COALESCE(g.game_count, 0) as game_count
            FROM users u
            LEFT JOIN (
                SELECT user_id, SUM(amount) as total_winnings 
                FROM transactions WHERE transaction_type = 'prize' 
                GROUP BY user_id
            ) t ON u.id = t.user_id
            LEFT JOIN (
                SELECT user_id, COUNT(*) as game_count 
                FROM game_sessions 
                GROUP BY user_id
            ) g ON u.id = g.user_id
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;
        
        // General search query
        if (query) {
            sql += ` AND (u.username ILIKE $${paramIndex} OR u.full_name ILIKE $${paramIndex} OR u.phone_number ILIKE $${paramIndex})`;
            params.push(`%${query}%`);
            paramIndex++;
        }
        
        // Specific field searches
        if (username) {
            sql += ` AND u.username ILIKE $${paramIndex}`;
            params.push(`%${username}%`);
            paramIndex++;
        }
        
        if (phone) {
            sql += ` AND u.phone_number ILIKE $${paramIndex}`;
            params.push(`%${phone}%`);
            paramIndex++;
        }
        
        if (city) {
            sql += ` AND u.city ILIKE $${paramIndex}`;
            params.push(`%${city}%`);
            paramIndex++;
        }
        
        if (suspended !== undefined) {
            sql += ` AND u.is_suspended = $${paramIndex}`;
            params.push(suspended === 'true');
            paramIndex++;
        }
        
        if (platform) {
            if (platform === 'telegram') {
                sql += ` AND u.phone_number LIKE 'tg_%'`;
            } else if (platform === 'whatsapp') {
                sql += ` AND u.phone_number NOT LIKE 'tg_%'`;
            }
        }
        
        if (dateFrom) {
            sql += ` AND u.created_at >= $${paramIndex}`;
            params.push(dateFrom);
            paramIndex++;
        }
        
        if (dateTo) {
            sql += ` AND u.created_at <= $${paramIndex}`;
            params.push(dateTo);
            paramIndex++;
        }
        
        // Sorting
        const validSortColumns = ['created_at', 'username', 'total_winnings', 'game_count', 'current_streak'];
        const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
        const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        
        sql += ` ORDER BY ${sortColumn} ${order} NULLS LAST`;
        sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));
        
        const result = await pool.query(sql, params);
        
        // Get total count
        let countSql = `SELECT COUNT(*) FROM users u WHERE 1=1`;
        // Apply same filters for count (simplified)
        const countResult = await pool.query(countSql);
        
        res.json({
            success: true,
            users: result.rows,
            total: parseInt(countResult.rows[0].count),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        logger.error('Error searching users:', error);
        res.status(500).json({ error: 'Failed to search users' });
    }
});

// ============================================
// VICTORY CARDS ENDPOINTS
// ============================================

// Get all victory cards (for admin dashboard)
router.get('/api/victory-cards', authenticateAdmin, async (req, res) => {
    try {
        const victoryCardsService = require('../services/victory-cards.service');
        const { limit = 50, offset = 0, userId, minAmount, dateFrom, dateTo } = req.query;
        
        const cards = await victoryCardsService.getAllVictoryCards({
            limit: parseInt(limit),
            offset: parseInt(offset),
            userId: userId ? parseInt(userId) : null,
            minAmount: minAmount ? parseFloat(minAmount) : null,
            dateFrom,
            dateTo
        });
        
        res.json({ success: true, cards });
    } catch (error) {
        logger.error('Error getting victory cards:', error);
        res.status(500).json({ error: 'Failed to get victory cards' });
    }
});

// Get recent winners
router.get('/api/winners/recent', authenticateAdmin, async (req, res) => {
    try {
        const { 
            page = 1, 
            limit = 20, 
            search = '', 
            status = '', 
            mode = '', 
            minAmount = '' 
        } = req.query;
        
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;
        
        // Build query conditions
        let conditions = [`t.transaction_type = 'prize'`, `t.amount > 0`];
        let params = [];
        let paramIndex = 1;
        
        // Search filter
        if (search) {
            conditions.push(`(
                u.username ILIKE $${paramIndex} OR 
                u.full_name ILIKE $${paramIndex} OR 
                u.phone_number ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }
        
        // Status filter (shared/pending) - uses transactions.victory_card_shared
        if (status === 'shared') {
            conditions.push(`t.victory_card_shared = true`);
        } else if (status === 'pending') {
            conditions.push(`(t.victory_card_shared = false OR t.victory_card_shared IS NULL)`);
        }
        
        // Mode filter
        if (mode) {
            conditions.push(`gs.game_mode = $${paramIndex}`);
            params.push(mode);
            paramIndex++;
        }
        
        // Amount filter
        if (minAmount) {
            const amount = parseInt(minAmount);
            if (amount === 50000) {
                conditions.push(`t.amount = 50000`);
            } else {
                conditions.push(`t.amount >= $${paramIndex}`);
                params.push(amount);
                paramIndex++;
            }
        }
        
        const whereClause = conditions.join(' AND ');
        
        // Get total count
        const countQuery = `
            SELECT COUNT(DISTINCT t.id) as total
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            LEFT JOIN victory_cards vc ON t.id = vc.transaction_id
            LEFT JOIN game_sessions gs ON t.user_id = gs.user_id 
                AND DATE(gs.completed_at) = DATE(t.created_at)
                AND gs.current_score = t.amount
            WHERE ${whereClause}
        `;
        
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(total / limitNum);
        
        // Get winners with pagination
        const winnersQuery = `
            SELECT DISTINCT ON (t.id)
                t.id as transaction_id,
                t.amount,
                t.created_at as win_date,
                t.victory_card_shared,
                u.id as user_id,
                u.username,
                u.full_name,
                u.phone_number,
                vc.id as victory_card_id,
                gs.game_mode,
                gs.platform
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            LEFT JOIN victory_cards vc ON t.id = vc.transaction_id
            LEFT JOIN game_sessions gs ON t.user_id = gs.user_id 
                AND DATE(gs.completed_at) = DATE(t.created_at)
                AND gs.current_score = t.amount
            WHERE ${whereClause}
            ORDER BY t.id DESC, t.created_at DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;
        
        params.push(limitNum, offset);
        
        const winnersResult = await pool.query(winnersQuery, params);
        
        res.json({ 
            success: true, 
            winners: winnersResult.rows,
            total,
            totalPages,
            currentPage: pageNum,
            perPage: limitNum
        });
    } catch (error) {
        logger.error('Error getting recent winners:', error);
        res.status(500).json({ error: 'Failed to get recent winners' });
    }
});

// Regenerate victory card
router.post('/api/victory-cards/:id/regenerate', authenticateAdmin, async (req, res) => {
    try {
        const victoryCardsService = require('../services/victory-cards.service');
        const ImageService = require('../services/image.service');
        const imageService = new ImageService();
        
        const cardId = parseInt(req.params.id);
        const adminId = req.session?.adminId || null;
        
        // Try to get card data by victory_card_id first
        let cardData = await victoryCardsService.getVictoryCardData(cardId);
        
        // If not found, try by transaction_id
        if (!cardData) {
            cardData = await victoryCardsService.getVictoryCardByTransaction(cardId);
        }
        
        // If still not found, get from transaction directly
        if (!cardData) {
            const transactionResult = await pool.query(`
                SELECT t.id as transaction_id, t.amount, t.created_at as win_date,
                       u.id as user_id, u.username, u.full_name, u.city,
                       gs.current_question as questions_answered
                FROM transactions t
                JOIN users u ON t.user_id = u.id
                LEFT JOIN game_sessions gs ON t.user_id = gs.user_id 
                    AND DATE(gs.completed_at) = DATE(t.created_at)
                    AND gs.current_score = t.amount
                WHERE t.id = $1 AND t.transaction_type = 'prize'
            `, [cardId]);
            
            if (transactionResult.rows.length > 0) {
                cardData = transactionResult.rows[0];
                cardData.total_questions = 15;
            }
        }
        
        if (!cardData) {
            return res.status(404).json({ error: 'Victory card or transaction not found' });
        }
        
        // Calculate questionsAnswered from amount if not available
        // Prize tiers: Q5=₦1000, Q6=₦2000, Q7=₦3000, Q8=₦5000, Q9=₦7500, Q10=₦10000, 
        //              Q11=₦15000, Q12=₦20000, Q13=₦25000, Q14=₦35000, Q15=₦50000
        let questionsAnswered = cardData.questions_answered;
        if (!questionsAnswered) {
            const amount = parseFloat(cardData.amount);
            const prizeTiers = {
                50000: 15, 35000: 14, 25000: 13, 20000: 12, 15000: 11,
                10000: 10, 7500: 9, 5000: 8, 3000: 7, 2000: 6, 1000: 5
            };
            questionsAnswered = prizeTiers[amount] || Math.min(Math.floor(amount / 3000) + 5, 15);
        }
        
        // Generate the image
        const imagePath = await imageService.generateWinImage({
            name: cardData.full_name,
            username: cardData.username,
            city: cardData.city,
            amount: parseFloat(cardData.amount),
            questionsAnswered: questionsAnswered,
            totalQuestions: cardData.total_questions || 15
        });
        
        // Log regeneration if we have a victory card id
        if (cardData.id) {
            await victoryCardsService.logAdminRegeneration(cardData.id, adminId);
        }
        
        // Return the image path (or base64)
        const fs = require('fs');
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        
        // Clean up
        fs.unlinkSync(imagePath);
        imageService.cleanupTempFiles();
        
        res.json({ 
            success: true, 
            image: `data:image/png;base64,${base64Image}`,
            cardData
        });
    } catch (error) {
        logger.error('Error regenerating victory card:', error);
        res.status(500).json({ error: 'Failed to regenerate victory card' });
    }
});

// Get win statistics
router.get('/api/stats/wins', authenticateAdmin, async (req, res) => {
    try {
        const victoryCardsService = require('../services/victory-cards.service');
        const { period = 'today' } = req.query;
        
        const stats = await victoryCardsService.getWinStatistics(period);
        res.json({ success: true, stats });
    } catch (error) {
        logger.error('Error getting win statistics:', error);
        res.status(500).json({ error: 'Failed to get win statistics' });
    }
});

// ============================================
// ANTI-FRAUD ENDPOINTS
// ============================================

// Get flagged users
router.get('/api/fraud/flagged-users', authenticateAdmin, async (req, res) => {
    try {
        const antiFraudService = require('../services/anti-fraud.service');
        const { limit = 50 } = req.query;
        
        const users = await antiFraudService.getFlaggedUsers(parseInt(limit));
        res.json({ success: true, users });
    } catch (error) {
        logger.error('Error getting flagged users:', error);
        res.status(500).json({ error: 'Failed to get flagged users' });
    }
});

// Get suspicious sessions
router.get('/api/fraud/suspicious-sessions', authenticateAdmin, async (req, res) => {
    try {
        const antiFraudService = require('../services/anti-fraud.service');
        const { limit = 50 } = req.query;
        
        const sessions = await antiFraudService.getSuspiciousSessions(parseInt(limit));
        res.json({ success: true, sessions });
    } catch (error) {
        logger.error('Error getting suspicious sessions:', error);
        res.status(500).json({ error: 'Failed to get suspicious sessions' });
    }
});

// Get user fraud report
router.get('/api/fraud/user/:id', authenticateAdmin, async (req, res) => {
    try {
        const antiFraudService = require('../services/anti-fraud.service');
        const userId = parseInt(req.params.id);
        
        const report = await antiFraudService.getUserFraudReport(userId);
        
        if (!report) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Augment with anti-cheat stats from audit logs
        try {
            const acStats = await pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE event_type = 'TURBO_MODE_ACTIVATED') as turbo_triggers,
                    COUNT(*) FILTER (WHERE event_type = 'SESSION_TERMINATED') as sessions_terminated,
                    COUNT(*) FILTER (WHERE event_type = 'PHOTO_VERIFICATION_REQUESTED') as photo_verifications,
                    COUNT(*) FILTER (WHERE event_type = 'PHOTO_VERIFICATION_FAILED') as photo_failures,
                    COUNT(*) FILTER (WHERE event_type = 'Q1_TIMEOUT_TRACKED') as q1_timeouts,
                    COUNT(*) FILTER (WHERE event_type = 'PERFECT_GAME_FLAGGED') as perfect_flagged
                FROM game_audit_logs
                WHERE user_id = $1
            `, [userId]);
            
            const userExtra = await pool.query(`
                SELECT temp_suspended_until, temp_suspension_reason, penalty_games_remaining
                FROM users WHERE id = $1
            `, [userId]);
            
            if (acStats.rows[0]) {
                report.stats = { ...report.stats, ...acStats.rows[0] };
            }
            if (userExtra.rows[0]) {
                report.user = { ...report.user, ...userExtra.rows[0] };
                report.stats.temp_suspensions = userExtra.rows[0].temp_suspended_until ? 1 : 0;
                report.stats.penalty_games_remaining = userExtra.rows[0].penalty_games_remaining || 0;
            }
        } catch (acError) {
            logger.error('Error augmenting fraud report with anti-cheat stats:', acError);
            // Non-fatal — proceed with base report
        }
        
        res.json({ success: true, report });
    } catch (error) {
        logger.error('Error getting user fraud report:', error);
        res.status(500).json({ error: 'Failed to get fraud report' });
    }
});

// Clear user fraud flags
router.post('/api/fraud/user/:id/clear', authenticateAdmin, async (req, res) => {
    try {
        const antiFraudService = require('../services/anti-fraud.service');
        const userId = parseInt(req.params.id);
        const adminId = req.session?.adminId || null;
        
        const success = await antiFraudService.clearUserFlags(userId, adminId);
        
        if (success) {
            res.json({ success: true, message: 'Fraud flags cleared' });
        } else {
            res.status(500).json({ error: 'Failed to clear fraud flags' });
        }
    } catch (error) {
        logger.error('Error clearing fraud flags:', error);
        res.status(500).json({ error: 'Failed to clear fraud flags' });
    }
});

// ============================================
// TURBO MODE ENDPOINTS
// ============================================

// Get turbo mode statistics
router.get('/api/fraud/turbo-mode-stats', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE event_type = 'TURBO_MODE_ACTIVATED') as total_triggers,
                COUNT(*) FILTER (WHERE event_type = 'TURBO_MODE_GO_TIMEOUT') as total_timeouts,
                COUNT(*) FILTER (WHERE event_type = 'TURBO_MODE_GO_RECEIVED') as total_go_received,
                COUNT(*) FILTER (WHERE event_type = 'TURBO_MODE_COMPLETED') as total_completed,
                COUNT(DISTINCT user_id) FILTER (WHERE event_type = 'TURBO_MODE_ACTIVATED') as unique_users_triggered
            FROM game_audit_logs
            WHERE event_type LIKE 'TURBO_MODE%'
            AND created_at >= NOW() - INTERVAL '30 days'
        `);
        
        res.json({ 
            success: true, 
            stats: result.rows[0] || {
                total_triggers: 0,
                total_timeouts: 0,
                total_go_received: 0,
                total_completed: 0,
                unique_users_triggered: 0
            }
        });
    } catch (error) {
        logger.error('Error getting turbo mode stats:', error);
        res.status(500).json({ error: 'Failed to get turbo mode stats' });
    }
});

// Get turbo mode events
router.get('/api/fraud/turbo-mode-events', authenticateAdmin, async (req, res) => {
    try {
        const { limit = 100 } = req.query;
        
        const result = await pool.query(`
            SELECT 
                gal.id,
                gal.session_id,
                gal.user_id,
                gal.event_type,
                gal.event_data,
                gal.created_at,
                u.username,
                u.full_name
            FROM game_audit_logs gal
            LEFT JOIN users u ON gal.user_id = u.id
            WHERE gal.event_type LIKE 'TURBO_MODE%'
            ORDER BY gal.created_at DESC
            LIMIT $1
        `, [parseInt(limit)]);
        
        res.json({ success: true, events: result.rows });
    } catch (error) {
        logger.error('Error getting turbo mode events:', error);
        res.status(500).json({ error: 'Failed to get turbo mode events' });
    }
});

// ============================================
// ANTI-CHEAT MONITORING ENDPOINTS (NEW)
// ============================================

// Anti-cheat stats summary
router.get('/api/fraud/anticheat-stats', authenticateAdmin, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE event_type = 'SESSION_TERMINATED') as sessions_terminated,
                COUNT(*) FILTER (WHERE event_type = 'PERFECT_GAME_FLAGGED') as perfect_games_flagged,
                COUNT(*) FILTER (WHERE event_type = 'PHOTO_VERIFICATION_REQUESTED') as photo_verifications,
                COUNT(*) FILTER (WHERE event_type = 'Q1_TIMEOUT_TRACKED') as q1_timeouts
            FROM game_audit_logs
            WHERE created_at > NOW() - INTERVAL '7 days'
        `);
        
        res.json({ success: true, stats: stats.rows[0] || {} });
    } catch (error) {
        logger.error('Error getting anti-cheat stats:', error);
        res.status(500).json({ error: 'Failed to get anti-cheat stats' });
    }
});

// Anti-cheat events list (session terminations, photo verifs, perfect game flags, Q1 timeouts)
router.get('/api/fraud/anticheat-events', authenticateAdmin, async (req, res) => {
    try {
        const statsResult = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE event_type = 'SESSION_TERMINATED') as sessions_terminated,
                COUNT(*) FILTER (WHERE event_type = 'PERFECT_GAME_FLAGGED') as perfect_games_flagged,
                COUNT(*) FILTER (WHERE event_type = 'PHOTO_VERIFICATION_REQUESTED') as photo_requested,
                COUNT(*) FILTER (WHERE event_type = 'PHOTO_VERIFICATION_PASSED') as photo_passed,
                COUNT(*) FILTER (WHERE event_type = 'PHOTO_VERIFICATION_FAILED') as photo_failed
            FROM game_audit_logs
            WHERE created_at > NOW() - INTERVAL '7 days'
        `);
        
        const eventsResult = await pool.query(`
            SELECT gal.*, u.username, u.full_name
            FROM game_audit_logs gal
            LEFT JOIN users u ON gal.user_id = u.id
            WHERE gal.event_type IN (
                'SESSION_TERMINATED', 'PERFECT_GAME_FLAGGED',
                'PHOTO_VERIFICATION_REQUESTED', 'PHOTO_VERIFICATION_PASSED', 'PHOTO_VERIFICATION_FAILED',
                'Q1_TIMEOUT_TRACKED'
            )
            AND gal.created_at > NOW() - INTERVAL '7 days'
            ORDER BY gal.created_at DESC
            LIMIT 100
        `);
        
        res.json({
            success: true,
            stats: statsResult.rows[0] || {},
            events: eventsResult.rows
        });
    } catch (error) {
        logger.error('Error getting anti-cheat events:', error);
        res.status(500).json({ error: 'Failed to get anti-cheat events' });
    }
});

// Temp suspensions and penalty games data
router.get('/api/fraud/temp-suspensions', authenticateAdmin, async (req, res) => {
    try {
        // Currently temp-suspended users
        const tempSuspended = await pool.query(`
            SELECT id, username, full_name, phone_number, temp_suspended_until, temp_suspension_reason
            FROM users
            WHERE temp_suspended_until IS NOT NULL AND temp_suspended_until > NOW()
            ORDER BY temp_suspended_until DESC
        `);
        
        // Users serving penalty games
        const penaltyUsers = await pool.query(`
            SELECT id, username, full_name, phone_number, penalty_games_remaining, penalty_timer_seconds
            FROM users
            WHERE penalty_games_remaining > 0
            ORDER BY penalty_games_remaining DESC
        `);
        
        // Q1 timeout events in last 7 days
        const q1Stats = await pool.query(`
            SELECT COUNT(*) as count
            FROM game_audit_logs
            WHERE event_type = 'Q1_TIMEOUT_TRACKED'
            AND created_at > NOW() - INTERVAL '7 days'
        `);
        
        res.json({
            success: true,
            stats: {
                temp_suspended: tempSuspended.rows.length,
                serving_penalty: penaltyUsers.rows.length,
                q1_timeouts_week: parseInt(q1Stats.rows[0]?.count || 0)
            },
            tempSuspended: tempSuspended.rows,
            penaltyUsers: penaltyUsers.rows
        });
    } catch (error) {
        logger.error('Error getting temp suspensions:', error);
        res.status(500).json({ error: 'Failed to get temp suspensions' });
    }
});

// Lift temp suspension
router.post('/api/fraud/temp-suspension/:userId/lift', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        await pool.query(
            'UPDATE users SET temp_suspended_until = NULL, temp_suspension_reason = NULL WHERE id = $1',
            [userId]
        );
        logger.info(`Admin lifted temp suspension for user ${userId}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('Error lifting temp suspension:', error);
        res.status(500).json({ error: 'Failed to lift temp suspension' });
    }
});

// Clear penalty games
router.post('/api/fraud/penalty-games/:userId/clear', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        await pool.query(
            'UPDATE users SET penalty_games_remaining = 0, penalty_timer_seconds = NULL WHERE id = $1',
            [userId]
        );
        logger.info(`Admin cleared penalty games for user ${userId}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('Error clearing penalty games:', error);
        res.status(500).json({ error: 'Failed to clear penalty games' });
    }
});

// ============================================
// ACHIEVEMENTS ENDPOINTS
// ============================================

// Get achievement leaderboard
router.get('/api/achievements/leaderboard', authenticateAdmin, async (req, res) => {
    try {
        const achievementsService = require('../services/achievements.service');
        const { limit = 20 } = req.query;
        
        const leaderboard = await achievementsService.getAchievementLeaderboard(parseInt(limit));
        res.json({ success: true, leaderboard });
    } catch (error) {
        logger.error('Error getting achievement leaderboard:', error);
        res.status(500).json({ error: 'Failed to get achievement leaderboard' });
    }
});

// Get all possible achievements
router.get('/api/achievements/all', authenticateAdmin, async (req, res) => {
    try {
        const achievementsService = require('../services/achievements.service');
        const achievements = achievementsService.getAllAchievements();
        res.json({ success: true, achievements });
    } catch (error) {
        logger.error('Error getting all achievements:', error);
        res.status(500).json({ error: 'Failed to get achievements' });
    }
});

// ============================================
// SYSTEM SETTINGS ENDPOINTS
// ============================================

// Get current system settings
router.get('/api/settings', authenticateAdmin, async (req, res) => {
    try {
        res.json({
            success: true,
            settings: {
                maintenanceMode: process.env.MAINTENANCE_MODE === 'true',
                maintenanceMessage: process.env.MAINTENANCE_MESSAGE || '',
                grandPrizeCooldownDays: parseInt(process.env.GRAND_PRIZE_COOLDOWN_DAYS) || 7,
                dailyWinLimit: parseInt(process.env.DAILY_WIN_LIMIT) || 30000,
                paymentMode: process.env.PAYMENT_MODE || 'disabled'
            }
        });
    } catch (error) {
        logger.error('Error getting settings:', error);
        res.status(500).json({ error: 'Failed to get settings' });
    }
});

// ============================================
// SECURITY DASHBOARD
// ============================================

router.get('/api/security/dashboard', authenticateAdmin, async (req, res) => {
    try {
        const kycResult = await pool.query(`SELECT COUNT(*) as count FROM kyc_verifications WHERE status = 'submitted'`);
        
        const alertsResult = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'new') as new_alerts,
                COUNT(*) FILTER (WHERE severity = 'critical' AND status = 'new') as critical_alerts
            FROM fraud_alerts
        `);
        
        const multiAccountResult = await pool.query(`SELECT COUNT(*) as count FROM account_links WHERE is_confirmed IS NULL`);
        
        const highRiskResult = await pool.query(`SELECT COUNT(*) as count FROM user_behavior_patterns WHERE anomaly_score >= 70`);
        
        const captchaResult = await pool.query(`
            SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_correct = false) as failed
            FROM captcha_logs WHERE created_at >= NOW() - INTERVAL '24 hours'
        `);
        
        const sharedDevicesResult = await pool.query(`SELECT COUNT(DISTINCT device_id) as count FROM device_fingerprints WHERE is_flagged = true`);
        
        res.json({
            success: true,
            dashboard: {
                pendingKYC: parseInt(kycResult.rows[0]?.count || 0),
                newFraudAlerts: parseInt(alertsResult.rows[0]?.new_alerts || 0),
                criticalAlerts: parseInt(alertsResult.rows[0]?.critical_alerts || 0),
                unreviewedAccountLinks: parseInt(multiAccountResult.rows[0]?.count || 0),
                highRiskUsers: parseInt(highRiskResult.rows[0]?.count || 0),
                captchaStats: {
                    total: parseInt(captchaResult.rows[0]?.total || 0),
                    failed: parseInt(captchaResult.rows[0]?.failed || 0),
                    failureRate: captchaResult.rows[0]?.total > 0 
                        ? ((captchaResult.rows[0].failed / captchaResult.rows[0].total) * 100).toFixed(1) + '%'
                        : '0%'
                },
                flaggedDevices: parseInt(sharedDevicesResult.rows[0]?.count || 0)
            }
        });
    } catch (error) {
        logger.error('Error getting security dashboard:', error);
        res.status(500).json({ error: 'Failed to get security dashboard' });
    }
});

// ============================================
// KYC MANAGEMENT
// ============================================

router.get('/api/kyc/pending', authenticateAdmin, async (req, res) => {
    try {
        const kycService = require('../services/kyc.service');
        const pendingReviews = await kycService.getPendingKYCReviews();
        res.json({ success: true, reviews: pendingReviews });
    } catch (error) {
        logger.error('Error getting pending KYC reviews:', error);
        res.status(500).json({ error: 'Failed to get pending KYC reviews' });
    }
});

router.get('/api/kyc/all', authenticateAdmin, async (req, res) => {
    try {
        const { status, limit = 50, offset = 0 } = req.query;
        const kycService = require('../services/kyc.service');
        const records = await kycService.getAllKYCRecords(status, parseInt(limit), parseInt(offset));
        res.json({ success: true, records });
    } catch (error) {
        logger.error('Error getting KYC records:', error);
        res.status(500).json({ error: 'Failed to get KYC records' });
    }
});

router.get('/api/kyc/user/:userId', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const kycService = require('../services/kyc.service');
        const kycStatus = await kycService.getKYCStatus(userId);
        res.json({ success: true, kyc: kycStatus });
    } catch (error) {
        logger.error('Error getting user KYC status:', error);
        res.status(500).json({ error: 'Failed to get KYC status' });
    }
});

router.post('/api/kyc/:kycId/approve', authenticateAdmin, async (req, res) => {
    try {
        const kycId = parseInt(req.params.kycId);
        const adminId = req.session?.adminId || null;
        const { notes } = req.body;
        
        const kycService = require('../services/kyc.service');
        const result = await kycService.approveKYC(kycId, adminId, notes);
        
        if (result.success) {
            res.json({ success: true, message: 'KYC approved successfully' });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        logger.error('Error approving KYC:', error);
        res.status(500).json({ error: 'Failed to approve KYC' });
    }
});

router.post('/api/kyc/:kycId/reject', authenticateAdmin, async (req, res) => {
    try {
        const kycId = parseInt(req.params.kycId);
        const adminId = req.session?.adminId || null;
        const { reason } = req.body;
        
        if (!reason) {
            return res.status(400).json({ error: 'Rejection reason is required' });
        }
        
        const kycService = require('../services/kyc.service');
        const result = await kycService.rejectKYC(kycId, adminId, reason);
        
        if (result.success) {
            res.json({ success: true, message: 'KYC rejected' });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        logger.error('Error rejecting KYC:', error);
        res.status(500).json({ error: 'Failed to reject KYC' });
    }
});

// ============================================
// FRAUD ALERTS
// ============================================

router.get('/api/security/fraud-alerts', authenticateAdmin, async (req, res) => {
    try {
        const { status = 'new', limit = 50 } = req.query;
        const deviceTrackingService = require('../services/device-tracking.service');
        const alerts = await deviceTrackingService.getFraudAlerts(status, parseInt(limit));
        res.json({ success: true, alerts });
    } catch (error) {
        logger.error('Error getting fraud alerts:', error);
        res.status(500).json({ error: 'Failed to get fraud alerts' });
    }
});

router.post('/api/security/fraud-alerts/:alertId/resolve', authenticateAdmin, async (req, res) => {
    try {
        const alertId = parseInt(req.params.alertId);
        const adminId = req.session?.adminId || null;
        const { resolution, notes } = req.body;
        
        const deviceTrackingService = require('../services/device-tracking.service');
        const result = await deviceTrackingService.resolveFraudAlert(alertId, adminId, resolution, notes);
        
        res.json({ success: result, message: result ? 'Alert resolved' : 'Failed to resolve alert' });
    } catch (error) {
        logger.error('Error resolving fraud alert:', error);
        res.status(500).json({ error: 'Failed to resolve alert' });
    }
});

// ============================================
// DEVICE & IP TRACKING
// ============================================

router.get('/api/security/linked-accounts/:userId', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const deviceTrackingService = require('../services/device-tracking.service');
        const linkedAccounts = await deviceTrackingService.getLinkedAccounts(userId);
        res.json({ success: true, linkedAccounts });
    } catch (error) {
        logger.error('Error getting linked accounts:', error);
        res.status(500).json({ error: 'Failed to get linked accounts' });
    }
});

router.get('/api/security/shared-devices', authenticateAdmin, async (req, res) => {
    try {
        const deviceTrackingService = require('../services/device-tracking.service');
        const sharedDevices = await deviceTrackingService.getSharedDeviceUsers();
        res.json({ success: true, sharedDevices });
    } catch (error) {
        logger.error('Error getting shared devices:', error);
        res.status(500).json({ error: 'Failed to get shared devices' });
    }
});

router.get('/api/security/user-devices/:userId', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const deviceTrackingService = require('../services/device-tracking.service');
        const devices = await deviceTrackingService.getUserDevices(userId);
        res.json({ success: true, devices });
    } catch (error) {
        logger.error('Error getting user devices:', error);
        res.status(500).json({ error: 'Failed to get devices' });
    }
});

router.get('/api/security/user-ips/:userId', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const { days = 30 } = req.query;
        const deviceTrackingService = require('../services/device-tracking.service');
        const ips = await deviceTrackingService.getUserIPs(userId, parseInt(days));
        res.json({ success: true, ips });
    } catch (error) {
        logger.error('Error getting user IPs:', error);
        res.status(500).json({ error: 'Failed to get IPs' });
    }
});

router.post('/api/security/account-links/:linkId/review', authenticateAdmin, async (req, res) => {
    try {
        const linkId = parseInt(req.params.linkId);
        const adminId = req.session?.adminId || null;
        const { isConfirmed } = req.body;
        
        const deviceTrackingService = require('../services/device-tracking.service');
        const result = await deviceTrackingService.reviewAccountLink(linkId, adminId, isConfirmed);
        
        res.json({ success: result, message: result ? 'Link reviewed' : 'Failed to review link' });
    } catch (error) {
        logger.error('Error reviewing account link:', error);
        res.status(500).json({ error: 'Failed to review link' });
    }
});

// ============================================
// BEHAVIORAL ANALYSIS
// ============================================

router.get('/api/security/high-risk-users', authenticateAdmin, async (req, res) => {
    try {
        const { minScore = 50 } = req.query;
        const behavioralService = require('../services/behavioral-analysis.service');
        const users = await behavioralService.getHighRiskUsers(parseInt(minScore));
        res.json({ success: true, users });
    } catch (error) {
        logger.error('Error getting high risk users:', error);
        res.status(500).json({ error: 'Failed to get high risk users' });
    }
});

router.get('/api/security/behavior-profile/:userId', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const behavioralService = require('../services/behavioral-analysis.service');
        const profile = await behavioralService.getUserBehaviorProfile(userId);
        res.json({ success: true, profile });
    } catch (error) {
        logger.error('Error getting behavior profile:', error);
        res.status(500).json({ error: 'Failed to get behavior profile' });
    }
});

router.post('/api/security/analyze-behavior/:userId', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const behavioralService = require('../services/behavioral-analysis.service');
        const result = await behavioralService.updateBehaviorPatterns(userId);
        res.json({ success: true, result });
    } catch (error) {
        logger.error('Error analyzing behavior:', error);
        res.status(500).json({ error: 'Failed to analyze behavior' });
    }
});

router.post('/api/security/batch-analyze', authenticateAdmin, async (req, res) => {
    try {
        const behavioralService = require('../services/behavioral-analysis.service');
        const updatedCount = await behavioralService.batchUpdatePatterns();
        res.json({ success: true, updatedCount });
    } catch (error) {
        logger.error('Error in batch analysis:', error);
        res.status(500).json({ error: 'Failed to run batch analysis' });
    }
});

// ============================================
// CAPTCHA STATISTICS
// ============================================

router.get('/api/security/captcha-stats', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT captcha_type, COUNT(*) as type_count,
                   COUNT(*) FILTER (WHERE is_correct = true) as passed,
                   COUNT(*) FILTER (WHERE is_correct = false) as failed,
                   AVG(response_time_ms) as avg_response_time
            FROM captcha_logs
            WHERE created_at >= NOW() - INTERVAL '7 days'
            GROUP BY captcha_type
        `);
        
        const totalResult = await pool.query(`
            SELECT COUNT(*) as total,
                   COUNT(*) FILTER (WHERE is_correct = true) as passed,
                   COUNT(*) FILTER (WHERE is_correct = false) as failed
            FROM captcha_logs WHERE created_at >= NOW() - INTERVAL '7 days'
        `);
        
        res.json({ success: true, byType: result.rows, totals: totalResult.rows[0] });
    } catch (error) {
        logger.error('Error getting CAPTCHA stats:', error);
        res.status(500).json({ error: 'Failed to get CAPTCHA stats' });
    }
});

router.get('/api/security/suspicious-captcha-users', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT cl.user_id, u.username, u.full_name,
                   COUNT(*) as total_captchas,
                   COUNT(*) FILTER (WHERE cl.is_correct = false) as failures,
                   AVG(cl.response_time_ms) as avg_response_time,
                   MIN(cl.response_time_ms) as min_response_time
            FROM captcha_logs cl
            JOIN users u ON cl.user_id = u.id
            WHERE cl.created_at >= NOW() - INTERVAL '7 days'
            GROUP BY cl.user_id, u.username, u.full_name
            HAVING COUNT(*) FILTER (WHERE cl.is_correct = false) >= 3
                OR MIN(cl.response_time_ms) < 500
            ORDER BY COUNT(*) FILTER (WHERE cl.is_correct = false) DESC
        `);
        
        res.json({ success: true, users: result.rows });
    } catch (error) {
        logger.error('Error getting suspicious CAPTCHA users:', error);
        res.status(500).json({ error: 'Failed to get suspicious users' });
    }
});

// ============================================
// FINANCIAL DASHBOARD ROUTES
// ============================================

// Financial access middleware - Super Admin and Finance Officer only
const requireFinancialAccess = async (req, res, next) => {
  const allowedRoles = ['super_admin', 'finance_officer', 'super admin', 'finance officer'];
  const roleName = req.adminSession.role_name?.toLowerCase();
  if (!allowedRoles.includes(roleName)) {
    return res.status(403).json({ error: 'Access denied. Financial dashboard requires Super Admin or Finance Officer role.' });
  }
  next();
};

// Financial Dashboard Page
router.get('/financials', (req, res) => {
  res.sendFile('admin-financials.html', { root: './src/views' });
});

// Revenue Overview
router.get('/api/financials/overview', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_financial_overview', { start_date, end_date }, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getRevenueOverview(start_date, end_date);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting financial overview:', error);
    res.status(500).json({ error: 'Failed to fetch financial overview' });
  }
});

// Token Revenue Breakdown
router.get('/api/financials/token-revenue', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_token_revenue', { start_date, end_date }, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getTokenRevenueBreakdown(start_date, end_date);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting token revenue:', error);
    res.status(500).json({ error: 'Failed to fetch token revenue' });
  }
});

// Tournament Revenue
router.get('/api/financials/tournament-revenue', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_tournament_revenue', { start_date, end_date }, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getTournamentRevenue(start_date, end_date);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting tournament revenue:', error);
    res.status(500).json({ error: 'Failed to fetch tournament revenue' });
  }
});

// Classic Mode Winnings
router.get('/api/financials/classic-winnings', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_classic_winnings', { start_date, end_date }, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getClassicModeWinnings(start_date, end_date);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting classic winnings:', error);
    res.status(500).json({ error: 'Failed to fetch classic winnings' });
  }
});

// Payout Tracking
router.get('/api/financials/payouts', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_payout_tracking', { start_date, end_date }, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getPayoutTracking(start_date, end_date);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting payout tracking:', error);
    res.status(500).json({ error: 'Failed to fetch payout data' });
  }
});

// Top Winners
router.get('/api/financials/top-winners', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    const { limit = 20, start_date, end_date } = req.query;
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_top_winners', { limit, start_date, end_date }, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getTopWinners(parseInt(limit), start_date, end_date);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting top winners:', error);
    res.status(500).json({ error: 'Failed to fetch top winners' });
  }
});

// Financial KPIs
router.get('/api/financials/kpis', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_financial_kpis', { start_date, end_date }, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getFinancialKPIs(start_date, end_date);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting KPIs:', error);
    res.status(500).json({ error: 'Failed to fetch KPIs' });
  }
});

// Revenue Trends
router.get('/api/financials/trends', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    const { period = 'daily', days = 30 } = req.query;
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_revenue_trends', { period, days }, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getRevenueTrends(period, parseInt(days));
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting trends:', error);
    res.status(500).json({ error: 'Failed to fetch trends' });
  }
});

// Comparison Reports
router.get('/api/financials/comparison', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    const { type = 'daily' } = req.query;
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_comparison_report', { type }, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getComparisonReport(type);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting comparison:', error);
    res.status(500).json({ error: 'Failed to fetch comparison' });
  }
});

// Revenue Forecast
router.get('/api/financials/forecast', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_forecast', {}, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getRevenueForecast();
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting forecast:', error);
    res.status(500).json({ error: 'Failed to fetch forecast' });
  }
});

// Churn Impact
router.get('/api/financials/churn-impact', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_churn_impact', {}, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getChurnImpact();
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting churn impact:', error);
    res.status(500).json({ error: 'Failed to fetch churn impact' });
  }
});

// Transaction Detail
router.get('/api/financials/transaction/:id', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_transaction_detail', { transaction_id: req.params.id }, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getTransactionDetails(req.params.id);
    if (!data) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting transaction:', error);
    res.status(500).json({ error: 'Failed to fetch transaction' });
  }
});

// User Financial Profile
router.get('/api/financials/user/:id', authenticateAdmin, requireFinancialAccess, async (req, res) => {
  try {
    await adminAuthService.logActivity(req.adminSession.admin_id, 'view_user_financial_profile', { user_id: req.params.id }, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.getUserFinancialProfile(req.params.id);
    if (!data) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error getting user profile:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Export Data
router.get('/api/financials/export', authenticateAdminWithQuery, requireFinancialAccess, async (req, res) => {
  try {
    const { start_date, end_date, type = 'all', format = 'csv' } = req.query;
    await adminAuthService.logActivity(req.adminSession.admin_id, 'export_financial_data', { start_date, end_date, type, format }, getIpAddress(req), req.headers['user-agent']);
    const data = await financialService.exportTransactions(start_date, end_date, type);
    if (format === 'csv') {
      const headers = Object.keys(data[0] || {});
      const csv = [headers.join(','), ...data.map(r => headers.map(h => { const v = r[h]; return typeof v === 'string' && (v.includes(',') || v.includes('"')) ? `"${v.replace(/"/g, '""')}"` : v; }).join(','))].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=financial_export_${type}_${new Date().toISOString().split('T')[0]}.csv`);
      return res.send(csv);
    }
    res.json({ success: true, data, count: data.length });
  } catch (error) {
    logger.error('Error exporting data:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// ============================================
// QUESTION ROTATION ENDPOINTS
// ============================================

/**
 * GET /admin/api/questions/rotation-stats
 * Overall rotation system statistics
 */
router.get('/api/questions/rotation-stats', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM questions WHERE is_active = true) as total_questions,
                (SELECT COUNT(DISTINCT id) FROM users WHERE last_active > NOW() - INTERVAL '30 days') as active_users,
                (SELECT COUNT(*) FROM user_question_history) as history_records,
                (SELECT ROUND(AVG(coverage), 2) FROM (
                    SELECT 
                        COUNT(DISTINCT uqh.question_id)::numeric / 
                        NULLIF((SELECT COUNT(*) FROM questions WHERE is_active = true), 0) * 100 as coverage
                    FROM users u
                    LEFT JOIN user_question_history uqh ON u.id = uqh.user_id
                    WHERE u.last_active > NOW() - INTERVAL '30 days'
                    GROUP BY u.id
                ) sub) as avg_coverage
        `);
        
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        logger.error('Error getting rotation stats:', error);
        res.json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/api/questions/difficulty-stats
 * Question count by difficulty level (1-15)
 */
router.get('/api/questions/difficulty-stats', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT difficulty, COUNT(*) as count
            FROM questions
            WHERE is_active = true
            GROUP BY difficulty
            ORDER BY difficulty
        `);
        
        // Convert to object { 1: 50, 2: 45, ... }
        const stats = {};
        for (let i = 1; i <= 15; i++) {
            stats[i] = 0;
        }
        result.rows.forEach(row => {
            stats[row.difficulty] = parseInt(row.count);
        });
        
        res.json({ success: true, data: stats });
    } catch (error) {
        logger.error('Error getting difficulty stats:', error);
        res.json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/api/questions/freshness-by-difficulty
 * Freshness breakdown by difficulty level
 */
router.get('/api/questions/freshness-by-difficulty', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            WITH active_users AS (
                SELECT COUNT(DISTINCT id) as count 
                FROM users 
                WHERE last_active > NOW() - INTERVAL '30 days'
            ),
            question_exposure AS (
                SELECT 
                    q.id,
                    q.difficulty,
                    COUNT(DISTINCT uqh.user_id) as users_seen,
                    (SELECT count FROM active_users) as total_active
                FROM questions q
                LEFT JOIN user_question_history uqh ON q.id = uqh.question_id
                WHERE q.is_active = true
                GROUP BY q.id, q.difficulty
            )
            SELECT 
                difficulty,
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE total_active = 0 OR users_seen::float / NULLIF(total_active, 0) < 0.3) as fresh,
                COUNT(*) FILTER (WHERE total_active > 0 AND users_seen::float / NULLIF(total_active, 0) BETWEEN 0.3 AND 0.7) as moderate,
                COUNT(*) FILTER (WHERE total_active > 0 AND users_seen::float / NULLIF(total_active, 0) > 0.7) as stale
            FROM question_exposure
            GROUP BY difficulty
            ORDER BY difficulty
        `);
        
        res.json({ success: true, data: result.rows });
    } catch (error) {
        logger.error('Error getting freshness by difficulty:', error);
        res.json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/api/questions/top-users-coverage
 * Users with highest question coverage
 */
router.get('/api/questions/top-users-coverage', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            WITH total AS (
                SELECT COUNT(*) as cnt FROM questions WHERE is_active = true
            )
            SELECT 
                u.id as user_id,
                u.username,
                COUNT(DISTINCT uqh.question_id) as questions_seen,
                (SELECT cnt FROM total) as total_questions,
                ROUND(COUNT(DISTINCT uqh.question_id)::numeric / NULLIF((SELECT cnt FROM total), 0) * 100, 2) as coverage_percent
            FROM users u
            JOIN user_question_history uqh ON u.id = uqh.user_id
            GROUP BY u.id, u.username
            ORDER BY questions_seen DESC
            LIMIT 20
        `);
        
        res.json({ success: true, data: result.rows });
    } catch (error) {
        logger.error('Error getting top users coverage:', error);
        res.json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/api/questions/user-coverage/:identifier
 * Get specific user's question coverage
 */
router.get('/api/questions/user-coverage/:identifier', authenticateAdmin, async (req, res) => {
    try {
        const identifier = req.params.identifier;
        
        // Try to find user by ID or phone
        let userQuery;
        if (/^\d+$/.test(identifier)) {
            userQuery = await pool.query('SELECT id, username FROM users WHERE id = $1', [identifier]);
        } else {
            userQuery = await pool.query('SELECT id, username FROM users WHERE phone_number LIKE $1', ['%' + identifier]);
        }
        
        if (userQuery.rows.length === 0) {
            return res.json({ success: false, error: 'User not found' });
        }
        
        const user = userQuery.rows[0];
        
        const result = await pool.query(`
            WITH total AS (
                SELECT COUNT(*) as cnt FROM questions WHERE is_active = true
            )
            SELECT 
                COUNT(DISTINCT question_id) as questions_seen,
                (SELECT cnt FROM total) as total_questions,
                ROUND(COUNT(DISTINCT question_id)::numeric / NULLIF((SELECT cnt FROM total), 0) * 100, 2) as coverage_percent
            FROM user_question_history
            WHERE user_id = $1
        `, [user.id]);
        
        res.json({ 
            success: true, 
            data: {
                user_id: user.id,
                username: user.username,
                ...result.rows[0]
            }
        });
    } catch (error) {
        logger.error('Error getting user coverage:', error);
        res.json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/api/questions/user-coverage-detailed/:userId
 * Get user's coverage broken down by difficulty level
 */
router.get('/api/questions/user-coverage-detailed/:userId', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        
        const result = await pool.query(`
            WITH difficulty_totals AS (
                SELECT difficulty, COUNT(*) as total
                FROM questions
                WHERE is_active = true
                GROUP BY difficulty
            ),
            user_seen AS (
                SELECT q.difficulty, COUNT(DISTINCT uqh.question_id) as seen
                FROM user_question_history uqh
                JOIN questions q ON uqh.question_id = q.id
                WHERE uqh.user_id = $1
                GROUP BY q.difficulty
            )
            SELECT 
                dt.difficulty,
                dt.total,
                COALESCE(us.seen, 0) as seen,
                ROUND(COALESCE(us.seen, 0)::numeric / NULLIF(dt.total, 0) * 100, 2) as coverage_percent
            FROM difficulty_totals dt
            LEFT JOIN user_seen us ON dt.difficulty = us.difficulty
            ORDER BY dt.difficulty
        `, [userId]);
        
        res.json({ success: true, data: result.rows });
    } catch (error) {
        logger.error('Error getting detailed user coverage:', error);
        res.json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/api/questions/recent-rotation
 * Recent rotation activity
 */
router.get('/api/questions/recent-rotation', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                uqh.user_id,
                u.username,
                uqh.question_id,
                q.question_text,
                q.difficulty,
                uqh.asked_at,
                (SELECT COUNT(*) FROM user_question_history 
                 WHERE user_id = uqh.user_id AND question_id = uqh.question_id) as times_seen
            FROM user_question_history uqh
            JOIN users u ON uqh.user_id = u.id
            JOIN questions q ON uqh.question_id = q.id
            ORDER BY uqh.asked_at DESC
            LIMIT 50
        `);
        
        res.json({ success: true, data: result.rows });
    } catch (error) {
        logger.error('Error getting recent rotation:', error);
        res.json({ success: false, error: error.message });
    }
});
// ============================================
// TOURNAMENT MANAGEMENT ROUTES - ADD TO admin.routes.js
// Add this code BEFORE the "module.exports = router;" line
// ============================================

// ============================================
// TOURNAMENT MANAGEMENT DASHBOARD PAGE
// URL: /admin/tournaments/manage
// No server-side auth - page handles auth client-side like other admin pages
// ============================================
router.get('/tournaments/manage', async (req, res) => {
    try {
        // Get all tournaments with stats
        const tournamentsResult = await pool.query(`
            SELECT 
                t.*,
                COUNT(DISTINCT tp.user_id) as participant_count,
                COUNT(DISTINCT tgs.id) as total_games_played,
                COALESCE(SUM(tep.amount) FILTER (WHERE tep.payment_status = 'success'), 0) as total_entry_fees,
                MAX(COALESCE(tp.best_questions_answered, 0)) as best_performance
            FROM tournaments t
            LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
            LEFT JOIN tournament_game_sessions tgs ON t.id = tgs.tournament_id
            LEFT JOIN tournament_entry_payments tep ON t.id = tep.tournament_id
            GROUP BY t.id
            ORDER BY 
                CASE t.status 
                    WHEN 'active' THEN 1 
                    WHEN 'upcoming' THEN 2
                    WHEN 'completed' THEN 3 
                END,
                t.created_at DESC
        `);

        const tournaments = tournamentsResult.rows;

        // Get summary stats
        const statsResult = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'active') as active_count,
                COUNT(*) FILTER (WHERE status = 'upcoming') as upcoming_count,
                COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
                COALESCE(SUM(prize_pool) FILTER (WHERE status = 'active'), 0) as active_prize_pool,
                COALESCE(SUM(actual_prize_distributed), 0) as total_distributed
            FROM tournaments
        `);
        const stats = statsResult.rows[0];

        // Generate tournament cards HTML
        let tournamentCardsHtml = '';
        tournaments.forEach(t => {
            const statusClass = t.status === 'active' ? 'success' : t.status === 'upcoming' ? 'primary' : t.status === 'cancelled' ? 'danger' : 'secondary';
            const actionButtons = t.status === 'active' ? `
                <button class="btn btn-sm btn-outline-warning" onclick="previewPrizes(${t.id})" title="Preview Prizes"><i class="bi bi-gift"></i></button>
                <button class="btn btn-sm btn-outline-danger" onclick="endTournament(${t.id}, '${t.tournament_name.replace(/'/g, "\\'")}'" title="End Tournament"><i class="bi bi-stop-circle"></i></button>
            ` : '';
            
            tournamentCardsHtml += `
                <div class="col-md-6 col-lg-4 mb-4">
                    <div class="card tournament-card h-100">
                        <div class="card-header d-flex justify-content-between align-items-center">
                            <span class="badge bg-${statusClass}">${t.status.toUpperCase()}</span>
                            <span class="text-muted small">#${t.id}</span>
                        </div>
                        <div class="card-body">
                            <h5 class="card-title">${t.tournament_name}</h5>
                            <p class="small text-muted mb-2">${t.tournament_type || 'Standard'} ${t.sponsor_name ? '• ' + t.sponsor_name : ''}</p>
                            <div class="row text-center mb-3">
                                <div class="col-4"><strong class="text-primary">${t.participant_count || 0}</strong><br><small>Players</small></div>
                                <div class="col-4"><strong class="text-success">₦${parseInt(t.prize_pool || 0).toLocaleString()}</strong><br><small>Prize</small></div>
                                <div class="col-4"><strong class="text-info">${t.total_games_played || 0}</strong><br><small>Games</small></div>
                            </div>
                            <p class="small text-muted mb-1"><i class="bi bi-calendar me-1"></i>${new Date(t.start_date).toLocaleDateString()} - ${new Date(t.end_date).toLocaleDateString()}</p>
                            <p class="small text-muted mb-0"><i class="bi bi-cash me-1"></i>${t.payment_type === 'free' ? 'Free Entry' : '₦' + (t.entry_fee || 0).toLocaleString() + ' Entry'}</p>
                            ${t.uses_tokens ? '<p class="small text-warning mb-0"><i class="bi bi-coin me-1"></i>' + (t.tokens_per_entry || 1) + ' tokens/game</p>' : ''}
                        </div>
                        <div class="card-footer bg-white">
                            <div class="btn-group w-100">
                                <button class="btn btn-sm btn-outline-primary" onclick="viewTournament(${t.id})" title="View Details"><i class="bi bi-eye"></i></button>
                                <button class="btn btn-sm btn-outline-success" onclick="viewLeaderboard(${t.id})" title="View Leaderboard"><i class="bi bi-trophy"></i></button>
                                ${actionButtons}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });

        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tournament Management - What's Up Trivia Admin</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css" rel="stylesheet">
    <style>
        :root { --primary-orange: #FF6B35; --dark-bg: #1a1a2e; }
        body { background: #f5f5f5; }
        .navbar { background: var(--dark-bg) !important; }
        .stat-card { border-radius: 15px; border: none; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        .stat-card.active { background: linear-gradient(135deg, #28a745, #20c997); color: white; }
        .stat-card.upcoming { background: linear-gradient(135deg, #007bff, #6610f2); color: white; }
        .stat-card.completed { background: linear-gradient(135deg, #6c757d, #495057); color: white; }
        .stat-card.money { background: linear-gradient(135deg, #ffc107, #fd7e14); color: #1a1a2e; }
        .tournament-card { border-radius: 15px; border: none; box-shadow: 0 4px 15px rgba(0,0,0,0.1); transition: transform 0.2s; }
        .tournament-card:hover { transform: translateY(-5px); }
        .btn-orange { background: var(--primary-orange); color: white; border: none; }
        .btn-orange:hover { background: #e55a2b; color: white; }
        .modal-header { background: var(--dark-bg); color: white; }
        .modal-header.bg-primary { background: #007bff !important; }
        .form-section { background: #f8f9fa; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
        .form-section h6 { margin-bottom: 1rem; color: var(--dark-bg); border-bottom: 2px solid var(--primary-orange); padding-bottom: 0.5rem; }
        .prize-row { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center; }
        .prize-row .position { min-width: 40px; font-weight: bold; }
        .toggle-btn-group { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
        .toggle-btn { padding: 0.5rem 1rem; border: 2px solid #dee2e6; background: white; border-radius: 8px; cursor: pointer; transition: all 0.2s; }
        .toggle-btn.active { border-color: var(--primary-orange); background: #fff5f0; color: var(--primary-orange); font-weight: bold; }
        .toggle-btn:hover { border-color: var(--primary-orange); }
        .detail-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; }
        .detail-item { padding: 0.75rem; background: #f8f9fa; border-radius: 8px; }
        .detail-item label { font-size: 0.75rem; color: #6c757d; margin-bottom: 0.25rem; display: block; }
        .detail-item .value { font-weight: 600; color: #1a1a2e; }
    </style>
</head>
<body>
    <nav class="navbar navbar-dark mb-4">
        <div class="container">
            <a class="navbar-brand" href="/admin/dashboard"><i class="bi bi-trophy-fill me-2"></i>Tournament Management</a>
            <div>
                <a href="/admin/dashboard" class="btn btn-outline-light btn-sm me-2"><i class="bi bi-house"></i> Dashboard</a>
                <a href="/admin/logout" class="btn btn-outline-danger btn-sm"><i class="bi bi-box-arrow-right"></i> Logout</a>
            </div>
        </div>
    </nav>

    <div class="container">
        <div class="row mb-4">
            <div class="col-md-3"><div class="card stat-card active"><div class="card-body text-center"><h2>${stats.active_count || 0}</h2><p class="mb-0">Active</p></div></div></div>
            <div class="col-md-3"><div class="card stat-card upcoming"><div class="card-body text-center"><h2>${stats.upcoming_count || 0}</h2><p class="mb-0">Upcoming</p></div></div></div>
            <div class="col-md-3"><div class="card stat-card completed"><div class="card-body text-center"><h2>${stats.completed_count || 0}</h2><p class="mb-0">Completed</p></div></div></div>
            <div class="col-md-3"><div class="card stat-card money"><div class="card-body text-center"><h2>₦${parseInt(stats.active_prize_pool || 0).toLocaleString()}</h2><p class="mb-0">Active Pool</p></div></div></div>
        </div>

        <div class="d-flex justify-content-between align-items-center mb-4">
            <h4><i class="bi bi-list-ul me-2"></i>All Tournaments</h4>
            <button class="btn btn-orange" data-bs-toggle="modal" data-bs-target="#createModal"><i class="bi bi-plus-circle me-2"></i>Create Tournament</button>
        </div>

        <div class="row">
            ${tournamentCardsHtml}
        </div>
    </div>

    <!-- Create Tournament Modal - ENHANCED -->
    <div class="modal fade" id="createModal" tabindex="-1">
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title"><i class="bi bi-plus-circle me-2"></i>Create Tournament</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="createForm">
                        <!-- Basic Information -->
                        <div class="form-section">
                            <h6><i class="bi bi-info-circle me-2"></i>Basic Information</h6>
                            <div class="row">
                                <div class="col-md-6 mb-3">
                                    <label class="form-label">Tournament Name *</label>
                                    <input type="text" class="form-control" name="tournamentName" required placeholder="e.g., MTN Mega Quiz">
                                </div>
                                <div class="col-md-3 mb-3">
                                    <label class="form-label">Type</label>
                                    <select class="form-select" name="tournamentType">
                                        <option value="sponsored">Sponsored</option>
                                        <option value="weekly">Weekly</option>
                                        <option value="monthly">Monthly</option>
                                        <option value="special">Special Event</option>
                                    </select>
                                </div>
                                <div class="col-md-3 mb-3">
                                    <label class="form-label">Status</label>
                                    <select class="form-select" name="status">
                                        <option value="upcoming">Upcoming</option>
                                        <option value="active">Active</option>
                                    </select>
                                </div>
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Description</label>
                                <textarea class="form-control" name="description" rows="2" placeholder="Tournament description..."></textarea>
                            </div>
                        </div>

                        <!-- Sponsor Information -->
                        <div class="form-section">
                            <h6><i class="bi bi-building me-2"></i>Sponsor Information</h6>
                            <div class="row">
                                <div class="col-md-6 mb-3">
                                    <label class="form-label">Sponsor Name</label>
                                    <input type="text" class="form-control" name="sponsorName" placeholder="e.g., MTN Nigeria">
                                </div>
                                <div class="col-md-6 mb-3">
                                    <label class="form-label">Sponsor Logo URL</label>
                                    <input type="url" class="form-control" name="sponsorLogoUrl" placeholder="https://...">
                                </div>
                            </div>
                        </div>

                        <!-- Payment & Prize -->
                        <div class="form-section">
                            <h6><i class="bi bi-cash-stack me-2"></i>Payment & Prize</h6>
                            <div class="row">
                                <div class="col-md-3 mb-3">
                                    <label class="form-label">Payment Type *</label>
                                    <select class="form-select" name="paymentType" onchange="toggleEntryFee(this.value)">
                                        <option value="free">Free Entry</option>
                                        <option value="paid">Paid Entry</option>
                                    </select>
                                </div>
                                <div class="col-md-3 mb-3" id="entryFeeDiv" style="display:none;">
                                    <label class="form-label">Entry Fee (₦)</label>
                                    <input type="number" class="form-control" name="entryFee" min="0" value="0">
                                </div>
                                <div class="col-md-3 mb-3">
                                    <label class="form-label">Prize Pool (₦) *</label>
                                    <input type="number" class="form-control" name="prizePool" required min="0" id="prizePoolInput" oninput="updatePrizeAmounts()">
                                </div>
                                <div class="col-md-3 mb-3">
                                    <label class="form-label d-flex align-items-center">
                                        <input type="checkbox" class="form-check-input me-2" name="usesTokens" id="usesTokensCheck" onchange="toggleTokens(this.checked)">
                                        Use Token System
                                    </label>
                                    <div id="tokensDiv" style="display:none;">
                                        <input type="number" class="form-control form-control-sm" name="tokensPerEntry" min="1" value="1" placeholder="Tokens per game">
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Duration & Limits -->
                        <div class="form-section">
                            <h6><i class="bi bi-calendar-range me-2"></i>Duration & Limits</h6>
                            <div class="row">
                                <div class="col-md-4 mb-3">
                                    <label class="form-label">Start Date *</label>
                                    <input type="datetime-local" class="form-control" name="startDate" required>
                                </div>
                                <div class="col-md-4 mb-3">
                                    <label class="form-label">End Date *</label>
                                    <input type="datetime-local" class="form-control" name="endDate" required>
                                </div>
                                <div class="col-md-4 mb-3">
                                    <label class="form-label">Max Participants</label>
                                    <input type="number" class="form-control" name="maxParticipants" value="0" min="0" placeholder="0 = unlimited">
                                </div>
                            </div>
                        </div>

                        <!-- Questions & Branding -->
                        <div class="form-section">
                            <h6><i class="bi bi-question-circle me-2"></i>Questions & Branding</h6>
                            <div class="row">
                                <div class="col-md-4 mb-3">
                                    <label class="form-label">Question Category/Bank</label>
                                    <input type="text" class="form-control" name="questionCategory" placeholder="Leave blank for general">
                                </div>
                                <div class="col-md-4 mb-3">
                                    <label class="form-label">Custom Instructions</label>
                                    <input type="text" class="form-control" name="customInstructions" placeholder="Special rules...">
                                </div>
                                <div class="col-md-4 mb-3">
                                    <label class="form-label">Custom Branding Text</label>
                                    <input type="text" class="form-control" name="customBranding" placeholder="Powered by...">
                                </div>
                            </div>
                        </div>

                        <!-- Prize Distribution -->
                        <div class="form-section">
                            <h6><i class="bi bi-gift me-2"></i>Prize Distribution</h6>
                            
                            <!-- Toggle Controls -->
                            <div class="row mb-3">
                                <div class="col-md-6">
                                    <label class="form-label">Distribution Mode</label>
                                    <div class="toggle-btn-group">
                                        <button type="button" class="toggle-btn active" id="pctModeBtn" onclick="setPrizeMode('percentage')">Percentage %</button>
                                        <button type="button" class="toggle-btn" id="amtModeBtn" onclick="setPrizeMode('amount')">Custom Amounts ₦</button>
                                    </div>
                                </div>
                                <div class="col-md-6">
                                    <label class="form-label">Winners Count</label>
                                    <div class="toggle-btn-group">
                                        <button type="button" class="toggle-btn active" id="top10Btn" onclick="setWinnersCount(10)">Top 10</button>
                                        <button type="button" class="toggle-btn" id="top20Btn" onclick="setWinnersCount(20)">Top 20</button>
                                    </div>
                                </div>
                            </div>

                            <!-- Prize Inputs -->
                            <div class="row" id="prizeInputsContainer">
                                <div class="col-md-6" id="prizeCol1"></div>
                                <div class="col-md-6" id="prizeCol2"></div>
                            </div>
                            
                            <div class="alert alert-info mt-3" id="prizeTotal">
                                <strong>Total: 100%</strong> ✅
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                    <button type="button" class="btn btn-orange" onclick="createTournament()">
                        <i class="bi bi-save me-2"></i>Create Tournament
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- View Tournament Modal -->
    <div class="modal fade" id="viewModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-primary">
                    <h5 class="modal-title"><i class="bi bi-eye me-2"></i>Tournament Details</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body" id="viewModalBody">
                    <div class="text-center py-5"><div class="spinner-border text-primary"></div><p class="mt-2">Loading...</p></div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                </div>
            </div>
        </div>
    </div>

    <!-- Leaderboard Modal -->
    <div class="modal fade" id="leaderboardModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-success text-white">
                    <h5 class="modal-title"><i class="bi bi-trophy me-2"></i>Leaderboard</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body" id="leaderboardBody">
                    <div class="text-center py-5"><div class="spinner-border"></div></div>
                </div>
            </div>
        </div>
    </div>

    <!-- Prize Preview Modal -->
    <div class="modal fade" id="prizeModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-warning">
                    <h5 class="modal-title"><i class="bi bi-gift me-2"></i>Prize Distribution Preview</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body" id="prizeBody">
                    <div class="text-center py-5"><div class="spinner-border"></div></div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                    <button type="button" class="btn btn-danger" id="confirmEndBtn" style="display:none;">
                        <i class="bi bi-stop-circle me-2"></i>Confirm End & Distribute
                    </button>
                </div>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <script>
        const token = localStorage.getItem('adminToken');
        if (!token) window.location.href = '/admin/login';
        
        // Prize distribution state
        let prizeMode = 'percentage'; // 'percentage' or 'amount'
        let winnersCount = 10; // 10 or 20
        const defaultPcts10 = [40, 20, 15, 10, 5, 3, 3, 2, 1, 1];
        const defaultPcts20 = [25, 15, 12, 10, 8, 6, 5, 4, 3, 2, 2, 1.5, 1.5, 1, 1, 0.8, 0.6, 0.4, 0.2, 0];
        
        // Initialize prize inputs on load
        document.addEventListener('DOMContentLoaded', () => {
            renderPrizeInputs();
        });

        // Toggle functions
        function toggleEntryFee(value) {
            document.getElementById('entryFeeDiv').style.display = value === 'paid' ? 'block' : 'none';
        }

        function toggleTokens(checked) {
            document.getElementById('tokensDiv').style.display = checked ? 'block' : 'none';
        }

        function setPrizeMode(mode) {
            prizeMode = mode;
            document.getElementById('pctModeBtn').classList.toggle('active', mode === 'percentage');
            document.getElementById('amtModeBtn').classList.toggle('active', mode === 'amount');
            renderPrizeInputs();
        }

        function setWinnersCount(count) {
            winnersCount = count;
            document.getElementById('top10Btn').classList.toggle('active', count === 10);
            document.getElementById('top20Btn').classList.toggle('active', count === 20);
            renderPrizeInputs();
        }

        function renderPrizeInputs() {
            const col1 = document.getElementById('prizeCol1');
            const col2 = document.getElementById('prizeCol2');
            const defaults = winnersCount === 10 ? defaultPcts10 : defaultPcts20;
            const prizePool = parseInt(document.getElementById('prizePoolInput')?.value) || 0;
            
            const medals = ['🥇', '🥈', '🥉'];
            let html1 = '', html2 = '';
            
            for (let i = 1; i <= winnersCount; i++) {
                const medal = i <= 3 ? medals[i-1] : i;
                const defaultVal = defaults[i-1] || 0;
                const suffix = prizeMode === 'percentage' ? '%' : '₦';
                const inputVal = prizeMode === 'percentage' ? defaultVal : Math.floor(prizePool * defaultVal / 100);
                
                const inputHtml = \`
                    <div class="input-group mb-2">
                        <span class="input-group-text" style="min-width:50px;">\${medal}</span>
                        <input type="number" class="form-control prize-input" name="prize\${i}" value="\${inputVal}" min="0" step="\${prizeMode === 'percentage' ? '0.1' : '1000'}" oninput="updatePrizeTotal()">
                        <span class="input-group-text">\${suffix}</span>
                        \${prizeMode === 'percentage' ? '<span class="input-group-text prize-preview" id="preview'+i+'" style="min-width:90px;">₦0</span>' : ''}
                    </div>
                \`;
                
                if (i <= Math.ceil(winnersCount / 2)) {
                    html1 += inputHtml;
                } else {
                    html2 += inputHtml;
                }
            }
            
            col1.innerHTML = html1;
            col2.innerHTML = html2;
            
            updatePrizeTotal();
        }

        function updatePrizeAmounts() {
            if (prizeMode === 'percentage') {
                updatePrizeTotal();
            }
        }

        function updatePrizeTotal() {
            const prizePool = parseInt(document.getElementById('prizePoolInput')?.value) || 0;
            const inputs = document.querySelectorAll('.prize-input');
            let total = 0;
            
            inputs.forEach((input, i) => {
                const val = parseFloat(input.value) || 0;
                total += val;
                
                if (prizeMode === 'percentage') {
                    const preview = document.getElementById('preview' + (i + 1));
                    if (preview) {
                        preview.textContent = '₦' + Math.floor(prizePool * val / 100).toLocaleString();
                    }
                }
            });
            
            const alertDiv = document.getElementById('prizeTotal');
            if (prizeMode === 'percentage') {
                if (Math.abs(total - 100) < 0.1) {
                    alertDiv.className = 'alert alert-success mt-3';
                    alertDiv.innerHTML = '<strong>Total: ' + total.toFixed(1) + '%</strong> ✅ = ₦' + prizePool.toLocaleString();
                } else {
                    alertDiv.className = 'alert alert-danger mt-3';
                    alertDiv.innerHTML = '<strong>Total: ' + total.toFixed(1) + '%</strong> ❌ Must equal 100%';
                }
            } else {
                alertDiv.className = total <= prizePool ? 'alert alert-success mt-3' : 'alert alert-danger mt-3';
                alertDiv.innerHTML = '<strong>Total: ₦' + total.toLocaleString() + '</strong> / ₦' + prizePool.toLocaleString() + (total <= prizePool ? ' ✅' : ' ❌ Exceeds pool!');
            }
        }
        
        async function createTournament() {
            const f = document.getElementById('createForm');
            const fd = new FormData(f);
            
            // Build prize distribution
            const pd = [];
            const prizePool = parseInt(fd.get('prizePool')) || 0;
            
            for (let i = 1; i <= winnersCount; i++) {
                const val = parseFloat(fd.get('prize' + i)) || 0;
                if (val > 0) {
                    if (prizeMode === 'percentage') {
                        pd.push(val / 100);
                    } else {
                        pd.push(val / prizePool); // Convert amount to percentage
                    }
                }
            }
            
            // Validate
            if (prizeMode === 'percentage') {
                const total = pd.reduce((a, b) => a + b, 0);
                if (Math.abs(total - 1) > 0.01) {
                    alert('Prize percentages must total 100%');
                    return;
                }
            }
            
            const data = {
                tournamentName: fd.get('tournamentName'),
                tournamentType: fd.get('tournamentType'),
                status: fd.get('status'),
                description: fd.get('description'),
                sponsorName: fd.get('sponsorName'),
                sponsorLogoUrl: fd.get('sponsorLogoUrl'),
                paymentType: fd.get('paymentType'),
                entryFee: parseInt(fd.get('entryFee')) || 0,
                prizePool: prizePool,
                usesTokens: fd.get('usesTokens') === 'on',
                tokensPerEntry: parseInt(fd.get('tokensPerEntry')) || 1,
                startDate: fd.get('startDate'),
                endDate: fd.get('endDate'),
                maxParticipants: parseInt(fd.get('maxParticipants')) || 0,
                questionCategory: fd.get('questionCategory'),
                customInstructions: fd.get('customInstructions'),
                customBranding: fd.get('customBranding'),
                prizeDistribution: pd
            };
            
            try {
                const r = await fetch('/admin/api/tournaments', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify(data)
                });
                const res = await r.json();
                if (res.success) {
                    alert('Tournament created successfully!');
                    location.reload();
                } else {
                    alert('Error: ' + res.error);
                }
            } catch (e) {
                alert('Error: ' + e.message);
            }
        }
        
        // View Tournament Details
        async function viewTournament(id) {
            const modal = new bootstrap.Modal(document.getElementById('viewModal'));
            modal.show();
            
            try {
                const r = await fetch('/admin/api/tournaments/' + id, {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const t = await r.json();
                
                if (t.id) {
                    const statusColors = { active: 'success', upcoming: 'primary', completed: 'secondary', cancelled: 'danger' };
                    document.getElementById('viewModalBody').innerHTML = \`
                        <div class="d-flex justify-content-between align-items-start mb-4">
                            <div>
                                <h4 class="mb-1">\${t.tournament_name}</h4>
                                <p class="text-muted mb-0">\${t.tournament_type || 'Standard'} Tournament \${t.sponsor_name ? '• Sponsored by ' + t.sponsor_name : ''}</p>
                            </div>
                            <span class="badge bg-\${statusColors[t.status] || 'secondary'} fs-6">\${t.status.toUpperCase()}</span>
                        </div>
                        
                        \${t.description ? '<p class="mb-4">' + t.description + '</p>' : ''}
                        
                        <div class="detail-grid">
                            <div class="detail-item">
                                <label>Prize Pool</label>
                                <div class="value text-success fs-5">₦\${parseInt(t.prize_pool || 0).toLocaleString()}</div>
                            </div>
                            <div class="detail-item">
                                <label>Entry Type</label>
                                <div class="value">\${t.payment_type === 'free' ? '🎁 Free Entry' : '💰 ₦' + (t.entry_fee || 0).toLocaleString()}</div>
                            </div>
                            <div class="detail-item">
                                <label>Start Date</label>
                                <div class="value">\${new Date(t.start_date).toLocaleString()}</div>
                            </div>
                            <div class="detail-item">
                                <label>End Date</label>
                                <div class="value">\${new Date(t.end_date).toLocaleString()}</div>
                            </div>
                            <div class="detail-item">
                                <label>Max Participants</label>
                                <div class="value">\${t.max_participants > 0 ? t.max_participants : 'Unlimited'}</div>
                            </div>
                            <div class="detail-item">
                                <label>Token System</label>
                                <div class="value">\${t.uses_tokens ? '🎟️ ' + (t.tokens_per_entry || 1) + ' tokens/game' : '❌ Not used'}</div>
                            </div>
                            <div class="detail-item">
                                <label>Question Category</label>
                                <div class="value">\${t.question_category || 'General'}</div>
                            </div>
                            <div class="detail-item">
                                <label>Created</label>
                                <div class="value">\${new Date(t.created_at).toLocaleDateString()}</div>
                            </div>
                        </div>
                        
                        \${t.sponsor_logo_url ? '<div class="mt-4 text-center"><img src="' + t.sponsor_logo_url + '" alt="Sponsor" style="max-height:60px;"></div>' : ''}
                        \${t.custom_branding ? '<p class="text-center text-muted mt-3">' + t.custom_branding + '</p>' : ''}
                        \${t.custom_instructions ? '<div class="alert alert-info mt-3"><strong>Special Instructions:</strong> ' + t.custom_instructions + '</div>' : ''}
                    \`;
                } else {
                    document.getElementById('viewModalBody').innerHTML = '<div class="alert alert-danger">Tournament not found</div>';
                }
            } catch (e) {
                document.getElementById('viewModalBody').innerHTML = '<div class="alert alert-danger">Error loading tournament: ' + e.message + '</div>';
            }
        }
        
        async function viewLeaderboard(id) {
            const modal = new bootstrap.Modal(document.getElementById('leaderboardModal'));
            modal.show();
            
            try {
                const r = await fetch('/admin/api/tournaments/' + id + '/participants', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const d = await r.json();
                
                if (d.participants && d.participants.length > 0) {
                    let h = '<table class="table table-striped table-hover"><thead class="table-dark"><tr><th>Rank</th><th>Player</th><th>Score</th><th>Time</th><th>Games</th><th>Platform</th></tr></thead><tbody>';
                    d.participants.forEach((p, i) => {
                        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
                        const platform = p.platform === 'telegram' ? '📱 Telegram' : '💬 WhatsApp';
                        h += '<tr><td>' + medal + '</td><td><strong>@' + (p.username || '?') + '</strong></td><td>Q' + (p.best_questions_answered || 0) + '</td><td>' + (parseFloat(p.best_time_taken || 999).toFixed(1)) + 's</td><td>' + (p.games_played || 0) + '</td><td>' + platform + '</td></tr>';
                    });
                    h += '</tbody></table>';
                    document.getElementById('leaderboardBody').innerHTML = h;
                } else {
                    document.getElementById('leaderboardBody').innerHTML = '<div class="alert alert-info text-center"><i class="bi bi-info-circle me-2"></i>No participants yet</div>';
                }
            } catch (e) {
                document.getElementById('leaderboardBody').innerHTML = '<div class="alert alert-danger">Error loading leaderboard</div>';
            }
        }
        
        async function previewPrizes(id) {
            const modal = new bootstrap.Modal(document.getElementById('prizeModal'));
            modal.show();
            
            try {
                const r = await fetch('/admin/api/tournaments/' + id + '/prize-preview', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const d = await r.json();
                
                if (d.success && d.winners && d.winners.length > 0) {
                    let h = '<div class="alert alert-warning"><i class="bi bi-exclamation-triangle me-2"></i><strong>PREVIEW ONLY</strong> - No changes have been made yet</div>';
                    h += '<table class="table"><thead class="table-dark"><tr><th>Rank</th><th>Player</th><th>Score</th><th>Time</th><th>Prize</th></tr></thead><tbody>';
                    d.winners.forEach(w => {
                        const medal = w.rank === 1 ? '🥇' : w.rank === 2 ? '🥈' : w.rank === 3 ? '🥉' : w.rank;
                        h += '<tr><td>' + medal + '</td><td><strong>@' + w.username + '</strong><br><small class="text-muted">' + w.platform + '</small></td><td>Q' + w.questionsAnswered + '</td><td>' + w.timeTaken + 's</td><td class="text-success"><strong>₦' + w.prize.toLocaleString() + '</strong><br><small>(' + w.percentage + ')</small></td></tr>';
                    });
                    h += '</tbody></table>';
                    h += '<div class="alert alert-success"><strong>Total to Distribute:</strong> ₦' + d.totalDistributed.toLocaleString() + '</div>';
                    document.getElementById('prizeBody').innerHTML = h;
                    document.getElementById('confirmEndBtn').style.display = 'block';
                    document.getElementById('confirmEndBtn').onclick = () => confirmEnd(id);
                } else {
                    document.getElementById('prizeBody').innerHTML = '<div class="alert alert-info text-center"><i class="bi bi-info-circle me-2"></i>No qualifying participants for prizes</div>';
                    document.getElementById('confirmEndBtn').style.display = 'none';
                }
            } catch (e) {
                document.getElementById('prizeBody').innerHTML = '<div class="alert alert-danger">Error loading preview: ' + e.message + '</div>';
            }
        }
        
        function endTournament(id, name) {
            if (confirm('Are you sure you want to END "' + name + '"?\\n\\nThis will show the prize distribution preview.')) {
                previewPrizes(id);
            }
        }
        
        async function confirmEnd(id) {
            if (!confirm('⚠️ FINAL CONFIRMATION\\n\\nThis will:\\n• END the tournament permanently\\n• DISTRIBUTE prizes to winners\\n• NOTIFY all winners\\n\\nThis action CANNOT be undone!')) {
                return;
            }
            
            try {
                const r = await fetch('/admin/api/tournaments/' + id + '/end', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ preview: false, notifyWinners: true })
                });
                const res = await r.json();
                if (res.success) {
                    alert('✅ Tournament ended successfully!\\n\\n' + res.message);
                    location.reload();
                } else {
                    alert('Error: ' + res.error);
                }
            } catch (e) {
                alert('Error: ' + e.message);
            }
        }
    </script>
</body>
</html>
        `);
    } catch (error) {
        logger.error('Error rendering tournament management page:', error);
        res.status(500).send('Error loading page');
    }
});

// ============================================
// GET TOURNAMENT PARTICIPANTS (for admin leaderboard)
// ============================================
router.get('/api/tournaments/:id/participants', authenticateAdmin, async (req, res) => {
    try {
        const tournamentId = req.params.id;
        
        const result = await pool.query(`
            SELECT 
                tp.rank,
                tp.best_score,
                COALESCE(tp.best_questions_answered, 0) as best_questions_answered,
                COALESCE(tp.best_time_taken, 999) as best_time_taken,
                tp.games_played,
                tp.total_score,
                tp.prize_won,
                u.username,
                u.full_name,
                u.city,
                CASE WHEN u.phone_number LIKE 'tg_%' THEN 'telegram' ELSE 'whatsapp' END as platform,
                tp.joined_at
            FROM tournament_participants tp
            JOIN users u ON tp.user_id = u.id
            WHERE tp.tournament_id = $1
            ORDER BY 
                COALESCE(tp.best_questions_answered, 0) DESC,
                COALESCE(tp.best_time_taken, 999) ASC,
                tp.joined_at ASC
        `, [tournamentId]);

        res.json({ participants: result.rows });
    } catch (error) {
        logger.error('Error getting tournament participants:', error);
        res.status(500).json({ error: 'Failed to fetch participants' });
    }
});

// ============================================
// END OF TOURNAMENT MANAGEMENT ROUTES
// Make sure module.exports = router; comes after this
// ============================================
// ============================================
// QUESTION MANAGEMENT ROUTES
// ============================================
// ADD THIS SECTION TO: src/routes/admin.routes.js
// LOCATION: Before the final "module.exports = router;" line
// ============================================

// Serve Question Manager page
router.get('/questions', (req, res) => {
    res.sendFile('admin-questions.html', { root: './src/views' });
});

// Get all question banks
router.get('/api/questions/banks', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                qb.id,
                qb.bank_name,
                qb.display_name,
                qb.description,
                qb.for_game_mode,
                qb.is_active,
                COUNT(q.id) as question_count
            FROM question_banks qb
            LEFT JOIN questions q ON qb.id = q.question_bank_id AND q.is_active = true
            WHERE qb.is_active = true
            GROUP BY qb.id
            ORDER BY qb.for_game_mode, qb.bank_name
        `);
        
        res.json({ success: true, banks: result.rows });
    } catch (error) {
        logger.error('Error fetching question banks:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get question bank statistics
router.get('/api/questions/stats', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                qb.bank_name,
                qb.display_name,
                qb.for_game_mode,
                COUNT(q.id) as total_questions,
                COUNT(q.id) FILTER (WHERE q.difficulty BETWEEN 1 AND 5) as easy_count,
                COUNT(q.id) FILTER (WHERE q.difficulty BETWEEN 6 AND 10) as medium_count,
                COUNT(q.id) FILTER (WHERE q.difficulty BETWEEN 11 AND 15) as hard_count,
                COUNT(q.id) FILTER (WHERE q.is_active = true) as active_count
            FROM question_banks qb
            LEFT JOIN questions q ON qb.id = q.question_bank_id
            WHERE qb.is_active = true
            GROUP BY qb.id, qb.bank_name, qb.display_name, qb.for_game_mode
            ORDER BY qb.for_game_mode
        `);
        
        res.json({ success: true, stats: result.rows });
    } catch (error) {
        logger.error('Error fetching question stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all categories
router.get('/api/questions/categories', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                category as name,
                category as display_name,
                COUNT(*) as question_count
            FROM questions
            WHERE is_active = true AND category IS NOT NULL AND category != ''
            GROUP BY category
            ORDER BY question_count DESC
        `);
        
        res.json({ success: true, categories: result.rows });
    } catch (error) {
        logger.error('Error fetching categories:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create new category
router.post('/api/questions/categories', authenticateAdmin, async (req, res) => {
    try {
        const { name, display_name } = req.body;
        
        if (!name || !display_name) {
            return res.status(400).json({ success: false, error: 'Name and display_name required' });
        }
        
        // Check if question_categories table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'question_categories'
            ) as exists
        `);
        
        if (tableCheck.rows[0].exists) {
            await pool.query(`
                INSERT INTO question_categories (name, display_name)
                VALUES ($1, $2)
                ON CONFLICT (name) DO UPDATE SET display_name = $2
            `, [name, display_name]);
        }
        
        // Log the action
        await adminAuthService.logActivity(
            req.adminSession.admin_id,
            'create_category',
            { name, display_name },
            getIpAddress(req),
            req.headers['user-agent']
        );
        
        res.json({ success: true, category: { name, display_name } });
    } catch (error) {
        logger.error('Error creating category:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Check for duplicate questions
router.post('/api/questions/check-duplicates', authenticateAdmin, async (req, res) => {
    try {
        const { questions } = req.body;
        
        if (!questions || !Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ success: false, error: 'Questions array required' });
        }
        
        const placeholders = questions.map((_, i) => `$${i + 1}`).join(', ');
        
        const result = await pool.query(`
            SELECT id, question_text, question_bank_id, category
            FROM questions
            WHERE question_text IN (${placeholders})
            ORDER BY question_text
        `, questions);
        
        res.json({ 
            success: true, 
            duplicates: result.rows,
            total_checked: questions.length,
            duplicates_found: result.rows.length
        });
    } catch (error) {
        logger.error('Error checking duplicates:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bulk insert questions
router.post('/api/questions/bulk-insert', authenticateAdmin, async (req, res) => {
    try {
        const { questions } = req.body;
        
        if (!questions || !Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ success: false, error: 'Questions array required' });
        }
        
        const adminId = req.adminSession.admin_id;
        let inserted = 0;
        const errors = [];
        
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            for (const q of questions) {
                try {
                    if (!q.question_text || !q.option_a || !q.option_b || !q.option_c || !q.option_d || !q.correct_answer) {
                        errors.push(`Question "${q.question_text?.substring(0, 30)}..." is missing required fields`);
                        continue;
                    }
                    
                    await client.query(`
                        INSERT INTO questions (
                            question_text, option_a, option_b, option_c, option_d,
                            correct_answer, difficulty, category, fun_fact,
                            question_bank_id, is_practice, is_active, created_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, NOW())
                    `, [
                        q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
                        q.correct_answer, q.difficulty || 7, q.category || 'general',
                        q.fun_fact || '', q.question_bank_id || 1, q.is_practice || false
                    ]);
                    
                    inserted++;
                } catch (insertError) {
                    errors.push(`Failed to insert "${q.question_text?.substring(0, 30)}...": ${insertError.message}`);
                }
            }
            
            await client.query('COMMIT');
            
            await adminAuthService.logActivity(
                adminId, 'bulk_insert_questions',
                { total_submitted: questions.length, inserted, errors: errors.length,
                  question_bank_id: questions[0]?.question_bank_id, category: questions[0]?.category },
                getIpAddress(req), req.headers['user-agent']
            );
            
            logger.info(`Bulk insert: ${inserted}/${questions.length} questions inserted by admin ${adminId}`);
            
            res.json({ success: true, inserted, total_submitted: questions.length, errors: errors.length > 0 ? errors : null });
            
        } catch (transactionError) {
            await client.query('ROLLBACK');
            throw transactionError;
        } finally {
            client.release();
        }
        
    } catch (error) {
        logger.error('Error in bulk insert:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get questions by bank (paginated)
router.get('/api/questions/bank/:bankId', authenticateAdmin, async (req, res) => {
    try {
        const bankId = req.params.bankId;
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        const search = req.query.search || '';
        
        let query = `
            SELECT q.*, qb.bank_name, qb.display_name as bank_display_name
            FROM questions q
            LEFT JOIN question_banks qb ON q.question_bank_id = qb.id
            WHERE q.question_bank_id = $1
        `;
        
        const params = [bankId];
        
        if (search) {
            query += ` AND q.question_text ILIKE $2`;
            params.push(`%${search}%`);
        }
        
        query += ` ORDER BY q.difficulty ASC, q.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
        
        const result = await pool.query(query, params);
        const countResult = await pool.query(`SELECT COUNT(*) as total FROM questions WHERE question_bank_id = $1`, [bankId]);
        
        res.json({ success: true, questions: result.rows, total: parseInt(countResult.rows[0].total), limit, offset });
    } catch (error) {
        logger.error('Error fetching questions:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update a single question
router.put('/api/questions/:id', authenticateAdmin, async (req, res) => {
    try {
        const questionId = req.params.id;
        const updates = req.body;
        
        const allowedFields = [
            'question_text', 'option_a', 'option_b', 'option_c', 'option_d',
            'correct_answer', 'difficulty', 'category', 'fun_fact',
            'question_bank_id', 'is_practice', 'is_active'
        ];
        
        const setClauses = [];
        const values = [];
        let paramIndex = 1;
        
        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                setClauses.push(`${key} = $${paramIndex}`);
                values.push(value);
                paramIndex++;
            }
        }
        
        if (setClauses.length === 0) {
            return res.status(400).json({ success: false, error: 'No valid fields to update' });
        }
        
        values.push(questionId);
        
        const result = await pool.query(`
            UPDATE questions SET ${setClauses.join(', ')}, updated_at = NOW()
            WHERE id = $${paramIndex} RETURNING *
        `, values);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Question not found' });
        }
        
        await adminAuthService.logActivity(
            req.adminSession.admin_id, 'update_question',
            { question_id: questionId, updates: Object.keys(updates) },
            getIpAddress(req), req.headers['user-agent']
        );
        
        res.json({ success: true, question: result.rows[0] });
    } catch (error) {
        logger.error('Error updating question:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete (deactivate) a question
router.delete('/api/questions/:id', authenticateAdmin, async (req, res) => {
    try {
        const questionId = req.params.id;
        
        const result = await pool.query(`
            UPDATE questions SET is_active = false, updated_at = NOW()
            WHERE id = $1 RETURNING id, question_text
        `, [questionId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Question not found' });
        }
        
        await adminAuthService.logActivity(
            req.adminSession.admin_id, 'delete_question',
            { question_id: questionId, question_text: result.rows[0].question_text?.substring(0, 50) },
            getIpAddress(req), req.headers['user-agent']
        );
        
        res.json({ success: true, message: 'Question deactivated' });
    } catch (error) {
        logger.error('Error deleting question:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// END OF QUESTION MANAGEMENT ROUTES
// ============================================

// ============================================
// LOVE QUEST ADMIN ROUTES
// ============================================

// Get Love Quest dashboard stats
router.get('/api/love-quest/stats', authenticateAdmin, async (req, res) => {
    try {
        const stats = await loveQuestService.getBookingStats();
        res.json({ success: true, stats });
    } catch (error) {
        logger.error('Error getting Love Quest stats:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// Get all packages
router.get('/api/love-quest/packages', authenticateAdmin, async (req, res) => {
    try {
        const packages = await loveQuestService.getPackages();
        res.json({ success: true, packages });
    } catch (error) {
        logger.error('Error getting packages:', error);
        res.status(500).json({ error: 'Failed to get packages' });
    }
});

// Get all bookings
router.get('/api/love-quest/bookings', authenticateAdmin, async (req, res) => {
    try {
        const { status, limit = 50, offset = 0 } = req.query;
        const bookings = await loveQuestService.getAllBookings(status, parseInt(limit), parseInt(offset));
        res.json({ success: true, bookings });
    } catch (error) {
        logger.error('Error getting bookings:', error);
        res.status(500).json({ error: 'Failed to get bookings' });
    }
});

// Get single booking with full details
router.get('/api/love-quest/bookings/:id', authenticateAdmin, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        console.log(`[LoveQuest] Fetching booking ${bookingId}`);
        
        const booking = await loveQuestService.getBooking(bookingId);
        if (!booking) {
            console.log(`[LoveQuest] Booking ${bookingId} not found`);
            return res.status(404).json({ error: 'Booking not found' });
        }
        console.log(`[LoveQuest] Found booking: ${booking.booking_code}`);
        
        let questions = [];
        let media = [];
        let session = null;
        let audit = [];
        
        try {
            questions = await loveQuestService.getQuestions(booking.id);
            console.log(`[LoveQuest] Found ${questions.length} questions`);
        } catch (qErr) {
            console.error('[LoveQuest] Error fetching questions:', qErr.message);
        }
        
        try {
            const mediaResult = await pool.query(
                'SELECT * FROM love_quest_media WHERE booking_id = $1 ORDER BY uploaded_at',
                [booking.id]
            );
            media = mediaResult.rows;
        } catch (mErr) {
            console.error('[LoveQuest] Error fetching media:', mErr.message);
        }
        
        try {
            const sessionResult = await pool.query(
                'SELECT * FROM love_quest_sessions WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1',
                [booking.id]
            );
            session = sessionResult.rows[0] || null;
        } catch (sErr) {
            console.error('[LoveQuest] Error fetching session:', sErr.message);
        }
        
        try {
            const auditResult = await pool.query(
                'SELECT * FROM love_quest_audit WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 50',
                [booking.id]
            );
            audit = auditResult.rows;
        } catch (aErr) {
            console.error('[LoveQuest] Error fetching audit:', aErr.message);
        }
        
        res.json({
            success: true,
            booking,
            questions,
            media,
            session,
            audit
        });
    } catch (error) {
        console.error('[LoveQuest] Error getting booking details:', error);
        logger.error('Error getting booking details:', error);
        res.status(500).json({ error: 'Failed to get booking details', details: error.message });
    }
});

// Create new booking (admin)
router.post('/api/love-quest/bookings', authenticateAdmin, async (req, res) => {
    try {
        const { creatorPhone, playerPhone, packageCode, creatorName, playerName } = req.body;
        
        if (!creatorPhone || !playerPhone || !packageCode) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const booking = await loveQuestService.createBooking(
            creatorPhone, playerPhone, packageCode, creatorName, playerName
        );
        
        res.json({ success: true, booking });
    } catch (error) {
        logger.error('Error creating booking:', error);
        res.status(500).json({ error: error.message || 'Failed to create booking' });
    }
});

// Update booking status
router.put('/api/love-quest/bookings/:id/status', authenticateAdmin, async (req, res) => {
    try {
        const { status, notes } = req.body;
        const validStatuses = [
            'pending', 'paid', 'curating', 'ready', 'scheduled',
            'sent', 'in_progress', 'completed', 'expired', 'cancelled', 'refunded'
        ];
        
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        
        await loveQuestService.updateBookingStatus(parseInt(req.params.id), status, notes);
        res.json({ success: true });
    } catch (error) {
        logger.error('Error updating booking status:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Update booking details
router.put('/api/love-quest/bookings/:id', authenticateAdmin, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        const {
            creatorName, playerName, relationshipType,
            scheduledSendAt, grandRevealText, grandRevealCashPrize,
            curatorNotes, prizePool
        } = req.body;
        
        await pool.query(`
            UPDATE love_quest_bookings SET
                creator_name = COALESCE($1, creator_name),
                player_name = COALESCE($2, player_name),
                relationship_type = COALESCE($3, relationship_type),
                scheduled_send_at = COALESCE($4, scheduled_send_at),
                grand_reveal_text = COALESCE($5, grand_reveal_text),
                grand_reveal_cash_prize = COALESCE($6, grand_reveal_cash_prize),
                curator_notes = COALESCE($7, curator_notes),
                prize_pool = COALESCE($8, prize_pool),
                updated_at = NOW()
            WHERE id = $9
        `, [
            creatorName, playerName, relationshipType,
            scheduledSendAt, grandRevealText, grandRevealCashPrize,
            curatorNotes, prizePool, bookingId
        ]);
        
        res.json({ success: true });
    } catch (error) {
        logger.error('Error updating booking:', error);
        res.status(500).json({ error: 'Failed to update booking' });
    }
});

// Mark payment received
router.post('/api/love-quest/bookings/:id/payment', authenticateAdmin, async (req, res) => {
    try {
        const { amount, reference } = req.body;
        const bookingId = parseInt(req.params.id);
        
        await pool.query(`
            UPDATE love_quest_bookings 
            SET total_paid = COALESCE(total_paid, 0) + $1, status = 'paid'
            WHERE id = $2
        `, [amount, bookingId]);
        
        await loveQuestService.logAuditEvent(bookingId, null, 'payment_received', {
            amount, reference
        }, 'admin', req.adminSession?.admin_id);
        
        res.json({ success: true });
    } catch (error) {
        logger.error('Error recording payment:', error);
        res.status(500).json({ error: 'Failed to record payment' });
    }
});

// Send invitation
router.post('/api/love-quest/bookings/:id/send-invitation', authenticateAdmin, async (req, res) => {
    try {
        const MessagingService = require('../services/messaging.service');
        const messagingService = new MessagingService();
        
        await loveQuestService.sendInvitation(parseInt(req.params.id), messagingService);
        res.json({ success: true, message: 'Invitation sent' });
    } catch (error) {
        logger.error('Error sending invitation:', error);
        res.status(500).json({ error: error.message || 'Failed to send invitation' });
    }
});

// Add/update question
router.post('/api/love-quest/bookings/:id/questions', authenticateAdmin, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        const question = await loveQuestService.addQuestion(bookingId, req.body);
        res.json({ success: true, question });
    } catch (error) {
        logger.error('Error adding question:', error);
        res.status(500).json({ error: 'Failed to add question' });
    }
});

// Get questions for booking
router.get('/api/love-quest/bookings/:id/questions', authenticateAdmin, async (req, res) => {
    try {
        const questions = await loveQuestService.getQuestions(parseInt(req.params.id));
        res.json({ success: true, questions });
    } catch (error) {
        logger.error('Error getting questions:', error);
        res.status(500).json({ error: 'Failed to get questions' });
    }
});

// Delete question
router.delete('/api/love-quest/questions/:id', authenticateAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM love_quest_questions WHERE id = $1', [parseInt(req.params.id)]);
        res.json({ success: true });
    } catch (error) {
        logger.error('Error deleting question:', error);
        res.status(500).json({ error: 'Failed to delete question' });
    }
});

// Bulk add questions
router.post('/api/love-quest/bookings/:id/questions/bulk', authenticateAdmin, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        const { questions } = req.body;
        
        if (!Array.isArray(questions)) {
            return res.status(400).json({ error: 'Questions must be an array' });
        }
        
        const results = [];
        for (const q of questions) {
            const question = await loveQuestService.addQuestion(bookingId, {
                ...q,
                questionNumber: q.questionNumber || results.length + 1
            });
            results.push(question);
        }
        
        res.json({ success: true, questions: results, count: results.length });
    } catch (error) {
        logger.error('Error bulk adding questions:', error);
        res.status(500).json({ error: 'Failed to add questions' });
    }
});

// Get media for booking
router.get('/api/love-quest/bookings/:id/media', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM love_quest_media WHERE booking_id = $1 ORDER BY uploaded_at',
            [parseInt(req.params.id)]
        );
        res.json({ success: true, media: result.rows });
    } catch (error) {
        logger.error('Error getting media:', error);
        res.status(500).json({ error: 'Failed to get media' });
    }
});

// Delete media
router.delete('/api/love-quest/media/:id', authenticateAdmin, async (req, res) => {
    try {
        const fs = require('fs');
        const mediaResult = await pool.query(
            'SELECT file_path FROM love_quest_media WHERE id = $1',
            [parseInt(req.params.id)]
        );
        
        if (mediaResult.rows[0]?.file_path) {
            if (fs.existsSync(mediaResult.rows[0].file_path)) {
                fs.unlinkSync(mediaResult.rows[0].file_path);
            }
        }
        
        await pool.query('DELETE FROM love_quest_media WHERE id = $1', [parseInt(req.params.id)]);
        res.json({ success: true });
    } catch (error) {
        logger.error('Error deleting media:', error);
        res.status(500).json({ error: 'Failed to delete media' });
    }
});

// Get session details
router.get('/api/love-quest/sessions/:id', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.*, b.booking_code, b.creator_name, b.player_name
            FROM love_quest_sessions s
            JOIN love_quest_bookings b ON s.booking_id = b.id
            WHERE s.id = $1
        `, [parseInt(req.params.id)]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        res.json({ success: true, session: result.rows[0] });
    } catch (error) {
        logger.error('Error getting session:', error);
        res.status(500).json({ error: 'Failed to get session' });
    }
});

// Audit trail
router.get('/api/love-quest/audit', authenticateAdmin, async (req, res) => {
    try {
        const { bookingId, limit = 100 } = req.query;
        
        let query = `
            SELECT a.*, b.booking_code
            FROM love_quest_audit a
            LEFT JOIN love_quest_bookings b ON a.booking_id = b.id
        `;
        const params = [];
        
        if (bookingId) {
            query += ' WHERE a.booking_id = $1';
            params.push(parseInt(bookingId));
        }
        
        query += ' ORDER BY a.created_at DESC LIMIT $' + (params.length + 1);
        params.push(parseInt(limit));
        
        const result = await pool.query(query, params);
        res.json({ success: true, events: result.rows });
    } catch (error) {
        logger.error('Error getting audit trail:', error);
        res.status(500).json({ error: 'Failed to get audit trail' });
    }
});

// Update package pricing
router.put('/api/love-quest/packages/:code', authenticateAdmin, async (req, res) => {
    try {
        const { basePrice, isActive, description } = req.body;
        
        await pool.query(`
            UPDATE love_quest_packages SET
                base_price = COALESCE($1, base_price),
                is_active = COALESCE($2, is_active),
                description = COALESCE($3, description)
            WHERE package_code = $4
        `, [basePrice, isActive, description, req.params.code]);
        
        res.json({ success: true });
    } catch (error) {
        logger.error('Error updating package:', error);
        res.status(500).json({ error: 'Failed to update package' });
    }
});

// Process scheduled invitations
router.post('/api/love-quest/process-scheduled', authenticateAdmin, async (req, res) => {
    try {
        const MessagingService = require('../services/messaging.service');
        const messagingService = new MessagingService();
        
        const result = await pool.query(`
            SELECT id FROM love_quest_bookings 
            WHERE status = 'scheduled' 
            AND scheduled_send_at <= NOW()
            AND scheduled_send_at > NOW() - INTERVAL '1 hour'
        `);
        
        let sent = 0;
        for (const row of result.rows) {
            try {
                await loveQuestService.sendInvitation(row.id, messagingService);
                sent++;
            } catch (err) {
                logger.error(`Failed to send scheduled invitation ${row.id}:`, err);
            }
        }
        
        res.json({ success: true, processed: result.rows.length, sent });
    } catch (error) {
        logger.error('Error processing scheduled sends:', error);
        res.status(500).json({ error: 'Failed to process scheduled sends' });
    }
});

// Generate default wrong responses helper
router.post('/api/love-quest/generate-responses', authenticateAdmin, async (req, res) => {
    try {
        const { playerName } = req.body;
        
        const responses = {
            generic: [
                `😤 ${playerName || 'Babe'}! How could you forget that?!\n\nBut... I still love you. 💕`,
                `😢 Ouch! That wasn't it...\n\nI'm not mad, just disappointed. 💔\n\nJust kidding! Try again!`,
                `🙈 Nooo! That's not right!\n\nWe need to make more memories together! 💕`,
                `😅 Wrong answer, but I'll forgive you...\n\nYou're lucky you're cute! 💕`,
                `💔 *dramatically clutches heart*\n\nHow could you?!\n\n...I'm over it. Let's continue! 😘`
            ],
            correct: [
                `✅ YES! You DO know me! 🎉💕`,
                `✅ That's right, baby! 🥰`,
                `✅ See? This is why I love you! 💕`,
                `✅ PERFECT! You remembered! 🎉`
            ]
        };
        
        res.json({ 
            success: true, 
            responses,
            suggestion: responses.generic[Math.floor(Math.random() * responses.generic.length)]
        });
    } catch (error) {
        logger.error('Error generating responses:', error);
        res.status(500).json({ error: 'Failed to generate responses' });
    }
});

// Export booking data
router.get('/api/love-quest/bookings/:id/export', authenticateAdmin, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        
        const booking = await loveQuestService.getBooking(bookingId);
        const questions = await loveQuestService.getQuestions(bookingId);
        
        const mediaResult = await pool.query(
            'SELECT * FROM love_quest_media WHERE booking_id = $1',
            [bookingId]
        );
        
        const sessionResult = await pool.query(
            'SELECT * FROM love_quest_sessions WHERE booking_id = $1',
            [bookingId]
        );
        
        const exportData = {
            exportedAt: new Date().toISOString(),
            booking,
            questions,
            media: mediaResult.rows,
            sessions: sessionResult.rows
        };
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=love-quest-${booking.booking_code}.json`);
        res.json(exportData);
    } catch (error) {
        logger.error('Error exporting booking:', error);
        res.status(500).json({ error: 'Failed to export booking' });
    }
});

// ============================================
// END OF LOVE QUEST ROUTES
// ============================================

module.exports = router;