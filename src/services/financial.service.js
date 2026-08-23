// ============================================
// FILE: src/services/financial.service.js
// COMPREHENSIVE FINANCIAL MANAGEMENT SERVICE
// For What's Up Trivia - Financial Dashboard
// FIXED: Correct column names for your database schema
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
      
      // Token Revenue (Classic Mode) - payment_transactions table uses 'amount'
      const tokenRevenue = await pool.query(`
        SELECT 
          COALESCE(SUM(amount), 0) as total,
          COUNT(*) as transaction_count
        FROM payment_transactions
        WHERE status = 'success'
        ${dateFilter ? `AND ${dateFilter}` : ''}
      `);
      
      // Tournament Entry Revenue - tournament_entry_payments uses 'amount' not 'amount_paid'
      const tournamentRevenue = await pool.query(`
        SELECT 
          COALESCE(SUM(amount), 0) as total,
          COUNT(*) as transaction_count
        FROM tournament_entry_payments
        WHERE payment_status = 'success'
        ${dateFilter ? `AND ${dateFilter}` : ''}
      `);
      
      // Total Payouts - from transactions table where type is 'prize' and payout completed
      // Status flow: pending -> details_collected -> approved -> paid -> confirmed
      const payouts = await pool.query(`
        SELECT 
          COALESCE(SUM(t.amount), 0) as total,
          COUNT(*) as payout_count
        FROM transactions t
        WHERE t.transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
        AND t.payout_status IN ('paid', 'confirmed')
        ${dateFilter ? `AND t.${dateFilter}` : ''}
      `);
      
      // Pending Payouts (Outstanding Obligations)
      const pendingPayouts = await pool.query(`
        SELECT 
          COALESCE(SUM(amount), 0) as total,
          COUNT(*) as pending_count
        FROM transactions
        WHERE transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
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
      const platformDateFilter = this.buildDateFilter(startDate, endDate, 'created_at');
      const platformBreakdown = await pool.query(`
        SELECT 
          COALESCE(platform, 'whatsapp') as platform,
          COUNT(*) as transaction_count,
          COALESCE(SUM(amount), 0) as total_revenue
        FROM payment_transactions
        WHERE status = 'success'
        ${platformDateFilter ? `AND ${platformDateFilter}` : ''}
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
      
      // Use scalar subqueries to avoid the cross-product double-counting
      // that happens when joining participants AND payments together.
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
          -- Distinct participant count
          (SELECT COUNT(DISTINCT user_id) 
           FROM tournament_participants 
           WHERE tournament_id = t.id) as total_participants,
          -- Distinct paying users
          (SELECT COUNT(DISTINCT user_id) 
           FROM tournament_entry_payments 
           WHERE tournament_id = t.id AND payment_status = 'success' AND gateway_used != 'promo') as paid_participants,
          -- True entry-fee revenue (excludes promo redemptions which are ₦0)
          (SELECT COALESCE(SUM(amount), 0) 
           FROM tournament_entry_payments 
           WHERE tournament_id = t.id AND payment_status = 'success') as total_entry_fees,
          -- Prizes paid out for this tournament.
          -- Uses transactions.tournament_id (added in the schema migration) for a direct relational link.
          -- We count both 'paid' and 'confirmed' payout states. Pending/cancelled don't count as paid out.
          -- Falls back to tournament_participants.prize_won for any legacy rows that weren't backfilled.
          GREATEST(
            (SELECT COALESCE(SUM(amount), 0) 
             FROM transactions 
             WHERE tournament_id = t.id 
               AND transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
               AND payout_status IN ('paid', 'confirmed')),
            (SELECT COALESCE(SUM(prize_won), 0) 
             FROM tournament_participants 
             WHERE tournament_id = t.id 
               AND prize_won > 0
               -- Only fall back if no linked transactions exist for this tournament
               AND NOT EXISTS (
                 SELECT 1 FROM transactions 
                 WHERE tournament_id = t.id 
                   AND transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
               ))
          ) as prizes_paid
        FROM tournaments t
        ${dateFilter ? `WHERE ${dateFilter}` : ''}
        ORDER BY t.start_date DESC
      `);
      
      // Add computed columns (net, ROI) row-by-row to ensure correctness
      const tournaments = result.rows.map(row => {
        const revenue = parseFloat(row.total_entry_fees);
        const paidOut = parseFloat(row.prizes_paid);
        const net_profit = revenue - paidOut;
        let roi;
        if (row.payment_type === 'free') {
          roi = 'N/A';
        } else if (revenue > 0) {
          // ROI = (net profit / revenue) * 100
          roi = ((net_profit / revenue) * 100).toFixed(2);
        } else {
          roi = '0';
        }
        return {
          ...row,
          net_profit,
          roi
        };
      });
      
      // Summary
      const summary = tournaments.reduce((acc, row) => {
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
      
      return { tournaments, summary };
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
        WHERE t.transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
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
        WHERE t.transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
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
      const dateFilter = this.buildDateFilter(startDate, endDate, 't.created_at');
      
      // Payout summary by status
      const statusSummary = await pool.query(`
        SELECT 
          t.payout_status as status,
          COUNT(*) as count,
          COALESCE(SUM(t.amount), 0) as total_amount
        FROM transactions t
        WHERE t.transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
        ${dateFilter ? `AND ${dateFilter}` : ''}
        GROUP BY t.payout_status
      `);
      
      // Mode classification:
      //   - tournament_id IS NOT NULL → 'tournament'
      //   - game_mode = 'practice' → 'practice' (shouldn't have prizes, but defensive)
      //   - else → 'classic'
      // We also use transaction_type as a backup signal: 'tournament_prize' = tournament.
      
      // Completed payouts with details
      const completedPayouts = await pool.query(`
        SELECT 
          t.id,
          t.amount,
          u.username,
          u.phone_number,
          pd.bank_name,
          pd.account_number,
          CASE 
            WHEN t.transaction_type IN ('challenge_prize','challenge_refund') THEN 'challenge'
            WHEN t.transaction_type = 'tournament_prize' OR gs.tournament_id IS NOT NULL THEN 'tournament'
            WHEN gs.game_mode = 'practice' THEN 'practice'
            ELSE 'classic'
          END as game_mode,
          t.created_at as completed_at
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN payout_details pd ON t.id = pd.transaction_id
        LEFT JOIN game_sessions gs ON t.session_id = gs.id
        WHERE t.transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
        AND t.payout_status IN ('paid', 'confirmed')
        ${dateFilter ? `AND ${dateFilter}` : ''}
        ORDER BY t.created_at DESC
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
          CASE 
            WHEN t.transaction_type IN ('challenge_prize','challenge_refund') THEN 'challenge'
            WHEN t.transaction_type = 'tournament_prize' OR gs.tournament_id IS NOT NULL THEN 'tournament'
            WHEN gs.game_mode = 'practice' THEN 'practice'
            ELSE 'classic'
          END as game_mode
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN payout_details pd ON t.id = pd.transaction_id
        LEFT JOIN game_sessions gs ON t.session_id = gs.id
        WHERE t.transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
        AND t.payout_status IN ('pending', 'details_collected', 'approved')
        ${dateFilter ? `AND ${dateFilter}` : ''}
        ORDER BY t.created_at ASC
      `);
      
      // By game mode — same classification logic
      const byGameMode = await pool.query(`
        SELECT 
          CASE 
            WHEN t.transaction_type IN ('challenge_prize','challenge_refund') THEN 'challenge'
            WHEN t.transaction_type = 'tournament_prize' OR gs.tournament_id IS NOT NULL THEN 'tournament'
            WHEN gs.game_mode = 'practice' THEN 'practice'
            ELSE 'classic'
          END as game_mode,
          COUNT(*) as payout_count,
          COALESCE(SUM(t.amount), 0) as total_amount
        FROM transactions t
        LEFT JOIN game_sessions gs ON t.session_id = gs.id
        WHERE t.transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
        AND t.payout_status IN ('paid', 'confirmed')
        ${dateFilter ? `AND ${dateFilter}` : ''}
        GROUP BY 1
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
      
      // Only count wins from classic and tournament modes — practice never counts
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
        JOIN game_sessions gs ON t.session_id = gs.id
        WHERE t.transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
          AND t.amount > 0
          AND gs.game_mode != 'practice'
          AND (gs.game_type IS NULL OR gs.game_type != 'practice')
          -- Free challenge rounds cost nothing and earn nothing. Leaving them
          -- in drags revenue-per-game toward zero and makes the series
          -- discontinuous at the launch date.
          AND gs.challenge_id IS NULL
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
      // IMPORTANT — two different date questions live in this method, and
      // conflating them was a real bug:
      //   * "how much money moved in this period?"     -> filter transactions
      //   * "how many players do we have?"             -> do NOT filter by
      //     registration date, or a player who signed up last month and paid
      //     this month vanishes from the denominator and conversion is
      //     understated.
      // So: revenue and payouts use the date range; population figures are
      // as-of-now. Cohort analysis (revenue by registration month) is a
      // separate report, not a filter on this one.
      const txFilter = this.buildDateFilter(startDate, endDate, 'created_at');
      const isRanged = !!txFilter;

      // Population as of now — never filtered by registration date
      const totalUsers = await pool.query(`SELECT COUNT(*) as count FROM users`);

      // Players who paid *within the period* (or ever, if no range given)
      const payingUsers = await pool.query(`
        SELECT COUNT(DISTINCT user_id) as count FROM (
          SELECT user_id FROM payment_transactions
          WHERE status = 'success' ${txFilter ? `AND ${txFilter}` : ''}
          UNION
          SELECT user_id FROM tournament_entry_payments
          WHERE payment_status = 'success' ${txFilter ? `AND ${txFilter}` : ''}
        ) paid
      `);

      const totalTokenRevenue = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) as token_revenue
        FROM payment_transactions
        WHERE status = 'success'
        ${txFilter ? `AND ${txFilter}` : ''}
      `);

      const tournamentRevenue = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) as tournament_revenue
        FROM tournament_entry_payments
        WHERE payment_status = 'success'
        ${txFilter ? `AND ${txFilter}` : ''}
      `);

      const totalPayouts = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM transactions
        WHERE transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
        AND payout_status IN ('paid', 'confirmed')
        ${txFilter ? `AND ${txFilter}` : ''}
      `);

      // Prizes awarded but not yet paid — a liability, not an expense yet.
      // Missing from the old KPIs entirely, which flattered net revenue.
      const outstanding = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM transactions
        WHERE transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
        AND payout_status NOT IN ('paid', 'confirmed')
      `);

      const totalRev = parseFloat(totalTokenRevenue.rows[0].token_revenue) +
                       parseFloat(tournamentRevenue.rows[0].tournament_revenue);
      const users = parseInt(totalUsers.rows[0].count);
      const payers = parseInt(payingUsers.rows[0].count);
      const payoutTotal = parseFloat(totalPayouts.rows[0].total);
      const liability = parseFloat(outstanding.rows[0].total);

      const arpu = users > 0 ? (totalRev / users).toFixed(2) : 0;
      const arppu = payers > 0 ? (totalRev / payers).toFixed(2) : 0;
      const conversionRate = users > 0 ? ((payers / users) * 100).toFixed(2) : 0;

      // NOT lifetime value. This is net revenue per registered user for the
      // selected period — a snapshot. True LTV needs cohort retention and
      // lives in getCohortLTV(). The old field was named `ltv` and read as
      // if it were the real thing; it is kept below only for backward
      // compatibility with any dashboard still reading it.
      const netPerUser = users > 0 ? ((totalRev - payoutTotal) / users).toFixed(2) : 0;

      // Gross margin: what proportion of revenue we keep after prizes.
      // Previously called "house_edge" — a gambling term, and this is a
      // skill-based competition platform. Same arithmetic, correct name.
      const grossMargin = totalRev > 0
        ? (((totalRev - payoutTotal) / totalRev) * 100).toFixed(2) : 0;

      return {
        period: isRanged ? { start: startDate, end: endDate } : { start: null, end: null },
        total_users: users,                     // as of now, not period-filtered
        paying_users: payers,                   // paid within the period
        total_revenue: totalRev,
        total_payouts: payoutTotal,
        outstanding_liability: liability,
        net_revenue: totalRev - payoutTotal,
        arpu: parseFloat(arpu),
        arppu: parseFloat(arppu),
        conversion_rate: parseFloat(conversionRate),
        net_revenue_per_user: parseFloat(netPerUser),
        gross_margin: parseFloat(grossMargin),

        // --- deprecated aliases, kept so nothing breaks mid-rebuild ---
        ltv: parseFloat(netPerUser),            // @deprecated -> net_revenue_per_user
        house_edge: parseFloat(grossMargin)     // @deprecated -> gross_margin
      };
    } catch (error) {
      logger.error(`Error getting financial KPIs: ${error.message}`);
      throw error;
    }
  }

  // ============================================
  // COHORT LTV — the real thing.
  // Groups players by the month they registered and tracks cumulative
  // revenue per member of that cohort. This is what tells you whether a
  // player acquired in March is worth more than one acquired in June,
  // which is the question "LTV" was pretending to answer.
  // ============================================
  async getCohortLTV(months = 6) {
    try {
      const result = await pool.query(`
        WITH cohorts AS (
          SELECT id AS user_id, DATE_TRUNC('month', created_at) AS cohort_month
          FROM users
          WHERE created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '${parseInt(months)} months'
        ),
        spend AS (
          SELECT user_id, amount, created_at FROM payment_transactions WHERE status = 'success'
          UNION ALL
          SELECT user_id, amount, created_at FROM tournament_entry_payments WHERE payment_status = 'success'
        )
        SELECT
          TO_CHAR(c.cohort_month, 'YYYY-MM') AS cohort,
          COUNT(DISTINCT c.user_id) AS cohort_size,
          COUNT(DISTINCT s.user_id) AS payers,
          COALESCE(SUM(s.amount), 0) AS revenue
        FROM cohorts c
        LEFT JOIN spend s ON s.user_id = c.user_id
        GROUP BY c.cohort_month
        ORDER BY c.cohort_month DESC
      `);

      return result.rows.map(r => {
        const size = parseInt(r.cohort_size) || 0;
        const payers = parseInt(r.payers) || 0;
        const revenue = parseFloat(r.revenue) || 0;
        return {
          cohort: r.cohort,
          cohort_size: size,
          payers,
          revenue,
          revenue_per_user: size > 0 ? parseFloat((revenue / size).toFixed(2)) : 0,
          revenue_per_payer: payers > 0 ? parseFloat((revenue / payers).toFixed(2)) : 0,
          conversion_rate: size > 0 ? parseFloat(((payers / size) * 100).toFixed(2)) : 0
        };
      });
    } catch (error) {
      logger.error(`Error getting cohort LTV: ${error.message}`);
      throw error;
    }
  }


  // ============================================
  // OPERATIONS — the views you check daily.
  // These answer questions the old dashboard could not:
  // what do we owe, how fast are we paying, which gateway is
  // losing us money, and did that tournament actually earn?
  // ============================================

  // --- 1. Outstanding prize liability, bucketed by age ---
  // A prize pending 9 days is a support ticket waiting to happen and a
  // reputational risk. Nothing surfaced this before.
  async getPayoutAging() {
    try {
      const result = await pool.query(`
        SELECT
          CASE
            WHEN NOW() - t.created_at < INTERVAL '24 hours'  THEN '0-24h'
            WHEN NOW() - t.created_at < INTERVAL '48 hours'  THEN '24-48h'
            WHEN NOW() - t.created_at < INTERVAL '72 hours'  THEN '48-72h'
            WHEN NOW() - t.created_at < INTERVAL '7 days'    THEN '3-7d'
            ELSE '7d+'
          END AS bucket,
          COUNT(*) AS count,
          COALESCE(SUM(t.amount), 0) AS amount
        FROM transactions t
        WHERE t.transaction_type IN ('prize','tournament_prize')
          AND t.payout_status NOT IN ('paid','confirmed')
        GROUP BY 1
      `);

      const order = ['0-24h', '24-48h', '48-72h', '3-7d', '7d+'];
      const byBucket = {};
      order.forEach(b => { byBucket[b] = { count: 0, amount: 0 }; });
      result.rows.forEach(r => {
        byBucket[r.bucket] = { count: parseInt(r.count), amount: parseFloat(r.amount) };
      });

      const oldest = await pool.query(`
        SELECT MIN(created_at) AS oldest
        FROM transactions
        WHERE transaction_type IN ('prize','tournament_prize')
          AND payout_status NOT IN ('paid','confirmed')
      `);

      const total = order.reduce((a, b) => a + byBucket[b].amount, 0);
      const count = order.reduce((a, b) => a + byBucket[b].count, 0);

      return {
        buckets: order.map(b => ({ bucket: b, ...byBucket[b] })),
        total_outstanding: total,
        total_count: count,
        // Anything past 72h has blown the published promise
        breaching: byBucket['3-7d'].count + byBucket['7d+'].count,
        oldest_pending_at: oldest.rows[0].oldest
      };
    } catch (error) {
      logger.error(`Error getting payout aging: ${error.message}`);
      throw error;
    }
  }

  // --- 2. Time to payout, against the published 12-24h promise ---
  async getPayoutSpeed(days = 30) {
    try {
      const result = await pool.query(`
        SELECT
          COUNT(*) AS paid_count,
          AVG(EXTRACT(EPOCH FROM (paid_at - created_at)) / 3600) AS avg_hours,
          PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (paid_at - created_at)) / 3600) AS median_hours,
          PERCENTILE_CONT(0.9) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (paid_at - created_at)) / 3600) AS p90_hours,
          COUNT(*) FILTER (
            WHERE paid_at - created_at <= INTERVAL '24 hours') AS within_24h
        FROM transactions
        WHERE transaction_type IN ('prize','tournament_prize')
          AND payout_status IN ('paid','confirmed')
          AND paid_at IS NOT NULL
          AND created_at >= NOW() - INTERVAL '${parseInt(days)} days'
      `);

      const r = result.rows[0];
      const paid = parseInt(r.paid_count) || 0;
      return {
        paid_count: paid,
        avg_hours: r.avg_hours ? parseFloat(Number(r.avg_hours).toFixed(1)) : null,
        median_hours: r.median_hours ? parseFloat(Number(r.median_hours).toFixed(1)) : null,
        p90_hours: r.p90_hours ? parseFloat(Number(r.p90_hours).toFixed(1)) : null,
        within_24h: parseInt(r.within_24h) || 0,
        // The number that matters: are we keeping the promise on the page?
        promise_kept_pct: paid > 0
          ? parseFloat(((parseInt(r.within_24h) / paid) * 100).toFixed(1)) : null
      };
    } catch (error) {
      logger.error(`Error getting payout speed: ${error.message}`);
      throw error;
    }
  }

  // --- 3. Gateway health: every failed payment is someone who tried to pay ---
  async getGatewayPerformance(days = 30) {
    try {
      const result = await pool.query(`
        SELECT
          COALESCE(gateway_used, 'unknown') AS gateway,
          COUNT(*) AS attempts,
          COUNT(*) FILTER (WHERE status = 'success') AS successes,
          COALESCE(SUM(amount) FILTER (WHERE status = 'success'), 0) AS revenue,
          AVG(EXTRACT(EPOCH FROM (paid_at - created_at))) FILTER (
            WHERE status = 'success' AND paid_at IS NOT NULL) AS avg_settle_seconds
        FROM payment_transactions
        WHERE created_at >= NOW() - INTERVAL '${parseInt(days)} days'
        GROUP BY 1
        ORDER BY revenue DESC
      `);

      return result.rows.map(r => {
        const attempts = parseInt(r.attempts) || 0;
        const successes = parseInt(r.successes) || 0;
        return {
          gateway: r.gateway,
          attempts,
          successes,
          failures: attempts - successes,
          success_rate: attempts > 0
            ? parseFloat(((successes / attempts) * 100).toFixed(1)) : 0,
          revenue: parseFloat(r.revenue) || 0,
          avg_settle_seconds: r.avg_settle_seconds
            ? Math.round(Number(r.avg_settle_seconds)) : null
        };
      });
    } catch (error) {
      logger.error(`Error getting gateway performance: ${error.message}`);
      throw error;
    }
  }

  // --- 4. Revenue by platform: WhatsApp vs Telegram vs Web ---
  // The sharpest strategic signal in the dataset, and it was never surfaced.
  async getRevenueByPlatform(startDate = null, endDate = null) {
    try {
      const f = this.buildDateFilter(startDate, endDate, 'created_at');
      const result = await pool.query(`
        SELECT platform, SUM(amount) AS revenue, COUNT(*) AS payments,
               COUNT(DISTINCT user_id) AS payers
        FROM (
          SELECT COALESCE(platform,'unknown') AS platform, amount, user_id, created_at
          FROM payment_transactions WHERE status = 'success'
          UNION ALL
          SELECT COALESCE(platform,'unknown'), amount, user_id, created_at
          FROM tournament_entry_payments WHERE payment_status = 'success'
        ) all_pay
        ${f ? `WHERE ${f}` : ''}
        GROUP BY platform
        ORDER BY revenue DESC
      `);
      return result.rows.map(r => ({
        platform: r.platform,
        revenue: parseFloat(r.revenue) || 0,
        payments: parseInt(r.payments) || 0,
        payers: parseInt(r.payers) || 0
      }));
    } catch (error) {
      logger.error(`Error getting revenue by platform: ${error.message}`);
      throw error;
    }
  }

  // --- 5. Tournament P&L: did that event make or lose money? ---
  async getTournamentPnL(limit = 20) {
    try {
      const result = await pool.query(`
        SELECT
          t.id, t.tournament_name, t.status, t.start_date, t.end_date,
          t.prize_pool AS advertised_pool,
          COALESCE(e.entry_revenue, 0)  AS entry_revenue,
          COALESCE(e.entry_count, 0)    AS entries,
          COALESCE(e.rebuy_revenue, 0)  AS rebuy_revenue,
          COALESCE(p.prizes_awarded, 0) AS prizes_awarded,
          COALESCE(pt.participants, 0)  AS participants
        FROM tournaments t
        LEFT JOIN LATERAL (
          SELECT SUM(amount) AS entry_revenue,
                 COUNT(*) AS entry_count,
                 SUM(amount) FILTER (WHERE payment_reference LIKE 'TRNR-%') AS rebuy_revenue
          FROM tournament_entry_payments
          WHERE tournament_id = t.id AND payment_status = 'success'
        ) e ON true
        LEFT JOIN LATERAL (
          SELECT SUM(amount) AS prizes_awarded
          FROM transactions
          WHERE tournament_id = t.id AND transaction_type = 'tournament_prize'
        ) p ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS participants
          FROM tournament_participants WHERE tournament_id = t.id
        ) pt ON true
        ORDER BY t.start_date DESC NULLS LAST
        LIMIT ${parseInt(limit)}
      `);

      return result.rows.map(r => {
        const revenue = parseFloat(r.entry_revenue) || 0;
        const prizes = parseFloat(r.prizes_awarded) || 0;
        const participants = parseInt(r.participants) || 0;
        return {
          id: r.id,
          name: r.tournament_name,
          status: r.status,
          start_date: r.start_date,
          end_date: r.end_date,
          participants,
          entries: parseInt(r.entries) || 0,
          entry_revenue: revenue,
          rebuy_revenue: parseFloat(r.rebuy_revenue) || 0,
          prizes_awarded: prizes,
          advertised_pool: parseFloat(r.advertised_pool) || 0,
          contribution: revenue - prizes,
          margin_pct: revenue > 0
            ? parseFloat((((revenue - prizes) / revenue) * 100).toFixed(1)) : null,
          revenue_per_participant: participants > 0
            ? parseFloat((revenue / participants).toFixed(2)) : 0
        };
      });
    } catch (error) {
      logger.error(`Error getting tournament P&L: ${error.message}`);
      throw error;
    }
  }

  // --- 6. Credit burn: bought vs actually played ---
  // Unplayed credits are deferred revenue and an early churn signal.
  async getCreditBurn() {
    try {
      const result = await pool.query(`
        SELECT
          COALESCE((SELECT SUM(games_purchased) FROM payment_transactions
                    WHERE status = 'success'), 0) AS credits_bought,
          COALESCE((SELECT COUNT(*) FROM game_sessions
                    WHERE status = 'completed'
                      AND COALESCE(game_type,'') <> 'practice'
                      AND challenge_id IS NULL), 0) AS games_played,
          COALESCE((SELECT SUM(games_remaining) FROM users), 0) AS credits_outstanding
      `);
      const r = result.rows[0];
      const bought = parseInt(r.credits_bought) || 0;
      const played = parseInt(r.games_played) || 0;
      return {
        credits_bought: bought,
        games_played: played,
        credits_outstanding: parseInt(r.credits_outstanding) || 0,
        burn_rate_pct: bought > 0
          ? parseFloat(((played / bought) * 100).toFixed(1)) : 0
      };
    } catch (error) {
      logger.error(`Error getting credit burn: ${error.message}`);
      throw error;
    }
  }

  // --- 7. Overview: the one screen to check each morning ---
  async getOperationsOverview() {
    try {
      const periodRevenue = async (interval) => {
        const q = await pool.query(`
          SELECT COALESCE(SUM(amount), 0) AS total FROM (
            SELECT amount, created_at FROM payment_transactions WHERE status = 'success'
            UNION ALL
            SELECT amount, created_at FROM tournament_entry_payments WHERE payment_status = 'success'
          ) x WHERE created_at >= ${interval}
        `);
        return parseFloat(q.rows[0].total) || 0;
      };

      const [today, yesterday, wtd, mtd, prevMonthToDate] = await Promise.all([
        periodRevenue("DATE_TRUNC('day', NOW())"),
        periodRevenue("DATE_TRUNC('day', NOW()) - INTERVAL '1 day'"),
        periodRevenue("DATE_TRUNC('week', NOW())"),
        periodRevenue("DATE_TRUNC('month', NOW())"),
        periodRevenue("DATE_TRUNC('month', NOW()) - INTERVAL '1 month'")
      ]);

      // yesterday's figure above includes today; subtract to isolate it
      const yesterdayOnly = Math.max(0, yesterday - today);

      const [aging, speed, burn] = await Promise.all([
        this.getPayoutAging(),
        this.getPayoutSpeed(30),
        this.getCreditBurn()
      ]);

      const paidAllTime = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
        WHERE transaction_type IN ('prize','tournament_prize')
          AND payout_status IN ('paid','confirmed')
      `);
      const revenueAllTime = await periodRevenue("'epoch'::timestamptz");

      return {
        revenue: {
          today,
          yesterday: yesterdayOnly,
          day_change_pct: yesterdayOnly > 0
            ? parseFloat((((today - yesterdayOnly) / yesterdayOnly) * 100).toFixed(1)) : null,
          week_to_date: wtd,
          month_to_date: mtd,
          prev_month_to_date: Math.max(0, prevMonthToDate - mtd),
          all_time: revenueAllTime
        },
        liability: {
          outstanding: aging.total_outstanding,
          count: aging.total_count,
          breaching_72h: aging.breaching,
          oldest_pending_at: aging.oldest_pending_at
        },
        payouts: speed,
        credits: burn,
        cash_position: revenueAllTime - parseFloat(paidAllTime.rows[0].total)
      };
    } catch (error) {
      logger.error(`Error getting overview: ${error.message}`);
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
          COALESCE(SUM(amount), 0) as revenue,
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
          ${dateGroup} as date,
          COALESCE(SUM(amount), 0) as amount,
          COUNT(*) as count
        FROM transactions
        WHERE transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
        AND payout_status IN ('paid', 'confirmed')
        AND created_at >= CURRENT_DATE - INTERVAL '${interval}'
        GROUP BY ${dateGroup}
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
          gs.game_mode,
          gs.final_score,
          gs.questions_answered,
          gs.started_at as game_started,
          gs.completed_at as game_completed,
          pd.bank_name,
          pd.account_number,
          pd.account_name
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN game_sessions gs ON t.session_id = gs.id
        LEFT JOIN payout_details pd ON t.id = pd.transaction_id
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
      // User basic info - removed 'email' column as it doesn't exist
      const user = await pool.query(`
        SELECT id, username, phone_number, full_name, 
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
        WHERE t.user_id = $1 AND t.transaction_type IN ('prize', 'tournament_prize')
        ORDER BY t.created_at DESC
      `, [userId]);
      
      // Tournament participation
      const tournaments = await pool.query(`
        SELECT 
          tep.id,
          tep.amount,
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
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
      
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
    // Dates come in as local time strings like "2026-01-11 00:00:00"
    // Database stores timestamps in local time, so direct comparison works
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
      
      const dateCondition = startDate || endDate 
        ? `${startDate ? `created_at >= '${startDate}'` : ''} ${startDate && endDate ? 'AND' : ''} ${endDate ? `created_at <= '${endDate}'` : ''}`
        : '';
      
      if (type === 'revenue') {
        query = `
          SELECT 
            'Token Purchase' as type,
            pt.reference,
            pt.amount,
            pt.games_purchased,
            pt.status,
            COALESCE(pt.platform, 'whatsapp') as platform,
            u.username,
            u.phone_number,
            pt.created_at
          FROM payment_transactions pt
          JOIN users u ON pt.user_id = u.id
          WHERE pt.status = 'success'
          ${dateCondition ? `AND ${dateCondition.replace('created_at', 'pt.created_at')}` : ''}
          
          UNION ALL
          
          SELECT 
            'Tournament Entry' as type,
            tep.payment_reference as reference,
            tep.amount,
            1 as games_purchased,
            tep.payment_status as status,
            COALESCE(tep.platform, 'whatsapp') as platform,
            u.username,
            u.phone_number,
            tep.created_at
          FROM tournament_entry_payments tep
          JOIN users u ON tep.user_id = u.id
          WHERE tep.payment_status = 'success'
          ${dateCondition ? `AND ${dateCondition.replace('created_at', 'tep.created_at')}` : ''}
          
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
            t.created_at as win_date
          FROM transactions t
          JOIN users u ON t.user_id = u.id
          LEFT JOIN payout_details pd ON t.id = pd.transaction_id
          LEFT JOIN game_sessions gs ON t.session_id = gs.id
          WHERE t.transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
          ${dateCondition ? `AND ${dateCondition.replace('created_at', 't.created_at')}` : ''}
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
            ${dateCondition ? `WHERE ${dateCondition.replace('created_at', 'pt.created_at')}` : ''}
            
            UNION ALL
            
            SELECT 
              'Tournament Entry' as type,
              tep.id,
              tep.amount,
              'revenue' as category,
              tep.payment_status as status,
              u.username,
              u.phone_number,
              tep.created_at
            FROM tournament_entry_payments tep
            JOIN users u ON tep.user_id = u.id
            ${dateCondition ? `WHERE ${dateCondition.replace('created_at', 'tep.created_at')}` : ''}
            
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
            WHERE t.transaction_type IN ('prize', 'tournament_prize', 'challenge_prize', 'challenge_refund')
            ${dateCondition ? `AND ${dateCondition.replace('created_at', 't.created_at')}` : ''}
          ) all_transactions
          ORDER BY created_at DESC
        `;
      }
      
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      logger.error('Error exporting transactions:', error);
      throw error;
    }
  }
}

module.exports = FinancialService;