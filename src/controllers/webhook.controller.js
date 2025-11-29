const pool = require('../config/database');
const redis = require('../config/redis');
const WhatsAppService = require('../services/whatsapp.service');
const GameService = require('../services/game.service');
const UserService = require('../services/user.service');
const { logger } = require('../utils/logger');

const whatsappService = new WhatsAppService();
const gameService = new GameService();
const userService = new UserService();

const LGA_LIST = [
  'Abak', 'Eastern Obolo', 'Eket', 'Esit Eket', 'Essien Udim',
  'Etim Ekpo', 'Etinan', 'Ibeno', 'Ibesikpo Asutan', 'Ibiono-Ibom',
  'Ika', 'Ikono', 'Ikot Abasi', 'Ikot Ekpene', 'Ini',
  'Itu', 'Mbo', 'Mkpat-Enin', 'Nsit-Atai', 'Nsit-Ibom',
  'Nsit-Ubium', 'Obot Akara', 'Okobo', 'Onna', 'Oron',
  'Oruk Anam', 'Udung-Uko', 'Ukanafun', 'Uruan', 'Urue-Offong/Oruko', 'Uyo'
];

// Constants for timeouts
const QUESTION_TIMEOUT = 12000; // 12 seconds
const GAME_TIMEOUT = 300000; // 5 minutes total game timeout

class WebhookController {
  async verify(req, res) {
    try {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
        logger.info('Webhook verified successfully');
        res.status(200).send(challenge);
      } else {
        logger.error('Webhook verification failed');
        res.status(403).send('Forbidden');
      }
    } catch (error) {
      logger.error('Error in webhook verification:', error);
      res.status(500).send('Internal Server Error');
    }
  }

  async handleMessage(req, res) {
    try {
      const body = req.body;
      
      // Immediately acknowledge receipt
      res.status(200).send('EVENT_RECEIVED');

      if (body.object === 'whatsapp_business_account') {
        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const messages = value?.messages;

        if (!messages || messages.length === 0) {
          return;
        }

        const message = messages[0];
        const from = message.from;
        const messageBody = message.text?.body || '';
        const messageType = message.type;

        // Only process text messages
        if (messageType !== 'text') {
          logger.info(`Ignoring non-text message from ${from}: ${messageType}`);
          return;
        }

        logger.info(`Message from ${from}: ${messageBody}`);

        // Process message asynchronously
        await this.routeMessage(from, messageBody);
      }
    } catch (error) {
      logger.error('Error handling webhook:', error);
      // Don't send error to user here as response is already sent
    }
  }

  async routeMessage(phone, message) {
    try {
      const input = message.trim().toUpperCase();

      // Check for RESET command first
      if (input === 'RESET' || input === 'RESTART') {
        let user = await userService.getUserByPhone(phone);
        if (user) {
          await this.handleReset(user);
        } else {
          await whatsappService.sendMessage(phone, 'No active session found. Send "Hello" to start!');
        }
        return;
      }

      // Get user and their state
      let user = await userService.getUserByPhone(phone);
      const userState = await userService.getUserState(phone);

      // Handle registration flows
      if (userState && userState.state === 'REGISTRATION_NAME') {
        await this.handleRegistrationName(phone, message);
        return;
      }

      if (userState && userState.state === 'REGISTRATION_LGA') {
        await this.handleRegistrationLGA(phone, message, userState.data.name);
        return;
      }

      // Handle leaderboard period selection
      if (userState && userState.state === 'SELECT_LEADERBOARD') {
        await this.handleLeaderboardSelection(phone, message);
        return;
      }

      // Handle new user
      if (!user) {
        await this.handleNewUser(phone);
        return;
      }

      // Get active game session
      const activeSession = await gameService.getActiveSession(user.id);

      // Check for timeout on active session
      if (activeSession) {
        const sessionAge = Date.now() - new Date(activeSession.started_at).getTime();
        
        if (sessionAge > GAME_TIMEOUT) {
          // Session has timed out
          await this.handleGameTimeout(user, activeSession);
          await this.sendMainMenu(user.phone_number);
          return;
        }

        // Check if waiting for answer and question has timed out
        const waitingForAnswer = await redis.get(`waiting_answer:${user.id}`);
        if (waitingForAnswer) {
          const questionStartTime = parseInt(waitingForAnswer);
          const timeSinceQuestion = Date.now() - questionStartTime;
          
          if (timeSinceQuestion > QUESTION_TIMEOUT) {
            // Question timed out, process as wrong answer
            await gameService.handleQuestionTimeout(activeSession, user);
            return;
          }
        }

        await this.handleGameInput(user, activeSession, message);
      } else {
        await this.handleMenuInput(user, message);
      }
    } catch (error) {
      logger.error('Error routing message:', error);
      await whatsappService.sendMessage(
        phone,
        '❌ Sorry, something went wrong. Type RESET to start over.'
      );
    }
  }

  async handleGameTimeout(user, session) {
    try {
      logger.info(`Game timeout for user ${user.id}, session ${session.id}`);
      
      // Mark session as timed out
      await pool.query(
        `UPDATE game_sessions 
         SET status = 'timeout', 
             completed_at = NOW() 
         WHERE id = $1`,
        [session.id]
      );

      // Clear any redis keys
      await redis.del(`waiting_answer:${user.id}`);
      await redis.del(`game_ready:${user.id}`);
      await redis.del(`current_question:${session.id}`);

      await whatsappService.sendMessage(
        user.phone_number,
        `⏰ Game Timed Out! ⏰

Your game session has expired due to inactivity.

Your progress has been saved.

Ready to start a new game?

1️⃣ Play Now
2️⃣ How to Play
3️⃣ Leaderboard`
      );
    } catch (error) {
      logger.error('Error handling game timeout:', error);
    }
  }

  async handleNewUser(phone) {
    await whatsappService.sendMessage(
      phone,
      `🎉 Welcome to WHAT'S UP AKWA IBOM! 🎉

The ultimate trivia game about our great state!

Test your knowledge and win amazing prizes! 🏆

Developed in partnership with the Department of Brand Management & Marketing, Office of the Governor.

Brought to you by the Akwa Ibom State Government.

🎄 Merry Christmas! 🎄

Let's get you registered! What's your full name?`
    );

    await userService.setUserState(phone, 'REGISTRATION_NAME');
  }

  async handleRegistrationName(phone, name) {
    if (!name || name.trim().length < 2) {
      await whatsappService.sendMessage(phone, 'Please enter a valid name (at least 2 characters).');
      return;
    }

    const trimmedName = name.trim();
    
    // Basic validation - no numbers or special characters
    if (!/^[a-zA-Z\s\-'.]+$/.test(trimmedName)) {
      await whatsappService.sendMessage(phone, 'Please enter a valid name using only letters.');
      return;
    }

    await userService.setUserState(phone, 'REGISTRATION_LGA', { name: trimmedName });

    let lgaMessage = `Nice to meet you, ${trimmedName}! 👋\n\nWhich Local Government Area are you from?\n\nReply with the number:\n\n`;
    LGA_LIST.forEach((lga, idx) => {
      lgaMessage += `${idx + 1}. ${lga}\n`;
    });

    await whatsappService.sendMessage(phone, lgaMessage);
  }

  async handleRegistrationLGA(phone, message, name) {
    const lgaIndex = parseInt(message.trim()) - 1;

    if (isNaN(lgaIndex) || lgaIndex < 0 || lgaIndex >= LGA_LIST.length) {
      await whatsappService.sendMessage(
        phone, 
        `Please reply with a valid number from 1 to ${LGA_LIST.length}.`
      );
      return;
    }

    const lga = LGA_LIST[lgaIndex];
    
    try {
      await userService.createUser(phone, name, lga);
      await userService.clearUserState(phone);

      await whatsappService.sendMessage(
        phone,
        `✅ Registration complete!

You're all set, ${name} from ${lga}!

Ready to play? Reply:
1️⃣ Play Now
2️⃣ How to Play
3️⃣ Leaderboard`
      );
    } catch (error) {
      logger.error('Error completing registration:', error);
      await whatsappService.sendMessage(
        phone,
        '❌ Registration failed. Please type RESET to try again.'
      );
    }
  }

  async handleMenuInput(user, message) {
    const input = message.trim().toUpperCase();

    // Check for win sharing response
    const winSharePending = await redis.get(`win_share_pending:${user.id}`);
    if (winSharePending && (input === 'YES' || input === 'Y')) {
      await this.handleWinShare(user, JSON.parse(winSharePending));
      await redis.del(`win_share_pending:${user.id}`);
      return;
    }

    // Check if this is first interaction after coming back (more than 5 minutes)
    const lastActiveMinutesAgo = user.last_active ? 
      (Date.now() - new Date(user.last_active).getTime()) / 60000 : 999;

    // Show welcome back message if returning after 5+ minutes and not immediately playing
    if (lastActiveMinutesAgo > 5 && !input.includes('PLAY') && input !== '1' && input !== '2' && input !== '3') {
      await whatsappService.sendMessage(
        user.phone_number,
        `Hello again ${user.full_name} from ${user.lga}! 👋

Welcome back to What's Up Akwa Ibom! 🎉

The ultimate trivia game about our great state!

Developed in partnership with the Department of Brand Management & Marketing, Office of the Governor.

Brought to you by the Akwa Ibom State Government.

🎄 Merry Christmas! 🎄

What would you like to do?

1️⃣ Play Now
2️⃣ How to Play
3️⃣ View Leaderboard`
      );
      
      // Update last_active to prevent showing this message repeatedly
      await pool.query(
        'UPDATE users SET last_active = NOW() WHERE id = $1',
        [user.id]
      );
      return;
    }

    // Handle post-game menu selections (Check if user just finished a game)
    const recentGame = await pool.query(
      `SELECT * FROM game_sessions 
       WHERE user_id = $1 AND status = 'completed' 
       AND completed_at > NOW() - INTERVAL '2 minutes'
       ORDER BY completed_at DESC LIMIT 1`,
      [user.id]
    );

    if (recentGame.rows.length > 0) {
      // User just finished a game, handle post-game options
      if (input === '1' || input.includes('PLAY')) {
        await gameService.startNewGame(user);
        return;
      } else if (input === '2' || input.includes('LEADERBOARD')) {
        await this.sendLeaderboardMenu(user.phone_number);
        return;
      } else if (input === '3' || input.includes('CLAIM')) {
        await whatsappService.sendMessage(
          user.phone_number,
          `🎁 PRIZE CLAIM 🎁

Your prize will be processed within 24-48 hours.

You will receive payment details via WhatsApp.

Thank you for playing!

Reply "PLAY NOW" to play again! 🎮`
        );
        return;
      }
    }

    // Regular menu handling
    if (input === '1' || input.includes('PLAY')) {
      await gameService.startNewGame(user);
    } else if (input === '2' || input.includes('HOW')) {
      await this.sendHowToPlay(user.phone_number);
    } else if (input === '3' || input.includes('LEADERBOARD')) {
      await this.sendLeaderboardMenu(user.phone_number);
    } else if (input === 'RESET' || input === 'RESTART') {
      await this.handleReset(user);
    } else {
      // Unknown command, show menu
      await this.sendMainMenu(user.phone_number);
    }
  }

  async handleReset(user) {
    try {
      // Cancel any active game sessions
      await pool.query(
        `UPDATE game_sessions 
         SET status = 'cancelled', completed_at = NOW() 
         WHERE user_id = $1 AND status = 'active'`,
        [user.id]
      );

      // Clear all user states and redis keys
      await userService.clearUserState(user.phone_number);
      await redis.del(`waiting_answer:${user.id}`);
      await redis.del(`game_ready:${user.id}`);

      await whatsappService.sendMessage(
        user.phone_number,
        `🔄 Game Reset! 🔄

All active games have been cancelled.

Ready to start fresh?

1️⃣ Play Now
2️⃣ How to Play
3️⃣ Leaderboard`
      );
    } catch (error) {
      logger.error('Error resetting game:', error);
      await whatsappService.sendMessage(
        user.phone_number,
        'Reset complete! Type 1 to start a new game.'
      );
    }
  }

  async handleGameInput(user, session, message) {
    const input = message.trim().toUpperCase();

    // Check if waiting for START command
    const gameReady = await redis.get(`game_ready:${user.id}`);
    if (gameReady) {
      if (input === 'START') {
        await redis.del(`game_ready:${user.id}`);
        await whatsappService.sendMessage(
          user.phone_number,
          '🎮 LET\'S GO! 🎮\n\nStarting in 3... 2... 1...'
        );
        setTimeout(async () => {
          await gameService.sendQuestion(session, user);
        }, 2000);
        return;
      } else {
        await whatsappService.sendMessage(
          user.phone_number,
          '⚠️ Reply START to begin the game!'
        );
        return;
      }
    }

    // Check if we're waiting for an answer
    const waitingForAnswer = await redis.get(`waiting_answer:${user.id}`);
    if (!waitingForAnswer) {
      // Not waiting for answer, might be between questions
      await whatsappService.sendMessage(
        user.phone_number,
        '⚠️ Please wait for the next question...\n\nOr type RESET to start over.'
      );
      return;
    }

    // Handle lifelines
    if (input.includes('50') || input.includes('5050')) {
      await gameService.useLifeline(session, user, 'fifty_fifty');
      return;
    }

    if (input.includes('SKIP')) {
      await gameService.useLifeline(session, user, 'skip');
      return;
    }

    // Handle answer
    if (['A', 'B', 'C', 'D'].includes(input)) {
      await gameService.processAnswer(session, user, input);
    } else {
      await whatsappService.sendMessage(
        user.phone_number,
        `⚠️ Invalid input!

Please reply with A, B, C, or D

Available lifelines:
- Type "50:50" (${session.lifeline_5050_used ? '❌ Used' : '✅ Available'})
- Type "Skip" (${session.lifeline_skip_used ? '❌ Used' : '✅ Available'})

Type "RESET" to start over`
      );
    }
  }

  async sendMainMenu(phone) {
    await whatsappService.sendMessage(
      phone,
      `🏠 MAIN MENU 🏠

What would you like to do?

1️⃣ Play Now
2️⃣ How to Play
3️⃣ View Leaderboard

Having issues? Type RESET to start fresh.

Reply with your choice.`
    );
  }

  async sendHowToPlay(phone) {
    await whatsappService.sendMessage(
      phone,
      `📖 HOW TO PLAY 📖

🎯 Answer 15 questions about Akwa Ibom
⏱️ 12 seconds per question
💎 2 lifelines available:
   • 50:50 - Remove 2 wrong answers
   • Skip - Move to next question

🏆 PRIZE LADDER:
Q15: ₦50,000 🥇
Q12: ₦25,000
Q10: ₦10,000 (SAFE)
Q8: ₦5,000
Q5: ₦1,000 (SAFE)

Safe amounts are guaranteed!

Ready to play? Reply "PLAY NOW"`
    );
  }

  async sendLeaderboardMenu(phone) {
    await userService.setUserState(phone, 'SELECT_LEADERBOARD');
    
    await whatsappService.sendMessage(
      phone,
      `📊 SELECT LEADERBOARD 📊

Which leaderboard would you like to see?

1️⃣ Today's Winners
2️⃣ This Week
3️⃣ This Month
4️⃣ All Time

Reply with your choice:`
    );
  }

  async handleLeaderboardSelection(phone, message) {
    const input = message.trim();
    let period = 'daily';
    let periodName = 'TODAY';

    switch(input) {
      case '1':
        period = 'daily';
        periodName = 'TODAY';
        break;
      case '2':
        period = 'weekly';
        periodName = 'THIS WEEK';
        break;
      case '3':
        period = 'monthly';
        periodName = 'THIS MONTH';
        break;
      case '4':
        period = 'all';
        periodName = 'ALL TIME';
        break;
      default:
        await whatsappService.sendMessage(
          phone,
          '⚠️ Please reply with 1, 2, 3, or 4'
        );
        return;
    }

    await userService.clearUserState(phone);
    await this.sendLeaderboardData(phone, period, periodName);
  }

  async sendLeaderboardData(phone, period, periodName) {
    try {
      const leaderboard = await gameService.getLeaderboard(period);
      
      let message = `🏅 ${periodName}'S LEADERBOARD 🏅\n\n`;
      
      if (leaderboard.length === 0) {
        message += 'No winners yet! Be the first! 🎯';
      } else {
        leaderboard.forEach((player, index) => {
          const medal = index === 0 ? '🏆' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
          const score = parseFloat(player.score || 0);
          message += `${index + 1}. ${player.full_name} (${player.lga}) - ₦${score.toLocaleString()} ${medal}\n`;
        });
      }

      message += '\n\nReply "PLAY NOW" to compete!';

      await whatsappService.sendMessage(phone, message);
    } catch (error) {
      logger.error('Error sending leaderboard:', error);
      await whatsappService.sendMessage(
        phone,
        '❌ Unable to load leaderboard. Please try again later.'
      );
    }
  }

  // Legacy method - kept for backward compatibility
  async sendLeaderboard(phone) {
    await this.sendLeaderboardMenu(phone);
  }

  async handleWinShare(user, winData) {
    const ImageService = require('../services/image.service');
    const imageService = new ImageService();
    const fs = require('fs');

    try {
      await whatsappService.sendMessage(
        user.phone_number,
        '🎨 Creating your victory card... Please wait a moment! ✨'
      );

      // Generate win image
      const imagePath = await imageService.generateWinImage({
        name: user.full_name,
        lga: user.lga,
        amount: winData.amount,
        questionsAnswered: winData.questionsAnswered,
        totalQuestions: winData.totalQuestions
      });

      // Send image via WhatsApp
      await whatsappService.sendImage(
        user.phone_number,
        imagePath,
        `🏆 ${user.full_name} won ₦${winData.amount.toLocaleString()} playing What's Up Akwa Ibom! Join now: https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}`
      );

      await whatsappService.sendMessage(
        user.phone_number,
        `✅ Victory card sent! 🎉

Save it and share on your WhatsApp Status to inspire others!

1️⃣ Play Again
2️⃣ View Leaderboard`
      );

      // Clean up temp file
      fs.unlinkSync(imagePath);

      // Clean up old temp files
      imageService.cleanupTempFiles();

    } catch (error) {
      logger.error('Error handling win share:', error);
      await whatsappService.sendMessage(
        user.phone_number,
        '❌ Sorry, something went wrong creating your victory card. Please try again later.'
      );
    }
  }
}

module.exports = new WebhookController();