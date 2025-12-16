// ============================================
// FILE: src/controllers/webhook.controller.js
// COMPLETE VERSION: Enhanced + All Original Handlers
// PART 1 OF 3: Setup, Routing, Registration, Game Modes
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const WhatsAppService = require('../services/whatsapp.service');
const GameService = require('../services/game.service');
const UserService = require('../services/user.service');
const PaymentService = require('../services/payment.service');
const PayoutService = require('../services/payout.service');
const ReferralService = require('../services/referral.service');
const TournamentService = require('../services/tournament.service');
const { logger } = require('../utils/logger');

const whatsappService = new WhatsAppService();
const gameService = new GameService();
const userService = new UserService();
const paymentService = new PaymentService();
const payoutService = new PayoutService();
const referralService = new ReferralService();
const tournamentService = new TournamentService();

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

      // ===================================
      // PRIORITY 0: RESET COMMAND (WORKS EVERYWHERE)
      // ===================================
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

      // ===================================
      // PRIORITY 1: REGISTRATION STATES
      // ===================================
      if (userState && userState.state === 'REGISTRATION_NAME') {
        await this.handleRegistrationName(phone, message);
        return;
      }

      if (userState && userState.state === 'REGISTRATION_CITY') {
        await this.handleRegistrationCity(phone, message, userState.data.name);
        return;
      }

      if (userState && userState.state === 'REGISTRATION_USERNAME') {
        await this.handleRegistrationUsername(phone, message, userState.data);
        return;
      }

      if (userState && userState.state === 'REGISTRATION_AGE') {
        await this.handleRegistrationAge(phone, message, userState.data);
        return;
      }

      if (userState && userState.state === 'REGISTRATION_REFERRAL') {
        await this.handleRegistrationReferral(phone, message, userState.data);
        return;
      }

      // ===================================
      // PRIORITY 2: GAME MODE SELECTION
      // ===================================
      if (userState && userState.state === 'SELECT_GAME_MODE') {
        await this.handleGameModeSelection(user, message);
        return;
      }

      // ===================================
      // PRIORITY 3: TOURNAMENT SELECTION
      // ===================================
      if (userState && userState.state === 'SELECT_TOURNAMENT') {
        await this.handleTournamentSelection(user, message, userState.data);
        return;
      }

      // ===================================
      // PRIORITY 4: PAYMENT STATES
      // ===================================
      if (userState && userState.state === 'SELECT_PACKAGE') {
        await this.handlePackageSelection(user, message, userState.data);
        return;
      }

      // ===================================
      // PRIORITY 5: LEADERBOARD STATES
      // ===================================
      if (userState && userState.state === 'SELECT_LEADERBOARD') {
        await this.handleLeaderboardSelection(phone, message);
        return;
      }

      // ===================================
      // PRIORITY 6: BANK DETAILS CONFIRMATION
      // ===================================
      if (userState && userState.state === 'CONFIRM_BANK_DETAILS') {
        await this.handleBankDetailsConfirmation(phone, message, userState.data);
        return;
      }

      // ===================================
      // PRIORITY 7: PAYOUT COLLECTION STATES
      // ===================================
      if (userState && userState.state === 'COLLECT_ACCOUNT_NAME') {
        await this.handleAccountNameInput(phone, message, userState);
        return;
      }

      if (userState && userState.state === 'COLLECT_ACCOUNT_NUMBER') {
        await this.handleAccountNumberInput(phone, message, userState);
        return;
      }

      if (userState && userState.state === 'COLLECT_BANK_NAME') {
        await this.handleBankNameInput(phone, message, userState);
        return;
      }

      if (userState && userState.state === 'COLLECT_CUSTOM_BANK') {
        await this.handleCustomBankInput(phone, message, userState);
        return;
      }

      // ===================================
      // PRIORITY 8: NEW USER (NO STATE, NO USER)
      // ===================================
      if (!user) {
        await this.handleNewUser(phone);
        return;
      }

      // ===================================
      // PRIORITY 9: ACTIVE GAME SESSION
      // ===================================
      const activeSession = await gameService.getActiveSession(user.id);

      // Clean up stale Redis state if no DB session
      if (!activeSession) {
        const gameReady = await redis.get(`game_ready:${user.id}`);
        if (gameReady) {
          logger.info(`Cleaning stale game_ready state for user ${user.id}`);
          await redis.del(`game_ready:${user.id}`);
        }
      }

      if (activeSession) {
        await this.handleGameInput(user, activeSession, message);
        return;
      }

      // ===================================
      // PRIORITY 10: MAIN MENU (DEFAULT)
      // ===================================
      await this.handleMenuInput(user, message);

    } catch (error) {
      logger.error('Error routing message:', error);
      await whatsappService.sendMessage(
        phone,
        '❌ Sorry, something went wrong. Type RESET to start over.'
      );
    }
  }

  // ============================================
  // REGISTRATION HANDLERS (WITH REFERRALS)
  // ============================================

  async handleNewUser(phone) {
    await whatsappService.sendMessage(
      phone,
      `🎉 *WELCOME TO WHAT'S UP TRIVIA GAME!* 🎉

The ultimate trivia game for you!

Test your knowledge and win amazing prizes! 🏆

_Developed & Proudly brought to you by SummerIsland Systems._

🎄 *Merry Christmas!* 🎄

Let's get you registered! What's your full name?`
    );

    await userService.setUserState(phone, 'REGISTRATION_NAME');
  }

  async handleRegistrationName(phone, name) {
    if (!name || name.trim().length < 2) {
      await whatsappService.sendMessage(phone, '❌ Please enter a valid name (at least 2 characters).');
      return;
    }

    await userService.setUserState(phone, 'REGISTRATION_CITY', {
      name: name.trim()
    });

    await whatsappService.sendMessage(
      phone,
      `Nice to meet you, ${name}! 👋

Which city are you from?

📍 Examples: Lagos, Abuja, Uyo, Port Harcourt, Kano, London, New York

Type your city name:`
    );
  }

  async handleRegistrationCity(phone, city, name) {
    if (!city || city.trim().length < 2) {
      await whatsappService.sendMessage(phone, '❌ Please enter a valid city name.');
      return;
    }

    const formattedCity = city.trim()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');

    await userService.setUserState(phone, 'REGISTRATION_USERNAME', {
      name: name,
      city: formattedCity
    });

    await whatsappService.sendMessage(
      phone,
      `Great! You're from ${formattedCity}! 🌍

Now, choose a *username* for the game.

This will be displayed on leaderboards and victory cards for privacy.

✅ Requirements:
• 3-20 characters
• Letters, numbers, underscores only
• No spaces

Examples: cool_player, trivia_king, sarah2024

Your username:`
    );
  }

  async handleRegistrationUsername(phone, username, stateData) {
    const { name, city } = stateData;

    const cleanUsername = username.trim().toLowerCase();

    if (cleanUsername.length < 3 || cleanUsername.length > 20) {
      await whatsappService.sendMessage(phone, '❌ Username must be 3-20 characters long.\n\nTry again:');
      return;
    }

    if (!/^[a-z0-9_]+$/.test(cleanUsername)) {
      await whatsappService.sendMessage(phone, '❌ Username can only contain letters, numbers, and underscores.\n\nNo spaces or special characters.\n\nTry again:');
      return;
    }

    const existingUser = await pool.query(
      'SELECT id FROM users WHERE LOWER(username) = $1',
      [cleanUsername]
    );

    if (existingUser.rows.length > 0) {
      await whatsappService.sendMessage(phone, `❌ Username "@${cleanUsername}" is already taken!\n\nTry a different one:`);
      return;
    }

    await userService.setUserState(phone, 'REGISTRATION_AGE', {
      name: name,
      city: city,
      username: cleanUsername
    });

    await whatsappService.sendMessage(
      phone,
      `Perfect! Your username is @${cleanUsername} ✨

Finally, how old are you?

Type your age (e.g., 25):`
    );
  }

  async handleRegistrationAge(phone, ageInput, stateData) {
    const { name, city, username } = stateData;

    const age = parseInt(ageInput.trim());

    if (isNaN(age) || age < 13 || age > 120) {
      await whatsappService.sendMessage(phone, '❌ Please enter a valid age (13-120).\n\nYour age:');
      return;
    }

    await userService.setUserState(phone, 'REGISTRATION_REFERRAL', {
      name: name,
      city: city,
      username: username,
      age: age
    });

    await whatsappService.sendMessage(
      phone,
      `Great! Almost done! 🎉

Do you have a referral code?

If a friend invited you, enter their code to get *1 FREE GAME* 🎁

Type the code, or type SKIP to continue:`
    );
  }

  async handleRegistrationReferral(phone, referralCodeInput, stateData) {
    const { name, city, username, age } = stateData;
    const input = referralCodeInput.trim().toUpperCase();

    let referrerId = null;

    if (input !== 'SKIP' && input.length > 0) {
      const referrerResult = await pool.query(
        'SELECT id, username FROM users WHERE UPPER(referral_code) = $1',
        [input]
      );

      if (referrerResult.rows.length === 0) {
        await whatsappService.sendMessage(
          phone,
          '❌ Invalid referral code.\n\nType the correct code or type SKIP:'
        );
        return;
      }

      referrerId = referrerResult.rows[0].id;
      logger.info(`User registering with referral code: ${input} from user ${referrerId}`);
    }

    const user = await userService.createUser(phone, name, city, username, age, referrerId);
    await userService.clearUserState(phone);

    const isPaymentEnabled = paymentService.isEnabled();

    let welcomeMsg = `✅ *REGISTRATION COMPLETE!* ✅\n\n`;
    welcomeMsg += `Welcome to the game, @${username}! 🎮\n\n`;
    welcomeMsg += `📍 Location: ${city}\n`;
    welcomeMsg += `🎂 Age: ${age}\n`;

    if (referrerId) {
      welcomeMsg += `🎁 Referral bonus: +1 FREE GAME! (Valid for 24hrs)\n`;
    }

    welcomeMsg += `\n🔗 Your referral code: *${user.referral_code}*\n`;
    welcomeMsg += `Share it! Every 3 friends = 1 FREE GAME for you! 💰\n\n`;
    welcomeMsg += `_Proudly brought to you by SummerIsland Systems._\n\n`;

    if (isPaymentEnabled) {
      const gamesRemaining = referrerId ? 1 : 0;
      welcomeMsg += `💎 Games Remaining: ${gamesRemaining}\n\n`;
      welcomeMsg += `Ready to play? Reply:\n\n`;

      if (gamesRemaining > 0) {
        welcomeMsg += `1️⃣ Play Now\n`;
        welcomeMsg += `2️⃣ How to Play\n`;
        welcomeMsg += `3️⃣ Leaderboard\n`;
        welcomeMsg += `4️⃣ Buy Games\n`;
        welcomeMsg += `5️⃣ My Stats`;
      } else {
        welcomeMsg += `1️⃣ Buy Games\n`;
        welcomeMsg += `2️⃣ How to Play\n`;
        welcomeMsg += `3️⃣ Leaderboard\n`;
        welcomeMsg += `4️⃣ My Stats`;
      }
    } else {
      welcomeMsg += `Ready to play? Reply:\n\n`;
      welcomeMsg += `1️⃣ Play Now\n`;
      welcomeMsg += `2️⃣ How to Play\n`;
      welcomeMsg += `3️⃣ Leaderboard\n`;
      welcomeMsg += `4️⃣ My Stats`;
    }

    await whatsappService.sendMessage(phone, welcomeMsg);
  }

  // ============================================
  // GAME MODE SELECTION
  // ============================================

  async showGameModeMenu(user) {
    await userService.setUserState(user.phone_number, 'SELECT_GAME_MODE');

    let message = `🎮 *SELECT GAME MODE* 🎮\n\n`;
    message += `Choose your challenge:\n\n`;
    message += `1️⃣ *Classic Mode*\n`;
    message += `   General knowledge questions\n`;
    message += `   Win up to ₦50,000!\n\n`;
    message += `2️⃣ *Akwa Ibom Edition*\n`;
    message += `   State-specific questions\n`;
    message += `   Test your local knowledge!\n\n`;
    message += `3️⃣ *World Edition*\n`;
    message += `   International questions\n`;
    message += `   Global trivia challenge!\n\n`;
    message += `4️⃣ *Tournaments* 🏆\n`;
    message += `   Compete for BIG prizes!\n\n`;
    message += `_Proudly brought to you by SummerIsland Systems._\n\n`;
    message += `Reply with your choice:`;

    await whatsappService.sendMessage(user.phone_number, message);
  }

  async handleGameModeSelection(user, message) {
    const input = message.trim();

    let gameMode = 'classic';
    let modeName = 'Classic Mode';

    switch(input) {
      case '1':
        gameMode = 'classic';
        modeName = '🎮 Classic Mode';
        break;
      case '2':
        gameMode = 'akwa_ibom';
        modeName = '🏛️ Akwa Ibom Edition';
        break;
      case '3':
        gameMode = 'world';
        modeName = '🌍 World Edition';
        break;
      case '4':
        await this.showActiveTournaments(user);
        return;
      default:
        await whatsappService.sendMessage(
          user.phone_number,
          '⚠️ Please reply with 1, 2, 3, or 4'
        );
        return;
    }

    await userService.clearUserState(user.phone_number);

    await whatsappService.sendMessage(
      user.phone_number,
      `✅ ${modeName} selected!\n\nStarting game...`
    );

    await gameService.startNewGame(user, gameMode);
  }

  // ============================================
  // TOURNAMENT HANDLERS
  // ============================================

  async showActiveTournaments(user) {
    try {
      const tournaments = await tournamentService.getActiveTournaments();

      if (tournaments.length === 0) {
        await whatsappService.sendMessage(
          user.phone_number,
          '❌ No active tournaments at the moment.\n\nTry Classic, Akwa Ibom, or World mode!\n\nType PLAY to start.'
        );
        await userService.clearUserState(user.phone_number);
        return;
      }

      let message = `🏆 *ACTIVE TOURNAMENTS* 🏆\n\n`;

      tournaments.forEach((t, index) => {
        const sponsorTag = t.sponsor_name ? `\n_Sponsored by ${t.sponsor_name}_` : '';
        const entryFee = t.entry_fee > 0 ? `₦${t.entry_fee.toLocaleString()}` : 'FREE';
        const endDate = new Date(t.end_date).toLocaleDateString();

        message += `${index + 1}️⃣ *${t.tournament_name}*${sponsorTag}\n`;
        message += `💰 Prize Pool: ₦${t.prize_pool.toLocaleString()}\n`;
        message += `🎟️ Entry: ${entryFee}\n`;
        message += `📅 Ends: ${endDate}\n`;
        message += `👥 Participants: ${t.participant_count || 0}\n\n`;
      });

      message += `Reply with tournament number to join:`;

      await userService.setUserState(user.phone_number, 'SELECT_TOURNAMENT', { tournaments });
      await whatsappService.sendMessage(user.phone_number, message);

    } catch (error) {
      logger.error('Error showing tournaments:', error);
      await whatsappService.sendMessage(
        user.phone_number,
        '❌ Error loading tournaments. Type PLAY for regular game.'
      );
    }
  }

  async handleTournamentSelection(user, message, stateData) {
    const input = parseInt(message.trim()) - 1;
    const tournaments = stateData.tournaments;

    if (input < 0 || input >= tournaments.length) {
      await whatsappService.sendMessage(
        user.phone_number,
        '❌ Invalid selection. Reply with tournament number:'
      );
      return;
    }

    const tournament = tournaments[input];

    const alreadyJoined = await tournamentService.isUserInTournament(user.id, tournament.id);

    if (alreadyJoined) {
      await userService.clearUserState(user.phone_number);

      await whatsappService.sendMessage(
        user.phone_number,
        `✅ You're already in "${tournament.tournament_name}"!\n\nStarting tournament game...`
      );

      await gameService.startNewGame(user, 'tournament', tournament.id);
      return;
    }

    if (tournament.entry_fee > 0) {
      await whatsappService.sendMessage(
        user.phone_number,
        `💰 *${tournament.tournament_name}*\n\n` +
        `Entry Fee: ₦${tournament.entry_fee.toLocaleString()}\n` +
        `Prize Pool: ₦${tournament.prize_pool.toLocaleString()}\n\n` +
        `Payment link coming soon!\n\n` +
        `Type MENU to return.`
      );
      await userService.clearUserState(user.phone_number);
      return;
    }

    await tournamentService.joinTournament(user.id, tournament.id);
    await userService.clearUserState(user.phone_number);

    await whatsappService.sendMessage(
      user.phone_number,
      `🎉 *TOURNAMENT JOINED!* 🎉\n\n` +
      `${tournament.tournament_name}\n` +
      `Prize Pool: ₦${tournament.prize_pool.toLocaleString()}\n\n` +
      `Starting game...`
    );

    await gameService.startNewGame(user, 'tournament', tournament.id);
  }


// ============================================
// PART 1 END - Continue to Part 2 for:
// - Profile Command
// - Referral Command  
// - Stats Handler
// - Menu Input Handler
// - Payment Handlers
// ============================================

// ============================================
// PART 2 OF 3: Profile, Referral, Stats, Menu, Payment Handlers
// APPEND THIS TO PART 1 (Insert before "module.exports")
// ============================================

  // ============================================
  // PROFILE COMMAND
  // ============================================

  async handleProfileCommand(user) {
    try {
      const stats = await userService.getUserStats(user.id);
      const referralStats = await referralService.getReferralStats(user.id);

      let message = `👤 *YOUR PROFILE*\n\n`;
      message += `*Username:* @${user.username}\n`;
      message += `*Full Name:* ${user.full_name}\n`;
      message += `*City:* ${user.city}\n`;
      message += `*Age:* ${user.age}\n\n`;

      message += `📊 *GAME STATS*\n`;
      message += `━━━━━━━━━━━━━━━━\n`;
      message += `Total Games: ${stats.totalGamesPlayed}\n`;
      message += `Games Won: ${stats.gamesWon}\n`;
      message += `Win Rate: ${stats.winRate}%\n`;
      message += `Total Winnings: ₦${stats.totalWinnings.toLocaleString()}\n`;
      message += `Overall Rank: #${stats.rank}\n\n`;

      message += `💰 *REFERRAL STATS*\n`;
      message += `━━━━━━━━━━━━━━━━\n`;
      message += `Your Code: *${user.referral_code}*\n`;
      message += `Total Referrals: ${referralStats.totalReferrals}\n`;
      message += `Pending Rewards: ${referralStats.pendingRewards} free game(s)\n`;
      message += `Next Reward: ${3 - (referralStats.totalReferrals % 3)} referral(s) away\n\n`;

      if (paymentService.isEnabled()) {
        message += `💎 *GAMES*\n`;
        message += `━━━━━━━━━━━━━━━━\n`;
        message += `Games Remaining: ${user.games_remaining}\n\n`;
      }

      message += `📅 Member since: ${new Date(user.created_at).toLocaleDateString()}\n\n`;
      message += `_Proudly brought to you by SummerIsland Systems._\n\n`;
      message += `Type STATS for detailed statistics.`;

      await whatsappService.sendMessage(user.phone_number, message);

    } catch (error) {
      logger.error('Error handling profile command:', error);
      await whatsappService.sendMessage(
        user.phone_number,
        '❌ Error loading profile. Please try again.'
      );
    }
  }

  // ============================================
  // REFERRAL COMMAND
  // ============================================

  async handleReferralCommand(user) {
    try {
      const stats = await referralService.getReferralStats(user.id);

      let message = `💰 *REFERRAL PROGRAM* 💰\n\n`;
      message += `Invite friends and earn FREE GAMES! 🎁\n\n`;

      message += `📊 *YOUR STATS*\n`;
      message += `━━━━━━━━━━━━━━━━\n`;
      message += `Your Code: *${user.referral_code}*\n`;
      message += `Total Referrals: ${stats.totalReferrals}\n`;
      message += `Free Games Earned: ${stats.pendingRewards}\n\n`;

      message += `🎯 *HOW IT WORKS*\n`;
      message += `━━━━━━━━━━━━━━━━\n`;
      message += `• Share your code: *${user.referral_code}*\n`;
      message += `• Your friend gets 1 FREE GAME (24hr expiry)\n`;
      message += `• Every 3 friends = 1 FREE GAME for you!\n\n`;

      const nextReward = 3 - (stats.totalReferrals % 3);
      message += `⏳ Next reward in: ${nextReward} referral${nextReward !== 1 ? 's' : ''}\n\n`;

      message += `📤 *SHARE YOUR CODE*\n`;
      message += `━━━━━━━━━━━━━━━━\n`;
      message += `Copy & share this:\n\n`;
      message += `"🎮 Play What's Up Trivia & win REAL MONEY! 💰\n\n`;
      message += `Use my code *${user.referral_code}* to get 1 FREE GAME!\n\n`;
      message += `Start: https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}"\n\n`;
      message += `_Proudly brought to you by SummerIsland Systems._`;

      await whatsappService.sendMessage(user.phone_number, message);

    } catch (error) {
      logger.error('Error handling referral command:', error);
      await whatsappService.sendMessage(
        user.phone_number,
        '❌ Error loading referral info. Please try again.'
      );
    }
  }

  // ============================================
  // STATS HANDLER (ENHANCED WITH REFERRAL INFO)
  // ============================================

  async handleStatsRequest(user) {
    try {
      const stats = await userService.getUserStats(user.id);
      const referralStats = await referralService.getReferralStats(user.id);

      if (!stats) {
        await whatsappService.sendMessage(
          user.phone_number,
          '❌ Unable to retrieve your stats. Please try again later.'
        );
        return;
      }

      let message = `📊 YOUR STATS - @${stats.username} 📊\n\n`;
      message += `👤 Name: ${stats.fullName}\n`;
      message += `📍 Location: ${stats.city}\n`;
      message += `🎂 Age: ${stats.age}\n`;
      message += `🏆 Overall Rank: #${stats.rank}\n\n`;

      message += `🎮 GAME STATISTICS\n`;
      message += `━━━━━━━━━━━━━━━━\n`;
      message += `Total Games: ${stats.totalGamesPlayed}\n`;
      message += `Games Won: ${stats.gamesWon}\n`;
      message += `Win Rate: ${stats.winRate}%\n`;
      message += `Highest Question: Q${stats.highestQuestionReached}\n\n`;

      message += `💰 EARNINGS\n`;
      message += `━━━━━━━━━━━━━━━━\n`;
      message += `Total Winnings: ₦${stats.totalWinnings.toLocaleString()}\n`;
      message += `Highest Win: ₦${stats.highestWin.toLocaleString()}\n`;
      message += `Average Score: ₦${Math.round(stats.avgScore).toLocaleString()}\n\n`;

      message += `💎 REFERRALS\n`;
      message += `━━━━━━━━━━━━━━━━\n`;
      message += `Code: ${user.referral_code}\n`;
      message += `Total Referrals: ${referralStats.totalReferrals}\n`;
      message += `Free Games Earned: ${referralStats.pendingRewards}\n\n`;

      if (paymentService.isEnabled()) {
        message += `💎 GAMES\n`;
        message += `━━━━━━━━━━━━━━━━\n`;
        message += `Games Remaining: ${stats.gamesRemaining}\n`;
        message += `Total Purchased: ${stats.totalGamesPurchased}\n\n`;
      }

      message += `📅 Member Since: ${new Date(stats.joinedDate).toLocaleDateString()}\n\n`;
      message += `_Proudly brought to you by SummerIsland Systems._\n\n`;
      message += `Keep playing to climb the ranks! 🚀\n\n`;
      message += `1️⃣ Play Now\n`;
      message += `2️⃣ View Leaderboard\n`;
      message += `3️⃣ Main Menu`;

      await whatsappService.sendMessage(user.phone_number, message);

    } catch (error) {
      logger.error('Error handling stats request:', error);
      await whatsappService.sendMessage(
        user.phone_number,
        '❌ Error retrieving stats. Please try again later.'
      );
    }
  }

  // ============================================
  // MENU INPUT HANDLER (ENHANCED WITH NEW COMMANDS)
  // ============================================

  async handleMenuInput(user, message) {
    const input = message.trim().toUpperCase();

    // PROFILE command
    if (input === 'PROFILE' || input.includes('PROFILE')) {
      await this.handleProfileCommand(user);
      return;
    }

    // REFERRAL command
    if (input === 'REFERRAL' || input === 'REFER' || input.includes('INVITE')) {
      await this.handleReferralCommand(user);
      return;
    }

    // CLAIM command
    if (input === 'CLAIM' || input.includes('CLAIM')) {
      await this.handleClaimPrize(user);
      return;
    }

    // RECEIVED confirmation
    if (input === 'RECEIVED' || input.includes('CONFIRM')) {
      await this.handlePaymentConfirmation(user);
      return;
    }

    // STATS command
    if (input === '5' || input === '4' || input.includes('STATS') || input.includes('STATISTICS')) {
      await this.handleStatsRequest(user);
      return;
    }

    // TOURNAMENTS command
    if (input.includes('TOURNAMENT')) {
      await this.showActiveTournaments(user);
      return;
    }

    // WIN SHARING
    const winSharePending = await redis.get(`win_share_pending:${user.id}`);
    if (winSharePending && (input === 'YES' || input === 'Y')) {
      await this.handleWinShare(user, JSON.parse(winSharePending));
      await redis.del(`win_share_pending:${user.id}`);
      return;
    }

    // BUY command
    if (input.includes('BUY')) {
      await this.handleBuyGames(user);
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

    // Welcome back message (enhanced with branding)
    const lastActiveMinutesAgo = user.last_active ?
      (Date.now() - new Date(user.last_active).getTime()) / 60000 : 999;

    if (lastActiveMinutesAgo > 5 && !input.includes('PLAY') && input !== '1' && input !== '2' && input !== '3' && input !== '4' && input !== '5') {
      let welcomeMessage = `Hello again @${user.username}! 👋\n\n`;
      welcomeMessage += `Welcome back to What's Up Trivia Game! 🎉\n\n`;

      if (paymentService.isEnabled()) {
        const gamesRemaining = await paymentService.getGamesRemaining(user.id);
        welcomeMessage += `💎 Games Remaining: ${gamesRemaining}\n\n`;
      }

      welcomeMessage += `_Proudly brought to you by SummerIsland Systems._\n\n`;
      welcomeMessage += `🎄 Merry Christmas! 🎄\n\n`;
      welcomeMessage += `What would you like to do?\n\n`;
      welcomeMessage += `1️⃣ Play Now\n`;
      welcomeMessage += `2️⃣ How to Play\n`;
      welcomeMessage += `3️⃣ View Leaderboard\n`;

      if (paymentService.isEnabled()) {
        welcomeMessage += `4️⃣ Buy Games\n`;
        welcomeMessage += `5️⃣ My Stats`;
      } else {
        welcomeMessage += `4️⃣ My Stats`;
      }

      await whatsappService.sendMessage(user.phone_number, welcomeMessage);

      await pool.query(
        'UPDATE users SET last_active = NOW() WHERE id = $1',
        [user.id]
      );
      return;
    }

    // Post-game menu selections
    const recentGame = await pool.query(
      `SELECT * FROM game_sessions
       WHERE user_id = $1 AND status = 'completed'
       AND completed_at > NOW() - INTERVAL '2 minutes'
       ORDER BY completed_at DESC LIMIT 1`,
      [user.id]
    );

    if (recentGame.rows.length > 0) {
      if (input === '1' || input.includes('PLAY')) {
        await this.showGameModeMenu(user);
        return;
      } else if (input === '2' || input.includes('LEADERBOARD')) {
        await this.sendLeaderboardMenu(user.phone_number);
        return;
      } else if (input === '3' || input.includes('CLAIM')) {
        await this.handleClaimPrize(user);
        return;
      } else if (input === '4') {
        const winSharePending = await redis.get(`win_share_pending:${user.id}`);
        if (winSharePending) {
          await this.handleWinShare(user, JSON.parse(winSharePending));
          await redis.del(`win_share_pending:${user.id}`);
        }
        return;
      }
    }

    // Regular menu handling
    if (input === '1' || input.includes('PLAY')) {
      await this.showGameModeMenu(user);
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

  // ============================================
  // PAYMENT HANDLERS
  // ============================================

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

  // ============================================
  // RESET HANDLER
  // ============================================

  async handleReset(user) {
    try {
      await pool.query(
        `UPDATE game_sessions SET status = 'cancelled' WHERE user_id = $1 AND status = 'active'`,
        [user.id]
      );

      await userService.clearUserState(user.phone_number);
      await redis.del(`game_ready:${user.id}`);

      await whatsappService.sendMessage(
        user.phone_number,
        `🔄 Game Reset! 🔄

All active games have been cancelled.

Ready to start fresh?

1️⃣ Play Now
2️⃣ How to Play
3️⃣ Leaderboard
4️⃣ My Stats`
      );

    } catch (error) {
      logger.error('Error resetting game:', error);
      await whatsappService.sendMessage(
        user.phone_number,
        'Reset complete! Type 1 to start a new game.'
      );
    }
  }

  // ============================================
  // GAME INPUT HANDLER
  // ============================================

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
        '⚠️ Please reply with A, B, C, or D\n\nOr use a lifeline:\n- Type "50" to activate 50:50\n- Type "Skip" to skip question\n- Type "RESET" to start over'
      );
    }
  }

  // ============================================
  // MENU SENDERS
  // ============================================

  async sendMainMenu(phone) {
    const isPaymentEnabled = paymentService.isEnabled();

    let message = '🏠 MAIN MENU 🏠\n\n';

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
      message += '5️⃣ My Stats\n';
    } else {
      message += '4️⃣ My Stats\n';
    }

    message += '\nHaving issues? Type RESET to start fresh.\n\nReply with your choice.';

    await whatsappService.sendMessage(phone, message);
  }

  async sendHowToPlay(phone) {
    await whatsappService.sendMessage(
      phone,
      `📖 HOW TO PLAY 📖

🎯 Answer 15 questions about various topics

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
        message += `${index + 1}. @${player.username} (${player.city}) - ₦${parseFloat(player.score).toLocaleString()} ${medal}\n`;
      });
    }

    message += '\n\nReply "PLAY NOW" to compete!';

    await whatsappService.sendMessage(phone, message);
  }

// ============================================
// PART 2 END - Continue to Part 3 for:
// - All Payout Handlers (handleClaimPrize, bank details, etc.)
// - Payment Confirmation
// - Victory Card Handler
// ============================================

// ============================================
// PART 3 OF 3 - FINAL: All Payout Handlers & Victory Card
// APPEND THIS TO PART 2 (Insert before "module.exports")
// ============================================

  // ============================================
  // PAYOUT HANDLERS (COMPLETE FROM ORIGINAL)
  // ============================================

  async handleClaimPrize(user) {
    try {
      const transaction = await payoutService.getPendingTransaction(user.id);

      if (!transaction) {
        await whatsappService.sendMessage(
          user.phone_number,
          '❌ No pending prizes to claim.\n\nPlay games to win prizes! 🎮\n\nType PLAY to start.'
        );
        return;
      }

      const existingDetails = await payoutService.getPayoutDetails(transaction.id);

      if (existingDetails) {
        await whatsappService.sendMessage(
          user.phone_number,
          `✅ Payment details already received for your ₦${parseFloat(transaction.amount).toLocaleString()} prize!\n\n` +
          `Account: ${existingDetails.account_name}\n` +
          `Bank: ${existingDetails.bank_name}\n\n` +
          `Your payment is being processed and will be sent within 12-24 hours.\n\n` +
          `Reference: #WUA-${transaction.id.toString().padStart(4, '0')}`
        );
        return;
      }

      const hasBankDetails = await payoutService.hasBankDetails(user.id);

      if (hasBankDetails) {
        const userBankDetails = await payoutService.getUserBankDetails(user.id);

        await userService.setUserState(user.phone_number, 'CONFIRM_BANK_DETAILS', {
          transactionId: transaction.id,
          amount: transaction.amount,
          existingDetails: userBankDetails
        });

        await whatsappService.sendMessage(
          user.phone_number,
          `💰 PRIZE CLAIM - #WUA-${transaction.id.toString().padStart(4, '0')}\n\n` +
          `You won: ₦${parseFloat(transaction.amount).toLocaleString()}\n\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `We have your bank details on file:\n\n` +
          `Account Name: ${userBankDetails.account_name}\n` +
          `Account Number: ${userBankDetails.account_number}\n` +
          `Bank: ${userBankDetails.bank_name}\n\n` +
          `━━━━━━━━━━━━━━━━\n\n` +
          `Reply:\n` +
          `✅ YES - Use these details\n` +
          `🔄 UPDATE - Enter new details\n` +
          `❌ CANCEL - Cancel claim`
        );

        logger.info(`Showing existing bank details to user ${user.id} for transaction ${transaction.id}`);
        return;
      }

      // No bank details - start collection
      await userService.setUserState(user.phone_number, 'COLLECT_ACCOUNT_NAME', {
        transactionId: transaction.id,
        amount: transaction.amount
      });

      await whatsappService.sendMessage(
        user.phone_number,
        `💰 PRIZE CLAIM - #WUA-${transaction.id.toString().padStart(4, '0')}\n\n` +
        `Great! Let's get you paid! 💵\n\n` +
        `You won: ₦${parseFloat(transaction.amount).toLocaleString()}\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `Step 1 of 3\n\n` +
        `Please send your FULL ACCOUNT NAME\n` +
        `(exactly as it appears on your bank statement)\n\n` +
        `Example: JOHN CHUKWUDI DOE\n\n` +
        `Reply with your account name:`
      );

      logger.info(`Started payout collection for user ${user.id}, transaction ${transaction.id}`);

    } catch (error) {
      logger.error('Error handling claim prize:', error);
      await whatsappService.sendMessage(
        user.phone_number,
        '❌ Error processing your claim. Please try again or contact support.'
      );
    }
  }

  async handleBankDetailsConfirmation(phone, message, stateData) {
    const input = message.trim().toUpperCase();
    const user = await userService.getUserByPhone(phone);

    if (input === 'YES' || input === 'Y' || input === '✅') {
      const success = await payoutService.linkBankDetailsToTransaction(
        user.id,
        stateData.transactionId
      );

      if (success) {
        await userService.clearUserState(phone);

        await whatsappService.sendMessage(
          phone,
          `✅ PAYMENT DETAILS CONFIRMED! ✅\n\n` +
          `━━━━━━━━━━━━━━━━━━━\n` +
          `Account Name: ${stateData.existingDetails.account_name}\n` +
          `Account Number: ${stateData.existingDetails.account_number}\n` +
          `Bank: ${stateData.existingDetails.bank_name}\n` +
          `Amount: ₦${parseFloat(stateData.amount).toLocaleString()}\n` +
          `━━━━━━━━━━━━━━━━━━━\n\n` +
          `We're processing your payment now.\n\n` +
          `You'll receive ₦${parseFloat(stateData.amount).toLocaleString()} within 12-24 hours.\n\n` +
          `You'll get a confirmation message once payment is sent. 💸\n\n` +
          `Thank you for playing! 🎉\n\n` +
          `Reference: #WUA-${stateData.transactionId.toString().padStart(4, '0')}`
        );
      } else {
        await whatsappService.sendMessage(
          phone,
          '❌ Error confirming details. Please try again.\n\nType CLAIM to restart.'
        );
      }
    } else if (input === 'UPDATE' || input === '🔄') {
      await userService.setUserState(phone, 'COLLECT_ACCOUNT_NAME', {
        transactionId: stateData.transactionId,
        amount: stateData.amount,
        isUpdate: true
      });

      await whatsappService.sendMessage(
        phone,
        `🔄 UPDATE BANK DETAILS\n\n` +
        `Step 1 of 3\n\n` +
        `Please send your NEW ACCOUNT NAME\n` +
        `(exactly as it appears on your bank statement)\n\n` +
        `Reply with your account name:`
      );
    } else if (input === 'CANCEL' || input === '❌') {
      await userService.clearUserState(phone);

      await whatsappService.sendMessage(
        phone,
        '❌ Claim cancelled.\n\nType CLAIM when you\'re ready to proceed.'
      );
    } else {
      await whatsappService.sendMessage(
        phone,
        '⚠️ Invalid response.\n\nReply:\n✅ YES\n🔄 UPDATE\n❌ CANCEL'
      );
    }
  }

  async handleAccountNameInput(phone, message, stateData) {
    const accountName = message.trim();

    if (accountName.length < 3) {
      await whatsappService.sendMessage(
        phone,
        '❌ Account name too short. Please enter your full name as it appears on your bank account.'
      );
      return;
    }

    if (accountName.length > 100) {
      await whatsappService.sendMessage(
        phone,
        '❌ Account name too long. Please enter a valid name (max 100 characters).'
      );
      return;
    }

    if (!/[a-zA-Z]/.test(accountName)) {
      await whatsappService.sendMessage(
        phone,
        '❌ Invalid account name. Please enter letters only (no numbers or special characters).'
      );
      return;
    }

    await userService.setUserState(phone, 'COLLECT_ACCOUNT_NUMBER', {
      ...stateData.data,
      accountName: accountName.toUpperCase()
    });

    await whatsappService.sendMessage(
      phone,
      `✅ Account Name: ${accountName.toUpperCase()}\n\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `Step 2 of 3\n\n` +
      `Please send your ACCOUNT NUMBER\n` +
      `(10 digits)\n\n` +
      `Example: 0123456789\n\n` +
      `Reply with your account number:`
    );
  }

  async handleAccountNumberInput(phone, message, stateData) {
    const validation = payoutService.validateAccountNumber(message);

    if (!validation.valid) {
      await whatsappService.sendMessage(
        phone,
        `❌ ${validation.error}\n\n` +
        `Please enter a valid 10-digit account number.`
      );
      return;
    }

    await userService.setUserState(phone, 'COLLECT_BANK_NAME', {
      ...stateData.data,
      accountNumber: validation.cleaned
    });

    await whatsappService.sendMessage(
      phone,
      `✅ Account Number: ${validation.cleaned}\n\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `Step 3 of 3\n\n` +
      `Please select your bank:\n\n` +
      `1️⃣ Access Bank\n` +
      `2️⃣ GTBank\n` +
      `3️⃣ First Bank\n` +
      `4️⃣ UBA\n` +
      `5️⃣ Zenith Bank\n` +
      `6️⃣ Ecobank\n` +
      `7️⃣ Fidelity Bank\n` +
      `8️⃣ Stanbic IBTC\n` +
      `9️⃣ Union Bank\n` +
      `🔟 Wema Bank\n` +
      `1️⃣1️⃣ Others (Type your bank name)\n\n` +
      `Reply with number or bank name:`
    );
  }

  async handleBankNameInput(phone, message, stateData) {
    const input = message.trim();
    let bankName;

    const bankMap = {
      '1': 'Access Bank',
      '2': 'GTBank',
      '3': 'First Bank',
      '4': 'UBA',
      '5': 'Zenith Bank',
      '6': 'Ecobank',
      '7': 'Fidelity Bank',
      '8': 'Stanbic IBTC',
      '9': 'Union Bank',
      '10': 'Wema Bank'
    };

    if (input === '11' || input.toUpperCase() === 'OTHERS' || input.toUpperCase() === 'OTHER') {
      await userService.setUserState(phone, 'COLLECT_CUSTOM_BANK', stateData.data);

      await whatsappService.sendMessage(
        phone,
        `Please type your bank name:\n\n` +
        `Example: Sterling Bank\n\n` +
        `Make sure to spell it correctly:`
      );
      return;
    }

    if (bankMap[input]) {
      bankName = bankMap[input];
    } else {
      bankName = input;
    }

    if (bankName.length < 3) {
      await whatsappService.sendMessage(
        phone,
        '❌ Invalid bank selection.\n\n' +
        'Please reply with a number (1-11) or type your bank name.'
      );
      return;
    }

    await this.completePayoutCollection(phone, stateData.data, bankName);
  }

  async handleCustomBankInput(phone, message, stateData) {
    const bankName = message.trim();

    if (bankName.length < 3) {
      await whatsappService.sendMessage(
        phone,
        '❌ Bank name too short. Please enter a valid bank name.'
      );
      return;
    }

    if (bankName.length > 100) {
      await whatsappService.sendMessage(
        phone,
        '❌ Bank name too long. Please enter a shorter name (max 100 characters).'
      );
      return;
    }

    await this.completePayoutCollection(phone, stateData.data, bankName);
  }

  async completePayoutCollection(phone, stateData, bankName) {
    try {
      const user = await userService.getUserByPhone(phone);

      await payoutService.savePayoutDetails(
        user.id,
        stateData.transactionId,
        stateData.accountName,
        stateData.accountNumber,
        bankName
      );

      await userService.clearUserState(phone);

      await whatsappService.sendMessage(
        phone,
        `✅ PAYMENT DETAILS RECEIVED! ✅\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `Account Name: ${stateData.accountName}\n` +
        `Account Number: ${stateData.accountNumber}\n` +
        `Bank: ${bankName}\n` +
        `Amount: ₦${parseFloat(stateData.amount).toLocaleString()}\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `We're processing your payment now.\n\n` +
        `You'll receive ₦${parseFloat(stateData.amount).toLocaleString()} within 12-24 hours.\n\n` +
        `You'll get a confirmation message once payment is sent. 💸\n\n` +
        `Thank you for playing! 🎉\n\n` +
        `Reference: #WUA-${stateData.transactionId.toString().padStart(4, '0')}`
      );

      logger.info(`Payout details collected for transaction ${stateData.transactionId}`);

    } catch (error) {
      logger.error('Error saving payout details:', error);
      await whatsappService.sendMessage(
        phone,
        '❌ Error saving your details. Please try again.\n\nType CLAIM to restart the process.'
      );
    }
  }

  async handlePaymentConfirmation(user) {
    try {
      const result = await pool.query(
        `SELECT * FROM transactions
         WHERE user_id = $1
         AND transaction_type = 'prize'
         AND payout_status = 'paid'
         ORDER BY paid_at DESC
         LIMIT 1`,
        [user.id]
      );

      if (result.rows.length === 0) {
        await whatsappService.sendMessage(
          user.phone_number,
          '❌ No recent payments found to confirm.'
        );
        return;
      }

      const transaction = result.rows[0];

      await payoutService.confirmPayout(transaction.id);

      await whatsappService.sendMessage(
        user.phone_number,
        `✅ PAYMENT CONFIRMED!\n\n` +
        `Thank you for confirming receipt of ₦${parseFloat(transaction.amount).toLocaleString()}!\n\n` +
        `We're glad you received it safely. 🎉\n\n` +
        `Keep playing to win more! 🏆\n\n` +
        `Type PLAY to start a new game.`
      );

      logger.info(`Payment confirmed by user ${user.id} for transaction ${transaction.id}`);

    } catch (error) {
      logger.error('Error handling payment confirmation:', error);
    }
  }

  // ============================================
  // VICTORY CARD HANDLER (WITH BRANDING)
  // ============================================

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
        username: user.username,
        city: user.city,
        amount: winData.amount,
        questionsAnswered: winData.questionsAnswered,
        totalQuestions: winData.totalQuestions
      });

      await whatsappService.sendImage(
        user.phone_number,
        imagePath,
        `🏆 @${user.username} won ₦${winData.amount.toLocaleString()} playing What's Up Trivia Game! Join now: https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}`
      );

      await whatsappService.sendMessage(
        user.phone_number,
        `✅ Victory card sent! 🎉

Save it and share on your WhatsApp Status to inspire others!

1️⃣ Play Again
2️⃣ View Leaderboard
3️⃣ Claim Prize`
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

// ============================================
// COMPLETE FILE END
// This is the FULL webhook.controller.js with:
// ✅ All registration handlers with referrals
// ✅ Profile command
// ✅ Referral command
// ✅ Enhanced stats with referral info
// ✅ Game mode selection (Classic, Akwa Ibom, World, Tournament)
// ✅ Tournament handlers
// ✅ All payment handlers
// ✅ All payout handlers (complete bank details flow)
// ✅ Victory card handler
// ✅ Enhanced branding throughout
// ✅ Reset handler
// ✅ Game input handler
// ✅ All menu senders
// ✅ Leaderboard handlers
// ============================================



