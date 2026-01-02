// ============================================
// FILE: src/services/behavioral-analysis.service.js
// Handles: User behavior pattern analysis, anomaly detection
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class BehavioralAnalysisService {
    constructor() {
        // Thresholds for anomaly detection
        this.THRESHOLDS = {
            MIN_RESPONSE_TIME_MS: 1500,          // Minimum realistic human response
            SUSPICIOUS_AVG_RESPONSE_MS: 2500,    // Suspiciously fast average
            MAX_GAMES_PER_HOUR: 15,              // Rate limit
            SKILL_JUMP_THRESHOLD: 0.3,           // 30% win rate increase = suspicious
            SUSPICIOUS_PERFECT_GAMES: 3,         // 3+ perfect games in a week
            MIN_GAMES_FOR_ANALYSIS: 10           // Need at least 10 games for patterns
        };
    }
    
    // ============================================
    // UPDATE USER BEHAVIOR PATTERNS
    // ============================================
    
    async updateBehaviorPatterns(userId) {
        try {
            // Get game session data
            const sessionsResult = await pool.query(`
                SELECT 
                    started_at,
                    completed_at,
                    avg_response_time_ms,
                    fastest_response_ms,
                    current_score,
                    current_question,
                    status,
                    suspicious_flag
                FROM game_sessions
                WHERE user_id = $1
                AND started_at >= NOW() - INTERVAL '30 days'
                ORDER BY started_at DESC
            `, [userId]);
            
            const sessions = sessionsResult.rows;
            
            if (sessions.length < this.THRESHOLDS.MIN_GAMES_FOR_ANALYSIS) {
                return null; // Not enough data
            }
            
            // Calculate patterns
            const patterns = this.calculatePatterns(sessions);
            
            // Detect anomalies
            const anomalies = await this.detectAnomalies(userId, patterns, sessions);
            
            // Save patterns
            await this.savePatterns(userId, patterns, anomalies);
            
            return { patterns, anomalies };
        } catch (error) {
            logger.error('Error updating behavior patterns:', error);
            return null;
        }
    }
    
    // ============================================
    // CALCULATE PATTERNS
    // ============================================
    
    calculatePatterns(sessions) {
        const completedSessions = sessions.filter(s => s.status === 'completed');
        
        // Response time patterns
        const responseTimes = completedSessions
            .filter(s => s.avg_response_time_ms)
            .map(s => parseFloat(s.avg_response_time_ms));
        
        const avgResponseTime = responseTimes.length > 0 
            ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length 
            : null;
        
        const minResponseTime = responseTimes.length > 0 
            ? Math.min(...sessions.filter(s => s.fastest_response_ms).map(s => parseFloat(s.fastest_response_ms)))
            : null;
        
        const maxResponseTime = responseTimes.length > 0 
            ? Math.max(...responseTimes) 
            : null;
        
        // Standard deviation
        const stdDev = responseTimes.length > 1 
            ? Math.sqrt(responseTimes.reduce((sum, t) => sum + Math.pow(t - avgResponseTime, 2), 0) / responseTimes.length)
            : 0;
        
        // Play time patterns
        const playHours = {};
        const playDays = {};
        
        sessions.forEach(s => {
            const date = new Date(s.started_at);
            const hour = date.getHours();
            const day = date.getDay();
            
            playHours[hour] = (playHours[hour] || 0) + 1;
            playDays[day] = (playDays[day] || 0) + 1;
        });
        
        // Games per day
        const uniqueDays = new Set(sessions.map(s => 
            new Date(s.started_at).toDateString()
        )).size;
        const gamesPerDay = sessions.length / Math.max(uniqueDays, 1);
        
        // Win rate
        const wins = completedSessions.filter(s => parseFloat(s.current_score) > 0).length;
        const winRate = completedSessions.length > 0 
            ? wins / completedSessions.length 
            : 0;
        
        // Average questions correct
        const avgQuestionsCorrect = completedSessions.length > 0
            ? completedSessions.reduce((sum, s) => sum + (s.current_question || 0), 0) / completedSessions.length
            : 0;
        
        return {
            avgResponseTimeMs: avgResponseTime ? Math.round(avgResponseTime) : null,
            minResponseTimeMs: minResponseTime ? Math.round(minResponseTime) : null,
            maxResponseTimeMs: maxResponseTime ? Math.round(maxResponseTime) : null,
            responseTimeStddev: stdDev,
            typicalPlayHours: playHours,
            typicalPlayDays: playDays,
            avgGamesPerDay: Math.round(gamesPerDay * 100) / 100,
            winRate: Math.round(winRate * 10000) / 10000,
            avgQuestionsCorrect: Math.round(avgQuestionsCorrect * 100) / 100,
            totalGames: sessions.length,
            completedGames: completedSessions.length
        };
    }
    
    // ============================================
    // DETECT ANOMALIES
    // ============================================
    
    async detectAnomalies(userId, patterns, sessions) {
        const anomalies = [];
        let anomalyScore = 0;
        
        // 1. Check response time anomalies
        if (patterns.minResponseTimeMs && patterns.minResponseTimeMs < this.THRESHOLDS.MIN_RESPONSE_TIME_MS) {
            anomalies.push({
                type: 'response_too_fast',
                severity: 'high',
                description: `Minimum response time (${patterns.minResponseTimeMs}ms) is below human threshold`,
                score: 30
            });
            anomalyScore += 30;
        }
        
        if (patterns.avgResponseTimeMs && patterns.avgResponseTimeMs < this.THRESHOLDS.SUSPICIOUS_AVG_RESPONSE_MS) {
            anomalies.push({
                type: 'avg_response_suspicious',
                severity: 'medium',
                description: `Average response time (${patterns.avgResponseTimeMs}ms) is suspiciously fast`,
                score: 20
            });
            anomalyScore += 20;
        }
        
        // 2. Check for too many perfect games
        const perfectGames = sessions.filter(s => 
            s.current_question === 15 && parseFloat(s.current_score) === 50000
        ).length;
        
        if (perfectGames >= this.THRESHOLDS.SUSPICIOUS_PERFECT_GAMES) {
            anomalies.push({
                type: 'too_many_perfect_games',
                severity: 'high',
                description: `${perfectGames} perfect games in 30 days`,
                score: 25
            });
            anomalyScore += 25;
        }
        
        // 3. Check for sudden skill improvement
        const skillTrend = await this.calculateSkillTrend(userId);
        if (skillTrend.suddenJump) {
            anomalies.push({
                type: 'sudden_skill_jump',
                severity: 'medium',
                description: `Win rate jumped from ${skillTrend.previousWinRate}% to ${skillTrend.currentWinRate}%`,
                score: 20
            });
            anomalyScore += 20;
        }
        
        // 4. Check for bot-like consistency
        if (patterns.responseTimeStddev && patterns.responseTimeStddev < 500 && patterns.totalGames > 20) {
            anomalies.push({
                type: 'too_consistent',
                severity: 'medium',
                description: `Response time variance too low (${Math.round(patterns.responseTimeStddev)}ms stddev) - possible bot`,
                score: 15
            });
            anomalyScore += 15;
        }
        
        // 5. Check for suspicious play patterns (24/7 activity)
        const activeHours = Object.keys(patterns.typicalPlayHours).length;
        if (activeHours > 18 && patterns.totalGames > 50) {
            anomalies.push({
                type: 'unusual_hours',
                severity: 'low',
                description: `Active in ${activeHours} different hours - possible shared account or bot`,
                score: 10
            });
            anomalyScore += 10;
        }
        
        // 6. Check for high game volume
        if (patterns.avgGamesPerDay > 20) {
            anomalies.push({
                type: 'high_volume',
                severity: 'medium',
                description: `Playing ${patterns.avgGamesPerDay} games per day on average`,
                score: 15
            });
            anomalyScore += 15;
        }
        
        return {
            anomalies,
            anomalyScore: Math.min(anomalyScore, 100), // Cap at 100
            skillTrend: skillTrend.trend
        };
    }
    
    // ============================================
    // CALCULATE SKILL TREND
    // ============================================
    
    async calculateSkillTrend(userId) {
        try {
            // Compare last 7 days vs previous 7-14 days
            const result = await pool.query(`
                SELECT 
                    CASE 
                        WHEN started_at >= NOW() - INTERVAL '7 days' THEN 'recent'
                        ELSE 'previous'
                    END as period,
                    COUNT(*) as games,
                    COUNT(*) FILTER (WHERE current_score > 0) as wins,
                    AVG(current_question) as avg_questions
                FROM game_sessions
                WHERE user_id = $1
                AND status = 'completed'
                AND started_at >= NOW() - INTERVAL '14 days'
                GROUP BY period
            `, [userId]);
            
            const recent = result.rows.find(r => r.period === 'recent') || { games: 0, wins: 0 };
            const previous = result.rows.find(r => r.period === 'previous') || { games: 0, wins: 0 };
            
            const recentWinRate = recent.games > 0 ? recent.wins / recent.games : 0;
            const previousWinRate = previous.games > 0 ? previous.wins / previous.games : 0;
            
            const improvement = recentWinRate - previousWinRate;
            const suddenJump = improvement > this.THRESHOLDS.SKILL_JUMP_THRESHOLD && previous.games >= 5;
            
            let trend = 'stable';
            if (improvement > 0.1) trend = 'improving';
            else if (improvement < -0.1) trend = 'declining';
            if (suddenJump) trend = 'suspicious_jump';
            
            return {
                trend,
                suddenJump,
                previousWinRate: Math.round(previousWinRate * 100),
                currentWinRate: Math.round(recentWinRate * 100),
                improvement: Math.round(improvement * 100)
            };
        } catch (error) {
            logger.error('Error calculating skill trend:', error);
            return { trend: 'unknown', suddenJump: false };
        }
    }
    
    // ============================================
    // SAVE PATTERNS
    // ============================================
    
    async savePatterns(userId, patterns, anomalies) {
        try {
            await pool.query(`
                INSERT INTO user_behavior_patterns (
                    user_id, avg_response_time_ms, min_response_time_ms, max_response_time_ms,
                    response_time_stddev, typical_play_hours, typical_play_days,
                    avg_games_per_day, win_rate, avg_questions_correct,
                    skill_trend, anomaly_score, anomaly_reasons, last_updated
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                    avg_response_time_ms = $2,
                    min_response_time_ms = $3,
                    max_response_time_ms = $4,
                    response_time_stddev = $5,
                    typical_play_hours = $6,
                    typical_play_days = $7,
                    avg_games_per_day = $8,
                    win_rate = $9,
                    avg_questions_correct = $10,
                    skill_trend = $11,
                    anomaly_score = $12,
                    anomaly_reasons = $13,
                    last_updated = NOW()
            `, [
                userId,
                patterns.avgResponseTimeMs,
                patterns.minResponseTimeMs,
                patterns.maxResponseTimeMs,
                patterns.responseTimeStddev,
                JSON.stringify(patterns.typicalPlayHours),
                JSON.stringify(patterns.typicalPlayDays),
                patterns.avgGamesPerDay,
                patterns.winRate,
                patterns.avgQuestionsCorrect,
                anomalies.skillTrend,
                anomalies.anomalyScore,
                JSON.stringify(anomalies.anomalies)
            ]);
            
            // Create fraud alert if score is high
            if (anomalies.anomalyScore >= 50) {
                await this.createFraudAlertFromAnomalies(userId, anomalies);
            }
            
            // Update user fraud flags if needed
            if (anomalies.anomalyScore >= 70) {
                await pool.query(`
                    UPDATE users SET fraud_flags = fraud_flags + 1 WHERE id = $1
                `, [userId]);
            }
            
        } catch (error) {
            logger.error('Error saving behavior patterns:', error);
        }
    }
    
    // ============================================
    // CREATE FRAUD ALERT FROM ANOMALIES
    // ============================================
    
    async createFraudAlertFromAnomalies(userId, anomalies) {
        try {
            const highSeverity = anomalies.anomalies.filter(a => a.severity === 'high');
            const severity = highSeverity.length >= 2 ? 'critical' : 
                            highSeverity.length === 1 ? 'high' : 'medium';
            
            const description = anomalies.anomalies
                .map(a => `• ${a.description}`)
                .join('\n');
            
            await pool.query(`
                INSERT INTO fraud_alerts (user_id, alert_type, severity, description, evidence)
                VALUES ($1, 'behavioral_anomaly', $2, $3, $4)
            `, [
                userId,
                severity,
                `Behavioral anomalies detected (score: ${anomalies.anomalyScore}):\n${description}`,
                JSON.stringify(anomalies)
            ]);
            
            logger.warn(`Fraud alert created for user ${userId}: Behavioral anomaly (score: ${anomalies.anomalyScore})`);
        } catch (error) {
            logger.error('Error creating fraud alert:', error);
        }
    }
    
    // ============================================
    // GET USER BEHAVIOR PROFILE
    // ============================================
    
    async getUserBehaviorProfile(userId) {
        try {
            const result = await pool.query(`
                SELECT * FROM user_behavior_patterns WHERE user_id = $1
            `, [userId]);
            
            if (!result.rows.length) {
                // Generate fresh patterns
                await this.updateBehaviorPatterns(userId);
                const newResult = await pool.query(`
                    SELECT * FROM user_behavior_patterns WHERE user_id = $1
                `, [userId]);
                return newResult.rows[0] || null;
            }
            
            return result.rows[0];
        } catch (error) {
            logger.error('Error getting behavior profile:', error);
            return null;
        }
    }
    
    // ============================================
    // GET HIGH RISK USERS
    // ============================================
    
    async getHighRiskUsers(minAnomalyScore = 50) {
        try {
            const result = await pool.query(`
                SELECT bp.*, u.username, u.full_name, u.fraud_flags, u.is_suspended
                FROM user_behavior_patterns bp
                JOIN users u ON bp.user_id = u.id
                WHERE bp.anomaly_score >= $1
                ORDER BY bp.anomaly_score DESC
            `, [minAnomalyScore]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting high risk users:', error);
            return [];
        }
    }
    
    // ============================================
    // ANALYZE GAME SESSION IN REAL-TIME
    // ============================================
    
    async analyzeGameSession(userId, sessionData) {
        try {
            const { responseTimes, correctAnswers, totalTime } = sessionData;
            
            // Get user's historical patterns
            const patterns = await this.getUserBehaviorProfile(userId);
            
            const warnings = [];
            
            // Check for impossibly fast responses
            const fastResponses = responseTimes.filter(t => t < this.THRESHOLDS.MIN_RESPONSE_TIME_MS);
            if (fastResponses.length >= 3) {
                warnings.push({
                    type: 'multiple_fast_responses',
                    message: `${fastResponses.length} responses under ${this.THRESHOLDS.MIN_RESPONSE_TIME_MS}ms`
                });
            }
            
            // Check for sudden improvement vs historical
            if (patterns && patterns.avg_questions_correct) {
                const currentScore = correctAnswers;
                const historicalAvg = parseFloat(patterns.avg_questions_correct);
                
                if (currentScore > historicalAvg + 5 && historicalAvg < 10) {
                    warnings.push({
                        type: 'unusual_performance',
                        message: `Scored ${currentScore} vs historical average of ${historicalAvg}`
                    });
                }
            }
            
            return {
                suspicious: warnings.length > 0,
                warnings,
                shouldFlag: warnings.length >= 2
            };
        } catch (error) {
            logger.error('Error analyzing game session:', error);
            return { suspicious: false, warnings: [] };
        }
    }
    
    // ============================================
    // BATCH UPDATE ALL PATTERNS (Cron Job)
    // ============================================
    
    async batchUpdatePatterns() {
        try {
            // Get users with recent activity
            const usersResult = await pool.query(`
                SELECT DISTINCT user_id 
                FROM game_sessions 
                WHERE started_at >= NOW() - INTERVAL '7 days'
            `);
            
            let updated = 0;
            for (const row of usersResult.rows) {
                await this.updateBehaviorPatterns(row.user_id);
                updated++;
            }
            
            logger.info(`Batch updated behavior patterns for ${updated} users`);
            return updated;
        } catch (error) {
            logger.error('Error in batch update:', error);
            return 0;
        }
    }
}

module.exports = new BehavioralAnalysisService();