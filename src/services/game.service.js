const pool = require('../config/database');
const redis = require('../config/redis');
const WhatsAppService = require('./whatsapp.service');
const QuestionService = require('./question.service');
const { logger } = require('../utils/logger');

const whatsappService = new WhatsAppService();
const questionService = new QuestionService();

const PRIZE_LADDER = {
  1: 200, 2: 250, 3: 300, 4: 500, 5: 1000,
  6: 2000, 7: 3000, 8: 5000, 9: 8000, 10: 10000,
  11: 20000, 12: 25000, 13: 30000, 14: 40000, 15: 50000,
};

const SAFE_CHECKPOINTS = [5, 10];

class GameService {

  // Start a new game for user
  async startNewGame(user) {
    try {
      const existingSession = await this.getActiveSession(user.id);

      if (existingSession) {
        await whatsappService.sendMessage(
          user.phone_number,
          '⚠️ You already have an active game! Complete it first.'
        );
        return;
      }

      const sessionKey = `game_${user.id}_${Date.now()}`;

      // Fetch 15 random questions from DB
      const questions = await questionService.getRandomQuestions(15);

      const result = await pool.query(
        `INSERT INTO game_sessions (user_id, session_key, current_question, current_score)
         VALUES ($1, $2, 1, 0)
         RETURNING *`,
        [user.id, sessionKey]
      );

      const session = result.rows[0];

      // Store session in Redis including the questions array
      session.questions = questions.map(q => q.id);
      await redis.setex(`session:${sessionKey}`, 3600, JSON.stringify(session));

      // Send game instructions
      await whatsappService.sendMessage(
        user.phone_number,
        `🎮 GAME INSTRUCTIONS 🎮

📋 RULES:
- 15 questions about Akwa Ibom
- 12 seconds per question
- Win up to ₦50,000!

💎 LIFELINES:
5️⃣0️⃣ 50:50 - Remove 2 wrong answers
⏭️ Skip - Jump to next question

Safe points: Q5 (₦1,000) & Q10 (₦10,000)

When you're ready, reply START to begin! 🚀`
      );

      // Set temporary key for waiting for START
      await redis.setex(`game_ready:${user.id}`, 300, sessionKey);

    } catch (error) {
      logger.error('Error starting game:', error);
      throw error;
    }
  }

  // Send the current question to the user
  async sendQuestion(session, user) {
    try {
      const questionNumber = session.current_question;
      const prizeAmount = PRIZE_LADDER[questionNumber];
      const isSafe = SAFE_CHECKPOINTS.includes(questionNumber);

      const questionId = session.questions[questionNumber - 1];
      const question = await questionService.getQuestionById(questionId);

      if (!question) throw new Error('No question found');

      session.current_question_id = question.id;
      await this.updateSession(session);

      let message = `❓ QUESTION ${questionNumber} - ₦${prizeAmount.toLocaleString()}`;
      if (isSafe) message += ' (SAFE) 🔒';
      message += `\n\n${question.question_text}\n\n`;
      message += `A) ${question.option_a}\n`;
      message += `B) ${question.option_b}\n`;
      message += `C) ${question.option_c}\n`;
      message += `D) ${question.option_d}\n\n`;
      message += `⏱️ 12 seconds...\n\n`;

      const lifelines = [];
      if (!session.lifeline_5050_used) lifelines.push('50:50');
      if (!session.lifeline_skip_used) lifelines.push('Skip');

      if (lifelines.length > 0) {
        message += `💎 Lifelines: ${lifelines.join(' | ')}`;
      }

      await whatsappService.sendMessage(user.phone_number, message);

      // Set timeout in Redis for this question
      await redis.setex(
        `timeout:${session.session_key}:q${questionNumber}`,
        15,
        (Date.now() + 12000).toString()
      );

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
            await this.sendQuestion(session, user);
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

    message += `Well played, ${user.full_name}! 👏\n\n1️⃣ Play Again\n2️⃣ Leaderboard\n`;
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

      if (wonGrandPrize) {
        await whatsappService.sendMessage(
          user.phone_number,
          `🎊 INCREDIBLE! 🎊\n\n🏆 CHAMPION! 🏆\n\nALL 15 QUESTIONS CORRECT!\n\n💰 ₦50,000 WON! 💰\n\n${user.full_name.toUpperCase()}, you're in the HALL OF FAME!\n\nPrize processed in 24-48 hours.\n\n1️⃣ Play Again\n2️⃣ Leaderboard\n3️⃣ Claim Prize`
        );
      }

    } catch (error) {
      logger.error('Error completing game:', error);
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
       SET current_question = $1, current_score = $2, current_question_id = $3
       WHERE id = $4`,
      [session.current_question, session.current_score, session.current_question_id, session.id]
    );

    await redis.setex(`session:${session.session_key}`, 3600, JSON.stringify(session));
  }

}

module.exports = GameService;
