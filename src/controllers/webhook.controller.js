const pool = require('../config/database');
const redis = require('../config/redis');
const WhatsAppService = require('../services/whatsapp.service');
const GameService = require('../services/game.service');
const UserService = require('../services/user.service');
const PaymentService = require('../services/payment.service');
const { logger } = require('../utils/logger');

const whatsappService = new WhatsAppService();
const gameService = new GameService();
const userService = new UserService();
const paymentService = new PaymentService();

const LGA_LIST = [
  'Abak', 'Eastern Obolo', 'Eket', 'Esit Eket', 'Essien Udim',
  'Etim Ekpo', 'Etinan', 'Ibeno', 'Ibesikpo Asutan', 'Ibiono-Ibom',
  'Ika', 'Ikono', 'Ikot Abasi', 'Ikot Ekpene', 'Ini',
  'Itu', 'Mbo', 'Mkpat-Enin', 'Nsit-Atai', 'Nsit-Ibom',
  'Nsit-Ubium', 'Obot Akara', 'Okobo', 'Onna', 'Oron',
  'Oruk Anam', 'Udung-Uko', 'Ukanafun', 'Uruan', 'Urue-Offong/Oruko', 'Uyo'
];

class WebhookController {
  async verify(req, res) {
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
  }

  async handleMessage(req, res) {
    try {
      const body = req.body;
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

        logger.info(`Message from ${from}: ${messageBody}`);

        await this.routeMessage(from, messageBody);
      }
    } catch (error) {
      logger.error('Error handling webhook:', error);
    }
  }

  async routeMessage(phone, message) {
    try {
      const input = message.trim().toUpperCase();

      if (input === 'RESET' || input === 'RESTART') {
        let user = await userService.getUserByPhone(phone);
        if (user) {
          await this.handleReset(user);
        } else {
          await whatsappService.sendMessage(phone, 'No active session found. Send "Hello" to start!');
        }
        return;
      }

      let user = await userService.getUserByPhone(phone);
      const userState = await userService.getUserState(phone);

      if (userState && userState.state === 'REGISTRATION_NAME') {
        await this.handleRegistrationName(phone, message);
        return;
      }

      if (userState && userState.state === 'REGISTRATION_LGA') {
        await this.handleRegistrationLGA(phone, message, userState.data.name);
        return;
      }

      if (userState && userState.state === 'SELECT_PACKAGE') {
        await this.handlePackageSelection(user, message, userState.data);
        return;
      }

      if (userState && userState.state === 'SELECT_LEADERBOARD') {
        await this.handleLeaderboardSelection(phone, message);
        return;
      }

      if (!user) {
        await this.handleNewUser(phone);
        return;
      }

      const activeSession = await gameService.getActiveSession(user.id);

      if (activeSession) {
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
      await whatsappService.sendMessage(phone, 'Please enter a valid name.');
      return;
    }

    await userService.setUserState(phone, 'REGISTRATION_LGA', { name: name.trim() });

    let lgaMessage = `Nice to meet you, ${name}! 👋\n\nWhich Local Government Area are you from?\n\nReply with the number:\n\n`;

    LGA_LIST.forEach((lga, idx) => {
      lgaMessage += `${idx + 1}. ${lga}\n`;
    });

    await whatsappService.sendMessage(phone, lgaMessage);
  }

  async handleRegistrationLGA(phone, message, name) {
  const lgaIndex = parseInt(message.trim()) - 1;

  if (lgaIndex < 0 || lgaIndex >= LGA_LIST.length) {
    await whatsappService.sendMessage(phone, 'Please reply with a valid number from the list.');
    return;
  }

  const lga = LGA_LIST[lgaIndex];

  await userService.createUser(phone, name, lga);
  await userService.clearUserState(phone);

  const isPaymentEnabled = paymentService.isEnabled();
  
  let welcomeMsg = `✅ Registration complete!\n\n`;
  welcomeMsg += `You're all set, ${name} from ${lga}!\n\n`;
  
  if (isPaymentEnabled) {
    welcomeMsg += `💎 Games Remaining: 0\n\n`;
    welcomeMsg += `Ready to play? Reply:\n\n`;
    welcomeMsg += `1️⃣ Buy Games\n`;
    welcomeMsg += `2️⃣ How to Play\n`;
    welcomeMsg += `3️⃣ Leaderboard`;
  } else {
    welcomeMsg += `Ready to play? Reply:\n\n`;
    welcomeMsg += `1️⃣ Play Now\n`;
    welcomeMsg += `2️⃣ How to Play\n`;
    welcomeMsg += `3️⃣ Leaderboard`;
  }

  await whatsappService.sendMessage(phone, welcomeMsg);
}

  async handleBuyGames(user) {
    try {
      if (!paymentService.isEnabled()) {
        await whatsappService.sendMessage(
          user.phone_number,
          '🎉 Good news! The game is currently FREE!\n\nType PLAY to start a game.'
        );
        return;
      }

      const packages = await paymentService.getPackages();
      const message = paymentService.formatPaymentMessage(packages);

      await whatsappService.sendMessage(user.phone_number, message);
      await userService.setUserState(user.phone_number, 'SELECT_PACKAGE', { packages });
    } catch (error) {
      logger.error('Error handling buy games:', error);
      await whatsappService.sendMessage(
        user.phone_number,
        '❌ Error loading packages. Please try again later.'
      );
    }
  }

  async handlePackageSelection(user, message, stateData) {
    try {
      const packageIndex = parseInt(message.trim()) - 1;
      const packages = stateData.packages;

      if (packageIndex < 0 || packageIndex >= packages.length) {
        await whatsappService.sendMessage(
          user.phone_number,
          '❌ Invalid selection. Please reply with 1, 2, or 3.'
        );
        return;
      }

      const selectedPackage = packages[packageIndex];
      const payment = await paymentService.initializePayment(user, selectedPackage.id);

      await userService.clearUserState(user.phone_number);

      await whatsappService.sendMessage(
        user.phone_number,
        `💳 PAYMENT LINK 💳\n\n` +
        `Package: ${selectedPackage.name}\n` +
        `Amount: ₦${payment.amount.toLocaleString()}\n` +
        `Games: ${payment.games}\n\n` +
        `Click link to pay:\n${payment.authorization_url}\n\n` +
        `Payment Reference: ${payment.reference}\n\n` +
        `⚠️ Link expires in 30 minutes`
      );

    } catch (error) {
      logger.error('Error handling package selection:', error);
      await whatsappService.sendMessage(
        user.phone_number,
        '❌ Error processing payment. Please try again.'
      );
    }
  }

  async handleMenuInput(user, message) {
  const input = message.trim().toUpperCase();

  // Handle BUY command
  if (input.includes('BUY') || input === '4') {
    await this.handleBuyGames(user);
    return;
  }

  // Check for win sharing response
  const winSharePending = await redis.get(`win_share_pending:${user.id}`);
  if (winSharePending && (input === 'YES' || input === 'Y')) {
    await this.handleWinShare(user, JSON.parse(winSharePending));
    await redis.del(`win_share_pending:${user.id}`);
    return;
  }

  // Check if payment is enabled and user has games
  if (paymentService.isEnabled()) {
    const hasGames = await paymentService.hasGamesRemaining(user.id);
    
    if (!hasGames && (input === '1' || input.includes('PLAY'))) {
      await whatsappService.sendMessage(
        user.phone_number,
        '❌ You have no games remaining!\n\n' +
        'Buy games to continue playing.\n\n' +
        'Type BUY to see packages.'
      );
      return;
    }
  }

  // Check if this is first interaction after coming back
  const lastActiveMinutesAgo = user.last_active ?
    (Date.now() - new Date(user.last_active).getTime()) / 60000 : 999;

  if (lastActiveMinutesAgo > 5 && !input.includes('PLAY') && input !== '1' && input !== '2' && input !== '3' && input !== '4') {
    // Show games remaining in welcome back message
    let welcomeMessage = `Hello again ${user.full_name} from ${user.lga}! 👋\n\nWelcome back to What's Up Akwa Ibom! 🎉\n\n`;
    
    if (paymentService.isEnabled()) {
      const gamesRemaining = await paymentService.getGamesRemaining(user.id);
      welcomeMessage += `💎 Games Remaining: ${gamesRemaining}\n\n`;
    }
    
    welcomeMessage += `The ultimate trivia game about our great state!\n\n`;
    welcomeMessage += `Developed in partnership with the Department of Brand Management & Marketing, Office of the Governor.\n\n`;
    welcomeMessage += `Brought to you by the Akwa Ibom State Government.\n\n`;
    welcomeMessage += `🎄 Merry Christmas! 🎄\n\n`;
    welcomeMessage += `What would you like to do?\n\n`;
    welcomeMessage += `1️⃣ Play Now\n`;
    welcomeMessage += `2️⃣ How to Play\n`;
    welcomeMessage += `3️⃣ View Leaderboard`;
    
    if (paymentService.isEnabled()) {
      welcomeMessage += `\n4️⃣ Buy Games`;
    }

    await whatsappService.sendMessage(user.phone_number, welcomeMessage);

    await pool.query(
      'UPDATE users SET last_active = NOW() WHERE id = $1',
      [user.id]
    );
    return;
  }

  // Handle post-game menu selections
  const recentGame = await pool.query(
    `SELECT * FROM game_sessions
     WHERE user_id = $1 AND status = 'completed'
     AND completed_at > NOW() - INTERVAL '2 minutes'
     ORDER BY completed_at DESC LIMIT 1`,
    [user.id]
  );

  if (recentGame.rows.length > 0) {
    if (input === '1' || input.includes('PLAY')) {
      await gameService.startNewGame(user);
      return;
    } else if (input === '2' || input.includes('LEADERBOARD')) {
      await this.sendLeaderboardMenu(user.phone_number);
      return;
    } else if (input === '3' || input.includes('CLAIM')) {
      await whatsappService.sendMessage(
        user.phone_number,
        '🎁 PRIZE CLAIM 🎁\n\nYour prize will be processed within 24-48 hours.\n\nYou will receive payment details via WhatsApp.\n\nThank you for playing!'
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
    await this.sendMainMenu(user.phone_number);
  }
}

  async handleReset(user) {
    try {
      await pool.query(
        `UPDATE game_sessions SET status = 'cancelled' WHERE user_id = $1 AND status = 'active'`,
        [user.id]
      );

      await userService.clearUserState(user.phone_number);

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

    const gameReady = await redis.get(`game_ready:${user.id}`);
    if (gameReady && input === 'START') {
      await redis.del(`game_ready:${user.id}`);
      await whatsappService.sendMessage(
        user.phone_number,
        '🎮 LET\'S GO! 🎮\n\nStarting in 3... 2... 1...'
      );

      setTimeout(async () => {
        await gameService.sendQuestion(session, user);
      }, 2000);
      return;
    }

    if (gameReady) {
      await whatsappService.sendMessage(
        user.phone_number,
        '⚠️ Reply START to begin the game!'
      );
      return;
    }

    if (input.includes('50') || input.includes('5050')) {
      await gameService.useLifeline(session, user, 'fifty_fifty');
      return;
    }

    if (input.includes('SKIP')) {
      await gameService.useLifeline(session, user, 'skip');
      return;
    }

    if (['A', 'B', 'C', 'D'].includes(input)) {
      await gameService.processAnswer(session, user, input);
    } else {
      await whatsappService.sendMessage(
        user.phone_number,
        '⚠️ Please reply with A, B, C, or D\n\nOr use a lifeline:\n- Type "50:50"\n- Type "Skip"\n- Type "RESET" to start over'
      );
    }
  }

  // UPDATE the sendMainMenu method in webhook.controller.js to show games remaining

async sendMainMenu(phone) {
  const isPaymentEnabled = paymentService.isEnabled();
  
  let message = '🏠 MAIN MENU 🏠\n\n';
  
  // Show games remaining if payment is enabled
  if (isPaymentEnabled) {
    const user = await userService.getUserByPhone(phone);
    if (user) {
      message += `💎 Games Remaining: ${user.games_remaining}\n\n`;
    }
  }
  
  message += 'What would you like to do?\n\n';
  message += '1️⃣ Play Now\n';
  message += '2️⃣ How to Play\n';
  message += '3️⃣ View Leaderboard\n';
  
  if (isPaymentEnabled) {
    message += '4️⃣ Buy Games\n';
  }
  
  message += '\nHaving issues? Type RESET to start fresh.\n\nReply with your choice.';

  await whatsappService.sendMessage(phone, message);
}

  async sendHowToPlay(phone) {
    await whatsappService.sendMessage(
      phone,
      `📖 HOW TO PLAY 📖

🎯 Answer 15 questions about Akwa Ibom
⏱️ 15 seconds per question
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
    const leaderboard = await gameService.getLeaderboard(period);

    let message = `🏅 ${periodName}'S LEADERBOARD 🏅\n\n`;

    if (leaderboard.length === 0) {
      message += 'No winners yet! Be the first! 🎯';
    } else {
      leaderboard.forEach((player, index) => {
        const medal = index === 0 ? '🏆' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
        message += `${index + 1}. ${player.full_name} (${player.lga}) - ₦${parseFloat(player.score).toLocaleString()} ${medal}\n`;
      });
    }

    message += '\n\nReply "PLAY NOW" to compete!';

    await whatsappService.sendMessage(phone, message);
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

      const imagePath = await imageService.generateWinImage({
        name: user.full_name,
        lga: user.lga,
        amount: winData.amount,
        questionsAnswered: winData.questionsAnswered,
        totalQuestions: winData.totalQuestions
      });

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

      fs.unlinkSync(imagePath);
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