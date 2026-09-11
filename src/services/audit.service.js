// ============================================================
// FILE: src/services/audit.service.js
// COMPLETE FILE - READY TO PASTE AND REPLACE
// CHANGES: Added logEvent() generic method, anti-cheat event
//          logging, photo verification logging, Q1 timeout logging,
//          perfect game flagging, session termination logging
// ============================================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');
const { AsyncLocalStorage } = require('async_hooks');

// ============================================
// WEB INPUT ATTRIBUTION
// ============================================
// Who sent this answer, from where, with how many streams open. A web answer
// travels route -> routeMessage -> processAnswer -> logAnswer, and threading a
// request through every signature in between would touch the shared chat
// router. AsyncLocalStorage carries it down the awaited chain instead: the
// route wraps the call, logAnswer reads it.
//
// THE TRAP, and the two guards against it. Node hands the store to anything
// scheduled inside the chain, timers included. An answer schedules the next
// question; the next question schedules its timeout. So a timer callback can
// run holding an OLD request's metadata. That is why:
//   * only answer events read it (ANSWER_GIVEN, CAPTCHA_PASSED/FAILED), which
//     are reached from an input and never from a timer;
//   * it is ignored unless it belongs to the same user AND is recent;
//   * the CALLER must ask for it ({ webInput: true }). Only Classic's answer
//     and CAPTCHA paths do. Challenge rounds call logAnswer too, and web-play's
//     /input also carries challenge chat commands, so without the opt-in a
//     challenge answer could pick up this field. Challenge mode is out of
//     scope for anti-cheat work: its audit rows stay exactly as they were.
// A missing field is honest. A wrong one would be evidence against someone.
const webInputStore = new AsyncLocalStorage();
const WEB_INPUT_MAX_AGE_MS = 30000;

class AuditService {
    constructor() {
        this.startAuditCleanup();
    }

    // What one web request looks like, for the audit trail.
    //
    // ip is the first X-Forwarded-For entry, read the same way web-auth.routes
    // reads it for sessions. That entry can be supplied by the client, so the
    // whole chain is kept beside it: a first hop that disagrees with the rest
    // is itself worth seeing.
    //
    // open_connections counts this user's SSE streams on THIS server process,
    // which is where the streams live. Two means two tabs or two devices
    // watching the same game.
    static describeWebRequest(req, userId) {
        const headers = (req && req.headers) || {};
        const chain = String(headers['x-forwarded-for'] || '');
        const ip = chain.split(',')[0].trim()
            || (req && req.socket && req.socket.remoteAddress)
            || null;

        let openConnections = null;
        try {
            const gameEvents = require('./game-events.service');
            const map = gameEvents.connections;
            // Keyed by whatever type subscribe() was given; a string id from one
            // path and a number from another must not read as zero streams.
            const set = map && (map.get(userId) || map.get(Number(userId)) || map.get(String(userId)));
            openConnections = set ? set.size : 0;
        } catch (e) { openConnections = null; }

        return {
            userId: String(userId),
            ip,
            ip_chain: chain ? chain.slice(0, 200) : null,
            user_agent: headers['user-agent'] ? String(headers['user-agent']).slice(0, 300) : null,
            open_connections: openConnections,
            receivedAt: Date.now()
        };
    }

    // Run fn with this request's metadata available to the answer loggers.
    // Returns whatever fn returns, so a promise chain is unchanged.
    runWithWebInput(req, userId, fn) {
        let meta = null;
        try { meta = AuditService.describeWebRequest(req, userId); } catch (e) { meta = null; }
        if (!meta) return fn();
        return webInputStore.run(meta, fn);
    }

    // The metadata for this user's current input, or null. See THE TRAP above.
    webInputFor(userId) {
        const meta = webInputStore.getStore();
        if (!meta) return null;
        if (meta.userId !== String(userId)) return null;
        if (Date.now() - meta.receivedAt > WEB_INPUT_MAX_AGE_MS) return null;
        return {
            ip: meta.ip,
            ip_chain: meta.ip_chain,
            user_agent: meta.user_agent,
            open_connections: meta.open_connections,
            received_at: new Date(meta.receivedAt).toISOString()
        };
    }

    // Seconds on the clock this question was actually served with.
    // Classic's getSessionTimeout returns timeoutSeconds; the challenge bypass
    // returns `seconds`; timeoutMs is on both.
    static clockSeconds(cfg, isTurboMode = false) {
        if (cfg) {
            if (Number.isFinite(cfg.timeoutSeconds)) return cfg.timeoutSeconds;
            if (Number.isFinite(cfg.seconds)) return cfg.seconds;
            if (Number.isFinite(cfg.timeoutMs)) return Math.round(cfg.timeoutMs / 1000);
        }
        return isTurboMode ? 10 : 12;
    }

    // Which rule set the clock, in getSessionTimeout's own priority order.
    static clockSource(cfg) {
        if (!cfg) return 'unrecorded';
        if (cfg.source === 'challenge' || cfg.source === 'challenge_fallback') return cfg.source;
        if (cfg.isTurboMode) return cfg.isWatchlist ? 'turbo_watchlist' : 'turbo';
        if (cfg.isWatchlist) return 'watchlist';
        if (cfg.isPenaltyMode) return 'penalty';
        if (cfg.isAdminOverride) return 'admin';
        return 'ladder';
    }

    // ============================================
    // GENERIC EVENT LOGGER
    // Used by anti-cheat system for all event types
    // ============================================

    async logEvent(sessionId, userId, eventType, eventData = {}) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, $3, $4, NOW())
            `, [sessionId, userId, eventType, JSON.stringify(eventData)]);
            
            logger.info(`📝 Audit: ${eventType} - Session ${sessionId}, User ${userId}`);
        } catch (error) {
            logger.error(`Error logging event ${eventType}:`, error);
        }
    }

    // ============================================
    // ANTI-CHEAT EVENT LOGGER
    // Writes to anti_cheat_events table
    // ============================================

    async logAntiCheatEvent(userId, sessionId, eventType, severity, details = {}) {
        try {
            await pool.query(`
                INSERT INTO anti_cheat_events 
                (user_id, session_id, event_type, severity, details, created_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
            `, [userId, sessionId, eventType, severity, JSON.stringify(details)]);

            logger.warn(`🔒 Anti-Cheat: ${eventType} [${severity}] - User ${userId}, Session ${sessionId}`);
        } catch (error) {
            logger.error(`Error logging anti-cheat event ${eventType}:`, error);
        }
    }

    // ============================================
    // GAME LIFECYCLE LOGGING
    // ============================================

    async logGameStart(sessionId, userId, gameMode, platform, tournamentId = null) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'GAME_START', $3, NOW())
            `, [
                sessionId, userId,
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
        }
    }

    // timeoutConfig is what getSessionTimeout resolved for this question.
    // Without it the log wrote `isTurboMode ? 10 : 12`, which was wrong for
    // every clock that mattered: clustering turbo serves 5s, the admin flat
    // clock 8s, watchlist and penalty their own. Review read "12s" for
    // questions served on 8s and "10s" for questions served on 5s.
    // Challenge rounds pass six arguments and get exactly the row they always
    // got: same timeout_seconds, no new fields.
    async logQuestionAsked(sessionId, userId, questionNumber, question, prizeAmount, isTurboMode = false, timeoutConfig = null) {
        try {
            const redis = require('../config/redis');
            const questionStartTime = Date.now();
            const isSafePoint = [5, 10].includes(questionNumber);
            
            await redis.setex(`audit_q_start:${sessionId}:${questionNumber}`, 60, questionStartTime.toString());
            
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'QUESTION_ASKED', $3, NOW())
            `, [
                sessionId, userId,
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
                    timeout_seconds: AuditService.clockSeconds(timeoutConfig, isTurboMode),
                    // Only when a clock was passed, which only Classic does.
                    // A challenge round's QUESTION_ASKED row is byte-for-byte
                    // what it was before this change.
                    ...(timeoutConfig ? {
                        timeout_ms: Number.isFinite(timeoutConfig.timeoutMs) ? timeoutConfig.timeoutMs : null,
                        clock_source: AuditService.clockSource(timeoutConfig),
                        turbo_type: timeoutConfig.turboType || null
                    } : {}),
                    times_seen_by_user: question.user_times_seen || 0,
                    is_safe_point: isSafePoint,
                    safe_point_note: isSafePoint ? `Q${questionNumber} is a safe checkpoint` : null
                })
            ]);
        } catch (error) {
            logger.error('Error logging question asked:', error);
        }
    }

    async logAnswer(sessionId, userId, questionNumber, userAnswer, correctAnswer, isCorrect, prizeWon, responseTimeMs = null, opts = {}) {
        try {
            const redis = require('../config/redis');

            // If responseTimeMs not provided, calculate from stored start time
            if (responseTimeMs === null) {
                const questionStartTime = await redis.get(`audit_q_start:${sessionId}:${questionNumber}`);
                responseTimeMs = questionStartTime ? Date.now() - parseInt(questionStartTime) : null;
            }
            
            await redis.del(`audit_q_start:${sessionId}:${questionNumber}`);

            const webInput = (opts && opts.webInput === true) ? this.webInputFor(userId) : null;
            
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'ANSWER_GIVEN', $3, NOW())
            `, [
                sessionId, userId,
                JSON.stringify({
                    ...(webInput ? { web_input: webInput } : {}),
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

    async logLifelineUsed(sessionId, userId, questionNumber, lifelineType, result) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'LIFELINE_USED', $3, NOW())
            `, [
                sessionId, userId,
                JSON.stringify({
                    question_number: questionNumber,
                    lifeline_type: lifelineType,
                    result: result
                })
            ]);
            
            logger.info(`📝 Audit: Lifeline ${lifelineType} used - Session ${sessionId}, Q${questionNumber}`);
        } catch (error) {
            logger.error('Error logging lifeline:', error);
        }
    }

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
                sessionId, userId,
                JSON.stringify({
                    question_number: questionNumber,
                    response_time_ms: responseTimeMs,
                    reason: 'Time limit exceeded'
                })
            ]);
            
            logger.info(`📝 Audit: Timeout - Session ${sessionId}, Q${questionNumber}`);
        } catch (error) {
            logger.error('Error logging timeout:', error);
        }
    }

    async logGameEnd(sessionId, userId, finalScore, questionsAnswered, outcome, guaranteedAmount = 0) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'GAME_END', $3, NOW())
            `, [
                sessionId, userId,
                JSON.stringify({
                    final_score: finalScore,
                    questions_answered: questionsAnswered,
                    outcome: outcome,
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
    // CAPTCHA AUDIT LOGGING
    // ============================================

    async logCaptchaShown(sessionId, userId, questionNumber, captchaType, captchaQuestion) {
        try {
            const redis = require('../config/redis');
            const captchaStartTime = Date.now();
            await redis.setex(`audit_captcha_start:${sessionId}:${questionNumber}`, 60, captchaStartTime.toString());
            
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'CAPTCHA_SHOWN', $3, NOW())
            `, [
                sessionId, userId,
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

    async logCaptchaResponse(sessionId, userId, questionNumber, captchaType, userAnswer, correctAnswer, isCorrect, responseTimeMs, opts = {}) {
        try {
            const redis = require('../config/redis');
            await redis.del(`audit_captcha_start:${sessionId}:${questionNumber}`);

            const webInput = (opts && opts.webInput === true) ? this.webInputFor(userId) : null;
            
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, $3, $4, NOW())
            `, [
                sessionId, userId,
                isCorrect ? 'CAPTCHA_PASSED' : 'CAPTCHA_FAILED',
                JSON.stringify({
                    ...(webInput ? { web_input: webInput } : {}),
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
                sessionId, userId,
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

    async logTurboModeActivated(sessionId, userId, questionNumber, suspiciousResponses, triggerType = 'last_second') {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'TURBO_MODE_ACTIVATED', $3, NOW())
            `, [
                sessionId, userId,
                JSON.stringify({
                    question_number: questionNumber,
                    trigger_type: triggerType,
                    suspicious_responses: suspiciousResponses,
                    activated_at: new Date().toISOString()
                })
            ]);

            // Also log to anti_cheat_events
            await this.logAntiCheatEvent(userId, sessionId, 'turbo_triggered', 'medium', {
                trigger_type: triggerType,
                question_number: questionNumber,
                suspicious_responses: suspiciousResponses
            });
            
            logger.info(`📝 Audit: ⚡ TURBO MODE ACTIVATED [${triggerType}] - Session ${sessionId}, Q${questionNumber}`);
        } catch (error) {
            logger.error('Error logging turbo mode activation:', error);
        }
    }

    async logTurboModeCompleted(sessionId, userId) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'TURBO_MODE_COMPLETED', $3, NOW())
            `, [
                sessionId, userId,
                JSON.stringify({
                    result: 'passed',
                    message: 'User completed turbo mode questions successfully',
                    completed_at: new Date().toISOString()
                })
            ]);
            
            logger.info(`📝 Audit: ⚡ TURBO MODE COMPLETED - Session ${sessionId}, User ${userId} passed`);
        } catch (error) {
            logger.error('Error logging turbo mode completion:', error);
        }
    }

    async logTurboModeQuestion(sessionId, userId, questionNumber, questionsRemaining) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'TURBO_MODE_QUESTION', $3, NOW())
            `, [
                sessionId, userId,
                JSON.stringify({
                    question_number: questionNumber,
                    turbo_questions_remaining: questionsRemaining,
                    timeout_seconds: 10
                })
            ]);
        } catch (error) {
            logger.error('Error logging turbo mode question:', error);
        }
    }

    async logTurboModeGoReceived(sessionId, userId) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'TURBO_MODE_GO_RECEIVED', $3, NOW())
            `, [
                sessionId, userId,
                JSON.stringify({
                    result: 'user_acknowledged',
                    received_at: new Date().toISOString()
                })
            ]);
        } catch (error) {
            logger.error('Error logging turbo mode GO received:', error);
        }
    }

    async logTurboModeTimeout(sessionId, userId) {
        try {
            await pool.query(`
                INSERT INTO game_audit_logs 
                (session_id, user_id, event_type, event_data, created_at)
                VALUES ($1, $2, 'TURBO_MODE_GO_TIMEOUT', $3, NOW())
            `, [
                sessionId, userId,
                JSON.stringify({
                    result: 'timeout',
                    message: 'User failed to type GO within 30 seconds',
                    timeout_at: new Date().toISOString()
                })
            ]);
        } catch (error) {
            logger.error('Error logging turbo mode timeout:', error);
        }
    }

    // ============================================
    // ANTI-CHEAT SPECIFIC LOGGING
    // ============================================

    async logSessionTerminated(sessionId, userId, reason, details = {}) {
        try {
            await this.logEvent(sessionId, userId, 'SESSION_TERMINATED', {
                reason,
                ...details,
                terminated_at: new Date().toISOString()
            });

            await this.logAntiCheatEvent(userId, sessionId, 'session_terminated', 'critical', {
                reason, ...details
            });
        } catch (error) {
            logger.error('Error logging session termination:', error);
        }
    }

    async logPerfectGameFlagged(sessionId, userId, details = {}) {
        try {
            await this.logEvent(sessionId, userId, 'PERFECT_GAME_FLAGGED', {
                message: 'Perfect 15/15 game flagged for review',
                ...details,
                flagged_at: new Date().toISOString()
            });

            await this.logAntiCheatEvent(userId, sessionId, 'perfect_game_flagged', 'high', details);
        } catch (error) {
            logger.error('Error logging perfect game flag:', error);
        }
    }

    async logPhotoVerificationRequested(sessionId, userId, questionNumber, challengeType) {
        try {
            await this.logEvent(sessionId, userId, 'PHOTO_VERIFICATION_REQUESTED', {
                question_number: questionNumber,
                challenge_type: challengeType,
                timeout_seconds: 20,
                requested_at: new Date().toISOString()
            });

            await this.logAntiCheatEvent(userId, sessionId, 'photo_requested', 'medium', {
                question_number: questionNumber,
                challenge_type: challengeType
            });
        } catch (error) {
            logger.error('Error logging photo verification request:', error);
        }
    }

    async logPhotoVerificationResult(sessionId, userId, passed, responseType, responseTimeMs) {
        try {
            const eventType = passed ? 'PHOTO_VERIFICATION_PASSED' : 'PHOTO_VERIFICATION_FAILED';
            await this.logEvent(sessionId, userId, eventType, {
                passed,
                response_type: responseType,
                response_time_ms: responseTimeMs,
                resolved_at: new Date().toISOString()
            });

            await this.logAntiCheatEvent(
                userId, sessionId,
                passed ? 'photo_passed' : 'photo_failed',
                passed ? 'low' : 'high',
                { response_type: responseType, response_time_ms: responseTimeMs }
            );
        } catch (error) {
            logger.error('Error logging photo verification result:', error);
        }
    }

    async logQ1TimeoutEvent(sessionId, userId, streak, action) {
        try {
            await this.logEvent(sessionId, userId, 'Q1_TIMEOUT_TRACKED', {
                streak_count: streak,
                action_taken: action,
                tracked_at: new Date().toISOString()
            });

            if (action === 'warning' || action === 'suspension') {
                await this.logAntiCheatEvent(
                    userId, sessionId,
                    action === 'suspension' ? 'q1_timeout_suspension' : 'q1_timeout_warning',
                    action === 'suspension' ? 'critical' : 'high',
                    { streak_count: streak }
                );
            }
        } catch (error) {
            logger.error('Error logging Q1 timeout event:', error);
        }
    }

    // ============================================
    // AUDIT LOG RETRIEVAL
    // ============================================

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

    async generateSessionReport(sessionId) {
        try {
            const auditTrail = await this.getSessionAuditTrail(sessionId);
            
            if (auditTrail.length === 0) return null;
            
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
                    average_response_time_ms: 0,
                    turbo_triggered: false,
                    photo_verification: false,
                    session_terminated: false
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
                    case 'TURBO_MODE_ACTIVATED':
                        report.summary.turbo_triggered = true;
                        break;
                    case 'PHOTO_VERIFICATION_REQUESTED':
                        report.summary.photo_verification = true;
                        break;
                    case 'SESSION_TERMINATED':
                        report.summary.session_terminated = true;
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

    startAuditCleanup() {
        setInterval(async () => {
            try {
                await this.cleanupOldAuditLogs();
            } catch (e) {
                logger.error('Audit cleanup interval error (non-fatal):', e.message);
            }
        }, 24 * 60 * 60 * 1000);
        
        setTimeout(async () => {
            try {
                await this.cleanupOldAuditLogs();
            } catch (e) {
                logger.error('Audit cleanup startup error (non-fatal):', e.message);
            }
        }, 60 * 1000);
        
        logger.info('📝 Audit cleanup job scheduled (runs every 24 hours)');
    }

    async cleanupOldAuditLogs(retentionDays = 7) {
        try {
            // Delete in small batches to avoid connection timeouts
            const BATCH_SIZE = 500;
            let totalDeleted = 0;
            let batchDeleted = 0;

            do {
                const result = await pool.query(`
                    DELETE FROM game_audit_logs
                    WHERE id IN (
                        SELECT id FROM game_audit_logs
                        WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
                        LIMIT ${BATCH_SIZE}
                    )
                `);
                
                batchDeleted = result.rowCount;
                totalDeleted += batchDeleted;
                
                // Small pause between batches to not hog the connection
                if (batchDeleted === BATCH_SIZE) {
                    await new Promise(r => setTimeout(r, 500));
                }
            } while (batchDeleted === BATCH_SIZE);

            if (totalDeleted > 0) {
                logger.info(`📝 Audit cleanup: Deleted ${totalDeleted} logs older than ${retentionDays} days`);
            } else {
                logger.info('📝 Audit cleanup: No old logs to delete');
            }
            return { deleted: totalDeleted };
        } catch (error) {
            logger.error('Error cleaning up audit logs:', error.message);
            // Don't throw - this is a background job, never crash the server
            return { deleted: 0, error: error.message };
        }
    }

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
                    COUNT(*) FILTER (WHERE event_type = 'TIMEOUT') as timeouts_logged,
                    COUNT(*) FILTER (WHERE event_type = 'TURBO_MODE_ACTIVATED') as turbo_activations,
                    COUNT(*) FILTER (WHERE event_type = 'SESSION_TERMINATED') as sessions_terminated,
                    COUNT(*) FILTER (WHERE event_type = 'PERFECT_GAME_FLAGGED') as perfect_games_flagged,
                    COUNT(*) FILTER (WHERE event_type = 'PHOTO_VERIFICATION_REQUESTED') as photo_verifications
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