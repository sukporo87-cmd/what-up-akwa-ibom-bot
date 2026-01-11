// ============================================
// FILE: src/services/financial.service.js
// COMPREHENSIVE FINANCIAL MANAGEMENT SERVICE
// For What's Up Trivia - Financial Dashboard
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class FinancialService {
  
  // ============================================
  // REVENUE OVERVIEW - TOP LEVEL METRICS
  // ============================================
  
  async getRevenueOverview(startDate = null, endDate = null) {
    try {
      const dateFilter = this.buildDateFilter(startDate, endDate, 'created_at');
      
      // Token Revenue (Classic Mode)
      const tokenRevenue = await pool.query(`
        SELECT 
          COALESCE(SUM(amount), 0) as total,
          COUNT(*) as transaction_count
        FROM payment_transactions
        WHERE status = 'success'
        ${dateFilter ? `AND ${dateFilter}` : ''}
      `);
      
      // Tournament Entry Revenue
      const tournamentRevenue = await pool.query(`
        SELECT 
          COALESCE(SUM(amount_paid), 0) as total,
          COUNT(*) as transaction_count
        FROM tournament_entry_payments
        WHERE payment_status = 'success'
        ${dateFilter ? `AND ${dateFilter}` : ''}
      `);
      
      // Total Payouts
      const payouts = await pool.query(`
        SELECT 
          COALESCE(SUM(t.amount), 0) as total,
          COUNT(*) as payout_count
        FROM transactions t
        JOIN payout_history ph ON t.id = ph.transaction_id
        WHERE t.transaction_type = 'prize'
        AND ph.action = 'completed'
        ${dateFilter ? `AND t.${dateFilter}` : ''}
      `);
      
      // Pending Payouts (Outstanding Obligations)
      const pendingPayouts = await pool.query(`
        SELECT 
          COALESCE(SUM(amount), 0) as total,
          COUNT(*) as pending_count
        FROM transactions
        WHERE transaction_type = 'prize'
        AND payout_status IN ('pending', 'details_collected', 'approved')
        ${dateFilter ? `AND ${dateFilter}` : ''}
      `);
      
      const grossRevenue = parseFloat(tokenRevenue.rows[0].total) + parseFloat(tournamentRevenue.rows[0].total);
      const totalPayouts = parseFloat(payouts.rows[0].total);
      const netRevenue = grossRevenue - totalPayouts;
      const profitMargin = grossRevenue > 0 ? ((netRevenue / grossRevenue) * 100).toFixed(2) : 0;
      const payoutRatio = grossRevenue > 0 ? ((totalPayouts / grossRevenue) * 100).toFixed(2) : 0;
      
      return {
        gross_revenue: grossRevenue,
        token_revenue: parseFloat(tokenRevenue.rows[0].total),
        token_transactions: parseInt(tokenRevenue.rows[0].transaction_count),
        tournament_revenue: parseFloat(tournamentRevenue.rows[0].total),
        tournament_transactions: parseInt(tournamentRevenue.rows[0].transaction_count),
        total_payouts: totalPayouts,
        payout_count: parseInt(payouts.rows[0].payout_count),
        pending_payouts: parseFloat(pendingPayouts.rows[0].total),
        pending_count: parseInt(pendingPayouts.rows[0].pending_count),
        net_revenue: netRevenue,
        profit_margin: parseFloat(profitMargin),
        payout_ratio: parseFloat(payoutRatio),
        house_edge: parseFloat(profitMargin)
      };
    } catch (error) {
      logger.error('Error getting revenue overview:', error);
      throw error;
    }
  }
  
  // ============================================
  // TOKEN REVENUE BREAKDOWN
  // ============================================
  
  async getTokenRevenueBreakdown(startDate = null, endDate = null) {
    try {
      const dateFilter = this.buildDateFilter(startDate, endDate, 'pt.created_at');
      
      const result = await pool.query(`
        SELECT 
          gp.name as package_name,
          gp.price_naira as price,
          gp.games_count,
          COUNT(pt.id) as sales_count,
          COALESCE(SUM(pt.amount), 0) as total_revenue,
          COALESCE(SUM(pt.games_purchased), 0) as total_games_sold
        FROM game_packages gp
        LEFT JOIN payment_transactions pt ON gp.id = pt.package_id 
          AND pt.status = 'success'
          ${dateFilter ? `AND ${dateFilter}` : ''}
        WHERE gp.is_active = true
        GROUP BY gp.id, gp.name, gp.price_naira, gp.games_count
        ORDER BY gp.price_naira ASC
      `);
      
      // Also get platform breakdown
      const platformBreakdown = await pool.query(`
        SELECT 
          COALESCE(platform, 'whatsapp') as platform,
          COUNT(*) as transaction_count,
          COALESCE(SUM(amount), 0) as total_revenue
        FROM payment_transactions
        WHERE status = 'success'
        ${dateFilter ? `AND ${dateFilter.replace('pt.', '')}` : ''}
        GROUP BY platform
      `);
      
      return {
        by_package: result.rows,
        by_platform: platformBreakdown.rows,
        total_revenue: result.rows.reduce((sum, row) => sum + parseFloat(row.total_revenue), 0),
        total_sales: result.rows.reduce((sum, row) => sum + parseInt(row.sales_count), 0)
      };
    } catch (error) {
      logger.error('Error getting token revenue breakdown:', error);
      throw error;
    }
  }
  
  // ============================================
  // TOURNAMENT REVENUE
  // ============================================
  
  async getTournamentRevenue(startDate = null, endDate = null) {
    try {
      const dateFilter = this.buildDateFilter(startDate, endDate, 't.created_at');
      
      const result = await pool.query(`
        SELECT 
          t.id,
          t.tournament_name,
          t.payment_type,
          t.entry_fee,
          t.prize_pool,
          t.status,
          t.start_date,
          t.end_date,
          COUNT(DISTINCT tp.user_id) as total_participants,
          COUNT(DISTINCT tep.user_id) FILTER (WHERE tep.payment_status = 'success') as paid_participants,
          COALESCE(SUM(tep.amount_paid) FILTER (WHERE tep.payment_status = 'success'), 0) as total_entry_fees,
          COALESCE(
            (SELECT SUM(tr.amount) FROM transactions tr 
             WHERE tr.session_id IN (SELECT gs.id FROM game_sessions gs WHERE gs.tournament_id = t.id)
             AND tr.transaction_type = 'prize'
             AND tr.payout_status = 'completed'), 0
          ) as prizes_paid,
          CASE 
            WHEN t.payment_type = 'paid' THEN 
              COALESCE(SUM(tep.amount_paid) FILTER (WHERE tep.payment_status = 'success'), 0) - t.prize_pool
            ELSE 0 - t.prize_pool
          END as net_profit
        FROM tournaments t
        LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
        LEFT JOIN tournament_entry_payments tep ON t.id = tep.tournament_id
        ${dateFilter ? `WHERE ${dateFilter}` : ''}
        GROUP BY t.id, t.tournament_name, t.payment_type, t.entry_fee, t.prize_pool, t.status, t.start_date, t.end_date
        ORDER BY t.start_date DESC
      `);
      
      // Calculate summary
      const summary = result.rows.reduce((acc, row) => {
        acc.total_entry_fees += parseFloat(row.total_entry_fees);
        acc.total_prize_pools += parseFloat(row.prize_pool);
        acc.total_prizes_paid += parseFloat(row.prizes_paid);
        acc.total_participants += parseInt(row.total_participants);
        if (row.payment_type === 'free') acc.free_tournaments++;
        else acc.paid_tournaments++;
        return acc;
      }, {
        total_entry_fees: 0,
        total_prize_pools: 0,
        total_prizes_paid: 0,
        total_participants: 0,
        free_tournaments: 0,
        paid_tournaments: 0
      });
      
      summary.net_revenue = summary.total_entry_fees - summary.total_prizes_paid;
      summary.roi = summary.total_entry_fees > 0 
        ? (((summary.total_entry_fees - summary.total_prizes_paid) / summary.total_entry_fees) * 100).toFixed(2)
        : 0;
      
      return {
        tournaments: result.rows.map(row => ({
          ...row,
          roi: row.total_entry_fees > 0 
            ? (((parseFloat(row.total_entry_fees) - parseFloat(row.prizes_paid)) / parseFloat(row.total_entry_fees)) * 100).toFixed(2)
            : row.payment_type === 'free' ? 'N/A' : '0'
        })),
        summary
      };
    } catch (error) {
      logger.error('Error getting tournament revenue:', error);
      throw error;
    }
  }
  
  // ============================================
  // CLASSIC MODE WINNINGS
  // ============================================
  
  async getClassicModeWinnings(startDate = null, endDate = null) {
    try {
      const dateFilter = this.buildDateFilter(startDate, endDate, 't.created_at');
      
      const result = await pool.query(`
        SELECT 
          DATE(t.created_at) as date,
          COUNT(*) as winner_count,
          COALESCE(SUM(t.amount), 0) as total_winnings,
          COALESCE(AVG(t.amount), 0) as avg_winning,
          COALESCE(MAX(t.amount), 0) as highest_winning,
          COALESCE(MIN(t.amount), 0) as lowest_winning
        FROM transactions t
        JOIN game_sessions gs ON t.session_id = gs.id
        WHERE t.transaction_type = 'prize'
        AND gs.game_mode = 'classic'
        ${dateFilter ? `AND ${dateFilter}` : ''}
        GROUP BY DATE(t.created_at)
        ORDER BY date DESC
        LIMIT 30
      `);
      
      // Get totals
      const totals = await pool.query(`
        SELECT 
          COUNT(*) as total_wins,
          COALESCE(SUM(t.amount), 0) as total_amount,
          COALESCE(AVG(t.amount), 0) as avg_amount
        FROM transactions t
        JOIN game_sessions gs ON t.session_id = gs.id
        WHERE t.transaction_type = 'prize'
        AND gs.game_mode = 'classic'
        ${dateFilter ? `AND ${dateFilter}` : ''}
      `);
      
      return {
        daily: result.rows,
        summary: {
          total_wins: parseInt(totals.rows[0].total_wins),
          total_amount: parseFloat(totals.rows[0].total_amount),
          avg_amount: parseFloat(totals.rows[0].avg_amount).toFixed(2)
        }
      };
    } catch (error) {
      logger.error('Error getting classic mode winnings:', error);
      throw error;
    }
  }
  
  // ============================================
  // PAYOUT TRACKING
  // ============================================
  
  async getPayoutTracking(startDate = null, endDate = null) {
    try {
      const dateFilter = this.buildDateFilter(startDate, endDate, 'ph.created_at');
      
      // Payout summary by status
      const statusSummary = await pool.query(`
        SELECT 
          t.payout_status as status,
          COUNT(*) as count,
          COALESCE(SUM(t.amount), 0) as total_amount
        FROM transactions t
        WHERE t.transaction_type = 'prize'
        ${dateFilter ? `AND ${dateFilter.replace('ph.', 't.')}` : ''}
        GROUP BY t.payout_status
      `);
      
      // Completed payouts with details
      const completedPayouts = await pool.query(`
        SELECT 
          ph.id,
          t.amount,
          u.username,
          u.phone_number,
          pd.bank_name,
          pd.account_number,
          gs.game_mode,
          ph.created_at as completed_at,
          ph.notes
        FROM payout_history ph
        JOIN transactions t ON ph.transaction_id = t.id
        JOIN users u ON t.user_id = u.id
        LEFT JOIN payout_details pd ON t.id = pd.transaction_id
        LEFT JOIN game_sessions gs ON t.session_id = gs.id
        WHERE ph.action = 'completed'
        ${dateFilter ? `AND ${dateFilter}` : ''}
        ORDER BY ph.created_at DESC
        LIMIT 100
      `);
      
      // Pending payouts
      const pendingPayouts = await pool.query(`
        SELECT 
          t.id,
          t.amount,
          t.payout_status,
          t.created_at,
          u.id as user_id,
          u.username,
          u.phone_number,
          pd.bank_name,
          pd.account_number,
          gs.game_mode
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN payout_details pd ON t.id = pd.transaction_id
        LEFT JOIN game_sessions gs ON t.session_id = gs.id
        WHERE t.transaction_type = 'prize'
        AND t.payout_status IN ('pending', 'details_collected', 'approved')
        ${dateFilter ? `AND ${dateFilter.replace('ph.', 't.')}` : ''}
        ORDER BY t.created_at ASC
      `);
      
      // By game mode
      const byGameMode = await pool.query(`
        SELECT 
          gs.game_mode,
          COUNT(*) as payout_count,
          COALESCE(SUM(t.amount), 0) as total_amount
        FROM payout_history ph
        JOIN transactions t ON ph.transaction_id = t.id
        LEFT JOIN game_sessions gs ON t.session_id = gs.id
        WHERE ph.action = 'completed'
        ${dateFilter ? `AND ${dateFilter}` : ''}
        GROUP BY gs.game_mode
      `);
      
      return {
        status_summary: statusSummary.rows,
        completed: completedPayouts.rows,
        pending: pendingPayouts.rows,
        by_game_mode: byGameMode.rows,
        total_completed: completedPayouts.rows.reduce((sum, row) => sum + parseFloat(row.amount), 0),
        total_pending: pendingPayouts.rows.reduce((sum, row) => sum + parseFloat(row.amount), 0)
      };
    } catch (error) {
      logger.error('Error getting payout tracking:', error);
      throw error;
    }
  }
  
  // ============================================
  // TOP WINNERS / EARNERS
  // ============================================
  
  async getTopWinners(limit = 20, startDate = null, endDate = null) {
    try {
      const dateFilter = this.buildDateFilter(startDate, endDate, 't.created_at');
      
      const result = await pool.query(`
        SELECT 
          u.id as user_id,
          u.username,
          u.phone_number,
          u.created_at as joined,
          COUNT(t.id) as win_count,
          COALESCE(SUM(t.amount), 0) as total_winnings,
          COALESCE(MAX(t.amount), 0) as highest_win,
          COALESCE(AVG(t.amount), 0) as avg_win
        FROM users u
        JOIN transactions t ON u.id = t.user_id
        WHERE t.transaction_type = 'prize'
        ${dateFilter ? `AND ${dateFilter}` : ''}
        GROUP BY u.id, u.username, u.phone_number, u.created_at
        ORDER BY total_winnings DESC
        LIMIT $1
      `, [limit]);
      
      return result.rows;
    } catch (error) {
      logger.error('Error getting top winners:', error);
      throw error;
    }
  }
  
  // ============================================
  // FINANCIAL KPIs
  // ============================================
  
  async getFinancialKPIs(startDate = null, endDate = null) {
    try {
      const dateFilter = this.buildDateFilter(startDate, endDate, 'created_at');
      
      // Total users
      const totalUsers = await pool.query(`
        SELECT COUNT(*) as count FROM users
        ${dateFilter ? `WHERE ${dateFilter}` : ''}
      `);
      
      // Paying users (users who made at least one purchase)
      const payingUsers = await pool.query(`
        SELECT COUNT(DISTINCT user_id) as count 
        FROM payment_transactions 
        WHERE status = 'success'
        ${dateFilter ? `AND ${dateFilter}` : ''}
      `);
      
      // Total revenue
      const totalRevenue = await pool.query(`
        SELECT 
          COALESCE(SUM(amount), 0) as token_revenue
        FROM payment_transactions
        WHERE status = 'success'
        ${dateFilter ? `AND ${dateFilter}` : ''}
      `);
      
      const tournamentRevenue = await pool.query(`
        SELECT 
          COALESCE(SUM(amount_paid), 0) as tournament_revenue
        FROM tournament_entry_payments
        WHERE payment_status = 'success'
        ${dateFilter ? `AND ${dateFilter}` : ''}
      `);
      
      // Total payouts
      const totalPayouts = await pool.query(`
        SELECT COALESCE(SUM(t.amount), 0) as total
        FROM transactions t
        JOIN payout_history ph ON t.id = ph.transaction_id
        WHERE t.transaction_type = 'prize'
        AND ph.action = 'completed'
        ${dateFilter ? `AND t.${dateFilter}` : ''}
      `);
      
      // Calculate LTV (simple: total revenue / total users)
      const totalRev = parseFloat(totalRevenue.rows[0].token_revenue) + parseFloat(tournamentRevenue.rows[0].tournament_revenue);
      const users = parseInt(totalUsers.rows[0].count);
      const payers = parseInt(payingUsers.rows[0].count);
      const payoutTotal = parseFloat(totalPayouts.rows[0].total);
      
      const arpu = users > 0 ? (totalRev / users).toFixed(2) : 0;
      const arppu = payers > 0 ? (totalRev / payers).toFixed(2) : 0;
      const ltv = users > 0 ? ((totalRev - payoutTotal) / users).toFixed(2) : 0;
      const conversionRate = users > 0 ? ((payers / users) * 100).toFixed(2) : 0;
      
      return {
        total_users: users,
        paying_users: payers,
        total_revenue: totalRev,
        total_payouts: payoutTotal,
        net_revenue: totalRev - payoutTotal,
        arpu: parseFloat(arpu),
        arppu: parseFloat(arppu),
        ltv: parseFloat(ltv),
        conversion_rate: parseFloat(conversionRate),
        house_edge: totalRev > 0 ? (((totalRev - payoutTotal) / totalRev) * 100).toFixed(2) : 0
      };
    } catch (error) {
      logger.error('Error getting financial KPIs:', error);
      throw error;
    }
  }
  
  // ============================================
  // REVENUE TRENDS (For Charts)
  // ============================================
  
  async getRevenueTrends(period = 'daily', days = 30) {
    try {
      let dateGroup, interval;
      
      switch (period) {
        case 'weekly':
          dateGroup = "DATE_TRUNC('week', created_at)";
          interval = `${days * 7} days`;
          break;
        case 'monthly':
          dateGroup = "DATE_TRUNC('month', created_at)";
          interval = `${days * 30} days`;
          break;
        default: // daily
          dateGroup = 'DATE(created_at)';
          interval = `${days} days`;
      }
      
      // Token revenue trend
      const tokenTrend = await pool.query(`
        SELECT 
          ${dateGroup} as date,
          COALESCE(SUM(amount), 0) as revenue,
          COUNT(*) as transactions
        FROM payment_transactions
        WHERE status = 'success'
        AND created_at >= CURRENT_DATE - INTERVAL '${interval}'
        GROUP BY ${dateGroup}
        ORDER BY date ASC
      `);
      
      // Tournament revenue trend
      const tournamentTrend = await pool.query(`
        SELECT 
          ${dateGroup} as date,
          COALESCE(SUM(amount_paid), 0) as revenue,
          COUNT(*) as transactions
        FROM tournament_entry_payments
        WHERE payment_status = 'success'
        AND created_at >= CURRENT_DATE - INTERVAL '${interval}'
        GROUP BY ${dateGroup}
        ORDER BY date ASC
      `);
      
      // Payout trend
      const payoutTrend = await pool.query(`
        SELECT 
          ${dateGroup.replace('created_at', 'ph.created_at')} as date,
          COALESCE(SUM(t.amount), 0) as amount,
          COUNT(*) as count
        FROM payout_history ph
        JOIN transactions t ON ph.transaction_id = t.id
        WHERE ph.action = 'completed'
        AND ph.created_at >= CURRENT_DATE - INTERVAL '${interval}'
        GROUP BY ${dateGroup.replace('created_at', 'ph.created_at')}
        ORDER BY date ASC
      `);
      
      return {
        token_revenue: tokenTrend.rows,
        tournament_revenue: tournamentTrend.rows,
        payouts: payoutTrend.rows
      };
    } catch (error) {
      logger.error('Error getting revenue trends:', error);
      throw error;
    }
  }
  
  // ============================================
  // TRANSACTION DRILL-DOWN
  // ============================================
  
  async getTransactionDetails(transactionId) {
    try {
      const result = await pool.query(`
        SELECT 
          t.*,
          u.username,
          u.phone_number,
          u.full_name,
          u.email,
          gs.game_mode,
          gs.final_score,
          gs.questions_answered,
          gs.started_at as game_started,
          gs.completed_at as game_completed,
          pd.bank_name,
          pd.account_number,
          pd.account_name,
          ph.action as payout_action,
          ph.created_at as payout_date,
          ph.admin_id as processed_by
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN game_sessions gs ON t.session_id = gs.id
        LEFT JOIN payout_details pd ON t.id = pd.transaction_id
        LEFT JOIN payout_history ph ON t.id = ph.transaction_id AND ph.action = 'completed'
        WHERE t.id = $1
      `, [transactionId]);
      
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting transaction details:', error);
      throw error;
    }
  }
  
  // ============================================
  // USER FINANCIAL PROFILE
  // ============================================
  
  async getUserFinancialProfile(userId) {
    try {
      // User basic info
      const user = await pool.query(`
        SELECT id, username, phone_number, full_name, email, 
               total_winnings, total_games_played, created_at
        FROM users WHERE id = $1
      `, [userId]);
      
      if (user.rows.length === 0) return null;
      
      // Purchase history
      const purchases = await pool.query(`
        SELECT 
          pt.id,
          pt.amount,
          pt.games_purchased,
          pt.status,
          pt.created_at,
          gp.name as package_name
        FROM payment_transactions pt
        JOIN game_packages gp ON pt.package_id = gp.id
        WHERE pt.user_id = $1
        ORDER BY pt.created_at DESC
      `, [userId]);
      
      // Win history
      const winnings = await pool.query(`
        SELECT 
          t.id,
          t.amount,
          t.payout_status,
          t.created_at,
          gs.game_mode
        FROM transactions t
        LEFT JOIN game_sessions gs ON t.session_id = gs.id
        WHERE t.user_id = $1 AND t.transaction_type = 'prize'
        ORDER BY t.created_at DESC
      `, [userId]);
      
      // Tournament participation
      const tournaments = await pool.query(`
        SELECT 
          tep.id,
          tep.amount_paid,
          tep.payment_status,
          tep.created_at,
          t.tournament_name
        FROM tournament_entry_payments tep
        JOIN tournaments t ON tep.tournament_id = t.id
        WHERE tep.user_id = $1
        ORDER BY tep.created_at DESC
      `, [userId]);
      
      // Calculate totals
      const totalSpent = purchases.rows
        .filter(p => p.status === 'success')
        .reduce((sum, p) => sum + parseFloat(p.amount), 0);
      
      const totalWon = winnings.rows.reduce((sum, w) => sum + parseFloat(w.amount), 0);
      
      const tournamentSpent = tournaments.rows
        .filter(t => t.payment_status === 'success')
        .reduce((sum, t) => sum + parseFloat(t.amount_paid), 0);
      
      return {
        user: user.rows[0],
        purchases: purchases.rows,
        winnings: winnings.rows,
        tournaments: tournaments.rows,
        summary: {
          total_spent_tokens: totalSpent,
          total_spent_tournaments: tournamentSpent,
          total_spent: totalSpent + tournamentSpent,
          total_won: totalWon,
          net_position: totalWon - (totalSpent + tournamentSpent),
          purchase_count: purchases.rows.filter(p => p.status === 'success').length,
          win_count: winnings.rows.length
        }
      };
    } catch (error) {
      logger.error('Error getting user financial profile:', error);
      throw error;
    }
  }
  
  // ============================================
  // COMPARISON REPORTS (Day-over-Day, Week-over-Week, etc.)
  // ============================================
  
  async getComparisonReport(type = 'daily') {
    try {
      let currentStart, currentEnd, previousStart, previousEnd;
      const now = new Date();
      
      switch (type) {
        case 'weekly':
          // This week vs last week
          const dayOfWeek = now.getDay();
          currentStart = new Date(now);
          currentStart.setDate(now.getDate() - dayOfWeek);
          currentStart.setHours(0, 0, 0, 0);
          currentEnd = now;
          
          previousStart = new Date(currentStart);
          previousStart.setDate(previousStart.getDate() - 7);
          previousEnd = new Date(currentStart);
          previousEnd.setMilliseconds(-1);
          break;
          
        case 'monthly':
          // This month vs last month
          currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
          currentEnd = now;
          
          previousStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          previousEnd = new Date(currentStart);
          previousEnd.setMilliseconds(-1);
          break;
          
        default: // daily
          // Today vs yesterday
          currentStart = new Date(now);
          currentStart.setHours(0, 0, 0, 0);
          currentEnd = now;
          
          previousStart = new Date(currentStart);
          previousStart.setDate(previousStart.getDate() - 1);
          previousEnd = new Date(currentStart);
          previousEnd.setMilliseconds(-1);
      }
      
      const [current, previous] = await Promise.all([
        this.getRevenueOverview(currentStart.toISOString(), currentEnd.toISOString()),
        this.getRevenueOverview(previousStart.toISOString(), previousEnd.toISOString())
      ]);
      
      // Calculate changes
      const calculateChange = (curr, prev) => {
        if (prev === 0) return curr > 0 ? 100 : 0;
        return (((curr - prev) / prev) * 100).toFixed(2);
      };
      
      return {
        current_period: {
          start: currentStart,
          end: currentEnd,
          data: current
        },
        previous_period: {
          start: previousStart,
          end: previousEnd,
          data: previous
        },
        changes: {
          gross_revenue: calculateChange(current.gross_revenue, previous.gross_revenue),
          token_revenue: calculateChange(current.token_revenue, previous.token_revenue),
          tournament_revenue: calculateChange(current.tournament_revenue, previous.tournament_revenue),
          total_payouts: calculateChange(current.total_payouts, previous.total_payouts),
          net_revenue: calculateChange(current.net_revenue, previous.net_revenue)
        }
      };
    } catch (error) {
      logger.error('Error getting comparison report:', error);
      throw error;
    }
  }
  
  // ============================================
  // REVENUE FORECAST (Simple Projection)
  // ============================================
  
  async getRevenueForecast() {
    try {
      // Get last 30 days average
      const last30Days = await pool.query(`
        SELECT 
          COALESCE(AVG(daily_revenue), 0) as avg_daily_revenue
        FROM (
          SELECT 
            DATE(created_at) as date,
            SUM(amount) as daily_revenue
          FROM payment_transactions
          WHERE status = 'success'
          AND created_at >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY DATE(created_at)
        ) daily
      `);
      
      const avgDaily = parseFloat(last30Days.rows[0].avg_daily_revenue);
      
      // Days remaining in month
      const now = new Date();
      const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const daysRemaining = lastDayOfMonth.getDate() - now.getDate();
      
      // Current month revenue so far
      const currentMonth = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM payment_transactions
        WHERE status = 'success'
        AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
      `);
      
      const currentMonthRevenue = parseFloat(currentMonth.rows[0].total);
      const projectedMonthEnd = currentMonthRevenue + (avgDaily * daysRemaining);
      
      return {
        avg_daily_revenue: avgDaily.toFixed(2),
        current_month_revenue: currentMonthRevenue,
        days_remaining: daysRemaining,
        projected_month_end: projectedMonthEnd.toFixed(2),
        projected_remaining: (avgDaily * daysRemaining).toFixed(2)
      };
    } catch (error) {
      logger.error('Error getting revenue forecast:', error);
      throw error;
    }
  }
  
  // ============================================
  // CHURN IMPACT (Revenue Lost)
  // ============================================
  
  async getChurnImpact() {
    try {
      // Users who purchased but haven't been active in 30 days
      const churnedPayers = await pool.query(`
        SELECT 
          COUNT(DISTINCT u.id) as churned_payers,
          COALESCE(SUM(pt.total_spent), 0) as historical_revenue
        FROM users u
        JOIN (
          SELECT user_id, SUM(amount) as total_spent
          FROM payment_transactions
          WHERE status = 'success'
          GROUP BY user_id
        ) pt ON u.id = pt.user_id
        WHERE u.last_active < CURRENT_DATE - INTERVAL '30 days'
      `);
      
      // Average revenue per paying user
      const arppu = await pool.query(`
        SELECT 
          COALESCE(AVG(total_spent), 0) as avg_spend
        FROM (
          SELECT user_id, SUM(amount) as total_spent
          FROM payment_transactions
          WHERE status = 'success'
          GROUP BY user_id
        ) user_totals
      `);
      
      const churnedCount = parseInt(churnedPayers.rows[0].churned_payers);
      const avgSpend = parseFloat(arppu.rows[0].avg_spend);
      const potentialLostRevenue = churnedCount * avgSpend;
      
      return {
        churned_payers: churnedCount,
        historical_revenue_from_churned: parseFloat(churnedPayers.rows[0].historical_revenue),
        avg_spend_per_payer: avgSpend.toFixed(2),
        potential_monthly_loss: potentialLostRevenue.toFixed(2)
      };
    } catch (error) {
      logger.error('Error getting churn impact:', error);
      throw error;
    }
  }
  
  // ============================================
  // HELPER METHODS
  // ============================================
  
  buildDateFilter(startDate, endDate, column = 'created_at') {
    if (!startDate && !endDate) return null;
    
    const conditions = [];
    if (startDate) {
      conditions.push(`${column} >= '${startDate}'`);
    }
    if (endDate) {
      conditions.push(`${column} <= '${endDate}'`);
    }
    
    return conditions.join(' AND ');
  }
  
  // ============================================
  // EXPORT DATA
  // ============================================
  
  async exportTransactions(startDate, endDate, type = 'all') {
    try {
      let query;
      const params = [];
      
      if (type === 'revenue') {
        query = `
          SELECT 
            'Token Purchase' as type,
            pt.reference,
            pt.amount,
            pt.games_purchased,
            pt.status,
            pt.platform,
            u.username,
            u.phone_number,
            pt.created_at
          FROM payment_transactions pt
          JOIN users u ON pt.user_id = u.id
          WHERE pt.status = 'success'
          ${startDate ? `AND pt.created_at >= $1` : ''}
          ${endDate ? `AND pt.created_at <= $${startDate ? 2 : 1}` : ''}
          
          UNION ALL
          
          SELECT 
            'Tournament Entry' as type,
            tep.reference,
            tep.amount_paid as amount,
            1 as games_purchased,
            tep.payment_status as status,
            tep.platform,
            u.username,
            u.phone_number,
            tep.created_at
          FROM tournament_entry_payments tep
          JOIN users u ON tep.user_id = u.id
          WHERE tep.payment_status = 'success'
          ${startDate ? `AND tep.created_at >= $1` : ''}
          ${endDate ? `AND tep.created_at <= $${startDate ? 2 : 1}` : ''}
          
          ORDER BY created_at DESC
        `;
      } else if (type === 'payouts') {
        query = `
          SELECT 
            t.id as transaction_id,
            t.amount,
            t.payout_status,
            u.username,
            u.phone_number,
            pd.bank_name,
            pd.account_number,
            gs.game_mode,
            t.created_at as win_date,
            ph.created_at as payout_date
          FROM transactions t
          JOIN users u ON t.user_id = u.id
          LEFT JOIN payout_details pd ON t.id = pd.transaction_id
          LEFT JOIN payout_history ph ON t.id = ph.transaction_id AND ph.action = 'completed'
          LEFT JOIN game_sessions gs ON t.session_id = gs.id
          WHERE t.transaction_type = 'prize'
          ${startDate ? `AND t.created_at >= $1` : ''}
          ${endDate ? `AND t.created_at <= $${startDate ? 2 : 1}` : ''}
          ORDER BY t.created_at DESC
        `;
      } else {
        // All transactions
        query = `
          SELECT * FROM (
            SELECT 
              'Token Purchase' as type,
              pt.id,
              pt.amount,
              'revenue' as category,
              pt.status,
              u.username,
              u.phone_number,
              pt.created_at
            FROM payment_transactions pt
            JOIN users u ON pt.user_id = u.id
            ${startDate ? `WHERE pt.created_at >= $1` : ''}
            ${endDate ? `${startDate ? 'AND' : 'WHERE'} pt.created_at <= $${startDate ? 2 : 1}` : ''}
            
            UNION ALL
            
            SELECT 
              'Tournament Entry' as type,
              tep.id,
              tep.amount_paid as amount,
              'revenue' as category,
              tep.payment_status as status,
              u.username,
              u.phone_number,
              tep.created_at
            FROM tournament_entry_payments tep
            JOIN users u ON tep.user_id = u.id
            ${startDate ? `WHERE tep.created_at >= $1` : ''}
            ${endDate ? `${startDate ? 'AND' : 'WHERE'} tep.created_at <= $${startDate ? 2 : 1}` : ''}
            
            UNION ALL
            
            SELECT 
              'Prize Payout' as type,
              t.id,
              t.amount,
              'payout' as category,
              t.payout_status as status,
              u.username,
              u.phone_number,
              t.created_at
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            WHERE t.transaction_type = 'prize'
            ${startDate ? `AND t.created_at >= $1` : ''}
            ${endDate ? `AND t.created_at <= $${startDate ? 2 : 1}` : ''}
          ) all_transactions
          ORDER BY created_at DESC
        `;
      }
      
      if (startDate) params.push(startDate);
      if (endDate) params.push(endDate);
      
      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error('Error exporting transactions:', error);
      throw error;
    }
  }
}

module.exports = FinancialService;