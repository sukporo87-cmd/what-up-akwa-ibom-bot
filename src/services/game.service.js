// ============================================
// FILE: src/services/game.service.js
// COMPLETE FILE - READY TO PASTE AND REPLACE
// CHANGES: Added platform tracking and audit logging
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const MessagingService = require('./messaging.service');
const QuestionService = require('./question.service');
const PaymentService = require('./payment.service');
const auditService = require('./audit.service');
const streakService = require('./streak.service');
const { logger } = require('../utils/logger');

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

    clearQuestionTimeout(timeoutKey) {
        const timeoutId = activeTimeouts.get(timeoutKey);
        if (timeoutId) {
            clearTimeout(timeoutId);
            activeTimeouts.delete(timeoutKey);
            logger.debug(`Cleared timeout for ${timeoutKey}. Remaining: ${activeTimeouts.size}`);
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
        
        if (cleared > 0) {
            logger.info(`Cleared ${cleared} timeouts for session ${sessionKey}`);
        }
    }

    // ============================================
    // GAME LIFECYCLE
    // ============================================

    async startNewGame(user, gameMode = 'classic', tournamentId = null) {
        try {
            // 🔧 NEW: Determine platform from user
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
                        '❌ You have no games remaining!\n\n' +
                        'Type BUY to purchase more games.'
                    );
                    return;
                }
                shouldDeductToken = true;
            }

            let tournamentUsesTokens = false;
            let hasTokensRemaining = true;
            
            if (isTournamentGame) {
                const TournamentService = require('./tournament.service');
                const tournamentService = new TournamentService();
                
                const tournament = await tournamentService.getTournamentById(tournamentId);
                
                if (!tournament) {
                    await messagingService.sendMessage(
                        user.phone_number,
                        '❌ Tournament not found!'
                    );
                    return;
                }
                
                tournamentUsesTokens = tournament.uses_tokens;
                
                const canPlay = await tournamentService.canUserPlay(user.id, tournamentId);
                
                if (!canPlay) {
                    const status = await tournamentService.getUserTournamentStatus(user.id, tournamentId);
                    
                    if (!status) {
                        await messagingService.sendMessage(
                            user.phone_number,
                            '❌ You have not joined this tournament!\n\n' +
                            'Type TOURNAMENTS to view available tournaments.'
                        );
                    } else if (status.uses_tokens && status.tokens_remaining <= 0) {
                        await messagingService.sendMessage(
                            user.phone_number,
                            '❌ You have no tournament tokens remaining!\n\n' +
                            `You've used all ${status.tokens_per_entry} attempts for this tournament.\n\n` +
                            'Type TOURNAMENTS to view other tournaments.'
                        );
                    } else if (status.payment_status !== 'success') {
                        await messagingService.sendMessage(
                            user.phone_number,
                            '❌ Payment not completed!\n\n' +
                            'Complete payment to access this tournament.\n\n' +
                            'Type TOURNAMENTS to try again.'
                        );
                    }
                    return;
                }
                
                if (tournamentUsesTokens) {
                    const status = await tournamentService.getUserTournamentStatus(user.id, tournamentId);
                    
                    if (!status || status.tokens_remaining <= 0) {
                        await messagingService.sendMessage(
                            user.phone_number,
                            '❌ No tokens remaining for this tournament!'
                        );
                        return;
                    }
                    
                    const deductResult = await pool.query(`
                        UPDATE tournament_participants
                        SET tokens_remaining = tokens_remaining - 1,
                            tokens_used = tokens_used + 1,
                            games_played_in_tournament = games_played_in_tournament + 1
                        WHERE user_id = $1 AND tournament_id = $2
                        AND tokens_remaining > 0
                        RETURNING tokens_remaining
                    `, [user.id, tournamentId]);
                    
                    if (deductResult.rows.length === 0) {
                        await messagingService.sendMessage(
                            user.phone_number,
                            '❌ Failed to deduct token. Please try again.'
                        );
                        return;
                    }
                    
                    const tokensLeft = deductResult.rows[0].tokens_remaining;
                    logger.info(`🎟️ Tournament token deducted for user ${user.id} in tournament ${tournamentId}. Tokens remaining: ${tokensLeft}`);
                    
                    tokenDeducted = true;
                }
            }

            const existingSession = await this.getActiveSession(user.id);
            if (existingSession) {
                await messagingService.sendMessage(
                    user.phone_number,
                    '⚠️ You already have an active game! Complete it first or type RESET.'
                );
                return;
            }

            if (shouldDeductToken) {
                const gamesLeft = await paymentService.deductGame(user.id);
                tokenDeducted = true;
                logger.info(`Regular game token deducted for user ${user.id} - Games remaining: ${gamesLeft}`);
            }

            const sessionKey = `game_${user.id}_${Date.now()}`;

            // 🔧 UPDATED: Create game session WITH PLATFORM
            const result = await pool.query(`
                INSERT INTO game_sessions (
                    user_id, session_key, current_question, current_score,
                    game_mode, tournament_id, is_tournament_game,
                    token_deducted, game_type, platform
                )
                VALUES ($1, $2, 1, 0, $3, $4, $5, $6, $7, $8)
                RETURNING *
            `, [
                user.id, sessionKey, gameMode, tournamentId,
                isTournamentGame, tokenDeducted, gameType, platform
            ]);

            const session = result.rows[0];
            await redis.setex(`session:${sessionKey}`, 3600, JSON.stringify(session));

            // 📝 AUDIT: Log game start
            await auditService.logGameStart(session.id, user.id, gameMode, platform, tournamentId);

            // 🔥 STREAK: Update user's daily streak (only for classic/tournament)
            let streakResult = null;
            if (gameMode === 'classic' || isTournamentGame) {
                try {
                    streakResult = await streakService.updateStreak(user.id, isTournamentGame ? 'tournament' : 'classic');
                    if (streakResult.reward) {
                        // Send streak reward notification
                        const rewardMessage = streakService.formatRewardMessage(streakResult.reward);
                        await messagingService.sendMessage(user.phone_number, rewardMessage);
                    }
                } catch (streakError) {
                    logger.error('Error updating streak:', streakError);
                    // Don't fail the game start if streak update fails
                }
            }

            logger.info(`🎮 Game started: User ${user.id}, Platform: ${platform}, Mode: ${gameMode}, Type: ${gameType}`);

            let gameModeText = '';
            let instructions = '';
            let branding = 'Proudly brought to you by SummerIsland Systems.';

            if (isPracticeMode) {
                gameModeText = '🎓 PRACTICE MODE';
                instructions = await this.getPracticeModeInstructions();
            } else if (isTournamentGame) {
                const TournamentService = require('./tournament.service');
                const tournamentService = new TournamentService();
                const tournament = await tournamentService.getTournamentById(tournamentId);
                const customInstructions = await tournamentService.getTournamentInstructions(tournamentId);

                gameModeText = `🏆 ${tournament.tournament_name.toUpperCase()}`;
                
                if (customInstructions && customInstructions.instructions) {
                    instructions = customInstructions.instructions;
                    branding = customInstructions.branding || branding;
                } else {
                    instructions = await this.getDefaultTournamentInstructions(tournament);
                    if (tournament.custom_branding) {
                        branding = tournament.custom_branding;
                    }
                }
                
                if (tournamentUsesTokens) {
                    const status = await tournamentService.getUserTournamentStatus(user.id, tournamentId);
                    if (status && status.tokens_remaining !== null) {
                        instructions += `\n\n🎟️ TOKENS REMAINING: ${status.tokens_remaining}`;
                    }
                }
            } else {
                switch(gameMode) {
                    case 'classic':
                        gameModeText = '🎮 CLASSIC MODE';
                        break;
                    case 'akwa_ibom':
                        gameModeText = '🏛️ AKWA IBOM EDITION';
                        break;
                    case 'world':
                        gameModeText = '🌍 WORLD EDITION';
                        break;
                    default:
                        gameModeText = '🎮 GAME MODE';
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
        return `🎓 PRACTICE MODE INSTRUCTIONS 🎓

📋 RULES:
- 15 questions
- 15 seconds per question
- ⚠️ NO PRIZES in practice mode
- Perfect for learning!

💎 LIFELINES:
5️⃣0️⃣ 50:50 - Remove 2 wrong answers
⏭️ Skip - Replace with new question

Use this mode to familiarize yourself with the game!
When ready, play Classic Mode to win real prizes! 🏆`;
    }

    async getDefaultGameInstructions() {
        return `🎮 GAME INSTRUCTIONS 🎮

📋 RULES:
- 15 questions
- 15 seconds per question
- Win up to ₦50,000!

💎 LIFELINES:
5️⃣0️⃣ 50:50 - Remove 2 wrong answers (Type '50' to activate)
⏭️ Skip - Replace with new question (Type 'Skip' to activate)

🏆 PRIZE LADDER:
Q15: ₦50,000 🥇
Q12: ₦25,000
Q10: ₦10,000 (SAFE)
Q8: ₦5,000
Q5: ₦1,000 (SAFE)

Safe amounts are guaranteed!`;
    }

    async getDefaultTournamentInstructions(tournament) {
        const prizeText = tournament.prize_pool ? 
            `Win up to ₦${tournament.prize_pool.toLocaleString()}!` : 
            'Compete for amazing prizes!';
        
        return `🏆 TOURNAMENT INSTRUCTIONS 🏆

📋 RULES:
- 15 questions
- 15 seconds per question
- ${prizeText}
- Top 10 winners share prize pool

💎 LIFELINES:
5️⃣0️⃣ 50:50 - Remove 2 wrong answers
⏭️ Skip - Replace with new question

Your BEST score counts!
Play as many times as allowed!`;
    }

    async completeGame(session, user, wonGrandPrize) {
        try {
            const finalScore = session.current_score;
            const questionNumber = session.current_question;
            
            const timeoutKey = `timeout:${session.session_key}:q${questionNumber}`;
            this.clearQuestionTimeout(timeoutKey);
            this.clearAllSessionTimeouts(session.session_key);

            // Determine outcome
            let outcome = 'completed';
            if (wonGrandPrize) {
                outcome = 'grand_prize';
            } else if (finalScore === 0) {
                outcome = 'wrong_answer';
            }

            // 📝 AUDIT: Log game end
            await auditService.logGameEnd(
                session.id, 
                user.id, 
                finalScore, 
                questionNumber - 1, 
                outcome,
                finalScore
            );

            await pool.query(`
                UPDATE game_sessions
                SET status = 'completed', completed_at = NOW(), final_score = $1
                WHERE id = $2
            `, [finalScore, session.id]);

            await pool.query(`
                UPDATE users
                SET total_games_played = total_games_played + 1,
                    total_winnings = total_winnings + $1,
                    highest_question_reached = GREATEST(highest_question_reached, $2),
                    last_active = NOW()
                WHERE id = $3
            `, [finalScore, session.current_question, user.id]);

            if (session.game_type !== 'practice' && finalScore > 0) {
                await pool.query(`
                    INSERT INTO transactions (user_id, session_id, amount, transaction_type, payment_status)
                    VALUES ($1, $2, $3, 'prize', 'pending')
                `, [user.id, session.id, finalScore]);
            }

            if (session.is_tournament_game && session.tournament_id) {
                const TournamentService = require('./tournament.service');
                const tournamentService = new TournamentService();
                
                await pool.query(`
                    INSERT INTO tournament_game_sessions
                    (tournament_id, user_id, game_session_id, score, questions_answered, completed, token_deducted)
                    VALUES ($1, $2, $3, $4, $5, true, $6)
                `, [
                    session.tournament_id, 
                    user.id, 
                    session.id, 
                    finalScore, 
                    session.current_question - 1,
                    session.token_deducted
                ]);
                
                await tournamentService.updateParticipantScore(
                    user.id,
                    session.tournament_id,
                    finalScore
                );
                
                const tokenStatus = await pool.query(`
                    SELECT tokens_remaining, uses_tokens
                    FROM tournament_participants tp
                    JOIN tournaments t ON tp.tournament_id = t.id
                    WHERE tp.user_id = $1 AND tp.tournament_id = $2
                `, [user.id, session.tournament_id]);
                
                if (tokenStatus.rows.length > 0 && tokenStatus.rows[0].uses_tokens) {
                    logger.info(`✅ Tournament game completed. User ${user.id} has ${tokenStatus.rows[0].tokens_remaining} tokens remaining`);
                }
            }

            await redis.del(`session:${session.session_key}`);
            await redis.del(`asked_questions:${session.session_key}`);
            await redis.del(`game_ready:${user.id}`);
            await redis.del(`user_state:${user.phone_number}`);

            if (session.game_type !== 'practice' && finalScore > 0) {
                await redis.setex(`win_share_pending:${user.id}`, 300, JSON.stringify({
                    amount: finalScore,
                    questionsAnswered: session.current_question - 1,
                    totalQuestions: 15
                }));
            }

            if (session.game_type === 'practice') {
                await this.sendPracticeCompleteMessage(user, finalScore, questionNumber);
            } else if (wonGrandPrize) {
                await this.sendGrandPrizeMessage(user, finalScore);
            } else if (finalScore > 0) {
                await this.sendWinMessage(user, finalScore, questionNumber);
            }

            // Store post-game state with game type so menu handling knows the context
            await redis.setex(`post_game:${user.id}`, 45, JSON.stringify({
                timestamp: Date.now(),
                gameType: session.game_type,
                finalScore: finalScore
            }));

        } catch (error) {
            logger.error('Error completing game:', error);
            throw error;
        }
    }

    async sendPracticeCompleteMessage(user, score, questionNumber) {
        let message = `🎓 PRACTICE COMPLETE! 🎓\n\n`;
        message += `Great job, ${user.full_name}!\n\n`;
        message += `You answered ${questionNumber - 1}/15 questions correctly.\n`;
        message += `Potential Score: ₦${score.toLocaleString()}\n\n`;
        message += `⚠️ This was practice mode - no real prizes.\n\n`;
        message += `Ready to play for REAL prizes?\n\n`;
        message += `1️⃣ Play Again\n`;
        message += `2️⃣ View Leaderboard\n`;
        message += `3️⃣ Main Menu\n\n`;
        message += `Type PLAY to start Classic Mode and win real money! 💰`;
        
        await messagingService.sendMessage(user.phone_number, message);
    }

    async sendGrandPrizeMessage(user, finalScore) {
        let message = `🎊 INCREDIBLE! 🎊\n`;
        message += `🏆 CHAMPION! 🏆\n\n`;
        message += `ALL 15 QUESTIONS CORRECT!\n\n`;
        message += `💰 ₦${finalScore.toLocaleString()} WON! 💰\n\n`;
        message += `${user.full_name.toUpperCase()}, you're in the HALL OF FAME!\n\n`;
        message += `Prize processed in 24-48 hours.\n\n`;
        message += `Would you like to share your win? Reply YES for victory card! 🎉\n\n`;
        message += `1️⃣ Play Again\n`;
        message += `2️⃣ View Leaderboard\n`;
        message += `3️⃣ Claim Prize\n`;
        message += `4️⃣ Share Victory Card`;
        
        await messagingService.sendMessage(user.phone_number, message);
    }

    async sendWinMessage(user, finalScore, questionNumber) {
        let message = `Congratulations ${user.full_name}! 🎉\n\n`;
        message += `You won ₦${finalScore.toLocaleString()}!\n\n`;
        message += `Would you like to share your win on WhatsApp Status? Reply YES to get your victory card! 📸\n\n`;
        message += `1️⃣ Play Again\n`;
        message += `2️⃣ View Leaderboard\n`;
        message += `3️⃣ Claim Prize\n`;
        message += `4️⃣ Share Victory Card\n\n`;
        message += `Type MENU for more options.`;
        
        await messagingService.sendMessage(user.phone_number, message);
    }

    async sendQuestion(session, user) {
        try {
            const questionNumber = session.current_question;
            const prizeAmount = PRIZE_LADDER[questionNumber];
            const isSafe = SAFE_CHECKPOINTS.includes(questionNumber);
            const timeoutKey = `timeout:${session.session_key}:q${questionNumber}`;
            
            this.clearQuestionTimeout(timeoutKey);
            
            const askedQuestionsKey = `asked_questions:${session.session_key}`;
            const askedQuestionsJson = await redis.get(askedQuestionsKey);
            const askedQuestions = askedQuestionsJson ? JSON.parse(askedQuestionsJson) : [];
            
            const question = await questionService.getQuestionByDifficulty(
                questionNumber, 
                askedQuestions,
                session.game_mode,
                session.tournament_id
            );
            
            if (!question) {
                throw new Error('No question found');
            }
            
            askedQuestions.push(question.id);
            await redis.setex(askedQuestionsKey, 3600, JSON.stringify(askedQuestions));
            
            session.current_question_id = question.id;
            await this.updateSession(session);
            
            // 📝 AUDIT: Log question asked
            await auditService.logQuestionAsked(session.id, user.id, questionNumber, question, prizeAmount);
            
            let message = `❓ QUESTION ${questionNumber} - ₦${prizeAmount.toLocaleString()}`;
            if (isSafe) message += ' (SAFE) 🔒';
            message += `\n\n${question.question_text}\n\n`;
            message += `A) ${question.option_a}\n`;
            message += `B) ${question.option_b}\n`;
            message += `C) ${question.option_c}\n`;
            message += `D) ${question.option_d}\n\n`;
            message += `⏱️ 15 seconds...\n\n`;
            
            const lifelines = [];
            if (!session.lifeline_5050_used) lifelines.push('50:50');
            if (!session.lifeline_skip_used) lifelines.push('Skip');
            
            if (lifelines.length > 0) {
                message += `💎 Lifelines: ${lifelines.join(' | ')}`;
            }
            
            await messagingService.sendMessage(user.phone_number, message);
            
            await redis.setex(timeoutKey, 18, (Date.now() + 15000).toString());
            
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
                } catch (error) {
                    logger.error('Error in timeout handler:', error);
                }
            }, 15000);
            
            activeTimeouts.set(timeoutKey, timeoutId);
            
        } catch (error) {
            logger.error('Error sending question:', error);
            throw error;
        }
    }

    async processAnswer(session, user, answer) {
        try {
            const questionNumber = session.current_question;
            const timeoutKey = `timeout:${session.session_key}:q${questionNumber}`;
            
            const timeout = await redis.get(timeoutKey);
            if (timeout && Date.now() > Number(timeout)) {
                await this.handleTimeout(session, user);
                return;
            }
            
            await redis.del(timeoutKey);
            this.clearQuestionTimeout(timeoutKey);
            
            if (!session.current_question_id) {
                await messagingService.sendMessage(
                    user.phone_number,
                    '❌ Session error. Type RESET to start a new game.'
                );
                return;
            }
            
            const question = await questionService.getQuestionById(session.current_question_id);
            
            if (!question) {
                await messagingService.sendMessage(
                    user.phone_number,
                    '❌ Question error. Type RESET to start a new game.'
                );
                return;
            }
            
            const isCorrect = answer === question.correct_answer;
            const prizeAmount = PRIZE_LADDER[questionNumber];
            
            // 📝 AUDIT: Log answer given
            await auditService.logAnswer(
                session.id, 
                user.id, 
                questionNumber, 
                answer, 
                question.correct_answer, 
                isCorrect, 
                isCorrect ? prizeAmount : session.current_score
            );
            
            if (isCorrect) {
                session.current_score = prizeAmount;
                session.current_question = questionNumber + 1;
                
                let message = `✅ CORRECT! 🎉\n\n`;
                if (question.fun_fact) message += `${question.fun_fact}\n\n`;
                message += `💰 You've won: ₦${prizeAmount.toLocaleString()}\n`;
                message += `💪 Question: ${questionNumber} of 15\n`;
                
                if (SAFE_CHECKPOINTS.includes(questionNumber)) {
                    message += `\n🔒 SAFE! ₦${prizeAmount.toLocaleString()} guaranteed!\n`;
                }
                
                await messagingService.sendMessage(user.phone_number, message);
                
                if (questionNumber === 15) {
                    await this.completeGame(session, user, true);
                } else {
                    await this.updateSession(session);
                    
                    setTimeout(async () => {
                        const activeSession = await this.getActiveSession(user.id);
                        if (activeSession && activeSession.id === session.id) {
                            await this.sendQuestion(session, user);
                        }
                    }, 3000);
                }
            } else {
                await this.handleWrongAnswer(session, user, question);
            }
            
            await questionService.updateQuestionStats(question.id, isCorrect);
            
        } catch (error) {
            logger.error('Error processing answer:', error);
            throw error;
        }
    }

    async handleWrongAnswer(session, user, question) {
        const questionNumber = session.current_question;
        let guaranteedAmount = 0;
        
        for (const checkpoint of [...SAFE_CHECKPOINTS].reverse()) {
            if (questionNumber > checkpoint) {
                guaranteedAmount = PRIZE_LADDER[checkpoint];
                break;
            }
        }
        
        let message = `❌ WRONG ANSWER 😢\n\n`;
        message += `Correct: ${question.correct_answer}) ${question['option_' + question.correct_answer.toLowerCase()]}\n\n`;
        
        if (question.fun_fact) message += `${question.fun_fact}\n\n`;
        
        message += `🎮 GAME OVER 🎮\n\n`;
        
        if (guaranteedAmount > 0) {
            message += `You reached a safe checkpoint!\n`;
            message += `💰 You won: ₦${guaranteedAmount.toLocaleString()} 🎉\n\n`;
            session.current_score = guaranteedAmount;
        } else {
            message += `💰 You won: ₦0\n\n`;
            session.current_score = 0;
        }
        
        message += `Well played, ${user.full_name}! 👏\n\n`;
        message += `1️⃣ Play Again\n`;
        message += `2️⃣ View Leaderboard\n`;
        if (guaranteedAmount > 0) {
            message += `3️⃣ Claim Prize\n`;
        }
        message += `\nType MENU for main menu.`;
        
        await messagingService.sendMessage(user.phone_number, message);
        await this.completeGame(session, user, false);
    }

    async handleTimeout(session, user) {
        // 📝 AUDIT: Log timeout
        await auditService.logTimeout(session.id, user.id, session.current_question);
        
        let guaranteedAmount = 0;
        for (const checkpoint of [...SAFE_CHECKPOINTS].reverse()) {
            if (session.current_question > checkpoint) {
                guaranteedAmount = PRIZE_LADDER[checkpoint];
                break;
            }
        }
        
        let message = `⏰ TIME'S UP! 😢\n\n`;
        message += `You didn't answer in time.\n\n`;
        message += `🎮 GAME OVER 🎮\n\n`;
        
        if (guaranteedAmount > 0) {
            message += `You reached a safe checkpoint!\n`;
            message += `💰 You won: ₦${guaranteedAmount.toLocaleString()} 🎉\n\n`;
        } else {
            message += `💰 You won: ₦0\n\n`;
        }
        
        message += `1️⃣ Play Again\n`;
        message += `2️⃣ View Leaderboard\n`;
        if (guaranteedAmount > 0) {
            message += `3️⃣ Claim Prize\n`;
        }
        message += `\nType MENU for main menu.`;
        
        await messagingService.sendMessage(user.phone_number, message);
        
        session.current_score = guaranteedAmount;
        await this.completeGame(session, user, false);
    }

    async useLifeline(session, user, lifeline) {
        try {
            const currentSession = await this.getActiveSession(user.id);
            
            if (!currentSession) {
                await messagingService.sendMessage(user.phone_number, '❌ No active game found.');
                return;
            }
            
            const question = await questionService.getQuestionById(currentSession.current_question_id);
            
            if (!question) {
                throw new Error('Question not found');
            }
            
            if (lifeline === 'fifty_fifty') {
                if (currentSession.lifeline_5050_used) {
                    await messagingService.sendMessage(user.phone_number, '❌ You already used 50:50!');
                    return;
                }
                
                await pool.query(
                    'UPDATE game_sessions SET lifeline_5050_used = true WHERE id = $1',
                    [currentSession.id]
                );
                
                const correctAnswer = question.correct_answer;
                const allOptions = ['A', 'B', 'C', 'D'];
                const wrongOptions = allOptions.filter(opt => opt !== correctAnswer);
                const keepWrong = wrongOptions[Math.floor(Math.random() * wrongOptions.length)];
                const remainingOptions = [correctAnswer, keepWrong].sort();
                
                // 📝 AUDIT: Log 50:50 lifeline used
                await auditService.logLifelineUsed(
                    currentSession.id, 
                    user.id, 
                    currentSession.current_question, 
                    '50:50',
                    { removed_options: wrongOptions.filter(o => o !== keepWrong), remaining_options: remainingOptions }
                );
                
                const questionNumber = currentSession.current_question;
                const prizeAmount = PRIZE_LADDER[questionNumber];
                const isSafe = SAFE_CHECKPOINTS.includes(questionNumber);
                
                let message = `💎 50:50 ACTIVATED! 💎\n\nTwo wrong answers removed!\n\n`;
                message += `❓ QUESTION ${questionNumber} - ₦${prizeAmount.toLocaleString()}`;
                if (isSafe) message += ' (SAFE) 🔒';
                message += `\n\n${question.question_text}\n\n`;
                
                remainingOptions.forEach(opt => {
                    message += `${opt}) ${question['option_' + opt.toLowerCase()]}\n`;
                });
                
                message += `\n⏱️ 15 seconds...\n\n`;
                
                const lifelines = [];
                if (!currentSession.lifeline_skip_used) lifelines.push('Skip');
                if (lifelines.length > 0) {
                    message += `💎 Lifelines: ${lifelines.join(' | ')}`;
                }
                
                await messagingService.sendMessage(user.phone_number, message);
                
            } else if (lifeline === 'skip') {
                if (currentSession.lifeline_skip_used) {
                    await messagingService.sendMessage(user.phone_number, '❌ You already used Skip!');
                    return;
                }
                
                const questionNumber = currentSession.current_question;
                const timeoutKey = `timeout:${currentSession.session_key}:q${questionNumber}`;
                
                this.clearQuestionTimeout(timeoutKey);
                await redis.del(timeoutKey);
                
                await pool.query(
                    'UPDATE game_sessions SET lifeline_skip_used = true WHERE id = $1',
                    [currentSession.id]
                );
                
                // 📝 AUDIT: Log Skip lifeline used
                await auditService.logLifelineUsed(
                    currentSession.id, 
                    user.id, 
                    questionNumber, 
                    'Skip',
                    { skipped_question_id: currentSession.current_question_id }
                );
                
                await messagingService.sendMessage(
                    user.phone_number,
                    `⏭️ SKIP USED! ⏭️\n\nGetting a new question at the same level...`
                );
                
                currentSession.lifeline_skip_used = true;
                await this.updateSession(currentSession);
                
                setTimeout(async () => {
                    const activeSession = await this.getActiveSession(user.id);
                    if (activeSession && activeSession.id === currentSession.id) {
                        await this.sendQuestion(currentSession, user);
                    }
                }, 1500);
            }
            
        } catch (error) {
            logger.error('Error using lifeline:', error);
            throw error;
        }
    }

    async getActiveSession(userId) {
        const result = await pool.query(`
            SELECT * FROM game_sessions
            WHERE user_id = $1 AND status = 'active'
            ORDER BY started_at DESC
            LIMIT 1
        `, [userId]);
        
        return result.rows[0] || null;
    }

    async updateSession(session) {
        await pool.query(`
            UPDATE game_sessions
            SET current_question = $1, current_score = $2, current_question_id = $3,
                lifeline_5050_used = $4, lifeline_skip_used = $5
            WHERE id = $6
        `, [
            session.current_question, session.current_score, session.current_question_id,
            session.lifeline_5050_used, session.lifeline_skip_used, session.id
        ]);
        
        await redis.setex(`session:${session.session_key}`, 3600, JSON.stringify(session));
    }

    async getLeaderboard(period = 'daily', limit = 10) {
        try {
            let dateCondition;
            
            switch(period.toLowerCase()) {
                case 'daily':
                    dateCondition = 'CURRENT_DATE';
                    break;
                case 'weekly':
                    dateCondition = "CURRENT_DATE - INTERVAL '7 days'";
                    break;
                case 'monthly':
                    dateCondition = "CURRENT_DATE - INTERVAL '30 days'";
                    break;
                case 'all':
                    dateCondition = "'1970-01-01'";
                    break;
                default:
                    dateCondition = 'CURRENT_DATE';
            }
            
            const result = await pool.query(`
                SELECT u.full_name, u.username, u.city, t.amount as score
                FROM transactions t
                JOIN users u ON t.user_id = u.id
                WHERE t.created_at >= ${dateCondition}
                AND t.transaction_type = 'prize'
                ORDER BY t.amount DESC, t.created_at DESC
                LIMIT $1
            `, [limit]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error fetching leaderboard:', error);
            throw error;
        }
    }
}

module.exports = GameService;