// ============================================
// FILE: src/routes/public.routes.js
// PUBLIC LEADERBOARD API - No Authentication Required
// For displaying tournament leaderboards on the website
// FIXED: Using correct column names from actual schema
// ============================================

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { logger } = require('../utils/logger');

// ============================================
// CORS MIDDLEWARE FOR PUBLIC ENDPOINTS
// ============================================
router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Cache-Control', 'public, max-age=60'); // Cache for 1 minute
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ============================================
// GET ALL TOURNAMENTS (for dropdown/selection)
// FIXED: tournament_name instead of name
// ============================================
router.get('/tournaments', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                t.id,
                t.tournament_name as name,
                t.status,
                t.start_date,
                t.end_date,
                t.prize_pool,
                t.payment_type,
                t.entry_fee,
                COALESCE(pc.participant_count, 0) as participant_count
            FROM tournaments t
            LEFT JOIN (
                SELECT tournament_id, COUNT(*) as participant_count 
                FROM tournament_participants 
                GROUP BY tournament_id
            ) pc ON t.id = pc.tournament_id
            WHERE t.status IN ('active', 'completed')
            ORDER BY 
                CASE t.status 
                    WHEN 'active' THEN 1 
                    WHEN 'completed' THEN 2 
                END,
                t.start_date DESC
            LIMIT 50
        `);
        
        res.json({
            success: true,
            data: result.rows,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Error fetching public tournaments:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch tournaments' });
    }
});

// ============================================
// GET TOURNAMENT LEADERBOARD BY ID
// FIXED: Using correct column names
// ============================================
router.get('/tournaments/:id/leaderboard', async (req, res) => {
    try {
        const tournamentId = parseInt(req.params.id);
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        
        if (isNaN(tournamentId)) {
            return res.status(400).json({ success: false, error: 'Invalid tournament ID' });
        }
        
        // Get tournament info including prize_structure
        const tournamentResult = await pool.query(`
            SELECT 
                t.id, 
                t.tournament_name as name, 
                t.status, 
                t.start_date, 
                t.end_date, 
                t.prize_pool,
                ti.prize_structure
            FROM tournaments t
            LEFT JOIN tournament_instructions ti ON t.id = ti.tournament_id
            WHERE t.id = $1
        `, [tournamentId]);
        
        if (tournamentResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Tournament not found' });
        }
        
        const tournament = tournamentResult.rows[0];
        
        // Calculate prize distribution based on prize_pool
        // Default distribution: 40%, 20%, 15%, 10%, 5%, 3%, 3%, 2%, 1%, 1%
        const prizePool = tournament.prize_pool || 0;
        let prizeStructure = tournament.prize_structure;
        
        // If no custom prize structure, generate default
        if (!prizeStructure && prizePool > 0) {
            const defaultDistribution = [0.40, 0.20, 0.15, 0.10, 0.05, 0.03, 0.03, 0.02, 0.01, 0.01];
            prizeStructure = defaultDistribution.map((pct, index) => ({
                position: index + 1,
                percentage: (pct * 100).toFixed(0) + '%',
                amount: Math.floor(prizePool * pct)
            }));
        }
        
        // Get leaderboard from tournament_participants
        // Ranking: Most questions answered > Fastest time > Earlier join
        const leaderboardResult = await pool.query(`
            SELECT 
                RANK() OVER (
                    ORDER BY 
                        COALESCE(tp.best_questions_answered, 0) DESC,
                        COALESCE(tp.best_time_taken, 999) ASC,
                        tp.joined_at ASC
                ) as rank,
                u.username,
                COALESCE(tp.best_questions_answered, 0) as questions_reached,
                COALESCE(tp.best_time_taken, 0) as time_taken,
                tp.best_score as score,
                tp.games_played,
                CASE 
                    WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
                    ELSE 'whatsapp'
                END as platform,
                COALESCE(tp.last_played_at, tp.joined_at) as last_played
            FROM tournament_participants tp
            JOIN users u ON tp.user_id = u.id
            WHERE tp.tournament_id = $1 
              AND (tp.best_questions_answered > 0 OR tp.best_score > 0)
            ORDER BY 
                COALESCE(tp.best_questions_answered, 0) DESC,
                COALESCE(tp.best_time_taken, 999) ASC,
                tp.joined_at ASC
            LIMIT $2
        `, [tournamentId, limit]);
        
        // Add tier classification and prize amount
        const defaultDistribution = [0.40, 0.20, 0.15, 0.10, 0.05, 0.03, 0.03, 0.02, 0.01, 0.01];
        const leaderboard = leaderboardResult.rows.map(row => {
            const rank = parseInt(row.rank);
            const prize = rank <= 10 && prizePool > 0 ? Math.floor(prizePool * defaultDistribution[rank - 1]) : 0;
            return {
                ...row,
                rank: rank,
                tier: rank <= 3 ? 'gold' : rank <= 10 ? 'silver' : 'bronze',
                prize_amount: prize
            };
        });
        
        res.json({
            success: true,
            tournament: {
                ...tournament,
                prize_structure: prizeStructure
            },
            leaderboard: leaderboard,
            total_participants: leaderboard.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Error fetching tournament leaderboard:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
    }
});

// ============================================
// GET ALL-TIME LEADERBOARD
// FIXED: Using correct column names
// ============================================
router.get('/leaderboard/all-time', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        
        const result = await pool.query(`
            SELECT 
                RANK() OVER (ORDER BY COALESCE(SUM(tp.prize_won), 0) DESC, COALESCE(SUM(tp.best_score), 0) DESC) as rank,
                u.username,
                COALESCE(SUM(tp.prize_won), 0) as total_winnings,
                COALESCE(SUM(tp.best_score), 0) as total_score,
                COUNT(DISTINCT tp.tournament_id) as tournaments_played,
                CASE 
                    WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
                    ELSE 'whatsapp'
                END as platform,
                MAX(tp.joined_at) as last_active
            FROM users u
            JOIN tournament_participants tp ON u.id = tp.user_id
            WHERE tp.best_score > 0
            GROUP BY u.id, u.username, u.phone_number
            HAVING COALESCE(SUM(tp.prize_won), 0) > 0 OR COALESCE(SUM(tp.best_score), 0) > 0
            ORDER BY total_winnings DESC, total_score DESC
            LIMIT $1
        `, [limit]);
        
        const leaderboard = result.rows.map(row => ({
            ...row,
            rank: parseInt(row.rank),
            tier: row.rank <= 10 ? 'gold' : row.rank <= 20 ? 'silver' : 'bronze'
        }));
        
        res.json({
            success: true,
            leaderboard: leaderboard,
            type: 'all-time',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Error fetching all-time leaderboard:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
    }
});

// ============================================
// GET DAILY LEADERBOARD
// Top performers in the last 24 hours
// ============================================
router.get('/leaderboard/daily', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        
        const result = await pool.query(`
            SELECT 
                RANK() OVER (ORDER BY SUM(COALESCE(gs.final_score, 0)) DESC) as rank,
                u.username,
                SUM(COALESCE(gs.final_score, 0)) as total_score,
                COUNT(gs.id) as games_played,
                MAX(COALESCE(gs.final_score, 0)) as best_score,
                CASE 
                    WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
                    ELSE 'whatsapp'
                END as platform,
                MAX(gs.completed_at) as last_played
            FROM users u
            JOIN game_sessions gs ON u.id = gs.user_id
            WHERE gs.status = 'completed'
              AND gs.completed_at >= NOW() - INTERVAL '24 hours'
            GROUP BY u.id, u.username, u.phone_number
            HAVING SUM(COALESCE(gs.final_score, 0)) > 0
            ORDER BY total_score DESC
            LIMIT $1
        `, [limit]);
        
        const leaderboard = result.rows.map(row => ({
            ...row,
            rank: parseInt(row.rank),
            tier: row.rank <= 10 ? 'gold' : row.rank <= 20 ? 'silver' : 'bronze'
        }));
        
        res.json({
            success: true,
            leaderboard: leaderboard,
            type: 'daily',
            period: {
                start: new Date(Date.now() - 24*60*60*1000).toISOString(),
                end: new Date().toISOString()
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Error fetching daily leaderboard:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
    }
});

// ============================================
// GET WEEKLY LEADERBOARD
// Top performers in the last 7 days
// ============================================
router.get('/leaderboard/weekly', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        
        const result = await pool.query(`
            SELECT 
                RANK() OVER (ORDER BY SUM(COALESCE(gs.final_score, 0)) DESC) as rank,
                u.username,
                SUM(COALESCE(gs.final_score, 0)) as total_score,
                COUNT(gs.id) as games_played,
                MAX(COALESCE(gs.final_score, 0)) as best_score,
                CASE 
                    WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
                    ELSE 'whatsapp'
                END as platform,
                MAX(gs.completed_at) as last_played
            FROM users u
            JOIN game_sessions gs ON u.id = gs.user_id
            WHERE gs.status = 'completed'
              AND gs.completed_at >= NOW() - INTERVAL '7 days'
            GROUP BY u.id, u.username, u.phone_number
            HAVING SUM(COALESCE(gs.final_score, 0)) > 0
            ORDER BY total_score DESC
            LIMIT $1
        `, [limit]);
        
        const leaderboard = result.rows.map(row => ({
            ...row,
            rank: parseInt(row.rank),
            tier: row.rank <= 10 ? 'gold' : row.rank <= 20 ? 'silver' : 'bronze'
        }));
        
        res.json({
            success: true,
            leaderboard: leaderboard,
            type: 'weekly',
            period: {
                start: new Date(Date.now() - 7*24*60*60*1000).toISOString(),
                end: new Date().toISOString()
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Error fetching weekly leaderboard:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
    }
});

// ============================================
// GET MONTHLY LEADERBOARD
// Top performers in the last 30 days
// ============================================
router.get('/leaderboard/monthly', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        
        const result = await pool.query(`
            SELECT 
                RANK() OVER (ORDER BY SUM(COALESCE(gs.final_score, 0)) DESC) as rank,
                u.username,
                SUM(COALESCE(gs.final_score, 0)) as total_score,
                COUNT(gs.id) as games_played,
                MAX(COALESCE(gs.final_score, 0)) as best_score,
                CASE 
                    WHEN u.phone_number LIKE 'tg_%' THEN 'telegram'
                    ELSE 'whatsapp'
                END as platform,
                MAX(gs.completed_at) as last_played
            FROM users u
            JOIN game_sessions gs ON u.id = gs.user_id
            WHERE gs.status = 'completed'
              AND gs.completed_at >= NOW() - INTERVAL '30 days'
            GROUP BY u.id, u.username, u.phone_number
            HAVING SUM(COALESCE(gs.final_score, 0)) > 0
            ORDER BY total_score DESC
            LIMIT $1
        `, [limit]);
        
        const leaderboard = result.rows.map(row => ({
            ...row,
            rank: parseInt(row.rank),
            tier: row.rank <= 10 ? 'gold' : row.rank <= 20 ? 'silver' : 'bronze'
        }));
        
        res.json({
            success: true,
            leaderboard: leaderboard,
            type: 'monthly',
            period: {
                start: new Date(Date.now() - 30*24*60*60*1000).toISOString(),
                end: new Date().toISOString()
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Error fetching monthly leaderboard:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
    }
});

// ============================================
// GET ACTIVE TOURNAMENT (for quick access)
// Returns the current active tournament if any
// ============================================
router.get('/tournaments/active', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                t.id,
                t.tournament_name as name,
                t.status,
                t.start_date,
                t.end_date,
                t.prize_pool,
                COALESCE(pc.participant_count, 0) as participant_count
            FROM tournaments t
            LEFT JOIN (
                SELECT tournament_id, COUNT(*) as participant_count 
                FROM tournament_participants 
                GROUP BY tournament_id
            ) pc ON t.id = pc.tournament_id
            WHERE t.status = 'active'
              AND t.start_date <= NOW()
              AND t.end_date > NOW()
            ORDER BY t.prize_pool DESC
            LIMIT 1
        `);
        
        if (result.rows.length === 0) {
            return res.json({
                success: true,
                tournament: null,
                message: 'No active tournament at the moment'
            });
        }
        
        res.json({
            success: true,
            tournament: result.rows[0],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Error fetching active tournament:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch tournament' });
    }
});

module.exports = router;