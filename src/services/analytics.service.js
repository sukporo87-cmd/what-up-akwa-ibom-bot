// ============================================
// FILE: src/services/analytics.service.js
// FIXED - Safer queries that handle missing columns
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
            // Query directly from users table (leaderboard_cache may have wrong schema)
            const result = await pool.query(`
                SELECT 
                    ROW_NUMBER() OVER (ORDER BY COALESCE(SUM(gs.final_score), 0) DESC) as rank,
                    u.id,
                    u.username,
                    u.full_name,
                    COALESCE(u.lga, u.city) as lga,
                    u.phone_number,
                    CASE 
                        WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
                        ELSE 'whatsapp'
                    END as platform,
                    COUNT(gs.id) as total_games_played,
                    COALESCE(SUM(gs.final_score), 0) as total_score,
                    COALESCE(MAX(gs.final_score), 0) as highest_score,
                    u.total_winnings as total_earnings,
                    u.total_referrals as referral_count,
                    u.last_active
                FROM users u
                LEFT JOIN game_sessions gs ON u.id = gs.user_id AND gs.status = 'completed'
                GROUP BY u.id
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
                    ROW_NUMBER() OVER (ORDER BY COALESCE(SUM(gs.final_score), 0) DESC) as rank,
                    u.id,
                    u.username,
                    u.full_name,
                    COALESCE(u.lga, u.city) as lga,
                    u.phone_number,
                    CASE 
                        WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
                        ELSE 'whatsapp'
                    END as platform,
                    COUNT(gs.id) as total_games_played,
                    COALESCE(SUM(gs.final_score), 0) as total_score,
                    COALESCE(MAX(gs.final_score), 0) as highest_score,
                    u.total_winnings as total_earnings,
                    u.total_referrals as referral_count,
                    u.last_active
                FROM users u
                LEFT JOIN game_sessions gs ON u.id = gs.user_id AND gs.status = 'completed'
                WHERE CASE 
                    WHEN $1 = 'telegram' THEN u.phone_number LIKE 'tg_%'
                    ELSE u.phone_number NOT LIKE 'tg_%'
                END
                GROUP BY u.id
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
            
            const platformFilter = platform === 'telegram' 
                ? "AND u.phone_number LIKE 'tg_%'" 
                : platform === 'whatsapp' 
                    ? "AND u.phone_number NOT LIKE 'tg_%'"
                    : '';
            
            const result = await pool.query(`
                SELECT 
                    ROW_NUMBER() OVER (ORDER BY SUM(COALESCE(gs.final_score, 0)) DESC) as rank,
                    u.id,
                    u.username,
                    u.full_name,
                    COALESCE(u.lga, u.city) as lga,
                    u.phone_number,
                    CASE 
                        WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
                        ELSE 'whatsapp'
                    END as platform,
                    COUNT(gs.id) as games_played,
                    SUM(COALESCE(gs.final_score, 0)) as total_score,
                    MAX(COALESCE(gs.final_score, 0)) as highest_score,
                    u.total_winnings as total_earnings
                FROM users u
                JOIN game_sessions gs ON u.id = gs.user_id
                WHERE gs.status = 'completed'
                ${dateFilter}
                ${platformFilter}
                GROUP BY u.id, u.username, u.full_name, u.lga, u.city, u.phone_number, u.total_winnings
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
            // Check if function exists
            const funcCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT 1 FROM pg_proc WHERE proname = 'get_tournament_leaderboard'
                )
            `);
            
            if (funcCheck.rows[0].exists) {
                const result = await pool.query(`
                    SELECT * FROM get_tournament_leaderboard($1)
                    LIMIT $2 OFFSET $3
                `, [tournamentId, limit, offset]);
                return result.rows;
            } else {
                // Fallback query
                const result = await pool.query(`
                    SELECT 
                        ROW_NUMBER() OVER (ORDER BY tp.total_score DESC) as rank,
                        u.username,
                        u.full_name,
                        CASE 
                            WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
                            ELSE 'whatsapp'
                        END as platform,
                        tp.total_score,
                        tp.games_played,
                        tp.best_score
                    FROM tournament_participants tp
                    JOIN users u ON tp.user_id = u.id
                    WHERE tp.tournament_id = $1
                    ORDER BY tp.total_score DESC
                    LIMIT $2 OFFSET $3
                `, [tournamentId, limit, offset]);
                return result.rows;
            }
        } catch (error) {
            logger.error(`Error getting tournament ${tournamentId} leaderboard:`, error);
            throw error;
        }
    }
    
    async getTournamentsWithStats() {
        try {
            // First check if tournaments table has any data
            const countCheck = await pool.query(`
                SELECT COUNT(*) as count FROM tournaments
            `);
            
            if (parseInt(countCheck.rows[0].count) === 0) {
                logger.info('No tournaments in database');
                return [];
            }
            
            const result = await pool.query(`
                SELECT 
                    t.id,
                    t.tournament_name,
                    COALESCE(t.entry_fee, 0) as entry_fee,
                    COALESCE(t.prize_pool, 0) as prize_pool,
                    t.start_date,
                    t.end_date,
                    COALESCE(t.status, 'upcoming') as status,
                    COUNT(DISTINCT tp.user_id) as total_participants,
                    COUNT(DISTINCT CASE 
                        WHEN u.platform = 'telegram' THEN tp.user_id 
                        WHEN u.phone_number LIKE 'tg_%' THEN tp.user_id
                    END) as telegram_participants,
                    COUNT(DISTINCT CASE 
                        WHEN u.platform = 'whatsapp' OR u.platform IS NULL THEN tp.user_id
                        WHEN u.phone_number NOT LIKE 'tg_%' THEN tp.user_id 
                    END) as whatsapp_participants,
                    COALESCE(MAX(tp.total_score), 0) as highest_score,
                    COALESCE(AVG(tp.total_score), 0) as avg_score
                FROM tournaments t
                LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
                LEFT JOIN users u ON tp.user_id = u.id
                GROUP BY t.id, t.tournament_name, t.entry_fee, t.prize_pool, 
                         t.start_date, t.end_date, t.status
                ORDER BY t.start_date DESC
            `);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting tournaments with stats:', error);
            logger.error('SQL Error details:', error.message);
            // Return empty array instead of throwing to prevent dashboard breaking
            return [];
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
                    COUNT(DISTINCT r.referred_user_id) as total_referred_users,
                    COUNT(DISTINCT CASE 
                        WHEN u.total_games_played > 0 THEN r.referred_user_id 
                    END) as active_referred_users,
                    ROUND(
                        COUNT(DISTINCT CASE WHEN u.total_games_played > 0 THEN r.referred_user_id END)::DECIMAL / 
                        NULLIF(COUNT(DISTINCT r.referred_user_id), 0) * 100, 
                        2
                    ) as conversion_rate
                FROM referrals r
                LEFT JOIN users u ON r.referred_user_id = u.id
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
                    CASE 
                        WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
                        ELSE 'whatsapp'
                    END as platform,
                    COUNT(r.id) as total_referrals,
                    COUNT(CASE WHEN ru.total_games_played > 0 THEN 1 END) as active_referrals,
                    u.referral_code
                FROM users u
                LEFT JOIN referrals r ON u.id = r.referrer_id
                LEFT JOIN users ru ON r.referred_user_id = ru.id
                WHERE u.total_referrals > 0
                GROUP BY u.id, u.username, u.full_name, u.phone_number, u.referral_code
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
            // First, let's get ALL transactions to see what we have
            const result = await pool.query(`
                SELECT 
                    COUNT(*) as total_transactions,
                    COALESCE(SUM(amount), 0) as total_revenue,
                    COALESCE(AVG(amount), 0) as avg_transaction,
                    COALESCE(SUM(CASE 
                        WHEN u.phone_number LIKE 'tg_%' THEN amount 
                        ELSE 0 
                    END), 0) as telegram_revenue,
                    COALESCE(SUM(CASE 
                        WHEN u.phone_number NOT LIKE 'tg_%' THEN amount 
                        ELSE 0 
                    END), 0) as whatsapp_revenue,
                    COUNT(DISTINCT t.user_id) as paying_users
                FROM transactions t
                JOIN users u ON t.user_id = u.id
                WHERE (
                    t.payment_status IN ('success', 'completed', 'paid', 'confirmed')
                    OR (t.transaction_type = 'payment' AND t.completed_at IS NOT NULL)
                    OR (t.payment_reference IS NOT NULL AND t.payment_reference != '')
                )
                AND t.amount > 0
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
                    COALESCE(SUM(amount), 0) as revenue,
                    COUNT(DISTINCT user_id) as unique_users
                FROM transactions
                WHERE (
                    payment_status IN ('success', 'completed', 'paid', 'confirmed')
                    OR (transaction_type = 'payment' AND completed_at IS NOT NULL)
                    OR (payment_reference IS NOT NULL AND payment_reference != '')
                )
                AND amount > 0
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
            // Check if function exists
            const funcCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT 1 FROM pg_proc WHERE proname = 'refresh_leaderboard_cache'
                )
            `);
            
            if (funcCheck.rows[0].exists) {
                await pool.query('SELECT refresh_leaderboard_cache()');
                logger.info('Leaderboard cache refreshed successfully');
            } else {
                logger.warn('refresh_leaderboard_cache function does not exist');
            }
            return { success: true };
        } catch (error) {
            logger.error('Error refreshing leaderboard cache:', error);
            throw error;
        }
    }
}

module.exports = new AnalyticsService();