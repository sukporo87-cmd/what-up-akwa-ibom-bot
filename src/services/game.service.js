const pool = require('../config/database');
const redis = require('../config/redis');
const WhatsAppService = require('./whatsapp.service');
const QuestionService = require('./question.service');
const PaymentService = require('./payment.service');
const { logger } = require('../utils/logger');

const whatsappService = new WhatsAppService();
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
  async startNewGame(user) {
  try {
    // Check if payment is enabled and user has games
    if (paymentService.isEnabled()) {
      const hasGames = await paymentService.hasGamesRemaining(user.id);
      
      if (!hasGames) {
        await whatsappService.sendMessage(
          user.phone_number,
          '❌ You have no games remaining!\n\n' +
          'Type BUY to purchase more games.'
        );
        return;
      }

      // Deduct one game and get remaining count
      const gamesLeft = await paymentService.deductGame(user.id);
      
      logger.info(`Game started for user ${user.id} - Games remaining: ${gamesLeft}`);
    }

    // Check for existing active session
    const existingSession = await this.getActiveSession(user.id);
    if (existingSession) {
      await whatsappService.sendMessage(
        user.phone_number,
        '⚠️ You already have an active game! Complete it first.'
      );
      return;
    }

    const sessionKey = `game_${user.id}_${Date.now()}`;
    const result = await pool.query(
      `INSERT INTO game_sessions (user_id, session_key, current_question, current_score)
       VALUES ($1, $2, 1, 0)
       RETURNING *`,
      [user.id, sessionKey]
    );

    const session = result.rows[0];
    await redis.setex(`session:${sessionKey}`, 3600, JSON.stringify(session));

    await whatsappService.sendMessage(
      user.phone_number,
      `🎮 GAME INSTRUCTIONS 🎮

📋 RULES:
- 15 questions about Akwa Ibom
- 15 seconds per question
- Win up to ₦50,000!

💎 LIFELINES:
5️⃣0️⃣ 50:50 - Remove 2 wrong answers
⏭️ Skip - Replace with new question (same level)

Safe points: Q5 (₦1,000) & Q10 (₦10,000)

When you're ready, reply START to begin! 🚀`
    );

    await redis.setex(`game_ready:${user.id}`, 300, sessionKey);

  } catch (error) {
    logger.error('Error starting game:', error);
    throw error;
  }
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

      const question = await questionService.getQuestionByDifficulty(questionNumber, askedQuestions);

      if (!question) {
        throw new Error('No question found');
      }

      askedQuestions.push(question.id);
      await redis.setex(askedQuestionsKey, 3600, JSON.stringify(askedQuestions));

      session.current_question_id = question.id;
      await this.updateSession(session);

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

      await whatsappService.sendMessage(user.phone_number, message);

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

  clearQuestionTimeout(timeoutKey) {
    const timeoutId = activeTimeouts.get(timeoutKey);
    if (timeoutId) {
      clearTimeout(timeoutId);
      activeTimeouts.delete(timeoutKey);
      logger.info(`Cleared timeout for ${timeoutKey}`);
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
        await whatsappService.sendMessage(
          user.phone_number,
          '❌ Session error. Type RESET to start a new game.'
        );
        return;
      }

      const question = await questionService.getQuestionById(session.current_question_id);

      if (!question) {
        await whatsappService.sendMessage(
          user.phone_number,
          '❌ Question error. Type RESET to start a new game.'
        );
        return;
      }

      const isCorrect = answer === question.correct_answer;
      const prizeAmount = PRIZE_LADDER[questionNumber];

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

        await whatsappService.sendMessage(user.phone_number, message);

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
    message += `1️⃣ Play Again\n2️⃣ View Leaderboard\n`;
    if (guaranteedAmount > 0) message += `3️⃣ Claim Prize`;

    await whatsappService.sendMessage(user.phone_number, message);

    await this.completeGame(session, user, false);
  }

  async handleTimeout(session, user) {
    await whatsappService.sendMessage(
      user.phone_number,
      `⏰ TIME'S UP! 😢\n\nYou didn't answer in time.\n\nGame Over!`
    );

    let guaranteedAmount = 0;
    for (const checkpoint of [...SAFE_CHECKPOINTS].reverse()) {
      if (session.current_question > checkpoint) {
        guaranteedAmount = PRIZE_LADDER[checkpoint];
        break;
      }
    }

    session.current_score = guaranteedAmount;
    await this.completeGame(session, user, false);
  }

  async completeGame(session, user, wonGrandPrize) {
    try {
      const finalScore = session.current_score;

      const questionNumber = session.current_question;
      const timeoutKey = `timeout:${session.session_key}:q${questionNumber}`;
      this.clearQuestionTimeout(timeoutKey);

      await pool.query(
        `UPDATE game_sessions
         SET status = 'completed', completed_at = NOW(), final_score = $1
         WHERE id = $2`,
        [finalScore, session.id]
      );

      await pool.query(
        `UPDATE users
         SET total_games_played = total_games_played + 1,
             total_winnings = total_winnings + $1,
             highest_question_reached = GREATEST(highest_question_reached, $2),
             last_active = NOW()
         WHERE id = $3`,
        [finalScore, session.current_question, user.id]
      );

      if (finalScore > 0) {
        await pool.query(
          `INSERT INTO transactions (user_id, session_id, amount, transaction_type, payment_status)
           VALUES ($1, $2, $3, 'prize', 'pending')`,
          [user.id, session.id, finalScore]
        );
      }

      await redis.del(`session:${session.session_key}`);
      await redis.del(`asked_questions:${session.session_key}`);

      if (wonGrandPrize) {
        await whatsappService.sendMessage(
          user.phone_number,
          `🎊 INCREDIBLE! 🎊
🏆 CHAMPION! 🏆

ALL 15 QUESTIONS CORRECT!

💰 ₦50,000 WON! 💰

${user.full_name.toUpperCase()}, you're in the HALL OF FAME!

Prize processed in 24-48 hours.

Would you like to share your win? Reply YES to get your victory card! 🎉

1️⃣ Play Again
2️⃣ View Leaderboard
3️⃣ Claim Prize`);
      } else if (finalScore > 0) {
        await whatsappService.sendMessage(
          user.phone_number,
          `Congratulations ${user.full_name}! 🎉

You won ₦${finalScore.toLocaleString()}!

Would you like to share your win on WhatsApp Status? Reply YES to get your victory card! 📸`
        );
      }

      if (finalScore > 0) {
        await redis.setex(`win_share_pending:${user.id}`, 300, JSON.stringify({
          amount: finalScore,
          questionsAnswered: session.current_question - 1,
          totalQuestions: 15
        }));
      }

    } catch (error) {
      logger.error('Error completing game:', error);
      throw error;
    }
  }

  async useLifeline(session, user, lifeline) {
    try {
      const currentSession = await this.getActiveSession(user.id);
      if (!currentSession) {
        await whatsappService.sendMessage(user.phone_number, '❌ No active game found.');
        return;
      }

      const question = await questionService.getQuestionById(currentSession.current_question_id);

      if (!question) {
        throw new Error('Question not found');
      }

      if (lifeline === 'fifty_fifty') {
        if (currentSession.lifeline_5050_used) {
          await whatsappService.sendMessage(user.phone_number, '❌ You already used 50:50!');
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

        await whatsappService.sendMessage(user.phone_number, message);

      } else if (lifeline === 'skip') {
        if (currentSession.lifeline_skip_used) {
          await whatsappService.sendMessage(user.phone_number, '❌ You already used Skip!');
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

        await whatsappService.sendMessage(
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
    const result = await pool.query(
      `SELECT * FROM game_sessions
       WHERE user_id = $1 AND status = 'active'
       ORDER BY started_at DESC
       LIMIT 1`,
      [userId]
    );

    return result.rows[0] || null;
  }

  async updateSession(session) {
    await pool.query(
      `UPDATE game_sessions
       SET current_question = $1, current_score = $2, current_question_id = $3,
           lifeline_5050_used = $4, lifeline_skip_used = $5
       WHERE id = $6`,
      [session.current_question, session.current_score, session.current_question_id,
       session.lifeline_5050_used, session.lifeline_skip_used, session.id]
    );

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

      const result = await pool.query(
        `SELECT u.full_name, u.lga, t.amount as score
         FROM transactions t
         JOIN users u ON t.user_id = u.id
         WHERE t.created_at >= ${dateCondition}
         AND t.transaction_type = 'prize'
         ORDER BY t.amount DESC, t.created_at DESC
         LIMIT $1`,
        [limit]
      );

      return result.rows;
    } catch (error) {
      logger.error('Error fetching leaderboard:', error);
      throw error;
    }
  }
}

module.exports = GameService;