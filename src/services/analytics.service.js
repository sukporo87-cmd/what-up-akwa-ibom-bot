// ============================================
// FILE: src/services/analytics.service.js
// VERIFIED - Matches working SQL migration
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class AnalyticsService {
    
    // ============================================
    // USER GROWTH ANALYTICS
    // ============================================
    
    async getDailyUserGrowth(days = 30) {
        try {
            const result = await pool.query(`
                SELECT 
                    date,
                    new_users,
                    telegram_users,
                    whatsapp_users
                FROM daily_user_growth
                WHERE date >= CURRENT_DATE - INTERVAL '${days} days'
                ORDER BY date DESC
            `);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting daily user growth:', error);
            throw error;
        }
    }
    
    async getWeeklyUserGrowth(weeks = 12) {
        try {
            const result = await pool.query(`
                SELECT 
                    week_start,
                    new_users,
                    telegram_users,
                    whatsapp_users
                FROM weekly_user_growth
                WHERE week_start >= CURRENT_DATE - INTERVAL '${weeks} weeks'
                ORDER BY week_start DESC
            `);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting weekly user growth:', error);
            throw error;
        }
    }
    
    async getMonthlyUserGrowth(months = 12) {
        try {
            const result = await pool.query(`
                SELECT 
                    month_start,
                    new_users,
                    telegram_users,
                    whatsapp_users
                FROM monthly_user_growth
                WHERE month_start >= CURRENT_DATE - INTERVAL '${months} months'
                ORDER BY month_start DESC
            `);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting monthly user growth:', error);
            throw error;
        }
    }
    
    async getUserGrowthSummary() {
        try {
            const [daily, weekly, monthly] = await Promise.all([
                this.getDailyUserGrowth(7),
                this.getWeeklyUserGrowth(4),
                this.getMonthlyUserGrowth(12)
            ]);
            
            const todayUsers = daily[0] || { new_users: 0 };
            const yesterdayUsers = daily[1] || { new_users: 0 };
            const dailyGrowth = yesterdayUsers.new_users > 0 
                ? ((todayUsers.new_users - yesterdayUsers.new_users) / yesterdayUsers.new_users * 100).toFixed(2)
                : 0;
            
            return {
                daily: {
                    data: daily,
                    growth_rate: dailyGrowth,
                    total_last_7_days: daily.reduce((sum, day) => sum + day.new_users, 0)
                },
                weekly: {
                    data: weekly,
                    total_last_4_weeks: weekly.reduce((sum, week) => sum + week.new_users, 0)
                },
                monthly: {
                    data: monthly,
                    total_last_12_months: monthly.reduce((sum, month) => sum + month.new_users, 0)
                }
            };
        } catch (error) {
            logger.error('Error getting user growth summary:', error);
            throw error;
        }
    }
    
    // ============================================
    // LEADERBOARD ANALYTICS
    // ============================================
    
    async getGlobalLeaderboard(limit = 100, offset = 0) {
        try {
            const result = await pool.query(`
                SELECT 
                    ROW_NUMBER() OVER (ORDER BY total_score DESC) as rank,
                    id,
                    username,
                    full_name,
                    lga,
                    phone_number,
                    platform,
                    total_games_played,
                    total_score,
                    highest_score,
                    total_earnings,
                    referral_count,
                    last_active
                FROM leaderboard_cache
                ORDER BY total_score DESC
                LIMIT $1 OFFSET $2
            `, [limit, offset]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting global leaderboard:', error);
            throw error;
        }
    }
    
    async getPlatformLeaderboard(platform, limit = 100, offset = 0) {
        try {
            const result = await pool.query(`
                SELECT 
                    ROW_NUMBER() OVER (ORDER BY total_score DESC) as rank,
                    id,
                    username,
                    full_name,
                    lga,
                    phone_number,
                    platform,
                    total_games_played,
                    total_score,
                    highest_score,
                    total_earnings,
                    referral_count,
                    last_active
                FROM leaderboard_cache
                WHERE platform = $1
                ORDER BY total_score DESC
                LIMIT $2 OFFSET $3
            `, [platform, limit, offset]);
            
            return result.rows;
        } catch (error) {
            logger.error(`Error getting ${platform} leaderboard:`, error);
            throw error;
        }
    }
    
    async getLeaderboardByTimeframe(timeframe = 'all-time', platform = null, limit = 100) {
        try {
            let dateFilter = '';
            
            switch (timeframe) {
                case 'daily':
                    dateFilter = "AND gs.completed_at >= CURRENT_DATE";
                    break;
                case 'weekly':
                    dateFilter = "AND gs.completed_at >= DATE_TRUNC('week', CURRENT_DATE)";
                    break;
                case 'monthly':
                    dateFilter = "AND gs.completed_at >= DATE_TRUNC('month', CURRENT_DATE)";
                    break;
                default:
                    dateFilter = '';
            }
            
            const platformFilter = platform ? `AND u.platform = '${platform}'` : '';
            
            const result = await pool.query(`
                SELECT 
                    ROW_NUMBER() OVER (ORDER BY SUM(COALESCE(gs.final_score, 0)) DESC) as rank,
                    u.id,
                    u.username,
                    u.full_name,
                    u.lga,
                    u.phone_number,
                    u.platform,
                    COUNT(gs.id) as games_played,
                    SUM(COALESCE(gs.final_score, 0)) as total_score,
                    MAX(COALESCE(gs.final_score, 0)) as highest_score,
                    u.total_winnings as total_earnings
                FROM users u
                JOIN game_sessions gs ON u.id = gs.user_id
                WHERE gs.status = 'completed'
                ${dateFilter}
                ${platformFilter}
                GROUP BY u.id, u.username, u.full_name, u.lga, u.phone_number, u.platform, u.total_winnings
                ORDER BY total_score DESC
                LIMIT $1
            `, [limit]);
            
            return result.rows;
        } catch (error) {
            logger.error(`Error getting ${timeframe} leaderboard:`, error);
            throw error;
        }
    }
    
    async getTournamentLeaderboard(tournamentId, limit = 100, offset = 0) {
        try {
            const result = await pool.query(`
                SELECT * FROM get_tournament_leaderboard($1)
                LIMIT $2 OFFSET $3
            `, [tournamentId, limit, offset]);
            
            return result.rows;
        } catch (error) {
            logger.error(`Error getting tournament ${tournamentId} leaderboard:`, error);
            throw error;
        }
    }
    
    async getTournamentsWithStats() {
        try {
            const result = await pool.query(`
                SELECT 
                    t.id,
                    t.tournament_name,
                    t.entry_fee,
                    t.prize_pool,
                    t.start_date,
                    t.end_date,
                    t.status,
                    COUNT(DISTINCT tp.user_id) as total_participants,
                    COUNT(DISTINCT CASE WHEN tp.platform = 'telegram' THEN tp.user_id END) as telegram_participants,
                    COUNT(DISTINCT CASE WHEN tp.platform = 'whatsapp' THEN tp.user_id END) as whatsapp_participants,
                    MAX(tp.total_score) as highest_score,
                    AVG(tp.total_score) as avg_score
                FROM tournaments t
                LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
                GROUP BY t.id
                ORDER BY t.start_date DESC
            `);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting tournaments with stats:', error);
            throw error;
        }
    }
    
    // ============================================
    // REFERRAL ANALYTICS
    // ============================================
    
    async getReferralStats() {
        try {
            const result = await pool.query(`
                SELECT 
                    COUNT(DISTINCT r.id) as total_referrals,
                    COUNT(DISTINCT r.referrer_id) as active_referrers,
                    COUNT(DISTINCT r.referee_id) as total_referred_users,
                    COUNT(DISTINCT CASE 
                        WHEN u.total_games_played > 0 THEN r.referee_id 
                    END) as active_referred_users,
                    ROUND(
                        COUNT(DISTINCT CASE WHEN u.total_games_played > 0 THEN r.referee_id END)::DECIMAL / 
                        NULLIF(COUNT(DISTINCT r.referee_id), 0) * 100, 
                        2
                    ) as conversion_rate
                FROM referrals r
                LEFT JOIN users u ON r.referee_id = u.id
            `);
            
            return result.rows[0];
        } catch (error) {
            logger.error('Error getting referral stats:', error);
            throw error;
        }
    }
    
    async getTopReferrers(limit = 50) {
        try {
            const result = await pool.query(`
                SELECT 
                    u.id,
                    u.username,
                    u.full_name,
                    u.phone_number,
                    u.platform,
                    COUNT(r.id) as total_referrals,
                    COUNT(CASE WHEN ru.total_games_played > 0 THEN 1 END) as active_referrals,
                    u.referral_code
                FROM users u
                LEFT JOIN referrals r ON u.id = r.referrer_id
                LEFT JOIN users ru ON r.referee_id = ru.id
                WHERE u.total_referrals > 0
                GROUP BY u.id, u.username, u.full_name, u.phone_number, u.platform, u.referral_code
                ORDER BY total_referrals DESC
                LIMIT $1
            `, [limit]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting top referrers:', error);
            throw error;
        }
    }
    
    // ============================================
    // REVENUE ANALYTICS
    // ============================================
    
    async getRevenueStats(days = 30) {
        try {
            const result = await pool.query(`
                SELECT 
                    COUNT(*) as total_transactions,
                    SUM(amount) as total_revenue,
                    AVG(amount) as avg_transaction,
                    SUM(CASE WHEN u.platform = 'telegram' THEN amount ELSE 0 END) as telegram_revenue,
                    SUM(CASE WHEN u.platform = 'whatsapp' THEN amount ELSE 0 END) as whatsapp_revenue,
                    COUNT(DISTINCT user_id) as paying_users
                FROM transactions t
                JOIN users u ON t.user_id = u.id
                WHERE t.payment_status = 'success'
                AND t.created_at >= CURRENT_DATE - INTERVAL '${days} days'
            `);
            
            return result.rows[0];
        } catch (error) {
            logger.error('Error getting revenue stats:', error);
            throw error;
        }
    }
    
    async getDailyRevenue(days = 30) {
        try {
            const result = await pool.query(`
                SELECT 
                    DATE(created_at) as date,
                    COUNT(*) as transactions,
                    SUM(amount) as revenue,
                    COUNT(DISTINCT user_id) as unique_users
                FROM transactions
                WHERE payment_status = 'success'
                AND created_at >= CURRENT_DATE - INTERVAL '${days} days'
                GROUP BY DATE(created_at)
                ORDER BY date DESC
            `);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting daily revenue:', error);
            throw error;
        }
    }
    
    // ============================================
    // GAME ANALYTICS
    // ============================================
    
    async getGameStats() {
        try {
            const result = await pool.query(`
                SELECT 
                    COUNT(*) as total_games,
                    COUNT(DISTINCT user_id) as unique_players,
                    AVG(COALESCE(final_score, 0)) as avg_score,
                    MAX(COALESCE(final_score, 0)) as highest_score,
                    COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_games,
                    COUNT(CASE WHEN status = 'timeout' THEN 1 END) as timeout_games,
                    COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_games,
                    ROUND(
                        COUNT(CASE WHEN status = 'completed' THEN 1 END)::DECIMAL / 
                        NULLIF(COUNT(*), 0) * 100, 
                        2
                    ) as completion_rate
                FROM game_sessions
            `);
            
            return result.rows[0];
        } catch (error) {
            logger.error('Error getting game stats:', error);
            throw error;
        }
    }
    
    async refreshLeaderboardCache() {
        try {
            await pool.query('SELECT refresh_leaderboard_cache()');
            logger.info('Leaderboard cache refreshed successfully');
            return { success: true };
        } catch (error) {
            logger.error('Error refreshing leaderboard cache:', error);
            throw error;
        }
    }
}

module.exports = new AnalyticsService();