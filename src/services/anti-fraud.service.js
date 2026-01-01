// ============================================
// FILE: src/services/anti-fraud.service.js
// Handles: Response time tracking, suspicious activity detection
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

// Thresholds for suspicious activity
const THRESHOLDS = {
    MIN_RESPONSE_TIME_MS: 1500,      // Minimum realistic response time
    SUSPICIOUS_FAST_COUNT: 5,         // Number of fast answers to flag
    SUSPICIOUS_AVG_TIME_MS: 2500,     // Suspiciously fast average
    MAX_GAMES_PER_HOUR: 15,           // Maximum games in an hour
    MAX_PERFECT_GAMES_PER_DAY: 3,     // Maximum perfect games per day
};

class AntiFraudService {
    
    // ============================================
    // TRACK RESPONSE TIME
    // ============================================
    
    async trackResponseTime(sessionId, questionNumber, responseTimeMs, userId) {
        try {
            // Store in Redis for the current session
            const key = `response_times:${sessionId}`;
            const existingData = await redis.get(key);
            const times = existingData ? JSON.parse(existingData) : [];
            
            times.push({
                question: questionNumber,
                time: responseTimeMs,
                timestamp: Date.now()
            });
            
            await redis.setex(key, 3600, JSON.stringify(times));
            
            // Check for suspiciously fast response
            if (responseTimeMs < THRESHOLDS.MIN_RESPONSE_TIME_MS) {
                await this.flagFastResponse(userId, sessionId, questionNumber, responseTimeMs);
            }
            
            return times;
        } catch (error) {
            logger.error('Error tracking response time:', error);
            return [];
        }
    }
    
    // ============================================
    // FLAG FAST RESPONSE
    // ============================================
    
    async flagFastResponse(userId, sessionId, questionNumber, responseTimeMs) {
        try {
            const key = `fast_responses:${userId}`;
            const count = await redis.incr(key);
            
            if (count === 1) {
                await redis.expire(key, 86400); // 24 hour window
            }
            
            logger.warn(`Fast response detected: User ${userId}, Session ${sessionId}, Q${questionNumber}, ${responseTimeMs}ms`);
            
            // If too many fast responses, flag for review
            if (count >= THRESHOLDS.SUSPICIOUS_FAST_COUNT) {
                await this.flagUserForReview(userId, 'Multiple fast responses detected');
            }
        } catch (error) {
            logger.error('Error flagging fast response:', error);
        }
    }
    
    // ============================================
    // FLAG USER FOR REVIEW
    // ============================================
    
    async flagUserForReview(userId, reason) {
        try {
            await pool.query(`
                UPDATE users 
                SET fraud_flags = COALESCE(fraud_flags, 0) + 1,
                    last_fraud_check = NOW()
                WHERE id = $1
            `, [userId]);
            
            // Log the flag
            await pool.query(`
                INSERT INTO admin_activity_log (admin_id, action_type, target_type, target_id, details)
                VALUES (NULL, 'fraud_flag', 'user', $1, $2)
            `, [userId, JSON.stringify({ reason, automated: true })]);
            
            logger.warn(`User ${userId} flagged for fraud review: ${reason}`);
        } catch (error) {
            logger.error('Error flagging user for review:', error);
        }
    }
    
    // ============================================
    // FINALIZE SESSION STATS
    // ============================================
    
    async finalizeSessionStats(sessionId, userId) {
        try {
            const key = `response_times:${sessionId}`;
            const existingData = await redis.get(key);
            
            if (!existingData) return null;
            
            const times = JSON.parse(existingData);
            
            if (times.length === 0) return null;
            
            const responseTimes = times.map(t => t.time);
            const avgTime = Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length);
            const fastestTime = Math.min(...responseTimes);
            const fastAnswers = responseTimes.filter(t => t < THRESHOLDS.MIN_RESPONSE_TIME_MS).length;
            
            // Determine if suspicious
            const isSuspicious = 
                avgTime < THRESHOLDS.SUSPICIOUS_AVG_TIME_MS ||
                fastAnswers >= THRESHOLDS.SUSPICIOUS_FAST_COUNT;
            
            // Update session in database
            await pool.query(`
                UPDATE game_sessions 
                SET avg_response_time_ms = $1,
                    fastest_response_ms = $2,
                    suspicious_flag = $3,
                    response_times = $4
                WHERE id = $5
            `, [avgTime, fastestTime, isSuspicious, JSON.stringify(times), sessionId]);
            
            // Clean up Redis
            await redis.del(key);
            
            if (isSuspicious) {
                await this.flagUserForReview(userId, `Suspicious game session: avg ${avgTime}ms, ${fastAnswers} fast answers`);
            }
            
            return {
                avgTime,
                fastestTime,
                totalQuestions: times.length,
                fastAnswers,
                isSuspicious
            };
        } catch (error) {
            logger.error('Error finalizing session stats:', error);
            return null;
        }
    }
    
    // ============================================
    // CHECK GAME RATE LIMIT
    // ============================================
    
    async checkGameRateLimit(userId) {
        try {
            const key = `games_per_hour:${userId}`;
            const count = await redis.incr(key);
            
            if (count === 1) {
                await redis.expire(key, 3600); // 1 hour window
            }
            
            if (count > THRESHOLDS.MAX_GAMES_PER_HOUR) {
                return {
                    allowed: false,
                    count,
                    limit: THRESHOLDS.MAX_GAMES_PER_HOUR,
                    message: `⚠️ *SLOW DOWN* ⚠️\n\nYou've played ${count} games in the last hour.\n\nPlease take a break and try again later.\n\n_Maximum ${THRESHOLDS.MAX_GAMES_PER_HOUR} games per hour._`
                };
            }
            
            return { allowed: true, count };
        } catch (error) {
            logger.error('Error checking game rate limit:', error);
            return { allowed: true };
        }
    }
    
    // ============================================
    // CHECK PERFECT GAME LIMIT
    // ============================================
    
    async checkPerfectGameLimit(userId) {
        try {
            const result = await pool.query(`
                SELECT COUNT(*) as count
                FROM game_sessions
                WHERE user_id = $1
                AND DATE(completed_at) = CURRENT_DATE
                AND current_question > 15
                AND status = 'won'
            `, [userId]);
            
            const count = parseInt(result.rows[0].count);
            
            if (count >= THRESHOLDS.MAX_PERFECT_GAMES_PER_DAY) {
                await this.flagUserForReview(userId, `${count} perfect games today - unusual pattern`);
                return {
                    suspicious: true,
                    count,
                    limit: THRESHOLDS.MAX_PERFECT_GAMES_PER_DAY
                };
            }
            
            return { suspicious: false, count };
        } catch (error) {
            logger.error('Error checking perfect game limit:', error);
            return { suspicious: false };
        }
    }
    
    // ============================================
    // GET FLAGGED USERS (for admin)
    // ============================================
    
    async getFlaggedUsers(limit = 50) {
        try {
            const result = await pool.query(`
                SELECT u.id, u.username, u.full_name, u.phone_number, u.city,
                       u.fraud_flags, u.last_fraud_check, u.is_suspended,
                       COUNT(gs.id) as total_games,
                       AVG(gs.avg_response_time_ms) as avg_response_time,
                       MIN(gs.fastest_response_ms) as fastest_ever,
                       COUNT(gs.id) FILTER (WHERE gs.suspicious_flag = true) as suspicious_games
                FROM users u
                LEFT JOIN game_sessions gs ON u.id = gs.user_id
                WHERE u.fraud_flags > 0
                GROUP BY u.id, u.username, u.full_name, u.phone_number, u.city,
                         u.fraud_flags, u.last_fraud_check, u.is_suspended
                ORDER BY u.fraud_flags DESC, u.last_fraud_check DESC
                LIMIT $1
            `, [limit]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting flagged users:', error);
            return [];
        }
    }
    
    // ============================================
    // GET SUSPICIOUS SESSIONS (for admin)
    // ============================================
    
    async getSuspiciousSessions(limit = 50) {
        try {
            const result = await pool.query(`
                SELECT gs.*, u.username, u.full_name, u.phone_number
                FROM game_sessions gs
                JOIN users u ON gs.user_id = u.id
                WHERE gs.suspicious_flag = true
                ORDER BY gs.started_at DESC
                LIMIT $1
            `, [limit]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting suspicious sessions:', error);
            return [];
        }
    }
    
    // ============================================
    // CLEAR USER FLAGS (admin action)
    // ============================================
    
    async clearUserFlags(userId, adminId) {
        try {
            await pool.query(`
                UPDATE users 
                SET fraud_flags = 0, last_fraud_check = NULL
                WHERE id = $1
            `, [userId]);
            
            await pool.query(`
                INSERT INTO admin_activity_log (admin_id, action_type, target_type, target_id, details)
                VALUES ($1, 'clear_fraud_flags', 'user', $2, $3)
            `, [adminId, userId, JSON.stringify({ cleared_at: new Date() })]);
            
            logger.info(`Fraud flags cleared for user ${userId} by admin ${adminId}`);
            return true;
        } catch (error) {
            logger.error('Error clearing user flags:', error);
            return false;
        }
    }
    
    // ============================================
    // GET USER FRAUD REPORT
    // ============================================
    
    async getUserFraudReport(userId) {
        try {
            // Get user info
            const userResult = await pool.query(`
                SELECT id, username, full_name, fraud_flags, last_fraud_check, is_suspended
                FROM users WHERE id = $1
            `, [userId]);
            
            if (userResult.rows.length === 0) return null;
            
            const user = userResult.rows[0];
            
            // Get session stats
            const sessionResult = await pool.query(`
                SELECT 
                    COUNT(*) as total_sessions,
                    AVG(avg_response_time_ms) as avg_response_time,
                    MIN(fastest_response_ms) as fastest_response,
                    COUNT(*) FILTER (WHERE suspicious_flag = true) as suspicious_sessions,
                    COUNT(*) FILTER (WHERE status = 'won') as wins,
                    COUNT(*) FILTER (WHERE current_question > 15 AND status = 'won') as perfect_games
                FROM game_sessions
                WHERE user_id = $1
            `, [userId]);
            
            // Get fraud log entries
            const logResult = await pool.query(`
                SELECT action_type, details, created_at
                FROM admin_activity_log
                WHERE target_type = 'user' AND target_id = $1
                AND action_type IN ('fraud_flag', 'clear_fraud_flags', 'suspend_user')
                ORDER BY created_at DESC
                LIMIT 20
            `, [userId]);
            
            return {
                user,
                stats: sessionResult.rows[0],
                history: logResult.rows
            };
        } catch (error) {
            logger.error('Error getting user fraud report:', error);
            return null;
        }
    }
    
    // ============================================
    // CALCULATE RESPONSE TIME FOR ANSWER
    // ============================================
    
    async getQuestionStartTime(sessionKey, questionNumber) {
        try {
            const key = `question_start:${sessionKey}:q${questionNumber}`;
            const startTime = await redis.get(key);
            return startTime ? parseInt(startTime) : null;
        } catch (error) {
            logger.error('Error getting question start time:', error);
            return null;
        }
    }
    
    async setQuestionStartTime(sessionKey, questionNumber) {
        try {
            const key = `question_start:${sessionKey}:q${questionNumber}`;
            await redis.setex(key, 60, Date.now().toString());
            return true;
        } catch (error) {
            logger.error('Error setting question start time:', error);
            return false;
        }
    }
}

module.exports = new AntiFraudService();
