// ============================================
// FILE: src/routes/admin.routes.js - COMPLETE VERSION WITH ALL FEATURES
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

router.get('/', (req, res) => {
  res.sendFile('admin.html', { root: './src/views' });
});

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
// ANALYTICS ENDPOINTS
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
        u.lga,
        u.total_games_played,
        u.total_winnings,
        u.highest_question_reached
      FROM users u
      WHERE u.total_winnings > 0
      ORDER BY u.total_winnings DESC
      LIMIT 5
    `);

    const lgaDistribution = await pool.query(`
      SELECT 
        lga,
        COUNT(*) as user_count,
        COALESCE(SUM(total_winnings), 0) as total_winnings
      FROM users
      GROUP BY lga
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
      lgaDistribution: lgaDistribution.rows,
      completionStats: completionStats.rows[0]
    });
  } catch (error) {
    logger.error('Error getting analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// FIXED: User Activity
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

// FIXED: Conversion Funnel
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

// LGA Performance
router.get('/api/analytics/lga-performance', authenticateAdmin, async (req, res) => {
  try {
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_lga_performance',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

    const lgaStats = await pool.query(`
      SELECT
        lga,
        COUNT(*) as user_count,
        COALESCE(SUM(total_games_played), 0) as total_games,
        COALESCE(SUM(total_winnings), 0) as total_winnings,
        COALESCE(AVG(total_winnings), 0) as avg_winnings_per_user,
        ROUND(
          COALESCE(AVG(total_games_played), 0),
          1
        ) as avg_games_per_user
      FROM users
      GROUP BY lga
      ORDER BY total_games DESC
      LIMIT 15
    `);

    res.json(lgaStats.rows);
  } catch (error) {
    logger.error('Error getting LGA performance:', error);
    res.status(500).json({ error: 'Failed to fetch LGA performance' });
  }
});

// User Retention
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

// Enhanced Analytics
router.get('/api/analytics/enhanced', authenticateAdmin, async (req, res) => {
  try {
    await adminAuthService.logActivity(
      req.adminSession.admin_id,
      'view_enhanced_analytics',
      {},
      getIpAddress(req),
      req.headers['user-agent']
    );

    const gamesCount = await pool.query(`SELECT * FROM games_count_by_period`);
    
    const peakTimes = await pool.query(`
      SELECT 
        hour_of_day,
        day_of_week,
        SUM(games_count) as total_games
      FROM game_session_hourly_stats
      WHERE date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY hour_of_day, day_of_week
      ORDER BY hour_of_day, day_of_week
    `);

    const questionCategories = await pool.query(`
      SELECT * FROM question_category_performance
      ORDER BY total_times_asked DESC
      LIMIT 10
    `);

    const retentionMetrics = await pool.query(`
      SELECT * FROM user_retention_metrics
      WHERE registration_date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY registration_date DESC
    `);

    const dailyActiveUsers = await pool.query(`
      SELECT 
        DATE(last_active) as date,
        COUNT(DISTINCT id) as active_users
      FROM users
      WHERE last_active >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(last_active)
      ORDER BY date ASC
    `);

    const engagementFunnel = await pool.query(`
      SELECT 
        COUNT(*) as total_registered,
        COUNT(CASE WHEN total_games_played > 0 THEN 1 END) as started_game,
        COUNT(CASE WHEN total_games_played >= 3 THEN 1 END) as played_3_games,
        COUNT(CASE WHEN total_winnings > 0 THEN 1 END) as won_prize,
        COUNT(CASE WHEN total_games_played >= 10 THEN 1 END) as power_users
      FROM users
    `);

    const lgaPerformance = await pool.query(`
      SELECT 
        lga,
        COUNT(*) as user_count,
        COALESCE(SUM(total_games_played), 0) as total_games,
        COALESCE(SUM(total_winnings), 0) as total_winnings,
        COALESCE(AVG(total_winnings), 0) as avg_winnings_per_user
      FROM users
      GROUP BY lga
      ORDER BY total_games DESC
      LIMIT 10
    `);

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

    const conversionRate = await pool.query(`
      SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN total_games_played > 0 THEN 1 END) as converted_users,
        ROUND(
          (COUNT(CASE WHEN total_games_played > 0 THEN 1 END)::numeric / COUNT(*)::numeric) * 100,
          1
        ) as conversion_rate_percentage
      FROM users
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
    `);

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
    `);

    const winRateByQuestion = await pool.query(`
      SELECT 
        current_question,
        COUNT(*) as attempts,
        COUNT(CASE WHEN final_score > 0 THEN 1 END) as wins,
        ROUND(
          (COUNT(CASE WHEN final_score > 0 THEN 1 END)::numeric / COUNT(*)::numeric) * 100,
          1
        ) as win_rate_percentage
      FROM game_sessions
      WHERE status = 'completed'
        AND current_question BETWEEN 1 AND 15
      GROUP BY current_question
      ORDER BY current_question ASC
    `);

    const returningUsers = await pool.query(`
      SELECT 
        COUNT(DISTINCT CASE 
          WHEN last_active >= CURRENT_DATE - INTERVAL '7 days' THEN id 
        END) as active_last_7_days,
        COUNT(DISTINCT CASE 
          WHEN last_active >= CURRENT_DATE - INTERVAL '14 days' 
          AND last_active < CURRENT_DATE - INTERVAL '7 days' THEN id 
        END) as active_7_to_14_days_ago,
        COUNT(DISTINCT CASE 
          WHEN last_active >= CURRENT_DATE - INTERVAL '7 days' 
          AND last_active >= CURRENT_DATE - INTERVAL '14 days'
          AND last_active < CURRENT_DATE - INTERVAL '7 days' THEN id 
        END) as returning_users
      FROM users
      WHERE last_active IS NOT NULL
    `);

    res.json({
      gamesCount: gamesCount.rows[0],
      peakTimes: peakTimes.rows,
      questionCategories: questionCategories.rows,
      retentionMetrics: retentionMetrics.rows,
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

router.get('/api/analytics/games-count', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM games_count_by_period');
    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Error getting games count:', error);
    res.status(500).json({ error: 'Failed to fetch games count' });
  }
});

// FIXED: Peak Times (auto-populates if empty)
router.get('/api/analytics/peak-times', authenticateAdmin, async (req, res) => {
  try {
    const checkData = await pool.query(`SELECT COUNT(*) as count FROM game_session_hourly_stats`);

    if (parseInt(checkData.rows[0].count) === 0) {
      logger.info('Populating hourly stats for the first time...');
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
      `);
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
    `);

    res.json(result.rows);
  } catch (error) {
    logger.error('Error getting peak times:', error);
    res.status(500).json({ error: 'Failed to fetch peak times' });
  }
});

router.get('/api/analytics/categories', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('REFRESH MATERIALIZED VIEW question_category_performance');
    const result = await pool.query(`
      SELECT * FROM question_category_performance
      ORDER BY total_times_asked DESC
    `);
    res.json(result.rows);
  } catch (error) {
    logger.error('Error getting category performance:', error);
    res.status(500).json({ error: 'Failed to fetch category performance' });
  }
});

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

// ============================================
// FILE: src/routes/admin.routes.js
// REPLACE THE /api/users ENDPOINT WITH THIS
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
// QUESTION ROUTES
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

module.exports = router;