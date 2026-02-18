// ============================================================
// FILE: src/services/game.service.js
// COMPLETE FILE - READY TO PASTE AND REPLACE
// CHANGES:
// 1. Multi-trigger turbo mode (last-second + clustering + consistency)
// 2. Progressive difficulty timers (Q1-5: 12s, Q6-10: 11s, Q11-15: 10s)
// 3. Perfect session auto-termination (perfect Q10 + no lifelines + tight CV)
// 4. Perfect game flagging (15/15 → payout under_review)
// 5. Photo verification challenges (Q13-15, 20s timeout)
// 6. Sanitized turbo messages (no timing hints)
// 7. Q1 timeout integration (calls restrictions.trackQ1Timeout)
// 8. Penalty game timer support (10s timers for flagged users)
// 9. Turbo always flags sessions suspicious
// ============================================================

const pool = require('../config/database');
const redis = require('../config/redis');
const MessagingService = require('./messaging.service');
const QuestionService = require('./question.service');
const PaymentService = require('./payment.service');
const auditService = require('./audit.service');
const streakService = require('./streak.service');
const restrictionsService = require('./restrictions.service');
const antiFraudService = require('./anti-fraud.service');
const achievementsService = require('./achievements.service');
const victoryCardsService = require('./victory-cards.service');
const captchaService = require('./captcha.service');
const deviceTrackingService = require('./device-tracking.service');
const kycService = require('./kyc.service');
const behavioralAnalysisService = require('./behavioral-analysis.service');
const { logger } = require('../utils/logger');

// ============================================
// BASE CONFIGURATION
// ============================================
const QUESTION_TIMEOUT_MS = 12000;
const QUESTION_TIMEOUT_SECONDS = 12;
const REDIS_TIMEOUT_BUFFER = 15;

// ============================================
// MULTI-TRIGGER TURBO MODE CONFIGURATION
// ============================================
const TURBO_MODE_CONFIG = {
    // --- Trigger 1: LAST-SECOND answers ---
    LAST_SECOND: {
        THRESHOLD_MS: 10500,            // Answers >= 10.5s (near timeout)
        CONSECUTIVE_TRIGGER: 3,         // 3 consecutive last-second answers
        REDUCED_TIMEOUT_MS: 8000,       // Drop to 8 seconds
        REDUCED_TIMEOUT_SECONDS: 8,
        TURBO_QUESTIONS: 3,
    },
    // --- Trigger 2: RESPONSE CLUSTERING ---
    CLUSTERING: {
        MIN_SAMPLES: 4,                 // Need 4+ answers to detect
        MAX_RANGE_MS: 2000,             // All answers within 2s window
        OFFSET_BELOW_MIN_MS: 1000,      // Timer = fastest - 1s
        MINIMUM_TIMEOUT_MS: 5000,       // Floor: 5 seconds
        MINIMUM_TIMEOUT_SECONDS: 5,
        TURBO_QUESTIONS: 3,
    },
    // --- Trigger 3: CONSISTENCY (low std deviation) ---
    CONSISTENCY: {
        MIN_SAMPLES: 5,                 // Need 5+ answers
        MAX_STD_DEV_MS: 800,            // Std dev < 800ms is bot-like
        MAX_CV: 0.10,                   // CV < 10%
        REDUCED_TIMEOUT_MS: 7000,       // Drop to 7 seconds
        REDUCED_TIMEOUT_SECONDS: 7,
        TURBO_QUESTIONS: 3,
    },
    GO_TIMEOUT_SECONDS: 30,
};

// ============================================
// PROGRESSIVE DIFFICULTY TIMERS
// ============================================
const DIFFICULTY_TIMERS = {
    getBaseTimeout(questionNumber) {
        if (questionNumber <= 5) return { ms: 12000, seconds: 12 };
        if (questionNumber <= 10) return { ms: 11000, seconds: 11 };
        return { ms: 10000, seconds: 10 };
    }
};

// ============================================
// SUSPICIOUS SESSION CONFIG
// ============================================
const SUSPICIOUS_SESSION_CONFIG = {
    PERFECT_THROUGH_Q: 10,
    MAX_CV: 0.12,
};

// ============================================
// PHOTO VERIFICATION CONFIG
// ============================================
const PHOTO_VERIFICATION_CONFIG = {
    TRIGGER_QUESTIONS: [13, 14, 15],    // Check at Q13-15
    TIMEOUT_MS: 20000,                  // 20-second window
    TIMEOUT_SECONDS: 20,
};

const messagingService = new MessagingService();
const questionService = new QuestionService();
const paymentService = new PaymentService();

const PRIZE_LADDER = {
    1: 200, 2: 250, 3: 300, 4: 500, 5: 1000,
    6: 2000, 7: 3000, 8: 5000, 9: 8000, 10: 10000,
    11: 20000, 12: 25000, 13: 30000, 14: 40000, 15: 50000,
};

const SAFE_CHECKPOINTS = [5, 10];
const activeTimeouts = new Map();

class GameService {
    constructor() {
        this.startZombieCleanup();
        this.startTimeoutCleanup();
    }

    // ============================================
    // CLEANUP & MAINTENANCE
    // ============================================
    
    startZombieCleanup() {
        setInterval(async () => {
            try {
                const result = await pool.query(`
                    UPDATE game_sessions
                    SET status = 'cancelled', completed_at = NOW()
                    WHERE status = 'active'
                    AND started_at < NOW() - INTERVAL '1 hour'
                    RETURNING id, user_id, session_key
                `);
                
                if (result.rows.length > 0) {
                    logger.info(`🧹 Auto-cleanup: Cancelled ${result.rows.length} zombie sessions`);
                    for (const session of result.rows) {
                        await redis.del(`game_ready:${session.user_id}`);
                        await redis.del(`session:${session.session_key}`);
                        await redis.del(`asked_questions:${session.session_key}`);
                        const sessionPrefix = `timeout:${session.session_key}:`;
                        for (const [key, timeoutId] of activeTimeouts.entries()) {
                            if (key.startsWith(sessionPrefix)) {
                                clearTimeout(timeoutId);
                                activeTimeouts.delete(key);
                            }
                        }
                    }
                }
            } catch (error) {
                logger.error('Error in zombie cleanup:', error);
            }
        }, 600000);
    }

    startTimeoutCleanup() {
        setInterval(async () => {
            try {
                const now = Date.now();
                let cleaned = 0;
                for (const [key, timeoutId] of activeTimeouts.entries()) {
                    const timeoutValue = await redis.get(key);
                    if (!timeoutValue || parseInt(timeoutValue) < now) {
                        clearTimeout(timeoutId);
                        activeTimeouts.delete(key);
                        cleaned++;
                    }
                }
                if (cleaned > 0) {
                    logger.info(`🧹 Timeout cleanup: Removed ${cleaned} stale timeouts. Active: ${activeTimeouts.size}`);
                }
            } catch (error) {
                logger.error('Error in timeout cleanup:', error);
            }
        }, 300000);
    }

    // ============================================
    // MULTI-TRIGGER TURBO MODE METHODS
    // ============================================

    /** Check if answer is last-second (>= 10.5s) */
    isSuspiciousLastSecond(responseTimeMs) {
        return responseTimeMs >= TURBO_MODE_CONFIG.LAST_SECOND.THRESHOLD_MS;
    }

    /** Detect response time clustering */
    detectClustering(responseTimes) {
        if (responseTimes.length < TURBO_MODE_CONFIG.CLUSTERING.MIN_SAMPLES) {
            return { detected: false };
        }
        const recent = responseTimes.slice(-TURBO_MODE_CONFIG.CLUSTERING.MIN_SAMPLES);
        const min = Math.min(...recent);
        const max = Math.max(...recent);
        const range = max - min;

        if (range <= TURBO_MODE_CONFIG.CLUSTERING.MAX_RANGE_MS) {
            // Calculate dynamic timeout: fastest answer - offset
            let dynamicTimeout = min - TURBO_MODE_CONFIG.CLUSTERING.OFFSET_BELOW_MIN_MS;
            dynamicTimeout = Math.max(dynamicTimeout, TURBO_MODE_CONFIG.CLUSTERING.MINIMUM_TIMEOUT_MS);
            return {
                detected: true,
                dynamicTimeoutMs: dynamicTimeout,
                dynamicTimeoutSeconds: Math.ceil(dynamicTimeout / 1000),
                range, min, max
            };
        }
        return { detected: false };
    }

    /** Detect consistency (low std dev / CV) */
    detectConsistency(responseTimes) {
        if (responseTimes.length < TURBO_MODE_CONFIG.CONSISTENCY.MIN_SAMPLES) {
            return { detected: false };
        }
        const recent = responseTimes.slice(-TURBO_MODE_CONFIG.CONSISTENCY.MIN_SAMPLES);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((sum, t) => sum + Math.pow(t - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(variance);
        const cv = stdDev / mean;

        if (stdDev < TURBO_MODE_CONFIG.CONSISTENCY.MAX_STD_DEV_MS && 
            cv < TURBO_MODE_CONFIG.CONSISTENCY.MAX_CV) {
            return { detected: true, stdDev, cv, mean };
        }
        return { detected: false, stdDev, cv };
    }

    /** Track response time and check all turbo triggers */
    async trackAndCheckTurboTriggers(session, user, responseTimeMs) {
        const trackingKey = `turbo_track:${session.session_key}`;
        
        try {
            let tracking = await redis.get(trackingKey);
            tracking = tracking ? JSON.parse(tracking) : {
                consecutiveLastSecond: 0,
                allResponseTimes: [],
                turboModeActive: false,
                turboQuestionsRemaining: 0,
                turboType: null,
                turboTimeoutMs: null,
                turboTimeoutSeconds: null,
            };

            // If turbo mode already active, don't re-trigger
            if (tracking.turboModeActive) {
                await redis.setex(trackingKey, 3600, JSON.stringify(tracking));
                return { activated: false, tracking };
            }

            // Track this response time
            tracking.allResponseTimes.push(responseTimeMs);

            // --- Trigger 1: Last-second detection ---
            if (this.isSuspiciousLastSecond(responseTimeMs)) {
                tracking.consecutiveLastSecond++;
                logger.warn(`⚠️ Last-second: Session ${session.session_key}, Q${session.current_question}, ${responseTimeMs}ms (${tracking.consecutiveLastSecond} consecutive)`);
            } else {
                tracking.consecutiveLastSecond = 0;
            }

            let triggerType = null;
            let turboTimeoutMs = null;
            let turboTimeoutSeconds = null;
            let turboQuestions = 3;
            let triggerDetails = {};

            // Check Trigger 1: Last-second
            if (tracking.consecutiveLastSecond >= TURBO_MODE_CONFIG.LAST_SECOND.CONSECUTIVE_TRIGGER) {
                triggerType = 'last_second';
                turboTimeoutMs = TURBO_MODE_CONFIG.LAST_SECOND.REDUCED_TIMEOUT_MS;
                turboTimeoutSeconds = TURBO_MODE_CONFIG.LAST_SECOND.REDUCED_TIMEOUT_SECONDS;
                turboQuestions = TURBO_MODE_CONFIG.LAST_SECOND.TURBO_QUESTIONS;
                triggerDetails = { consecutiveCount: tracking.consecutiveLastSecond };
            }

            // Check Trigger 2: Clustering
            if (!triggerType) {
                const clustering = this.detectClustering(tracking.allResponseTimes);
                if (clustering.detected) {
                    triggerType = 'clustering';
                    turboTimeoutMs = clustering.dynamicTimeoutMs;
                    turboTimeoutSeconds = clustering.dynamicTimeoutSeconds;
                    turboQuestions = TURBO_MODE_CONFIG.CLUSTERING.TURBO_QUESTIONS;
                    triggerDetails = { range: clustering.range, min: clustering.min, max: clustering.max, dynamicTimeout: clustering.dynamicTimeoutMs };
                }
            }

            // Check Trigger 3: Consistency
            if (!triggerType) {
                const consistency = this.detectConsistency(tracking.allResponseTimes);
                if (consistency.detected) {
                    triggerType = 'consistency';
                    turboTimeoutMs = TURBO_MODE_CONFIG.CONSISTENCY.REDUCED_TIMEOUT_MS;
                    turboTimeoutSeconds = TURBO_MODE_CONFIG.CONSISTENCY.REDUCED_TIMEOUT_SECONDS;
                    turboQuestions = TURBO_MODE_CONFIG.CONSISTENCY.TURBO_QUESTIONS;
                    triggerDetails = { stdDev: consistency.stdDev, cv: consistency.cv, mean: consistency.mean };
                }
            }

            // Activate turbo mode if any trigger fired
            if (triggerType) {
                tracking.turboModeActive = true;
                tracking.turboQuestionsRemaining = turboQuestions;
                tracking.turboType = triggerType;
                tracking.turboTimeoutMs = turboTimeoutMs;
                tracking.turboTimeoutSeconds = turboTimeoutSeconds;
                tracking.activatedAt = Date.now();
                tracking.activatedAtQuestion = session.current_question;
                tracking.waitingForGo = true;

                await redis.setex(trackingKey, 3600, JSON.stringify(tracking));

                // Set GO wait state
                const turboGoKey = `turbo_go_wait:${session.session_key}`;
                await redis.setex(turboGoKey, 35, JSON.stringify({
                    sessionId: session.id,
                    userId: user.id,
                    activatedAt: Date.now(),
                    expiresAt: Date.now() + 30000
                }));

                // Flag session as suspicious
                await pool.query(`
                    UPDATE game_sessions 
                    SET suspicious_flag = true, turbo_triggered = true,
                        turbo_type = $1, suspicious_type = $2,
                        suspicious_details = $3
                    WHERE id = $4
                `, [triggerType, `turbo_${triggerType}`, JSON.stringify(triggerDetails), session.id]);

                // Flag user
                await restrictionsService.flagUserSuspicious(user.id, `turbo_${triggerType}`, triggerDetails);

                // Audit log
                await auditService.logTurboModeActivated(
                    session.id, user.id,
                    session.current_question - 1,
                    tracking.allResponseTimes.slice(-5),
                    triggerType
                );

                logger.warn(`⚡ TURBO MODE [${triggerType}]: User ${user.id}, Session ${session.id}, timeout=${turboTimeoutMs}ms`);

                // Send sanitized warning
                await this.sendTurboModeWarning(user);
                this.setTurboGoTimeout(session, user);

                return { activated: true, tracking, triggerType };
            }

            await redis.setex(trackingKey, 3600, JSON.stringify(tracking));
            return { activated: false, tracking };
        } catch (error) {
            logger.error('Error in turbo trigger check:', error);
            return { activated: false, tracking: null };
        }
    }

    /** Set timeout for GO response (30 seconds) */
    setTurboGoTimeout(session, user) {
        const turboGoKey = `turbo_go_wait:${session.session_key}`;
        const timeoutKey = `turbo_go_timeout:${session.session_key}`;
        
        const timeoutId = setTimeout(async () => {
            try {
                const goWait = await redis.get(turboGoKey);
                if (goWait) {
                    logger.warn(`⚡ TURBO MODE: User ${user.id} failed to type GO in 30 seconds`);
                    await redis.del(turboGoKey);
                    await auditService.logTurboModeTimeout(session.id, user.id);
                    await this.handleTurboGoTimeout(session, user);
                }
            } catch (error) {
                logger.error('Error in turbo GO timeout:', error);
            }
        }, 30000);
        
        activeTimeouts.set(timeoutKey, timeoutId);
    }

    /** Handle when user doesn't type GO in time */
    async handleTurboGoTimeout(session, user) {
        const currentSession = await this.getActiveSession(user.id);
        if (!currentSession || currentSession.id !== session.id) return;
        
        const questionNumber = currentSession.current_question - 1;
        let guaranteedAmount = 0;
        for (const checkpoint of [...SAFE_CHECKPOINTS].reverse()) {
            if (questionNumber >= checkpoint) {
                guaranteedAmount = PRIZE_LADDER[checkpoint];
                break;
            }
        }
        
        currentSession.current_score = guaranteedAmount;
        
        const message = `⏰ TIME'S UP!\n\n` +
            `You didn't type GO within 30 seconds.\n\n` +
            `🎮 GAME OVER 🎮\n\n` +
            (guaranteedAmount > 0 
                ? `You reached a safe checkpoint!\n💰 You won: ₦${guaranteedAmount.toLocaleString()} 🎉\n\n`
                : `💰 You won: ₦0\n\n`) +
            `Better luck next time! 👋\n\n` +
            `1️⃣ Play Again\n2️⃣ View Leaderboard\n` +
            (guaranteedAmount > 0 ? `3️⃣ Claim Prize\n4️⃣ Share Victory Card\n\n💡 _Tip: Type CLAIM anytime to claim your prize_` : `3️⃣ Main Menu\n`);
        
        await messagingService.sendMessage(user.phone_number, message);
        await this.completeGame(currentSession, user, false, 'turbo_go_timeout');
    }

    /** Handle GO input from user during turbo mode wait */
    async handleTurboGoInput(session, user) {
        const turboGoKey = `turbo_go_wait:${session.session_key}`;
        const timeoutKey = `turbo_go_timeout:${session.session_key}`;
        
        try {
            const goWait = await redis.get(turboGoKey);
            if (!goWait) return false;
            
            await redis.del(turboGoKey);
            this.clearQuestionTimeout(timeoutKey);
            
            logger.info(`⚡ TURBO MODE: User ${user.id} typed GO - continuing with turbo questions`);
            await auditService.logTurboModeGoReceived(session.id, user.id);
            
            await messagingService.sendMessage(
                user.phone_number,
                `✅ Let's GO! ⚡\n\nGet ready... here comes your first turbo question!`
            );
            
            setTimeout(async () => {
                const activeSession = await this.getActiveSession(user.id);
                if (activeSession && activeSession.id === session.id) {
                    await this.sendQuestionOrCaptcha(activeSession, user);
                }
            }, 2000);
            
            return true;
        } catch (error) {
            logger.error('Error handling turbo GO input:', error);
            return false;
        }
    }

    /** Check if session is waiting for GO input */
    async isWaitingForTurboGo(sessionKey) {
        const turboGoKey = `turbo_go_wait:${sessionKey}`;
        const goWait = await redis.get(turboGoKey);
        return goWait !== null;
    }

    /** Send sanitized turbo mode warning (no timing hints) */
    async sendTurboModeWarning(user) {
        const messages = [
            `⚡ *VERIFICATION REQUIRED* ⚡\n\nHold on! 🛑\n\nOur system has flagged unusual activity in your game session.\n\nThe next few questions will have *shorter timers* to verify fair play. ⏱️\n\nThis is to ensure a fair experience for all players. 🎯\n\nType *GO* when you're ready to continue.\n⏱️ You have 30 seconds...`,
            `⚡ *SPEED CHECK* ⚡\n\nJust a moment! 🛑\n\nWe need to verify your gameplay before continuing.\n\nThe next few questions will test your reflexes with *shorter timers*. ⏱️\n\nFair play matters! 💪\n\nType *GO* to continue.\n⏱️ You have 30 seconds...`,
            `⚡ *FAIR PLAY CHECK* ⚡\n\nHang tight! 🛑\n\nOur system requires a quick verification to continue.\n\nNext questions will have *tighter time limits*. ⚡\n\nGood luck! 🍀\n\nType *GO* when ready.\n⏱️ You have 30 seconds...`,
        ];

        const message = messages[Math.floor(Math.random() * messages.length)];
        await messagingService.sendMessage(user.phone_number, message);
    }

    /** Get current timeout for session (turbo > penalty > progressive > base) */
    async getSessionTimeout(sessionKey, questionNumber = null, userId = null) {
        const trackingKey = `turbo_track:${sessionKey}`;
        
        try {
            // Priority 1: Active turbo mode
            const tracking = await redis.get(trackingKey);
            if (tracking) {
                const data = JSON.parse(tracking);
                if (data.turboModeActive && data.turboQuestionsRemaining > 0) {
                    return {
                        timeoutMs: data.turboTimeoutMs || TURBO_MODE_CONFIG.LAST_SECOND.REDUCED_TIMEOUT_MS,
                        timeoutSeconds: data.turboTimeoutSeconds || TURBO_MODE_CONFIG.LAST_SECOND.REDUCED_TIMEOUT_SECONDS,
                        isTurboMode: true,
                        turboType: data.turboType || 'last_second',
                        questionsRemaining: data.turboQuestionsRemaining,
                    };
                }
            }
        } catch (error) {
            logger.error('Error getting session timeout:', error);
        }

        // Priority 2: Penalty mode (10s timers)
        if (userId) {
            try {
                const penalty = await restrictionsService.isUserInPenaltyMode(userId);
                if (penalty.inPenalty) {
                    const penaltyMs = penalty.timerSeconds * 1000;
                    return {
                        timeoutMs: penaltyMs,
                        timeoutSeconds: penalty.timerSeconds,
                        isTurboMode: false,
                        isPenaltyMode: true,
                        penaltyGamesRemaining: penalty.gamesRemaining,
                        questionsRemaining: 0,
                    };
                }
            } catch (error) {
                logger.error('Error checking penalty mode:', error);
            }
        }

        // Priority 3: Progressive difficulty timer
        if (questionNumber) {
            const base = DIFFICULTY_TIMERS.getBaseTimeout(questionNumber);
            return {
                timeoutMs: base.ms,
                timeoutSeconds: base.seconds,
                isTurboMode: false,
                questionsRemaining: 0,
            };
        }
        
        return {
            timeoutMs: QUESTION_TIMEOUT_MS,
            timeoutSeconds: QUESTION_TIMEOUT_SECONDS,
            isTurboMode: false,
            questionsRemaining: 0,
        };
    }

    /** Decrement turbo mode questions remaining */
    async decrementTurboQuestions(sessionKey, userId, sessionId) {
        const trackingKey = `turbo_track:${sessionKey}`;
        
        try {
            const tracking = await redis.get(trackingKey);
            if (tracking) {
                const data = JSON.parse(tracking);
                if (data.turboModeActive && data.turboQuestionsRemaining > 0) {
                    data.turboQuestionsRemaining--;
                    
                    if (data.turboQuestionsRemaining === 0) {
                        data.turboModeActive = false;
                        data.completedAt = Date.now();
                        await auditService.logTurboModeCompleted(sessionId, userId);
                        logger.info(`⚡ Turbo mode completed: User ${userId}, Session ${sessionId}`);
                    }
                    
                    await redis.setex(trackingKey, 3600, JSON.stringify(data));
                    return data;
                }
            }
        } catch (error) {
            logger.error('Error decrementing turbo questions:', error);
        }
        return null;
    }

    // ============================================
    // SUSPICIOUS PERFECT SESSION DETECTION
    // ============================================

    async checkSuspiciousPerfectSession(session, user, questionNumber, responseTimeMs) {
        if (questionNumber < SUSPICIOUS_SESSION_CONFIG.PERFECT_THROUGH_Q) return { terminate: false };

        const expectedPerfectScore = PRIZE_LADDER[questionNumber];
        if (session.current_score !== expectedPerfectScore) return { terminate: false };
        if (session.lifeline_5050_used || session.lifeline_skip_used) return { terminate: false };

        const trackingKey = `turbo_track:${session.session_key}`;
        try {
            const raw = await redis.get(trackingKey);
            const tracking = raw ? JSON.parse(raw) : null;

            if (!tracking || tracking.allResponseTimes.length < 8) return { terminate: false };

            const times = tracking.allResponseTimes;
            const mean = times.reduce((a, b) => a + b, 0) / times.length;
            const variance = times.reduce((sum, t) => sum + Math.pow(t - mean, 2), 0) / times.length;
            const stdDev = Math.sqrt(variance);
            const cv = stdDev / mean;

            if (cv < SUSPICIOUS_SESSION_CONFIG.MAX_CV) {
                logger.warn(`🚨 SUSPICIOUS PERFECT SESSION: User ${user.id}, CV=${cv.toFixed(4)}, mean=${mean.toFixed(0)}ms`);

                // Flag and terminate
                await pool.query(`
                    UPDATE game_sessions 
                    SET suspicious_flag = true, auto_terminated = true,
                        termination_reason = 'suspicious_perfect_session',
                        suspicious_type = 'perfect_session_cv',
                        suspicious_details = $1
                    WHERE id = $2
                `, [JSON.stringify({ cv, stdDev, mean, times_count: times.length }), session.id]);

                await auditService.logSessionTerminated(session.id, user.id, 'suspicious_perfect_session', {
                    cv, stdDev, mean, score: session.current_score, question: questionNumber
                });

                await restrictionsService.flagUserSuspicious(user.id, 'perfect_session_terminated', { cv, mean });

                return { terminate: true, cv, stdDev, mean };
            }
        } catch (error) {
            logger.error('Error checking suspicious perfect session:', error);
        }

        return { terminate: false };
    }

    /** Handle terminated suspicious session */
    async handleSuspiciousTermination(session, user) {
        // Void all winnings - set score to 0
        session.current_score = 0;

        const message = `🚫 *GAME SESSION ENDED* 🚫\n\n` +
            `Our system has detected unusual gameplay patterns in this session.\n\n` +
            `Your game has been ended and all winnings from this session have been voided.\n\n` +
            `💰 Final Score: ₦0\n\n` +
            `If you believe this is an error, please contact support.\n\n` +
            `1️⃣ Play Again\n2️⃣ Main Menu`;

        await messagingService.sendMessage(user.phone_number, message);

        // Void any pending transactions from this session
        await pool.query(`
            UPDATE transactions 
            SET payment_status = 'voided', payout_hold = true,
                hold_reason = 'auto_terminated_suspicious_session'
            WHERE session_id = $1 AND payment_status = 'pending'
        `, [session.id]);

        await this.completeGame(session, user, false, 'auto_terminated');
    }

    // ============================================
    // PHOTO VERIFICATION
    // ============================================

    async shouldRequestPhotoVerification(session, user, questionNumber) {
        if (!PHOTO_VERIFICATION_CONFIG.TRIGGER_QUESTIONS.includes(questionNumber)) return false;
        if (session.game_type === 'practice') return false;
        if (session.photo_verification_requested) return false;

        // Only for suspicious sessions
        const isSuspicious = session.suspicious_flag === true;
        const userSuspicious = await restrictionsService.isUserSuspicious(user.id);

        return isSuspicious || userSuspicious.suspicious;
    }

    async sendPhotoVerification(session, user, questionNumber) {
        const challenges = [
            { type: 'selfie', text: '📸 Take a quick selfie to verify you\'re playing!' },
            { type: 'fingers', text: '✌️ Send a photo showing 3 fingers to continue!' },
            { type: 'camera_snap', text: '📷 Take a photo of anything around you right now!' },
        ];

        const challenge = challenges[Math.floor(Math.random() * challenges.length)];

        // Store verification state
        const photoKey = `photo_verify:${session.session_key}`;
        await redis.setex(photoKey, 25, JSON.stringify({
            challengeType: challenge.type,
            questionNumber,
            startTime: Date.now(),
            sessionId: session.id,
            userId: user.id
        }));

        // Update session
        await pool.query(`
            UPDATE game_sessions 
            SET photo_verification_requested = true, photo_verification_at = NOW()
            WHERE id = $1
        `, [session.id]);

        // Log
        await auditService.logPhotoVerificationRequested(session.id, user.id, questionNumber, challenge.type);

        // Log to photo_verifications table
        await pool.query(`
            INSERT INTO photo_verifications 
            (user_id, session_id, question_number, challenge_type, challenge_text)
            VALUES ($1, $2, $3, $4, $5)
        `, [user.id, session.id, questionNumber, challenge.type, challenge.text]);

        const message = `📸 *PHOTO VERIFICATION* 📸\n\n` +
            `${challenge.text}\n\n` +
            `⏱️ You have *${PHOTO_VERIFICATION_CONFIG.TIMEOUT_SECONDS} seconds* to send a photo.\n\n` +
            `_This helps us maintain fair play for all players._`;

        await messagingService.sendMessage(user.phone_number, message);

        // Set timeout
        const timeoutKey = `photo_timeout:${session.session_key}`;
        const timeoutId = setTimeout(async () => {
            try {
                const photoData = await redis.get(photoKey);
                if (photoData) {
                    await redis.del(photoKey);
                    await this.handlePhotoVerificationFailure(session, user, 'timeout');
                }
            } catch (error) {
                logger.error('Error in photo verification timeout:', error);
            }
        }, PHOTO_VERIFICATION_CONFIG.TIMEOUT_MS);

        activeTimeouts.set(timeoutKey, timeoutId);
    }

    /** Check if waiting for photo verification */
    async hasPendingPhotoVerification(sessionKey) {
        const photoKey = `photo_verify:${sessionKey}`;
        const data = await redis.get(photoKey);
        return !!data;
    }

    /** Handle received photo (called from webhook when image message received) */
    async processPhotoVerification(session, user) {
        const photoKey = `photo_verify:${session.session_key}`;
        const timeoutKey = `photo_timeout:${session.session_key}`;

        try {
            const photoData = await redis.get(photoKey);
            if (!photoData) return false;

            const data = JSON.parse(photoData);
            const responseTimeMs = Date.now() - data.startTime;

            // Clear the verification state
            await redis.del(photoKey);
            this.clearQuestionTimeout(timeoutKey);

            // Update session
            await pool.query(`
                UPDATE game_sessions SET photo_verification_passed = true WHERE id = $1
            `, [session.id]);

            // Log success
            await auditService.logPhotoVerificationResult(session.id, user.id, true, 'image', responseTimeMs);

            // Update photo_verifications record
            await pool.query(`
                UPDATE photo_verifications 
                SET responded_at = NOW(), response_type = 'image', passed = true, response_time_ms = $1
                WHERE session_id = $2 AND user_id = $3 AND passed IS NULL
            `, [responseTimeMs, session.id, user.id]);

            await messagingService.sendMessage(user.phone_number, `✅ *Verified!* Thank you.\n\nLet's continue your game... 🎮`);

            // Continue the game
            setTimeout(async () => {
                const activeSession = await this.getActiveSession(user.id);
                if (activeSession && activeSession.id === session.id) {
                    await this.sendQuestionOrCaptcha(activeSession, user);
                }
            }, 1500);

            return true;
        } catch (error) {
            logger.error('Error processing photo verification:', error);
            return false;
        }
    }

    /** Handle photo verification failure */
    async handlePhotoVerificationFailure(session, user, reason) {
        await pool.query(`
            UPDATE game_sessions SET photo_verification_passed = false WHERE id = $1
        `, [session.id]);

        await auditService.logPhotoVerificationResult(session.id, user.id, false, reason, null);

        await pool.query(`
            UPDATE photo_verifications 
            SET responded_at = NOW(), response_type = $1, passed = false, failure_reason = $2
            WHERE session_id = $3 AND user_id = $4 AND passed IS NULL
        `, [reason, reason === 'timeout' ? 'Did not send photo within 20 seconds' : reason, session.id, user.id]);

        const guaranteedAmount = this.getGuaranteedAmount(session.current_question);
        session.current_score = guaranteedAmount;

        const message = reason === 'timeout'
            ? `⏱️ *VERIFICATION TIMEOUT*\n\nYou didn't send a photo in time.\n\n🎮 GAME OVER\n\n💰 Final Score: ₦${guaranteedAmount.toLocaleString()}`
            : `❌ *VERIFICATION FAILED*\n\n🎮 GAME OVER\n\n💰 Final Score: ₦${guaranteedAmount.toLocaleString()}`;

        await messagingService.sendMessage(user.phone_number, message);
        await this.completeGame(session, user, false, 'photo_verification_failed');
    }

    // ============================================
    // PERFECT GAME FLAGGING
    // ============================================

    async flagPerfectGame(session, user) {
        try {
            // Put payout on hold
            await pool.query(`
                UPDATE transactions 
                SET payout_hold = true, hold_reason = 'perfect_game_review',
                    payment_status = 'under_review'
                WHERE session_id = $1 AND transaction_type = 'prize'
            `, [session.id]);

            // Flag session
            await pool.query(`
                UPDATE game_sessions 
                SET suspicious_flag = true, suspicious_type = 'perfect_game'
                WHERE id = $1
            `, [session.id]);

            await auditService.logPerfectGameFlagged(session.id, user.id, {
                score: 50000, questions: 15
            });

            logger.warn(`🏆🔒 PERFECT GAME FLAGGED: User ${user.id}, Session ${session.id} - payout under review`);
        } catch (error) {
            logger.error('Error flagging perfect game:', error);
        }
    }

    // ============================================
    // TIMEOUT & UTILITY METHODS
    // ============================================

    clearQuestionTimeout(timeoutKey) {
        const timeoutId = activeTimeouts.get(timeoutKey);
        if (timeoutId) {
            clearTimeout(timeoutId);
            activeTimeouts.delete(timeoutKey);
        }
    }

    clearAllSessionTimeouts(sessionKey) {
        const sessionPrefix = `timeout:${sessionKey}:`;
        let cleared = 0;
        for (const [key, timeoutId] of activeTimeouts.entries()) {
            if (key.startsWith(sessionPrefix)) {
                clearTimeout(timeoutId);
                activeTimeouts.delete(key);
                cleared++;
            }
        }
        // Also clear turbo and photo timeouts
        for (const prefix of ['turbo_go_timeout:', 'photo_timeout:']) {
            const key = `${prefix}${sessionKey}`;
            const tid = activeTimeouts.get(key);
            if (tid) { clearTimeout(tid); activeTimeouts.delete(key); cleared++; }
        }
        if (cleared > 0) logger.info(`Cleared ${cleared} timeouts for session ${sessionKey}`);
    }

    getGuaranteedAmount(questionNumber) {
        let guaranteed = 0;
        for (const checkpoint of [...SAFE_CHECKPOINTS].reverse()) {
            if (questionNumber > checkpoint) {
                guaranteed = PRIZE_LADDER[checkpoint];
                break;
            }
        }
        return guaranteed;
    }

    // ============================================
    // GAME LIFECYCLE
    // ============================================

    async startNewGame(user, gameMode = 'classic', tournamentId = null) {
        try {
            const platform = user.phone_number.startsWith('tg_') ? 'telegram' : 'whatsapp';
            const isTournamentGame = tournamentId !== null;
            const isPracticeMode = gameMode === 'practice';
            const gameType = isPracticeMode ? 'practice' : (isTournamentGame ? 'tournament' : 'regular');

            let shouldDeductToken = false;
            let tokenDeducted = false;

            if (paymentService.isEnabled() && !isPracticeMode && !isTournamentGame) {
                const hasGames = await paymentService.hasGamesRemaining(user.id);
                if (!hasGames) {
                    await messagingService.sendMessage(
                        user.phone_number,
                        '❌ You have no games remaining!\n\nType BUY to purchase more games.'
                    );
                    return;
                }
                shouldDeductToken = true;
            }

            // Tournament checks (unchanged from original)
            let tournamentUsesTokens = false;
            if (isTournamentGame) {
                const TournamentService = require('./tournament.service');
                const ts = new TournamentService();
                const tournament = await ts.getTournamentById(tournamentId);
                if (!tournament) {
                    await messagingService.sendMessage(user.phone_number, '❌ Tournament not found!');
                    return;
                }
                tournamentUsesTokens = tournament.uses_tokens;
                const canPlay = await ts.canUserPlay(user.id, tournamentId);
                if (!canPlay) {
                    const status = await ts.getUserTournamentStatus(user.id, tournamentId);
                    if (!status) {
                        await messagingService.sendMessage(user.phone_number, '❌ You have not joined this tournament!\n\nType TOURNAMENTS to view available tournaments.');
                    } else if (status.uses_tokens && status.tokens_remaining <= 0) {
                        await messagingService.sendMessage(user.phone_number, `❌ You have no tournament tokens remaining!\n\nYou've used all ${status.tokens_per_entry} attempts for this tournament.\n\nType TOURNAMENTS to view other tournaments.`);
                    } else if (status.payment_status !== 'success') {
                        await messagingService.sendMessage(user.phone_number, '❌ Payment not completed!\n\nComplete payment to access this tournament.\n\nType TOURNAMENTS to try again.');
                    }
                    return;
                }
                if (tournamentUsesTokens) {
                    const status = await ts.getUserTournamentStatus(user.id, tournamentId);
                    if (!status || status.tokens_remaining <= 0) {
                        await messagingService.sendMessage(user.phone_number, '❌ No tokens remaining for this tournament!');
                        return;
                    }
                    const deductResult = await pool.query(`
                        UPDATE tournament_participants
                        SET tokens_remaining = tokens_remaining - 1,
                            tokens_used = tokens_used + 1,
                            games_played_in_tournament = games_played_in_tournament + 1
                        WHERE user_id = $1 AND tournament_id = $2 AND tokens_remaining > 0
                        RETURNING tokens_remaining
                    `, [user.id, tournamentId]);
                    if (deductResult.rows.length === 0) {
                        await messagingService.sendMessage(user.phone_number, '❌ Failed to deduct token. Please try again.');
                        return;
                    }
                    tokenDeducted = true;
                }
            }

            const existingSession = await this.getActiveSession(user.id);
            if (existingSession) {
                await messagingService.sendMessage(user.phone_number, '⚠️ You already have an active game! Complete it first or type RESET.');
                return;
            }

            if (shouldDeductToken) {
                const gamesLeft = await paymentService.deductGame(user.id);
                tokenDeducted = true;
                logger.info(`Regular game token deducted for user ${user.id} - Games remaining: ${gamesLeft}`);
            }

            const sessionKey = `game_${user.id}_${Date.now()}`;

            const result = await pool.query(`
                INSERT INTO game_sessions (
                    user_id, session_key, current_question, current_score,
                    game_mode, tournament_id, is_tournament_game,
                    token_deducted, game_type, platform
                )
                VALUES ($1, $2, 1, 0, $3, $4, $5, $6, $7, $8)
                RETURNING *
            `, [user.id, sessionKey, gameMode, tournamentId, isTournamentGame, tokenDeducted, gameType, platform]);

            const session = result.rows[0];
            await redis.setex(`session:${sessionKey}`, 3600, JSON.stringify(session));

            await auditService.logGameStart(session.id, user.id, gameMode, platform, tournamentId);

            // Device tracking
            try {
                const deviceId = deviceTrackingService.generateDeviceFingerprint({
                    platform, phoneNumber: user.phone_number,
                    deviceType: platform === 'telegram' ? 'telegram_client' : 'whatsapp_client'
                });
                await deviceTrackingService.recordDevice(user.id, deviceId, platform, {
                    gameSessionId: session.id, gameMode, timestamp: new Date().toISOString()
                });
            } catch (deviceError) {
                logger.error('Error recording device:', deviceError);
            }

            // Streak tracking
            let streakResult = null;
            if (gameMode === 'classic' || isTournamentGame) {
                try {
                    streakResult = await streakService.updateStreak(user.id, isTournamentGame ? 'tournament' : 'classic');
                    if (streakResult.reward) {
                        const rewardMessage = streakService.formatRewardMessage(streakResult.reward);
                        await messagingService.sendMessage(user.phone_number, rewardMessage);
                    }
                } catch (streakError) {
                    logger.error('Error updating streak:', streakError);
                }
            }

            logger.info(`🎮 Game started: User ${user.id}, Platform: ${platform}, Mode: ${gameMode}, Type: ${gameType}`);

            // Check for penalty mode notification
            if (!isPracticeMode) {
                const penalty = await restrictionsService.isUserInPenaltyMode(user.id);
                if (penalty.inPenalty) {
                    await messagingService.sendMessage(
                        user.phone_number,
                        restrictionsService.getPenaltyModeMessage(penalty.gamesRemaining)
                    );
                }
            }

            // Check for Q1 timeout warning (show before game starts)
            if (!isPracticeMode) {
                try {
                    const userRecord = await pool.query(
                        'SELECT q1_timeout_streak, q1_timeout_warned FROM users WHERE id = $1',
                        [user.id]
                    );
                    if (userRecord.rows.length > 0) {
                        const streak = userRecord.rows[0].q1_timeout_streak || 0;
                        if (streak >= 2 && !userRecord.rows[0].q1_timeout_warned) {
                            await messagingService.sendMessage(
                                user.phone_number,
                                restrictionsService.getQ1TimeoutWarningMessage()
                            );
                            await pool.query('UPDATE users SET q1_timeout_warned = true WHERE id = $1', [user.id]);
                        }
                    }
                } catch (warnErr) {
                    logger.error('Error checking Q1 warning:', warnErr);
                }
            }

            // Build game instructions (unchanged from original)
            let gameModeText = '';
            let instructions = '';
            let branding = 'Proudly brought to you by SummerIsland Systems.';

            if (isPracticeMode) {
                gameModeText = '🎓 PRACTICE MODE';
                instructions = await this.getPracticeModeInstructions();
            } else if (isTournamentGame) {
                const TournamentService = require('./tournament.service');
                const ts = new TournamentService();
                const tournament = await ts.getTournamentById(tournamentId);
                const customInstructions = await ts.getTournamentInstructions(tournamentId);
                gameModeText = `🏆 ${tournament.tournament_name.toUpperCase()}`;
                if (customInstructions && customInstructions.instructions) {
                    instructions = customInstructions.instructions;
                    branding = customInstructions.branding || branding;
                } else {
                    instructions = await this.getDefaultTournamentInstructions(tournament);
                    if (tournament.custom_branding) branding = tournament.custom_branding;
                }
                if (tournamentUsesTokens) {
                    const status = await ts.getUserTournamentStatus(user.id, tournamentId);
                    if (status && status.tokens_remaining !== null) {
                        instructions += `\n\n🎟️ TOKENS REMAINING: ${status.tokens_remaining}`;
                    }
                }
            } else {
                switch(gameMode) {
                    case 'classic': gameModeText = '🎮 CLASSIC MODE'; break;
                    case 'akwa_ibom': gameModeText = '🏛️ AKWA IBOM EDITION'; break;
                    case 'world': gameModeText = '🌍 WORLD EDITION'; break;
                    default: gameModeText = '🎮 GAME MODE';
                }
                instructions = await this.getDefaultGameInstructions();
            }

            await messagingService.sendMessage(
                user.phone_number,
                `${gameModeText}\n\n${instructions}\n\n${branding}\n\nWhen you're ready, reply START to begin! 🚀`
            );

            await redis.setex(`game_ready:${user.id}`, 300, sessionKey);

        } catch (error) {
            logger.error('Error starting game:', error);
            throw error;
        }
    }

    async getPracticeModeInstructions() {
        return `🎓 PRACTICE MODE INSTRUCTIONS 🎓\n\n📋 RULES:\n- 15 questions\n- ${QUESTION_TIMEOUT_SECONDS} seconds per question\n- ⚠️ NO PRIZES in practice mode\n- Perfect for learning!\n\n💎 LIFELINES:\n5️⃣0️⃣ 50:50 - Remove 2 wrong answers\n⏭️ Skip - Replace with new question\n\nUse this mode to familiarize yourself with the game!\nWhen ready, play Classic Mode to win real prizes! 🏆`;
    }

    async getDefaultGameInstructions() {
        return `🎮 GAME INSTRUCTIONS 🎮\n\n📋 RULES:\n- 15 questions\n- ${QUESTION_TIMEOUT_SECONDS} seconds per question\n- Win up to ₦50,000!\n\n💎 LIFELINES:\n5️⃣0️⃣ 50:50 - Remove 2 wrong answers (Type '50' to activate)\n⏭️ Skip - Replace with new question (Type 'Skip' to activate)\n\n🏆 PRIZE LADDER:\nQ15: ₦50,000 🥇\nQ12: ₦25,000\nQ10: ₦10,000 (SAFE)\nQ8: ₦5,000\nQ5: ₦1,000 (SAFE)\n\nSafe amounts are guaranteed!`;
    }

    async getDefaultTournamentInstructions(tournament) {
        const prizeText = tournament.prize_pool ? `Win up to ₦${tournament.prize_pool.toLocaleString()}!` : 'Compete for amazing prizes!';
        return `🏆 TOURNAMENT INSTRUCTIONS 🏆\n\n📋 RULES:\n- 15 questions\n- ${QUESTION_TIMEOUT_SECONDS} seconds per question\n- ${prizeText}\n- Top 10 winners share prize pool\n\n💎 LIFELINES:\n5️⃣0️⃣ 50:50 - Remove 2 wrong answers\n⏭️ Skip - Replace with new question\n\nYour BEST score counts!\nPlay as many times as allowed!`;
    }

    // ============================================
    // GAME COMPLETION
    // ============================================

    async completeGame(session, user, wonGrandPrize, endReason = null) {
        try {
            // GUARD: Prevent double completion - check if session is still active
            const sessionCheck = await pool.query(
                'SELECT status FROM game_sessions WHERE id = $1',
                [session.id]
            );
            if (!sessionCheck.rows.length || sessionCheck.rows[0].status !== 'active') {
                logger.warn(`⚠️ completeGame called on non-active session ${session.id} (status: ${sessionCheck.rows[0]?.status})`);
                return; // Already completed, ignore duplicate call
            }

            // GUARD: Redis lock to prevent race conditions
            const completionLock = `lock:complete:${session.id}`;
            const lockAcquired = await redis.set(completionLock, '1', 'NX', 'EX', 10);
            if (!lockAcquired) {
                logger.warn(`⚠️ completeGame lock failed for session ${session.id} - already completing`);
                return;
            }

            const finalScore = session.current_score;
            const questionNumber = session.current_question;
            
            const timeoutKey = `timeout:${session.session_key}:q${questionNumber}`;
            this.clearQuestionTimeout(timeoutKey);
            this.clearAllSessionTimeouts(session.session_key);

            let outcome = endReason || 'completed';
            if (wonGrandPrize) outcome = 'grand_prize';
            else if (finalScore === 0 && !endReason) outcome = 'wrong_answer';

            await auditService.logGameEnd(session.id, user.id, finalScore, questionNumber - 1, outcome, finalScore);

            await pool.query(`
                UPDATE game_sessions
                SET status = 'completed', completed_at = NOW(), final_score = $1
                WHERE id = $2
            `, [finalScore, session.id]);

            // Only count real winnings (not practice mode) in total_winnings
            const winningsToAdd = session.game_type !== 'practice' ? finalScore : 0;
            
            await pool.query(`
                UPDATE users
                SET total_games_played = total_games_played + 1,
                    total_winnings = total_winnings + $1,
                    highest_question_reached = GREATEST(highest_question_reached, $2),
                    last_active = NOW()
                WHERE id = $3
            `, [winningsToAdd, session.current_question, user.id]);

            // Create payout transaction for classic mode wins
            // Uses ON CONFLICT to prevent duplicate transactions for same session
            if (session.game_type !== 'practice' && !session.is_tournament_game && finalScore > 0) {
                await pool.query(`
                    INSERT INTO transactions (user_id, session_id, amount, transaction_type, payment_status, payout_status)
                    VALUES ($1, $2, $3, 'prize', 'pending', 'pending')
                    ON CONFLICT (session_id) WHERE transaction_type = 'prize' DO NOTHING
                `, [user.id, session.id, finalScore]);
            }

            // Tournament scoring (unchanged)
            if (session.is_tournament_game && session.tournament_id) {
                const TournamentService = require('./tournament.service');
                const ts = new TournamentService();
                const gameTimeResult = await pool.query(
                    'SELECT EXTRACT(EPOCH FROM (NOW() - started_at)) as time_taken FROM game_sessions WHERE id = $1',
                    [session.id]
                );
                const timeTaken = parseFloat(gameTimeResult.rows[0]?.time_taken) || 999;
                const questionsAnswered = session.current_question - 1;
                await pool.query(`
                    INSERT INTO tournament_game_sessions
                    (tournament_id, user_id, game_session_id, score, questions_answered, time_taken, completed, token_deducted)
                    VALUES ($1, $2, $3, $4, $5, $6, true, $7)
                `, [session.tournament_id, user.id, session.id, finalScore, questionsAnswered, timeTaken, session.token_deducted]);
                await ts.updateParticipantScore(user.id, session.tournament_id, finalScore, questionsAnswered, timeTaken);
            }

            // Cleanup Redis
            await redis.del(`session:${session.session_key}`);
            await redis.del(`asked_questions:${session.session_key}`);
            await redis.del(`game_ready:${user.id}`);
            await redis.del(`user_state:${user.phone_number}`);

            // Finalize anti-fraud
            try { await antiFraudService.finalizeSessionStats(session.id, user.id); } catch (e) {}

            // Perfect game flagging
            if (wonGrandPrize && session.game_type !== 'practice') {
                await this.flagPerfectGame(session, user);
            }

            // Penalty game tracking
            if (session.game_type !== 'practice') {
                try { await restrictionsService.decrementPenaltyGames(user.id); } catch (e) {}
            }

            // Share data / victory cards (unchanged from original)
            if (session.game_type !== 'practice') {
                const questionsAnswered = session.current_question - 1;
                
                if (session.is_tournament_game) {
                    const timeTaken = await this.getGameTimeTaken(session.id);
                    let tournamentName = 'Tournament';
                    let currentRank = null;
                    if (session.tournament_id) {
                        try {
                            const tResult = await pool.query('SELECT tournament_name FROM tournaments WHERE id = $1', [session.tournament_id]);
                            if (tResult.rows.length > 0) tournamentName = tResult.rows[0].tournament_name;
                            const rResult = await pool.query('SELECT rank FROM tournament_participants WHERE user_id = $1 AND tournament_id = $2', [user.id, session.tournament_id]);
                            if (rResult.rows.length > 0) currentRank = rResult.rows[0].rank;
                        } catch (err) {}
                    }
                    await redis.setex(`win_share_pending:${user.id}`, 86400, JSON.stringify({
                        isTournament: true, questionsAnswered, timeTaken,
                        tournamentName, tournamentId: session.tournament_id,
                        rank: currentRank, totalQuestions: 15
                    }));
                } else if (finalScore > 0) {
                    await redis.setex(`win_share_pending:${user.id}`, 86400, JSON.stringify({
                        isTournament: false, amount: finalScore,
                        questionsAnswered, totalQuestions: 15
                    }));
                    try {
                        const txResult = await pool.query(`SELECT id FROM transactions WHERE user_id = $1 AND transaction_type = 'prize' AND amount = $2 ORDER BY created_at DESC LIMIT 1`, [user.id, finalScore]);
                        if (txResult.rows.length > 0) {
                            const transactionId = txResult.rows[0].id;
                            await victoryCardsService.storeWinData(transactionId, { amount: finalScore, questionsAnswered, totalQuestions: 15, gameMode: session.game_mode, username: user.username, fullName: user.full_name, city: user.city, wonAt: new Date().toISOString() });
                            await victoryCardsService.createVictoryCardRecord(user.id, transactionId, session.id, { amount: finalScore, questionsAnswered, totalQuestions: 15 });
                        }
                    } catch (vcError) { logger.error('Error creating victory card record:', vcError); }

                    if (wonGrandPrize) {
                        try { await restrictionsService.setGrandPrizeCooldown(user.id); } catch (e) {}
                    }
                }
            }

            // Achievements
            try { await achievementsService.checkAndAwardAchievements(user.id); } catch (e) {}

            // Send completion messages
            if (session.game_type === 'practice') {
                await this.sendPracticeCompleteMessage(user, finalScore, questionNumber);
            } else if (session.is_tournament_game) {
                const timeTaken = await this.getGameTimeTaken(session.id);
                if (wonGrandPrize) {
                    await this.sendGrandPrizeMessage(user, finalScore, session);
                } else {
                    await this.sendTournamentCompleteMessage(user, questionNumber - 1, timeTaken, session);
                }
            } else if (wonGrandPrize) {
                await this.sendGrandPrizeMessage(user, finalScore);
            } else if (finalScore > 0 && !endReason) {
                await this.sendWinMessage(user, finalScore, questionNumber);
            }

            // Post-game state
            await redis.setex(`post_game:${user.id}`, 300, JSON.stringify({
                timestamp: Date.now(), gameType: session.game_type,
                isTournament: session.is_tournament_game,
                tournamentId: session.tournament_id, finalScore
            }));

        } catch (error) {
            logger.error('Error completing game:', error);
            throw error;
        }
    }

    // Message senders (unchanged from original)
    async sendPracticeCompleteMessage(user, score, questionNumber) {
        let message = `🎓 PRACTICE COMPLETE! 🎓\n\nGreat job, ${user.full_name}!\n\nYou answered ${questionNumber - 1}/15 questions correctly.\nPotential Score: ₦${score.toLocaleString()}\n\n⚠️ This was practice mode - no real prizes.\n\nReady to play for REAL prizes?\n\n1️⃣ Play Again\n2️⃣ View Leaderboard\n3️⃣ Main Menu\n\nType PLAY to start Classic Mode and win real money! 💰`;
        await messagingService.sendMessage(user.phone_number, message);
    }

    async sendGrandPrizeMessage(user, finalScore, session = null) {
        const isTournament = session?.is_tournament_game;
        if (isTournament) {
            const timeTaken = await this.getGameTimeTaken(session.id);
            let message = `🎊 *PERFECT GAME!* 🎊\n🏆 *TOURNAMENT LEGEND!* 🏆\n\n*ALL 15 QUESTIONS CORRECT!*\n\n📊 *Your Performance:*\n• Questions: *15/15* ✨\n• Time: *${timeTaken}s*\n\n${user.full_name.toUpperCase()}, you're at the TOP!\n\n🌐 Check if you're #1 at:\nwhatsuptrivia.com.ng/leaderboards\n\nShare your PERFECT game? Reply YES for tournament card! 📸\n\n1️⃣ Play Again\n2️⃣ View Tournament Leaderboard\n3️⃣ Share Tournament Card`;
            await messagingService.sendMessage(user.phone_number, message);
        } else {
            let message = `🎊 INCREDIBLE! 🎊\n🏆 CHAMPION! 🏆\n\nALL 15 QUESTIONS CORRECT!\n\n💰 ₦${finalScore.toLocaleString()} WON! 💰\n\n${user.full_name.toUpperCase()}, you're in the HALL OF FAME!\n\nPrize processed in 24-48 hours.\n\nWould you like to share your win? Reply YES for victory card! 🎉\n\n1️⃣ Play Again\n2️⃣ View Leaderboard\n3️⃣ Claim Prize\n4️⃣ Share Victory Card`;
            await messagingService.sendMessage(user.phone_number, message);
        }
    }

    async sendWinMessage(user, finalScore, questionNumber) {
        let message = `Congratulations ${user.full_name}! 🎉\n\nYou won ₦${finalScore.toLocaleString()}!\n\nWould you like to share your win on WhatsApp Status? Reply YES to get your victory card! 📸\n\n1️⃣ Play Again\n2️⃣ View Leaderboard\n3️⃣ Claim Prize\n4️⃣ Share Victory Card\n\n💡 _Tip: Type CLAIM anytime to claim your prize_`;
        await messagingService.sendMessage(user.phone_number, message);
    }

    async sendTournamentCompleteMessage(user, questionsAnswered, timeTaken, session) {
        try {
            let tournamentName = 'Tournament';
            if (session.tournament_id) {
                const TournamentService = require('./tournament.service');
                const ts = new TournamentService();
                const tournament = await ts.getTournamentById(session.tournament_id);
                if (tournament) tournamentName = tournament.tournament_name;
            }
            let rankInfo = '';
            if (session.tournament_id) {
                const rankResult = await pool.query('SELECT rank FROM tournament_participants WHERE user_id = $1 AND tournament_id = $2', [user.id, session.tournament_id]);
                if (rankResult.rows.length > 0 && rankResult.rows[0].rank) rankInfo = `\n📍 Current Rank: #${rankResult.rows[0].rank}`;
            }
            let perf = questionsAnswered >= 10 ? '🔥 Excellent run!' : questionsAnswered >= 5 ? '👍 Good effort!' : '💪 Don\'t give up!';
            let message = `🏆 *TOURNAMENT GAME COMPLETE!* 🏆\n\nWell done, ${user.full_name}! 👏\n\n📊 *Your Performance:*\n• Questions Reached: *Q${questionsAnswered}*\n• Time Taken: *${timeTaken}s*${rankInfo}\n\n${perf}\n\n💡 *Remember:* Only your BEST game is ranked.\nKeep playing to climb the leaderboard!\n\n🌐 Check rankings at:\nwhatsuptrivia.com.ng/leaderboards\n\nWould you like to share your record? Reply YES for a tournament card! 📸\n\n1️⃣ Play Again\n2️⃣ View Tournament Leaderboard\n3️⃣ Share Tournament Card`;
            await messagingService.sendMessage(user.phone_number, message);
        } catch (error) {
            logger.error('Error sending tournament complete message:', error);
            let message = `🏆 Tournament Game Complete!\n\nQuestions: Q${questionsAnswered} | Time: ${timeTaken}s\n\n1️⃣ Play Again\n2️⃣ View Leaderboard`;
            await messagingService.sendMessage(user.phone_number, message);
        }
    }

    // ============================================
    // CAPTCHA + PHOTO VERIFICATION ROUTER
    // ============================================

    async sendQuestionOrCaptcha(session, user) {
        const questionNumber = session.current_question;
        
        if (session.game_type === 'practice' || session.game_mode === 'practice') {
            await this.sendQuestion(session, user);
            return;
        }

        // Check for photo verification first (Q13-15, suspicious sessions)
        if (await this.shouldRequestPhotoVerification(session, user, questionNumber)) {
            await this.sendPhotoVerification(session, user, questionNumber);
            return;
        }

        // Check for suspicious perfect session auto-termination
        if (questionNumber > SUSPICIOUS_SESSION_CONFIG.PERFECT_THROUGH_Q) {
            // Get the latest response time from tracking
            try {
                const trackingKey = `turbo_track:${session.session_key}`;
                const raw = await redis.get(trackingKey);
                if (raw) {
                    const tracking = JSON.parse(raw);
                    const lastResponseTime = tracking.allResponseTimes?.slice(-1)[0] || 0;
                    const termResult = await this.checkSuspiciousPerfectSession(session, user, questionNumber - 1, lastResponseTime);
                    if (termResult.terminate) {
                        await this.handleSuspiciousTermination(session, user);
                        return;
                    }
                }
            } catch (e) {
                logger.error('Error checking suspicious session:', e);
            }
        }
        
        // Standard CAPTCHA check
        let shownCaptchas = [];
        try {
            const captchaData = session.captcha_shown_at;
            if (Array.isArray(captchaData)) shownCaptchas = captchaData;
            else if (typeof captchaData === 'string' && captchaData.length > 0) shownCaptchas = JSON.parse(captchaData);
            if (!Array.isArray(shownCaptchas)) shownCaptchas = [];
        } catch (e) { shownCaptchas = []; }
        
        if (captchaService.shouldShowCaptcha(questionNumber, shownCaptchas)) {
            await this.sendCaptcha(session, user, questionNumber);
        } else {
            await this.sendQuestion(session, user);
        }
    }

    // ============================================
    // CAPTCHA METHODS (unchanged structure)
    // ============================================

    async sendCaptcha(session, user, questionNumber) {
        try {
            const captcha = captchaService.generateCaptcha();
            const timeoutKey = `timeout:${session.session_key}:captcha${questionNumber}`;
            this.clearQuestionTimeout(timeoutKey);
            
            const captchaKey = `captcha:${session.session_key}`;
            await redis.setex(captchaKey, 30, JSON.stringify({ ...captcha, questionNumber, startTime: Date.now() }));
            
            let shownCaptchas = [];
            try {
                const cd = session.captcha_shown_at;
                if (Array.isArray(cd)) shownCaptchas = cd;
                else if (typeof cd === 'string' && cd.length > 0) shownCaptchas = JSON.parse(cd);
                if (!Array.isArray(shownCaptchas)) shownCaptchas = [];
            } catch (e) { shownCaptchas = []; }
            shownCaptchas.push(questionNumber);
            
            await pool.query('UPDATE game_sessions SET captcha_shown_at = $1 WHERE id = $2', [JSON.stringify(shownCaptchas), session.id]);
            session.captcha_shown_at = JSON.stringify(shownCaptchas);
            
            const message = captchaService.formatCaptchaMessage(captcha, session.current_score, questionNumber);
            await messagingService.sendMessage(user.phone_number, message);
            
            await auditService.logCaptchaShown(session.id, user.id, questionNumber, captcha.type, captcha.displayQuestion);
            
            await redis.setex(timeoutKey, REDIS_TIMEOUT_BUFFER, (Date.now() + QUESTION_TIMEOUT_MS).toString());
            
            const timeoutId = setTimeout(async () => {
                try {
                    const timeout = await redis.get(timeoutKey);
                    if (timeout) {
                        await redis.del(timeoutKey);
                        await redis.del(captchaKey);
                        activeTimeouts.delete(timeoutKey);
                        await auditService.logCaptchaTimeout(session.id, user.id, questionNumber, captcha.type);
                        await this.handleCaptchaFailure(session, user, 'timeout');
                    }
                } catch (error) { logger.error('Error in CAPTCHA timeout:', error); }
            }, QUESTION_TIMEOUT_MS);
            
            activeTimeouts.set(timeoutKey, timeoutId);
        } catch (error) {
            logger.error('Error sending CAPTCHA:', error);
            await this.sendQuestion(session, user);
        }
    }

    async processCaptchaAnswer(session, user, answer) {
        try {
            const captchaKey = `captcha:${session.session_key}`;
            const captchaData = await redis.get(captchaKey);
            if (!captchaData) return false;
            
            const captcha = JSON.parse(captchaData);
            const questionNumber = captcha.questionNumber;
            const timeoutKey = `timeout:${session.session_key}:captcha${questionNumber}`;
            
            await redis.del(timeoutKey);
            this.clearQuestionTimeout(timeoutKey);
            await redis.del(captchaKey);
            
            const responseTimeMs = Date.now() - captcha.startTime;
            const isCorrect = captchaService.validateAnswer(captcha, answer);
            
            await captchaService.logCaptchaAttempt(user.id, session.id, questionNumber, captcha, answer, isCorrect, responseTimeMs);
            await auditService.logCaptchaResponse(session.id, user.id, questionNumber, captcha.type, answer, captcha.answer || captcha.correctAnswer, isCorrect, responseTimeMs);
            
            if (isCorrect) {
                await messagingService.sendMessage(user.phone_number, '✅ Verified! Here comes your question...');
                setTimeout(async () => { await this.sendQuestion(session, user); }, 500);
            } else {
                await this.handleCaptchaFailure(session, user, 'wrong_answer');
            }
            
            return true;
        } catch (error) {
            logger.error('Error processing CAPTCHA:', error);
            await this.sendQuestion(session, user);
            return true;
        }
    }

    async handleCaptchaFailure(session, user, reason) {
        try {
            const message = reason === 'timeout' 
                ? `⏱️ *TIME'S UP!*\n\nYou didn't complete the security check in time.\n\nYour game has ended.\n\n💰 Final Score: ₦${session.current_score.toLocaleString()}`
                : `❌ *VERIFICATION FAILED*\n\nYou didn't pass the security check.\n\nYour game has ended.\n\n💰 Final Score: ₦${session.current_score.toLocaleString()}`;
            
            await messagingService.sendMessage(user.phone_number, message);
            
            await pool.query('UPDATE game_sessions SET status = \'completed\', completed_at = NOW(), captcha_passed = false WHERE id = $1', [session.id]);
            await redis.del(`session:${session.session_key}`);
            await redis.del(`asked_questions:${session.session_key}`);
            await redis.del(`game_ready:${user.id}`);
            await redis.del(`captcha:${session.session_key}`);
            this.clearAllSessionTimeouts(session.session_key);
        } catch (error) { logger.error('Error handling CAPTCHA failure:', error); }
    }

    async hasPendingCaptcha(sessionKey) {
        const captchaData = await redis.get(`captcha:${sessionKey}`);
        return !!captchaData;
    }

    // ============================================
    // QUESTION ROTATION (unchanged)
    // ============================================

    getDifficultyLevelsForQuestion(questionNumber) {
        const mapping = {
            1: [1, 2], 2: [2, 3], 3: [3], 4: [4, 5], 5: [5],
            6: [6, 7], 7: [7, 8], 8: [8], 9: [9, 10], 10: [10],
            11: [11], 12: [12], 13: [13], 14: [14], 15: [15]
        };
        return mapping[questionNumber] || [questionNumber];
    }

    async getRandomizedQuestion(userId, questionNumber, excludeIds, gameMode, tournamentId) {
        try {
            const allowedDifficulties = this.getDifficultyLevelsForQuestion(questionNumber);
            const difficultyList = allowedDifficulties.join(',');
            let bankCondition = gameMode === 'practice' ? `AND (q.question_bank_id = 2)` : `AND (q.question_bank_id = 1 OR q.question_bank_id IS NULL)`;
            const excludeClause = excludeIds.length > 0 ? `AND q.id NOT IN (${excludeIds.join(',')})` : '';

            const smartQuery = `
                WITH user_history AS (
                    SELECT question_id, COUNT(*) as times_seen, MAX(asked_at) as last_seen
                    FROM user_question_history WHERE user_id = $1 GROUP BY question_id
                ),
                scored_questions AS (
                    SELECT q.*, COALESCE(uh.times_seen, 0) as user_times_seen, uh.last_seen,
                        CASE WHEN uh.question_id IS NULL THEN 10000 ELSE 0 END
                        + COALESCE(EXTRACT(EPOCH FROM (NOW() - uh.last_seen)) / 3600, 10000)
                        + (100.0 / GREATEST(q.times_asked + 1, 1))
                        + (RANDOM() * 50) AS selection_score
                    FROM questions q
                    LEFT JOIN user_history uh ON q.id = uh.question_id
                    WHERE q.difficulty IN (${difficultyList}) AND q.is_active = true
                    AND (q.is_disabled = false OR q.is_disabled IS NULL)
                    ${bankCondition} ${excludeClause}
                )
                SELECT * FROM scored_questions
                ORDER BY CASE WHEN user_times_seen = 0 THEN 0 ELSE 1 END, selection_score DESC
                LIMIT 1
            `;

            const result = await pool.query(smartQuery, [userId]);
            if (result.rows.length > 0) {
                const question = result.rows[0];
                question.user_times_seen = question.user_times_seen || 0;
                return question;
            }

            // Emergency fallback
            const emergencyResult = await pool.query(`
                SELECT q.*, 0 as user_times_seen FROM questions q
                WHERE q.is_active = true AND (q.is_disabled = false OR q.is_disabled IS NULL)
                ${bankCondition} ${excludeClause}
                ORDER BY ABS(q.difficulty - ${allowedDifficulties[0]}), RANDOM() LIMIT 1
            `);
            if (emergencyResult.rows.length > 0) return emergencyResult.rows[0];

            return await questionService.getQuestionByDifficulty(questionNumber, excludeIds, gameMode, tournamentId);
        } catch (error) {
            logger.error('Error in smart question rotation:', error);
            return await questionService.getQuestionByDifficulty(questionNumber, excludeIds, gameMode, tournamentId);
        }
    }

    async logQuestionHistory(userId, questionId) {
        try { await pool.query('INSERT INTO user_question_history (user_id, question_id, asked_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING', [userId, questionId]); }
        catch (error) { logger.error('Error logging question history:', error); }
    }

    // ============================================
    // SEND QUESTION (with progressive timers + penalty)
    // ============================================

    async sendQuestion(session, user) {
        try {
            const questionNumber = session.current_question;
            const prizeAmount = PRIZE_LADDER[questionNumber];
            const isSafe = SAFE_CHECKPOINTS.includes(questionNumber);
            const timeoutKey = `timeout:${session.session_key}:q${questionNumber}`;
            this.clearQuestionTimeout(timeoutKey);
            
            // Get dynamic timeout (turbo > penalty > progressive > base)
            const timeoutConfig = await this.getSessionTimeout(session.session_key, questionNumber, user.id);
            const currentTimeoutMs = timeoutConfig.timeoutMs;
            const currentTimeoutSeconds = timeoutConfig.timeoutSeconds;
            
            if (timeoutConfig.isTurboMode) {
                await this.decrementTurboQuestions(session.session_key, user.id, session.id);
            }
            
            const askedQuestionsKey = `asked_questions:${session.session_key}`;
            const askedQuestionsJson = await redis.get(askedQuestionsKey);
            const askedQuestions = askedQuestionsJson ? JSON.parse(askedQuestionsJson) : [];
            
            const question = await this.getRandomizedQuestion(user.id, questionNumber, askedQuestions, session.game_mode, session.tournament_id);
            if (!question) throw new Error('No question found');
            
            askedQuestions.push(question.id);
            await redis.setex(askedQuestionsKey, 3600, JSON.stringify(askedQuestions));
            
            session.current_question_id = question.id;
            await this.updateSession(session);
            await this.logQuestionHistory(user.id, question.id);
            
            await auditService.logQuestionAsked(session.id, user.id, questionNumber, question, prizeAmount, timeoutConfig.isTurboMode);
            await antiFraudService.setQuestionStartTime(session.session_key, questionNumber);
            
            let message = `❓ QUESTION ${questionNumber} - ₦${prizeAmount.toLocaleString()}`;
            if (isSafe) message += ' (SAFE) 🔒';
            if (timeoutConfig.isTurboMode) message += ' ⚡';
            if (timeoutConfig.isPenaltyMode) message += ' ⚠️';
            message += `\n\n${question.question_text}\n\n`;
            message += `A) ${question.option_a}\nB) ${question.option_b}\nC) ${question.option_c}\nD) ${question.option_d}\n\n`;
            message += `⏱️ ${currentTimeoutSeconds} seconds...`;
            if (timeoutConfig.isTurboMode) message += ` ⚡`;
            message += `\n\n`;
            
            const lifelines = [];
            if (!session.lifeline_5050_used) lifelines.push('50:50');
            if (!session.lifeline_skip_used) lifelines.push('Skip');
            if (lifelines.length > 0) message += `💎 Lifelines: ${lifelines.join(' | ')}`;
            
            await messagingService.sendMessage(user.phone_number, message);
            
            await redis.setex(timeoutKey, Math.ceil(currentTimeoutMs / 1000) + 3, (Date.now() + currentTimeoutMs).toString());
            
            const timeoutId = setTimeout(async () => {
                try {
                    const timeout = await redis.get(timeoutKey);
                    if (timeout) {
                        const currentSession = await this.getActiveSession(user.id);
                        if (currentSession && currentSession.current_question === questionNumber) {
                            await redis.del(timeoutKey);
                            activeTimeouts.delete(timeoutKey);
                            await this.handleTimeout(currentSession, user);
                        }
                    }
                } catch (error) { logger.error('Error in timeout handler:', error); }
            }, currentTimeoutMs);
            
            activeTimeouts.set(timeoutKey, timeoutId);
        } catch (error) {
            logger.error('Error sending question:', error);
            throw error;
        }
    }

    // ============================================
    // PROCESS ANSWER (with turbo trigger check)
    // ============================================

    async processAnswer(session, user, answer) {
        try {
            const hasCaptcha = await this.hasPendingCaptcha(session.session_key);
            if (hasCaptcha) {
                const handled = await this.processCaptchaAnswer(session, user, answer);
                if (handled) return;
            }
            
            const questionNumber = session.current_question;
            const timeoutKey = `timeout:${session.session_key}:q${questionNumber}`;
            
            const answerLockKey = `lock:answer:${session.session_key}:${questionNumber}`;
            const lockAcquired = await redis.set(answerLockKey, '1', 'NX', 'EX', 3);
            if (!lockAcquired) { logger.warn(`Duplicate answer prevented`); return; }
            
            try {
                // Timeout enforcement
                const startTime = await antiFraudService.getQuestionStartTime(session.session_key, questionNumber);
                if (startTime) {
                    const elapsed = Date.now() - startTime;
                    const timeoutConfig = await this.getSessionTimeout(session.session_key, questionNumber, user.id);
                    if (elapsed > timeoutConfig.timeoutMs) {
                        logger.info(`⏰ Answer REJECTED (timeout): ${elapsed}ms > ${timeoutConfig.timeoutMs}ms`);
                        await redis.del(timeoutKey);
                        this.clearQuestionTimeout(timeoutKey);
                        await this.handleTimeout(session, user);
                        return;
                    }
                }
                
                const timeout = await redis.get(timeoutKey);
                if (!timeout) {
                    await this.handleTimeout(session, user);
                    return;
                }
                
                await redis.del(timeoutKey);
                this.clearQuestionTimeout(timeoutKey);
            
                // Calculate response time
                let responseTimeMs = null;
                try {
                    const st = await antiFraudService.getQuestionStartTime(session.session_key, questionNumber);
                    if (st) {
                        responseTimeMs = Date.now() - st;
                        await antiFraudService.trackResponseTime(session.id, questionNumber, responseTimeMs, user.id);
                    }
                } catch (afError) { logger.error('Error tracking response time:', afError); }
            
                if (!session.current_question_id) {
                    await messagingService.sendMessage(user.phone_number, '❌ Session error. Type RESET to start a new game.');
                    return;
                }
            
                const question = await questionService.getQuestionById(session.current_question_id);
                if (!question) {
                    await messagingService.sendMessage(user.phone_number, '❌ Question error. Type RESET to start a new game.');
                    return;
                }
            
                const isCorrect = answer === question.correct_answer;
                const prizeAmount = PRIZE_LADDER[questionNumber];
            
                await auditService.logAnswer(session.id, user.id, questionNumber, answer, question.correct_answer, isCorrect, isCorrect ? prizeAmount : session.current_score, responseTimeMs);
            
                if (isCorrect) {
                    session.current_score = prizeAmount;
                    session.current_question = questionNumber + 1;

                    // Reset Q1 timeout streak on any correct Q1 answer
                    if (questionNumber === 1) {
                        await restrictionsService.resetQ1TimeoutStreak(user.id);
                    }
                    
                    let message = `✅ CORRECT! 🎉\n\n`;
                    if (question.fun_fact) message += `${question.fun_fact}\n\n`;
                    message += `💰 You've won: ₦${prizeAmount.toLocaleString()}\n`;
                    message += `💪 Question: ${questionNumber} of 15\n`;
                    if (SAFE_CHECKPOINTS.includes(questionNumber)) message += `\n🔒 SAFE! ₦${prizeAmount.toLocaleString()} guaranteed!\n`;
                    
                    await messagingService.sendMessage(user.phone_number, message);
                    
                    if (questionNumber === 15) {
                        await this.completeGame(session, user, true);
                    } else {
                        await this.updateSession(session);
                        
                        // Check turbo triggers (not for practice mode)
                        let turboActivated = false;
                        const isPracticeMode = session.game_mode === 'practice' || session.game_type === 'practice';
                        if (responseTimeMs && !isPracticeMode) {
                            const turboResult = await this.trackAndCheckTurboTriggers(session, user, responseTimeMs);
                            turboActivated = turboResult.activated;
                        }
                        
                        if (turboActivated) return; // Wait for GO input
                        
                        setTimeout(async () => {
                            const activeSession = await this.getActiveSession(user.id);
                            if (activeSession && activeSession.id === session.id) {
                                await this.sendQuestionOrCaptcha(session, user);
                            }
                        }, 3000);
                    }
                } else {
                    await this.handleWrongAnswer(session, user, question);
                }
            
                await questionService.updateQuestionStats(question.id, isCorrect);
            } finally {
                await redis.del(answerLockKey);
            }
        } catch (error) {
            logger.error('Error processing answer:', error);
            throw error;
        }
    }

    async handleWrongAnswer(session, user, question) {
        const questionNumber = session.current_question;
        const isTournament = session.is_tournament_game;
        let guaranteedAmount = 0;
        if (!isTournament) {
            for (const checkpoint of [...SAFE_CHECKPOINTS].reverse()) {
                if (questionNumber > checkpoint) { guaranteedAmount = PRIZE_LADDER[checkpoint]; break; }
            }
        }
        
        let message = `❌ WRONG ANSWER 😢\n\nCorrect: ${question.correct_answer}) ${question['option_' + question.correct_answer.toLowerCase()]}\n\n`;
        if (question.fun_fact) message += `${question.fun_fact}\n\n`;
        message += `🎮 GAME OVER 🎮\n\n`;
        
        if (isTournament) {
            const timeTaken = await this.getGameTimeTaken(session.id);
            message += `📊 *Your Performance:*\n• Questions Reached: Q${questionNumber - 1}\n• Time Taken: ${timeTaken}s\n\n🏆 Check the leaderboard!\n💡 _Remember: Only your BEST game counts._\n\n🌐 Visit whatsuptrivia.com.ng/leaderboards\n\nWell played, ${user.full_name}! 👏\n\n1️⃣ Play Again\n2️⃣ View Tournament Leaderboard\n3️⃣ Exit Tournament`;
            session.current_score = 0;
        } else {
            if (guaranteedAmount > 0) {
                message += `You reached a safe checkpoint!\n💰 You won: ₦${guaranteedAmount.toLocaleString()} 🎉\n\n`;
                session.current_score = guaranteedAmount;
            } else {
                message += `💰 You won: ₦0\n\n`;
                session.current_score = 0;
            }
            message += `Well played, ${user.full_name}! 👏\n\n1️⃣ Play Again\n2️⃣ View Leaderboard\n`;
            message += guaranteedAmount > 0 ? `3️⃣ Claim Prize\n4️⃣ Share Victory Card\n\n💡 _Tip: Type CLAIM anytime to claim your prize_` : `3️⃣ Main Menu\n`;
        }
        
        await messagingService.sendMessage(user.phone_number, message);
        await this.completeGame(session, user, false, 'wrong_answer');
    }

    async getGameTimeTaken(sessionId) {
        try {
            const result = await pool.query('SELECT EXTRACT(EPOCH FROM (NOW() - started_at)) as time_taken FROM game_sessions WHERE id = $1', [sessionId]);
            return result.rows[0]?.time_taken ? parseFloat(result.rows[0].time_taken).toFixed(1) : '0';
        } catch (error) { return '0'; }
    }

    // ============================================
    // TIMEOUT HANDLER (with Q1 timeout tracking)
    // ============================================

    async handleTimeout(session, user) {
        // GUARD: Prevent double timeout handling with Redis lock
        const timeoutLockKey = `lock:timeout:${session.id}:q${session.current_question}`;
        const lockAcquired = await redis.set(timeoutLockKey, '1', 'NX', 'EX', 10);
        if (!lockAcquired) {
            logger.warn(`⚠️ handleTimeout already running for session ${session.id} Q${session.current_question} - skipping duplicate`);
            return;
        }

        await auditService.logTimeout(session.id, user.id, session.current_question);
        
        // Q1 TIMEOUT TRACKING (only for classic/tournament, not practice)
        if (session.current_question === 1 && session.game_type !== 'practice') {
            try {
                const q1Result = await restrictionsService.trackQ1Timeout(user.id, session.id);
                await auditService.logQ1TimeoutEvent(session.id, user.id, q1Result.streak, q1Result.action);

                if (q1Result.action === 'suspension') {
                    // Immediate temp suspension
                    await restrictionsService.setTempSuspension(user.id, 'Repeated Q1 timeout violations');
                    
                    const suspMsg = restrictionsService.getQ1SuspensionMessage();
                    await messagingService.sendMessage(user.phone_number, suspMsg);

                    // End the game
                    session.current_score = 0;
                    await this.completeGame(session, user, false, 'q1_timeout_suspension');
                    return;
                }
            } catch (q1Error) {
                logger.error('Error in Q1 timeout tracking:', q1Error);
            }
        }

        const isTournament = session.is_tournament_game;
        let guaranteedAmount = 0;
        if (!isTournament) {
            for (const checkpoint of [...SAFE_CHECKPOINTS].reverse()) {
                if (session.current_question > checkpoint) { guaranteedAmount = PRIZE_LADDER[checkpoint]; break; }
            }
        }
        
        let message = `⏰ TIME'S UP! 😢\n\nYou didn't answer in time.\n\n🎮 GAME OVER 🎮\n\n`;
        
        if (isTournament) {
            const timeTaken = await this.getGameTimeTaken(session.id);
            message += `📊 *Your Performance:*\n• Questions Reached: Q${session.current_question - 1}\n• Time Taken: ${timeTaken}s\n\n🏆 Check the leaderboard!\n💡 _Remember: Only your BEST game counts._\n\n🌐 Visit whatsuptrivia.com.ng/leaderboards\n\n1️⃣ Play Again\n2️⃣ View Tournament Leaderboard\n3️⃣ Exit Tournament`;
            session.current_score = 0;
        } else {
            if (guaranteedAmount > 0) {
                message += `You reached a safe checkpoint!\n💰 You won: ₦${guaranteedAmount.toLocaleString()} 🎉\n\n`;
            } else {
                message += `💰 You won: ₦0\n\n`;
            }
            message += `1️⃣ Play Again\n2️⃣ View Leaderboard\n`;
            message += guaranteedAmount > 0 ? `3️⃣ Claim Prize\n4️⃣ Share Victory Card\n\n💡 _Tip: Type CLAIM anytime to claim your prize_` : `3️⃣ Main Menu\n`;
            session.current_score = guaranteedAmount;
        }
        
        await messagingService.sendMessage(user.phone_number, message);
        await this.completeGame(session, user, false, 'timeout');
    }

    // ============================================
    // LIFELINES (unchanged from original)
    // ============================================

    async useLifeline(session, user, lifeline) {
        try {
            const currentSession = await this.getActiveSession(user.id);
            if (!currentSession) { await messagingService.sendMessage(user.phone_number, '❌ No active game found.'); return; }
            
            const question = await questionService.getQuestionById(currentSession.current_question_id);
            if (!question) throw new Error('Question not found');
            
            if (lifeline === 'fifty_fifty') {
                if (currentSession.lifeline_5050_used) { await messagingService.sendMessage(user.phone_number, '❌ You already used 50:50!'); return; }
                
                const questionNumber = currentSession.current_question;
                const timeoutKey = `timeout:${currentSession.session_key}:q${questionNumber}`;
                
                const existingTimeout = await redis.get(timeoutKey);
                let remainingTime = 15;
                if (existingTimeout) {
                    const timeoutExpiry = parseInt(existingTimeout);
                    remainingTime = Math.max(0, Math.ceil((timeoutExpiry - Date.now()) / 1000));
                }
                const newTime = remainingTime + 5;
                
                this.clearQuestionTimeout(timeoutKey);
                await redis.del(timeoutKey);
                await antiFraudService.updateQuestionStartTime(currentSession.session_key, questionNumber, Date.now());
                
                await pool.query('UPDATE game_sessions SET lifeline_5050_used = true WHERE id = $1', [currentSession.id]);
                
                const correctAnswer = question.correct_answer;
                const allOptions = ['A', 'B', 'C', 'D'];
                const wrongOptions = allOptions.filter(opt => opt !== correctAnswer);
                const keepWrong = wrongOptions[Math.floor(Math.random() * wrongOptions.length)];
                const remainingOptions = [correctAnswer, keepWrong].sort();
                
                await auditService.logLifelineUsed(currentSession.id, user.id, questionNumber, '50:50', { removed_options: wrongOptions.filter(o => o !== keepWrong), remaining_options: remainingOptions, bonus_seconds: 5, new_time: newTime });
                
                const prizeAmount = PRIZE_LADDER[questionNumber];
                const isSafe = SAFE_CHECKPOINTS.includes(questionNumber);
                
                let message = `💎 50:50 ACTIVATED! 💎\n\nTwo wrong answers removed!\n+5 bonus seconds added!\n\n`;
                message += `❓ QUESTION ${questionNumber} - ₦${prizeAmount.toLocaleString()}`;
                if (isSafe) message += ' (SAFE) 🔒';
                message += `\n\n${question.question_text}\n\n`;
                remainingOptions.forEach(opt => { message += `${opt}) ${question['option_' + opt.toLowerCase()]}\n`; });
                message += `\n⏱️ ${newTime} seconds...\n\n`;
                const lifelines = [];
                if (!currentSession.lifeline_skip_used) lifelines.push('Skip');
                if (lifelines.length > 0) message += `💎 Lifelines: ${lifelines.join(' | ')}`;
                
                await messagingService.sendMessage(user.phone_number, message);
                
                await redis.setex(timeoutKey, newTime + 5, (Date.now() + newTime * 1000).toString());
                const timeoutId = setTimeout(async () => {
                    try {
                        const t = await redis.get(timeoutKey);
                        if (t) {
                            const as = await this.getActiveSession(user.id);
                            if (as && as.current_question === questionNumber) {
                                await redis.del(timeoutKey);
                                activeTimeouts.delete(timeoutKey);
                                await this.handleTimeout(as, user);
                            }
                        }
                    } catch (error) { logger.error('Error in 50:50 timeout:', error); }
                }, newTime * 1000);
                activeTimeouts.set(timeoutKey, timeoutId);
                
            } else if (lifeline === 'skip') {
                if (currentSession.lifeline_skip_used) { await messagingService.sendMessage(user.phone_number, '❌ You already used Skip!'); return; }
                
                const questionNumber = currentSession.current_question;
                const timeoutKey = `timeout:${currentSession.session_key}:q${questionNumber}`;
                this.clearQuestionTimeout(timeoutKey);
                await redis.del(timeoutKey);
                
                await pool.query('UPDATE game_sessions SET lifeline_skip_used = true WHERE id = $1', [currentSession.id]);
                await auditService.logLifelineUsed(currentSession.id, user.id, questionNumber, 'Skip', { skipped_question_id: currentSession.current_question_id });
                
                await messagingService.sendMessage(user.phone_number, `⏭️ SKIP USED! ⏭️\n\nGetting a new question at the same level...`);
                
                currentSession.lifeline_skip_used = true;
                await this.updateSession(currentSession);
                
                setTimeout(async () => {
                    const as = await this.getActiveSession(user.id);
                    if (as && as.id === currentSession.id) { await this.sendQuestionOrCaptcha(currentSession, user); }
                }, 1500);
            }
        } catch (error) {
            logger.error('Error using lifeline:', error);
            throw error;
        }
    }

    // ============================================
    // SESSION MANAGEMENT
    // ============================================

    async getActiveSession(userId) {
        const result = await pool.query(`SELECT * FROM game_sessions WHERE user_id = $1 AND status = 'active' ORDER BY started_at DESC LIMIT 1`, [userId]);
        return result.rows[0] || null;
    }

    async updateSession(session) {
        await pool.query(`
            UPDATE game_sessions
            SET current_question = $1, current_score = $2, current_question_id = $3,
                lifeline_5050_used = $4, lifeline_skip_used = $5
            WHERE id = $6
        `, [session.current_question, session.current_score, session.current_question_id, session.lifeline_5050_used, session.lifeline_skip_used, session.id]);
        await redis.setex(`session:${session.session_key}`, 3600, JSON.stringify(session));
    }

    async getLeaderboard(period = 'daily', limit = 10) {
        try {
            let dateCondition;
            switch(period.toLowerCase()) {
                case 'daily': dateCondition = 'CURRENT_DATE'; break;
                case 'weekly': dateCondition = "CURRENT_DATE - INTERVAL '7 days'"; break;
                case 'monthly': dateCondition = "CURRENT_DATE - INTERVAL '30 days'"; break;
                case 'all': dateCondition = "'1970-01-01'"; break;
                default: dateCondition = 'CURRENT_DATE';
            }
            const result = await pool.query(`
                SELECT u.full_name, u.username, u.city, t.amount as score
                FROM transactions t JOIN users u ON t.user_id = u.id
                WHERE t.created_at >= ${dateCondition} AND t.transaction_type = 'prize'
                ORDER BY t.amount DESC, t.created_at DESC LIMIT $1
            `, [limit]);
            return result.rows;
        } catch (error) {
            logger.error('Error fetching leaderboard:', error);
            throw error;
        }
    }
}

module.exports = GameService;