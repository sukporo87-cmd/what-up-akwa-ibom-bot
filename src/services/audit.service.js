// ============================================
// FILE: src/services/audit.service.js
// Game Session Audit Trail Service
// Tracks every action in a game session for dispute resolution
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class AuditService {
    constructor() {
        // Start the cleanup job for old audit logs
        this.startAuditCleanup();
    }

    // ============================================
    // AUDIT LOG CREATION
    // ============================================

    /**
     * Log when a game session starts
     */
    async logGameStart(sessionId, userId, gameMode, platform, tournamentId = null) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'GAME_START', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    game_mode: gameMode,
                    platform: platform,
                    tournament_id: tournamentId,
                    started_at: new Date().toISOString()
                })
            ]);
            
            logger.info(`📝 Audit: Game started - Session ${sessionId}, User ${userId}`);
        } catch (error) {
            logger.error('Error logging game start:', error);
            // Don't throw - audit logging should not break the game
        }
    }

    /**
     * Log when a question is presented to the user
     */
    async logQuestionAsked(sessionId, userId, questionNumber, question, prizeAmount, isTurboMode = false) {
        try {
            const questionStartTime = Date.now();
            const isSafePoint = [5, 10].includes(questionNumber);
            
            // Store question start time in Redis for response time calculation
            const redis = require('../config/redis');
            await redis.setex(`audit_q_start:${sessionId}:${questionNumber}`, 60, questionStartTime.toString());
            
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'QUESTION_ASKED', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    question_number: questionNumber,
                    question_id: question.id,
                    question_text: question.question_text,
                    option_a: question.option_a,
                    option_b: question.option_b,
                    option_c: question.option_c,
                    option_d: question.option_d,
                    correct_answer: question.correct_answer,
                    difficulty: question.difficulty,
                    category: question.category,
                    prize_at_stake: prizeAmount,
                    question_start_time: questionStartTime,
                    turbo_mode: isTurboMode,
                    timeout_seconds: isTurboMode ? 10 : 12,
                    // NEW: Rotation tracking fields
                    times_seen_by_user: question.user_times_seen || 0,
                    is_safe_point: isSafePoint,
                    safe_point_note: isSafePoint ? `Q${questionNumber} is a safe checkpoint` : null
                })
            ]);
        } catch (error) {
            logger.error('Error logging question asked:', error);
        }
    }

    /**
     * Log when a user answers a question
     */
    async logAnswer(sessionId, userId, questionNumber, userAnswer, correctAnswer, isCorrect, prizeWon) {
        try {
            const redis = require('../config/redis');
            const questionStartTime = await redis.get(`audit_q_start:${sessionId}:${questionNumber}`);
            const responseTimeMs = questionStartTime ? Date.now() - parseInt(questionStartTime) : null;
            
            // Clean up the start time
            await redis.del(`audit_q_start:${sessionId}:${questionNumber}`);
            
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'ANSWER_GIVEN', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    question_number: questionNumber,
                    user_answer: userAnswer,
                    correct_answer: correctAnswer,
                    is_correct: isCorrect,
                    response_time_ms: responseTimeMs,
                    response_time_seconds: responseTimeMs ? (responseTimeMs / 1000).toFixed(2) : null,
                    prize_won: isCorrect ? prizeWon : 0,
                    cumulative_score: prizeWon
                })
            ]);
            
            logger.info(`📝 Audit: Answer - Session ${sessionId}, Q${questionNumber}, ${isCorrect ? '✓' : '✗'}, ${responseTimeMs}ms`);
        } catch (error) {
            logger.error('Error logging answer:', error);
        }
    }

    /**
     * Log when a lifeline is used
     */
    async logLifelineUsed(sessionId, userId, questionNumber, lifelineType, result) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'LIFELINE_USED', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    question_number: questionNumber,
                    lifeline_type: lifelineType,
                    result: result // e.g., removed options for 50:50, or "skipped" for skip
                })
            ]);
            
            logger.info(`📝 Audit: Lifeline ${lifelineType} used - Session ${sessionId}, Q${questionNumber}`);
        } catch (error) {
            logger.error('Error logging lifeline:', error);
        }
    }

    /**
     * Log when time runs out on a question
     */
    async logTimeout(sessionId, userId, questionNumber) {
        try {
            const redis = require('../config/redis');
            const questionStartTime = await redis.get(`audit_q_start:${sessionId}:${questionNumber}`);
            const responseTimeMs = questionStartTime ? Date.now() - parseInt(questionStartTime) : 15000;
            
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'TIMEOUT', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    question_number: questionNumber,
                    response_time_ms: responseTimeMs,
                    reason: 'Time limit exceeded (15 seconds)'
                })
            ]);
            
            logger.info(`📝 Audit: Timeout - Session ${sessionId}, Q${questionNumber}`);
        } catch (error) {
            logger.error('Error logging timeout:', error);
        }
    }

    // ============================================
    // CAPTCHA AUDIT LOGGING
    // ============================================

    /**
     * Log when a CAPTCHA is shown to the user
     */
    async logCaptchaShown(sessionId, userId, questionNumber, captchaType, captchaQuestion) {
        try {
            const redis = require('../config/redis');
            const captchaStartTime = Date.now();
            
            // Store CAPTCHA start time for response time calculation
            await redis.setex(`audit_captcha_start:${sessionId}:${questionNumber}`, 60, captchaStartTime.toString());
            
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'CAPTCHA_SHOWN', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    question_number: questionNumber,
                    captcha_type: captchaType,
                    captcha_question: captchaQuestion,
                    captcha_start_time: captchaStartTime
                })
            ]);
            
            logger.info(`📝 Audit: CAPTCHA shown - Session ${sessionId}, Q${questionNumber}, Type: ${captchaType}`);
        } catch (error) {
            logger.error('Error logging CAPTCHA shown:', error);
        }
    }

    /**
     * Log CAPTCHA response (pass or fail)
     */
    async logCaptchaResponse(sessionId, userId, questionNumber, captchaType, userAnswer, correctAnswer, isCorrect, responseTimeMs) {
        try {
            const redis = require('../config/redis');
            
            // Clean up the start time
            await redis.del(`audit_captcha_start:${sessionId}:${questionNumber}`);
            
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, $3, $4, NOW())
            `, [
                sessionId,
                userId,
                isCorrect ? 'CAPTCHA_PASSED' : 'CAPTCHA_FAILED',
                JSON.stringify({
                    question_number: questionNumber,
                    captcha_type: captchaType,
                    user_answer: userAnswer,
                    correct_answer: correctAnswer,
                    is_correct: isCorrect,
                    response_time_ms: responseTimeMs,
                    response_time_seconds: responseTimeMs ? (responseTimeMs / 1000).toFixed(2) : null
                })
            ]);
            
            logger.info(`📝 Audit: CAPTCHA ${isCorrect ? 'PASSED ✅' : 'FAILED ❌'} - Session ${sessionId}, Q${questionNumber}, ${responseTimeMs}ms`);
        } catch (error) {
            logger.error('Error logging CAPTCHA response:', error);
        }
    }

    /**
     * Log CAPTCHA timeout
     */
    async logCaptchaTimeout(sessionId, userId, questionNumber, captchaType) {
        try {
            const redis = require('../config/redis');
            const captchaStartTime = await redis.get(`audit_captcha_start:${sessionId}:${questionNumber}`);
            const responseTimeMs = captchaStartTime ? Date.now() - parseInt(captchaStartTime) : 12000;
            
            await redis.del(`audit_captcha_start:${sessionId}:${questionNumber}`);
            
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'CAPTCHA_TIMEOUT', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    question_number: questionNumber,
                    captcha_type: captchaType,
                    response_time_ms: responseTimeMs,
                    reason: 'CAPTCHA time limit exceeded (12 seconds)'
                })
            ]);
            
            logger.info(`📝 Audit: CAPTCHA timeout - Session ${sessionId}, Q${questionNumber}`);
        } catch (error) {
            logger.error('Error logging CAPTCHA timeout:', error);
        }
    }

    // ============================================
    // TURBO MODE AUDIT LOGGING
    // ============================================

    /**
     * Log when Turbo Mode is activated
     */
    async logTurboModeActivated(sessionId, userId, questionNumber, suspiciousResponses) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'TURBO_MODE_ACTIVATED', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    question_number: questionNumber,
                    trigger_reason: '3 consecutive answers in 10.5s-11.99s window',
                    suspicious_responses: suspiciousResponses,
                    reduced_timeout: '10 seconds',
                    turbo_questions: 2,
                    activated_at: new Date().toISOString()
                })
            ]);
            
            logger.info(`📝 Audit: ⚡ TURBO MODE ACTIVATED - Session ${sessionId}, Q${questionNumber}`);
        } catch (error) {
            logger.error('Error logging turbo mode activation:', error);
        }
    }

    /**
     * Log when Turbo Mode is completed (user passed the test)
     */
    async logTurboModeCompleted(sessionId, userId) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'TURBO_MODE_COMPLETED', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    result: 'passed',
                    message: 'User completed 2 turbo mode questions successfully',
                    completed_at: new Date().toISOString()
                })
            ]);
            
            logger.info(`📝 Audit: ⚡ TURBO MODE COMPLETED - Session ${sessionId}, User ${userId} passed`);
        } catch (error) {
            logger.error('Error logging turbo mode completion:', error);
        }
    }

    /**
     * Log when a question is asked during Turbo Mode
     */
    async logTurboModeQuestion(sessionId, userId, questionNumber, questionsRemaining) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'TURBO_MODE_QUESTION', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    question_number: questionNumber,
                    turbo_questions_remaining: questionsRemaining,
                    timeout_seconds: 10
                })
            ]);
            
            logger.info(`📝 Audit: ⚡ Turbo question - Session ${sessionId}, Q${questionNumber}, ${questionsRemaining} remaining`);
        } catch (error) {
            logger.error('Error logging turbo mode question:', error);
        }
    }

    /**
     * Log when user types GO to continue turbo mode
     */
    async logTurboModeGoReceived(sessionId, userId) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'TURBO_MODE_GO_RECEIVED', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    result: 'user_acknowledged',
                    message: 'User typed GO to continue with turbo mode',
                    received_at: new Date().toISOString()
                })
            ]);
            
            logger.info(`📝 Audit: ⚡ TURBO MODE GO RECEIVED - Session ${sessionId}, User ${userId}`);
        } catch (error) {
            logger.error('Error logging turbo mode GO received:', error);
        }
    }

    /**
     * Log when user fails to type GO within 30 seconds
     */
    async logTurboModeTimeout(sessionId, userId) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'TURBO_MODE_GO_TIMEOUT', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    result: 'timeout',
                    message: 'User failed to type GO within 30 seconds',
                    timeout_at: new Date().toISOString()
                })
            ]);
            
            logger.info(`📝 Audit: ⚡ TURBO MODE GO TIMEOUT - Session ${sessionId}, User ${userId}`);
        } catch (error) {
            logger.error('Error logging turbo mode timeout:', error);
        }
    }

    /**
     * Log when a game ends
     */
    async logGameEnd(sessionId, userId, finalScore, questionsAnswered, outcome, guaranteedAmount = 0) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'GAME_END', $3, NOW())
            `, [
                sessionId,
                userId,
                JSON.stringify({
                    final_score: finalScore,
                    questions_answered: questionsAnswered,
                    outcome: outcome, // 'completed', 'wrong_answer', 'timeout', 'cancelled'
                    guaranteed_amount: guaranteedAmount,
                    ended_at: new Date().toISOString()
                })
            ]);
            
            logger.info(`📝 Audit: Game ended - Session ${sessionId}, Score: ₦${finalScore}, Outcome: ${outcome}`);
        } catch (error) {
            logger.error('Error logging game end:', error);
        }
    }

    // ============================================
    // AUDIT LOG RETRIEVAL
    // ============================================

    /**
     * Get complete audit trail for a game session
     */
    async getSessionAuditTrail(sessionId) {
        try {
            const result = await pool.query(`
                SELECT 
                    gal.*,
                    u.username,
                    u.full_name,
                    u.phone_number,
                    gs.game_mode,
                    gs.final_score,
                    gs.status as session_status,
                    gs.started_at as session_started,
                    gs.completed_at as session_completed
                FROM game_audit_logs gal
                JOIN users u ON gal.user_id = u.id
                JOIN game_sessions gs ON gal.session_id = gs.id
                WHERE gal.session_id = $1
                ORDER BY gal.created_at ASC
            `, [sessionId]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting session audit trail:', error);
            throw error;
        }
    }

    /**
     * Get audit trail for a user within a date range
     */
    async getUserAuditTrail(userId, startDate = null, endDate = null) {
        try {
            let query = `
                SELECT 
                    gal.*,
                    gs.game_mode,
                    gs.final_score,
                    gs.status as session_status
                FROM game_audit_logs gal
                JOIN game_sessions gs ON gal.session_id = gs.id
                WHERE gal.user_id = $1
            `;
            const params = [userId];
            
            if (startDate) {
                query += ` AND gal.created_at >= $${params.length + 1}`;
                params.push(startDate);
            }
            
            if (endDate) {
                query += ` AND gal.created_at <= $${params.length + 1}`;
                params.push(endDate);
            }
            
            query += ` ORDER BY gal.created_at DESC LIMIT 1000`;
            
            const result = await pool.query(query, params);
            return result.rows;
        } catch (error) {
            logger.error('Error getting user audit trail:', error);
            throw error;
        }
    }

    /**
     * Generate a formatted audit report for a session
     */
    async generateSessionReport(sessionId) {
        try {
            const auditTrail = await this.getSessionAuditTrail(sessionId);
            
            if (auditTrail.length === 0) {
                return null;
            }
            
            const firstEntry = auditTrail[0];
            const report = {
                session_id: sessionId,
                user: {
                    id: firstEntry.user_id,
                    username: firstEntry.username,
                    full_name: firstEntry.full_name,
                    phone: firstEntry.phone_number
                },
                game_info: {
                    mode: firstEntry.game_mode,
                    final_score: firstEntry.final_score,
                    status: firstEntry.session_status,
                    started: firstEntry.session_started,
                    completed: firstEntry.session_completed
                },
                timeline: [],
                summary: {
                    total_questions: 0,
                    correct_answers: 0,
                    wrong_answers: 0,
                    timeouts: 0,
                    lifelines_used: [],
                    total_response_time_ms: 0,
                    average_response_time_ms: 0
                }
            };
            
            let responseTimeCount = 0;
            
            for (const entry of auditTrail) {
                const eventData = entry.event_data;
                
                report.timeline.push({
                    event: entry.event_type,
                    timestamp: entry.created_at,
                    data: eventData
                });
                
                // Build summary
                switch (entry.event_type) {
                    case 'QUESTION_ASKED':
                        report.summary.total_questions++;
                        break;
                    case 'ANSWER_GIVEN':
                        if (eventData.is_correct) {
                            report.summary.correct_answers++;
                        } else {
                            report.summary.wrong_answers++;
                        }
                        if (eventData.response_time_ms) {
                            report.summary.total_response_time_ms += eventData.response_time_ms;
                            responseTimeCount++;
                        }
                        break;
                    case 'TIMEOUT':
                        report.summary.timeouts++;
                        break;
                    case 'LIFELINE_USED':
                        report.summary.lifelines_used.push(eventData.lifeline_type);
                        break;
                }
            }
            
            if (responseTimeCount > 0) {
                report.summary.average_response_time_ms = 
                    Math.round(report.summary.total_response_time_ms / responseTimeCount);
            }
            
            return report;
        } catch (error) {
            logger.error('Error generating session report:', error);
            throw error;
        }
    }

    // ============================================
    // CLEANUP & ARCHIVAL
    // ============================================

    /**
     * Start the automatic cleanup job (runs daily)
     */
    startAuditCleanup() {
        // Run cleanup every 24 hours
        setInterval(async () => {
            await this.cleanupOldAuditLogs();
        }, 24 * 60 * 60 * 1000); // 24 hours
        
        // Also run once at startup (delayed by 1 minute)
        setTimeout(async () => {
            await this.cleanupOldAuditLogs();
        }, 60 * 1000);
        
        logger.info('📝 Audit cleanup job scheduled (runs every 24 hours)');
    }

    /**
     * Delete audit logs older than 7 days
     * Optionally archive to external storage first
     */
    async cleanupOldAuditLogs(retentionDays = 7) {
        try {
            // First, get the logs that will be deleted (for potential archiving)
            const toDelete = await pool.query(`
                SELECT COUNT(*) as count
                FROM game_audit_logs
                WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
            `);
            
            const deleteCount = parseInt(toDelete.rows[0].count);
            
            if (deleteCount === 0) {
                logger.info('📝 Audit cleanup: No old logs to delete');
                return { deleted: 0 };
            }
            
            // Optional: Archive before deleting (implement archiveToStorage if needed)
            // await this.archiveToStorage(retentionDays);
            
            // Delete old logs
            const result = await pool.query(`
                DELETE FROM game_audit_logs
                WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
                RETURNING id
            `);
            
            logger.info(`📝 Audit cleanup: Deleted ${result.rowCount} logs older than ${retentionDays} days`);
            
            return { deleted: result.rowCount };
        } catch (error) {
            logger.error('Error cleaning up audit logs:', error);
            throw error;
        }
    }

    /**
     * Archive old audit logs to external storage (optional implementation)
     * This is a placeholder - implement based on your storage preference
     * Options: AWS S3, Cloudflare R2, Google Cloud Storage, etc.
     */
    async archiveToStorage(retentionDays = 7) {
        try {
            // Get logs to archive
            const logsToArchive = await pool.query(`
                SELECT * FROM game_audit_logs
                WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
                ORDER BY created_at ASC
            `);
            
            if (logsToArchive.rows.length === 0) {
                return { archived: 0 };
            }
            
            // Group by date for organized storage
            const archiveDate = new Date().toISOString().split('T')[0];
            const archiveData = {
                archived_at: new Date().toISOString(),
                retention_days: retentionDays,
                record_count: logsToArchive.rows.length,
                logs: logsToArchive.rows
            };
            
            // TODO: Implement actual storage upload
            // Example for AWS S3:
            // const s3 = new AWS.S3();
            // await s3.putObject({
            //     Bucket: process.env.AUDIT_ARCHIVE_BUCKET,
            //     Key: `audit-logs/${archiveDate}/audit-archive-${Date.now()}.json`,
            //     Body: JSON.stringify(archiveData),
            //     ContentType: 'application/json'
            // }).promise();
            
            logger.info(`📝 Audit archive: ${logsToArchive.rows.length} logs ready for archival`);
            
            return { archived: logsToArchive.rows.length, data: archiveData };
        } catch (error) {
            logger.error('Error archiving audit logs:', error);
            throw error;
        }
    }

    /**
     * Get audit statistics for admin dashboard
     */
    async getAuditStats() {
        try {
            const stats = await pool.query(`
                SELECT 
                    COUNT(*) as total_logs,
                    COUNT(DISTINCT session_id) as total_sessions,
                    COUNT(DISTINCT user_id) as unique_users,
                    MIN(created_at) as oldest_log,
                    MAX(created_at) as newest_log,
                    COUNT(*) FILTER (WHERE event_type = 'GAME_START') as games_started,
                    COUNT(*) FILTER (WHERE event_type = 'GAME_END') as games_ended,
                    COUNT(*) FILTER (WHERE event_type = 'ANSWER_GIVEN') as answers_logged,
                    COUNT(*) FILTER (WHERE event_type = 'TIMEOUT') as timeouts_logged
                FROM game_audit_logs
                WHERE created_at > NOW() - INTERVAL '7 days'
            `);
            
            return stats.rows[0];
        } catch (error) {
            logger.error('Error getting audit stats:', error);
            throw error;
        }
    }
}

module.exports = new AuditService();