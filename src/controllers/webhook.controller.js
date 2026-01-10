// ============================================
// FILE: src/controllers/webhook.controller.js
// COMPLETE MERGED VERSION
// Part 1/6: Imports, Setup, Core Methods
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const MessagingService = require('../services/messaging.service');
const GameService = require('../services/game.service');
const UserService = require('../services/user.service');
const PaymentService = require('../services/payment.service');
const PayoutService = require('../services/payout.service');
const ReferralService = require('../services/referral.service');
const TournamentService = require('../services/tournament.service');
const streakService = require('../services/streak.service');
const restrictionsService = require('../services/restrictions.service');
const achievementsService = require('../services/achievements.service');
const victoryCardsService = require('../services/victory-cards.service');
const antiFraudService = require('../services/anti-fraud.service');
const auditService = require('../services/audit.service');
const { logger } = require('../utils/logger');

const messagingService = new MessagingService();
const gameService = new GameService();
const userService = new UserService();
const paymentService = new PaymentService();
const payoutService = new PayoutService();
const referralService = new ReferralService();
const tournamentService = new TournamentService();

class WebhookController {
  // ============================================
  // WEBHOOK VERIFICATION
  // ============================================
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

  // ============================================
  // WEBHOOK MESSAGE HANDLER
  // ============================================
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

  // ============================================
  // MESSAGE ROUTER - COMPLETE WITH ALL STATES
  // ============================================
  async routeMessage(phone, message) {
    try {
      const input = message.trim().toUpperCase();

      // ===================================
      // PRIORITY -1: MAINTENANCE MODE CHECK
      // ===================================
      if (restrictionsService.isMaintenanceMode()) {
        await messagingService.sendMessage(phone, restrictionsService.getMaintenanceMessage());
        return;
      }

      // ===================================
      // PRIORITY -0.5: RATE LIMITING
      // ===================================
      const rateLimit = await restrictionsService.checkRateLimit(phone, 'message', 30, 1);
      if (rateLimit.limited) {
        await messagingService.sendMessage(phone, restrictionsService.getRateLimitMessage());
        return;
      }

      // ===================================
      // PRIORITY 0: RESET COMMAND (WORKS EVERYWHERE)
      // ===================================
      if (input === 'RESET' || input === 'RESTART') {
        let user = await userService.getUserByPhone(phone);
        if (user) {
          await this.handleReset(user);
        } else {
          await messagingService.sendMessage(phone, 'No active session found. Send "Hello" to start!');
        }
        return;
      }

      let user = await userService.getUserByPhone(phone);
      const userState = await userService.getUserState(phone);

      // ===================================
      // PRIORITY 0.5: SUSPENSION CHECK (for existing users)
      // ===================================
      if (user) {
        const suspension = await restrictionsService.isUserSuspended(user.id);
        if (suspension.suspended) {
          await messagingService.sendMessage(phone, restrictionsService.getSuspensionMessage(suspension.reason));
          return;
        }
      }

      // ===================================
      // PRIORITY 1: TERMS ACCEPTANCE (BEFORE REGISTRATION)
      // ===================================
      if (userState && userState.state === 'TERMS_ACCEPTANCE') {
        await this.handleTermsAcceptance(phone, message, userState.data);
        return;
      }

      // ===================================
      // PRIORITY 2: REGISTRATION STATES
      // ===================================
      if (userState && userState.state === 'REGISTRATION_NAME') {
        await this.handleRegistrationName(phone, message, userState.data);
        return;
      }

      if (userState && userState.state === 'REGISTRATION_CITY') {
        await this.handleRegistrationCity(phone, message, userState.data);
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
      // PRIORITY 3: TOURNAMENT SELECTION & PAYMENT
      // ===================================
      if (userState && userState.state === 'SELECT_TOURNAMENT') {
        await this.handleTournamentSelection(user, message, userState.data);
        return;
      }

      if (userState && userState.state === 'CONFIRM_TOURNAMENT_PAYMENT') {
        await this.handleTournamentPaymentConfirmation(phone, message, userState.data);
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
      // PRIORITY 4.5: CLEAR LEADERBOARD STATE IF IN POST-GAME
      // This prevents leaderboard state from intercepting post-game menu options
      // ===================================
      if (userState && userState.state === 'SELECT_LEADERBOARD') {
        const postGameState = await redis.get(`post_game:${user.id}`);
        if (postGameState) {
          // User is in post-game window, clear leaderboard state so post-game menu works
          await userService.clearUserState(phone);
          // Don't return - let it fall through to handleMenuInput for post-game handling
        } else {
          // Not in post-game, handle leaderboard selection normally
          await this.handleLeaderboardSelection(phone, message);
          return;
        }
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
      // PRIORITY 8.5: PAYMENT CONFIRMATION (RECEIVED)
      // Must come before active game check so users can confirm payments mid-game
      // ===================================
      if (input === 'RECEIVED' || input === 'CONFIRM' || input === 'CONFIRMED') {
        await this.handlePaymentConfirmation(user);
        return;
      }

      // ===================================
      // PRIORITY 8.6: CLAIM PRIZE COMMAND
      // Allow "CLAIM" keyword to work anytime
      // ===================================
      if (input === 'CLAIM' || input === 'CLAIM PRIZE' || input === 'CLAIMPRICE') {
        await this.handleClaimPrize(user);
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
      await messagingService.sendMessage(
        phone,
        '❌ Sorry, something went wrong. Type RESET to start over.'
      );
    }
  }

// ============================================
// END OF PART 1/6
// Next: Registration Handlers
// ============================================
// ============================================
// Part 2/6: Registration Handlers
// APPEND TO PART 1
// ============================================

  // ============================================
  // REGISTRATION HANDLERS (WITH REFERRALS)
  // ============================================

  async handleNewUser(phone, platform = 'whatsapp') {
    // Show terms and privacy acceptance first
    const termsUrl = process.env.TERMS_URL || 'https://whatsuptrivia.com.ng/terms';
    const privacyUrl = process.env.PRIVACY_URL || 'https://whatsuptrivia.com.ng/privacy';
    
    await messagingService.sendMessage(
      phone,
      `🎉 *Welcome to What's Up Trivia!* 🎉

Play. Learn. Win.

Before you continue, please review and accept our Terms of Service and Privacy Policy.

📄 *Terms of Service:*
${termsUrl}

🔐 *Privacy Policy:*
${privacyUrl}

Reply:
1️⃣ I ACCEPT
2️⃣ I DO NOT ACCEPT`
    );

    await userService.setUserState(phone, 'TERMS_ACCEPTANCE', { platform });
  }

  async handleTermsAcceptance(phone, message, stateData) {
    const input = message.trim();
    const platform = stateData?.platform || 'whatsapp';
    
    if (input === '1' || input.toUpperCase() === 'I ACCEPT' || input.toUpperCase() === 'ACCEPT') {
      // User accepted - store consent data for later (will be saved when user is created)
      await userService.setUserState(phone, 'REGISTRATION_NAME', {
        termsAccepted: true,
        privacyAccepted: true,
        consentTimestamp: new Date().toISOString(),
        consentPlatform: platform
      });
      
      await messagingService.sendMessage(
        phone,
        `✅ Thank you for accepting our Terms and Privacy Policy!

🎉 *WELCOME TO WHAT'S UP TRIVIA GAME!* 🎉

The ultimate trivia game for you!

Test your knowledge and win amazing prizes! 🏆

_Developed & Proudly brought to you by SummerIsland Systems._

Let's get you registered! What's your full name?`
      );
    } else if (input === '2' || input.toUpperCase().includes('NOT ACCEPT') || input.toUpperCase() === 'DECLINE') {
      // User declined
      await userService.clearUserState(phone);
      
      await messagingService.sendMessage(
        phone,
        `❌ We're sorry to see you go!

You must accept our Terms of Service and Privacy Policy to use What's Up Trivia.

If you change your mind, simply send "Hi" to start again.

Thank you for your interest! 👋`
      );
    } else {
      // Invalid input
      await messagingService.sendMessage(
        phone,
        `⚠️ Please reply with:

1️⃣ I ACCEPT - to continue
2️⃣ I DO NOT ACCEPT - to decline`
      );
    }
  }

  async handleRegistrationName(phone, name, stateData = {}) {
    if (!name || name.trim().length < 2) {
      await messagingService.sendMessage(phone, '❌ Please enter a valid name (at least 2 characters).');
      return;
    }

    // Preserve consent data from terms acceptance
    await userService.setUserState(phone, 'REGISTRATION_CITY', {
      ...stateData,
      name: name.trim()
    });

    await messagingService.sendMessage(
      phone,
      `Nice to meet you, ${name}! 👋

Which city are you from?

📍 Examples: Lagos, Abuja, Uyo, Port Harcourt, Kano, London, New York

Type your city name:`
    );
  }

  async handleRegistrationCity(phone, city, stateData = {}) {
    if (!city || city.trim().length < 2) {
      await messagingService.sendMessage(phone, '❌ Please enter a valid city name.');
      return;
    }

    const formattedCity = city.trim()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');

    // Preserve consent data
    await userService.setUserState(phone, 'REGISTRATION_USERNAME', {
      ...stateData,
      city: formattedCity
    });

    await messagingService.sendMessage(
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
      await messagingService.sendMessage(phone, '❌ Username must be 3-20 characters long.\n\nTry again:');
      return;
    }

    if (!/^[a-z0-9_]+$/.test(cleanUsername)) {
      await messagingService.sendMessage(phone, '❌ Username can only contain letters, numbers, and underscores.\n\nNo spaces or special characters.\n\nTry again:');
      return;
    }

    const existingUser = await pool.query(
      'SELECT id FROM users WHERE LOWER(username) = $1',
      [cleanUsername]
    );

    if (existingUser.rows.length > 0) {
      await messagingService.sendMessage(phone, `❌ Username "@${cleanUsername}" is already taken!\n\nTry a different one:`);
      return;
    }

    // Preserve consent data
    await userService.setUserState(phone, 'REGISTRATION_AGE', {
      ...stateData,
      username: cleanUsername
    });

    await messagingService.sendMessage(
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
      await messagingService.sendMessage(phone, '❌ Please enter a valid age (13-120).\n\nYour age:');
      return;
    }

    // Preserve consent data
    await userService.setUserState(phone, 'REGISTRATION_REFERRAL', {
      ...stateData,
      age: age
    });

    await messagingService.sendMessage(
      phone,
      `Great! Almost done! 🎉

Do you have a referral code?

If a friend invited you, enter their code to get *1 FREE GAME* 🎁

Type the code, or type SKIP to continue:`
    );
  }

  async handleRegistrationReferral(phone, referralCodeInput, stateData) {
    const { name, city, username, age, termsAccepted, privacyAccepted, consentTimestamp, consentPlatform } = stateData;
    const input = referralCodeInput.trim().toUpperCase();

    let referrerId = null;

    if (input !== 'SKIP' && input.length > 0) {
      const referrerResult = await pool.query(
        'SELECT id, username FROM users WHERE UPPER(referral_code) = $1',
        [input]
      );

      if (referrerResult.rows.length === 0) {
        await messagingService.sendMessage(
          phone,
          '❌ Invalid referral code.\n\nType the correct code or type SKIP:'
        );
        return;
      }

      referrerId = referrerResult.rows[0].id;
      logger.info(`User registering with referral code: ${input} from user ${referrerId}`);
    }

    // Pass consent data to createUser
    const consentData = {
      termsAccepted: termsAccepted || false,
      privacyAccepted: privacyAccepted || false,
      consentTimestamp: consentTimestamp || null,
      consentPlatform: consentPlatform || 'whatsapp'
    };

    const user = await userService.createUser(phone, name, city, username, age, referrerId, consentData);
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
    welcomeMsg += `🎆 Happy New Year! 🎆\n\n`;

    if (isPaymentEnabled) {
      const gamesRemaining = referrerId ? 1 : 0;
      welcomeMsg += `💎 Games Remaining: ${gamesRemaining}\n\n`;
      
      if (gamesRemaining === 0) {
        welcomeMsg += `⚠️ You need games to play Classic Mode.\n`;
        welcomeMsg += `Try Practice Mode for FREE or buy games!\n\n`;
      }
      
      welcomeMsg += `Ready to play? Reply:\n\n`;
      welcomeMsg += `1️⃣ Play Now\n`;
      welcomeMsg += `2️⃣ How to Play\n`;
      welcomeMsg += `3️⃣ Leaderboard\n`;
      welcomeMsg += `4️⃣ Buy Games\n`;
      welcomeMsg += `5️⃣ My Stats`;
    } else {
      welcomeMsg += `Ready to play? Reply:\n\n`;
      welcomeMsg += `1️⃣ Play Now\n`;
      welcomeMsg += `2️⃣ How to Play\n`;
      welcomeMsg += `3️⃣ Leaderboard\n`;
      welcomeMsg += `4️⃣ My Stats`;
    }

    await messagingService.sendMessage(phone, welcomeMsg);
  }

// ============================================
// END OF PART 2/6
// Next: Game Mode & Tournament Selection
// ============================================
// ============================================
// Part 3/6: Game Mode & Tournament Selection
// APPEND TO PART 2
// ============================================

  // ============================================
  // GAME MODE SELECTION (UPDATED WITH TOURNAMENTS)
  // ============================================

  async showGameModeMenu(user) {
    await userService.setUserState(user.phone_number, 'SELECT_GAME_MODE');
    
    let message = `🎮 SELECT GAME MODE 🎮\n\n`;
    message += `Choose your challenge:\n\n`;
    
    message += `1️⃣ *Free Play - Practice Mode*\n`;
    message += `   Familiarize with gameplay\n`;
    message += `   ⚠️ No prizes won\n`;
    message += `   Perfect for learning!\n\n`;
    
    message += `2️⃣ *Classic Mode*\n`;
    message += `   General knowledge questions\n`;
    message += `   Win up to ₦50,000! 💰\n\n`;
    
    message += `3️⃣ *Sponsored Tournaments* 🏆\n`;
    message += `   Compete for MEGA prizes!\n`;
    message += `   Special sponsored events\n\n`;
    
    message += `_Proudly brought to you by SummerIsland Systems._\n\n`;
    message += `Reply with your choice (1, 2, or 3):`;
    
    await messagingService.sendMessage(user.phone_number, message);
  }

  async handleGameModeSelection(user, message) {
    const input = message.trim();
    
    switch(input) {
      case '1':
        // Free Play - Practice Mode (only checks suspension, allows during cooldown/limit)
        await userService.clearUserState(user.phone_number);
        await messagingService.sendMessage(
          user.phone_number,
          `✅ Practice Mode selected!\n\n⚠️ Remember: No real prizes in practice mode.\n\nStarting game...`
        );
        await gameService.startNewGame(user, 'practice');
        break;
        
      case '2':
        // Classic Mode - Check all restrictions
        const classicRestriction = await restrictionsService.canUserPlay(user.id, 'classic');
        if (!classicRestriction.canPlay) {
          await userService.clearUserState(user.phone_number);
          await messagingService.sendMessage(user.phone_number, classicRestriction.message);
          return;
        }
        
        // Game rate limit removed - keeping grand prize cooldown and daily win limit only
        // const rateLimit = await antiFraudService.checkGameRateLimit(user.id);
        // if (!rateLimit.allowed) {
        //   await userService.clearUserState(user.phone_number);
        //   await messagingService.sendMessage(user.phone_number, rateLimit.message);
        //   return;
        // }
        
        await userService.clearUserState(user.phone_number);
        await messagingService.sendMessage(
          user.phone_number,
          `✅ Classic Mode selected!\n\nStarting game...`
        );
        await gameService.startNewGame(user, 'classic');
        break;
        
      case '3':
        // Sponsored Tournaments - Check restrictions
        const tournamentRestriction = await restrictionsService.canUserPlay(user.id, 'tournament');
        if (!tournamentRestriction.canPlay) {
          await userService.clearUserState(user.phone_number);
          await messagingService.sendMessage(user.phone_number, tournamentRestriction.message);
          return;
        }
        
        await this.showTournamentCategories(user);
        break;
        
      default:
        await messagingService.sendMessage(
          user.phone_number,
          '⚠️ Please reply with 1, 2, or 3'
        );
        return;
    }
  }

  // ============================================
  // TOURNAMENT CATEGORIES & SELECTION
  // ============================================

  async showTournamentCategories(user) {
    try {
      const tournaments = await tournamentService.getActiveTournaments();
      
      if (tournaments.length === 0) {
        await messagingService.sendMessage(
          user.phone_number,
          '❌ No active tournaments at the moment.\n\n' +
          'Check back soon for exciting tournaments!\n\n' +
          'Type PLAY to try Classic Mode or Practice Mode.'
        );
        await userService.clearUserState(user.phone_number);
        return;
      }
      
      // Group tournaments by type
      const freeTournaments = tournaments.filter(t => t.payment_type === 'free');
      const paidTournaments = tournaments.filter(t => t.payment_type === 'paid');
      
      let message = `🏆 *SPONSORED TOURNAMENTS* 🏆\n\n`;
      
      // Show free tournaments first
      if (freeTournaments.length > 0) {
        message += `🆓 *FREE TOURNAMENTS*\n`;
        message += `━━━━━━━━━━━━━━━━\n\n`;
        
        freeTournaments.forEach((t, index) => {
          const endDate = new Date(t.end_date).toLocaleDateString();
          const sponsorTag = t.sponsor_name ? `\n_Sponsored by ${t.sponsor_name}_` : '';
          
          message += `${index + 1}️⃣ *${t.tournament_name}*${sponsorTag}\n`;
          message += `💰 Prize Pool: ₦${t.prize_pool.toLocaleString()}\n`;
          message += `📅 Ends: ${endDate}\n`;
          message += `👥 Participants: ${t.participant_count || 0}\n\n`;
        });
      }
      
      // Show paid tournaments
      if (paidTournaments.length > 0) {
        const startIndex = freeTournaments.length;
        message += `💳 *PAID ENTRY TOURNAMENTS*\n`;
        message += `━━━━━━━━━━━━━━━━\n\n`;
        
        paidTournaments.forEach((t, index) => {
          const endDate = new Date(t.end_date).toLocaleDateString();
          const sponsorTag = t.sponsor_name ? `\n_Sponsored by ${t.sponsor_name}_` : '';
          
          message += `${startIndex + index + 1}️⃣ *${t.tournament_name}*${sponsorTag}\n`;
          message += `💰 Prize Pool: ₦${t.prize_pool.toLocaleString()}\n`;
          message += `🎟️ Entry: ₦${t.entry_fee.toLocaleString()}\n`;
          message += `📅 Ends: ${endDate}\n`;
          message += `👥 Participants: ${t.participant_count || 0}`;
          
          if (t.max_participants) {
            message += `/${t.max_participants}`;
          }
          message += `\n\n`;
        });
      }
      
      message += `Reply with tournament number to join:\n`;
      message += `Or type MENU to return.`;
      
      await userService.setUserState(user.phone_number, 'SELECT_TOURNAMENT', { 
        tournaments: [...freeTournaments, ...paidTournaments]
      });
      
      await messagingService.sendMessage(user.phone_number, message);
      
    } catch (error) {
      logger.error('Error showing tournaments:', error);
      await messagingService.sendMessage(
        user.phone_number,
        '❌ Error loading tournaments. Type PLAY for regular game.'
      );
    }
  }

  async handleTournamentSelection(user, message, stateData) {
    const input = message.trim().toUpperCase();
    
    if (input === 'MENU' || input === 'BACK') {
      await userService.clearUserState(user.phone_number);
      await this.sendMainMenu(user.phone_number);
      return;
    }
    
    const tournamentIndex = parseInt(input) - 1;
    const tournaments = stateData.tournaments;
    
    if (tournamentIndex < 0 || tournamentIndex >= tournaments.length) {
      await messagingService.sendMessage(
        user.phone_number,
        '❌ Invalid selection. Reply with tournament number or MENU:'
      );
      return;
    }
    
    const tournament = tournaments[tournamentIndex];
    
    // Check if already joined
    const status = await tournamentService.getUserTournamentStatus(user.id, tournament.id);
    
    if (status && status.entry_paid) {
      // Already joined and paid - start game
      await userService.clearUserState(user.phone_number);
      
      let startMessage = `✅ You're already in "${tournament.tournament_name}"!\n\n`;
      
      if (tournament.uses_tokens && status.tokens_remaining !== null) {
        startMessage += `🎟️ Tokens remaining: ${status.tokens_remaining}\n\n`;
      }
      
      startMessage += `Starting tournament game...`;
      
      await messagingService.sendMessage(user.phone_number, startMessage);
      await gameService.startNewGame(user, 'tournament', tournament.id);
      return;
    }
    
    // Handle joining based on payment type
    if (tournament.payment_type === 'free') {
      await this.joinFreeTournament(user, tournament);
    } else {
      await this.showPaidTournamentInfo(user, tournament);
    }
  }

  async joinFreeTournament(user, tournament) {
    try {
      const result = await tournamentService.joinFreeTournament(user.id, tournament.id);
      
      await userService.clearUserState(user.phone_number);
      
      if (result.success) {
        let message = `🎉 *TOURNAMENT JOINED!* 🎉\n\n`;
        message += `${tournament.tournament_name}\n`;
        message += `Prize Pool: ₦${tournament.prize_pool.toLocaleString()}\n\n`;
        
        if (tournament.uses_tokens && result.tokensRemaining) {
          message += `🎟️ You have ${result.tokensRemaining} game attempts\n\n`;
        } else {
          message += `♾️ Unlimited plays during tournament!\n\n`;
        }
        
        message += `Starting game...`;
        
        await messagingService.sendMessage(user.phone_number, message);
        await gameService.startNewGame(user, 'tournament', tournament.id);
      } else {
        await messagingService.sendMessage(
          user.phone_number,
          `❌ ${result.error}\n\nType TOURNAMENTS to try again.`
        );
      }
    } catch (error) {
      logger.error('Error joining free tournament:', error);
      await messagingService.sendMessage(
        user.phone_number,
        '❌ Error joining tournament. Please try again.'
      );
    }
  }

  async showPaidTournamentInfo(user, tournament) {
    try {
      let message = `💳 *${tournament.tournament_name}*\n\n`;
      
      if (tournament.sponsor_name) {
        message += `_Sponsored by ${tournament.sponsor_name}_\n\n`;
      }
      
      message += `━━━━━━━━━━━━━━━━\n`;
      message += `💰 Prize Pool: ₦${tournament.prize_pool.toLocaleString()}\n`;
      message += `🎟️ Entry Fee: ₦${tournament.entry_fee.toLocaleString()}\n`;
      
      if (tournament.uses_tokens) {
        message += `🎮 Attempts: ${tournament.tokens_per_entry} games\n`;
      } else {
        message += `♾️ Unlimited plays after payment\n`;
      }
      
      message += `📅 Duration: Until ${new Date(tournament.end_date).toLocaleDateString()}\n`;
      
      if (tournament.max_participants) {
        const spotsLeft = tournament.max_participants - (tournament.participant_count || 0);
        message += `🪑 Spots Left: ${spotsLeft}/${tournament.max_participants}\n`;
      }
      
      message += `━━━━━━━━━━━━━━━━\n\n`;
      message += `Ready to join?\n\n`;
      message += `Reply YES to proceed with payment\n`;
      message += `Reply NO to go back`;
      
      await userService.setUserState(user.phone_number, 'CONFIRM_TOURNAMENT_PAYMENT', {
        tournamentId: tournament.id,
        tournamentName: tournament.tournament_name,
        entryFee: tournament.entry_fee
      });
      
      await messagingService.sendMessage(user.phone_number, message);
      
    } catch (error) {
      logger.error('Error showing paid tournament info:', error);
    }
  }

  // ============================================
  // TOURNAMENT PAYMENT CONFIRMATION
  // ============================================

  async handleTournamentPaymentConfirmation(phone, message, stateData) {
    const input = message.trim().toUpperCase();
    const user = await userService.getUserByPhone(phone);
    
    if (input === 'YES' || input === 'Y') {
      try {
        // Initialize payment
        const payment = await tournamentService.initializeTournamentPayment(
          user.id,
          stateData.tournamentId
        );
        
        await userService.clearUserState(phone);
        
        let message = `💳 TOURNAMENT PAYMENT 💳\n\n`;
        message += `Tournament: ${stateData.tournamentName}\n`;
        message += `Amount: ₦${stateData.entryFee.toLocaleString()}\n\n`;
        message += `Click link to pay:\n${payment.authorization_url}\n\n`;
        message += `Payment Reference: ${payment.reference}\n\n`;
        message += `⚠️ Link expires in 30 minutes\n\n`;
        message += `After payment, you'll be automatically added to the tournament!`;
        
        await messagingService.sendMessage(phone, message);
        
      } catch (error) {
        logger.error('Error initializing tournament payment:', error);
        await messagingService.sendMessage(
          phone,
          '❌ Error processing payment. Please try again.\n\nType TOURNAMENTS to start over.'
        );
      }
    } else if (input === 'NO' || input === 'N') {
      await userService.clearUserState(phone);
      await messagingService.sendMessage(
        phone,
        '✅ Payment cancelled.\n\nType TOURNAMENTS to view other tournaments.'
      );
    } else {
      await messagingService.sendMessage(
        phone,
        '⚠️ Please reply YES or NO'
      );
    }
  }

// ============================================
// END OF PART 3/6
// Next: Menu Input & Profile/Referral/Stats Commands
// ============================================
// ============================================
// Part 4/6: Menu Input & Command Handlers
// APPEND TO PART 3
// ============================================

  // ============================================
  // MAIN MENU INPUT HANDLER (FIXED VERSION)
  // ============================================

  async handleMenuInput(user, message) {
    const input = message.trim().toUpperCase();
    const isPaymentEnabled = paymentService.isEnabled();

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

    // TOURNAMENTS command
    if (input.includes('TOURNAMENT')) {
      // Check restrictions before showing tournaments
      const restriction = await restrictionsService.canUserPlay(user.id, 'tournament');
      if (!restriction.canPlay) {
        await messagingService.sendMessage(user.phone_number, restriction.message);
        return;
      }
      await this.showTournamentCategories(user);
      return;
    }

    // ACHIEVEMENTS command
    if (input === 'ACHIEVEMENTS' || input === 'BADGES' || input.includes('ACHIEVEMENT')) {
      await this.handleAchievementsCommand(user);
      return;
    }

    // WIN SHARING (YES/Y/SHARE/4 response)
    const winSharePending = await redis.get(`win_share_pending:${user.id}`);
    if (winSharePending && (
        input === 'YES' || 
        input === 'Y' || 
        input === 'SHARE' || 
        input === '4' ||
        input.includes('VICTORY') ||
        input.includes('CARD')
    )) {
      await this.handleWinShare(user, JSON.parse(winSharePending));
      await redis.del(`win_share_pending:${user.id}`);
      await redis.del(`post_game:${user.id}`);
      return;
    }
    
    // SHARE command fallback - when win_share_pending has expired but user has unshared victory card
    if (!winSharePending && (input === 'SHARE' || input === '4' || input.includes('VICTORY'))) {
      const winData = await victoryCardsService.getWinDataForShare(user.id);
      if (winData) {
        // User has an unshared win - generate victory card
        await this.handleWinShare(user, winData);
        return;
      }
    }

    // BUY command (text-based) - works regardless of payment mode
    if (input.includes('BUY')) {
      await this.handleBuyGames(user);
      return;
    }

    // STATS command (text-based)
    if (input.includes('STATS') || input.includes('STATISTICS')) {
      await this.handleStatsRequest(user);
      return;
    }

    // Check for explicit post-game state first
    const postGameState = await redis.get(`post_game:${user.id}`);
    const isInPostGameWindow = postGameState !== null;
    
    // Parse post-game state to get game type
    let postGameData = null;
    if (isInPostGameWindow) {
      try {
        postGameData = JSON.parse(postGameState);
      } catch (e) {
        // Legacy format (just timestamp string) - treat as non-practice
        postGameData = { gameType: 'classic', timestamp: parseInt(postGameState) };
      }
    }
    
    // If NOT in post-game window, check for active session conflicts
    if (!isInPostGameWindow) {
      const activeSession = await gameService.getActiveSession(user.id);
      
      if (activeSession) {
        await messagingService.sendMessage(
          user.phone_number,
          '⚠️ You have an active game. Complete it or type RESET.'
        );
        return;
      }
      
      // Clear any stale user state
      const userState = await userService.getUserState(user.phone_number);
      if (userState && !['SELECT_GAME_MODE', 'SELECT_TOURNAMENT', 'SELECT_PACKAGE', 'SELECT_LEADERBOARD'].includes(userState.state)) {
        logger.warn(`Clearing unexpected state: ${userState.state} for user ${user.id}`);
        await userService.clearUserState(user.phone_number);
      }
    }

    // Welcome back message (only if NOT in post-game and not recent)
    const lastActiveMinutesAgo = user.last_active ? 
      (Date.now() - new Date(user.last_active).getTime()) / 60000 : 999;

    if (!isInPostGameWindow && lastActiveMinutesAgo > 5 && 
        !input.includes('PLAY') && 
        input !== '1' && input !== '2' && input !== '3' && input !== '4' && input !== '5') {

      let welcomeMessage = `Hello again @${user.username}! 👋\n\n`;
      welcomeMessage += `Welcome back to What's Up Trivia Game! 🎉\n\n`;

      if (isPaymentEnabled) {
        const gamesRemaining = await paymentService.getGamesRemaining(user.id);
        welcomeMessage += `💎 Classic Mode Tokens: ${gamesRemaining}\n\n`;
      }

      welcomeMessage += `_Proudly brought to you by SummerIsland Systems._\n\n`;
      welcomeMessage += `🎆 Happy New Year! 🎆\n\n`;
      welcomeMessage += `What would you like to do?\n\n`;
      welcomeMessage += `1️⃣ Play Now\n`;
      welcomeMessage += `2️⃣ How to Play\n`;
      welcomeMessage += `3️⃣ View Leaderboard\n`;

      if (isPaymentEnabled) {
        welcomeMessage += `4️⃣ Buy Games\n`;
        welcomeMessage += `5️⃣ My Stats`;
      } else {
        welcomeMessage += `4️⃣ My Stats`;
      }

      await messagingService.sendMessage(user.phone_number, welcomeMessage);
      await pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [user.id]);
      return;
    }

    // ============================================
    // POST-GAME MENU HANDLING
    // Practice mode menu:
    //   1️⃣ Play Again | 2️⃣ View Leaderboard | 3️⃣ Main Menu
    // Classic/Tournament win menu:
    //   1️⃣ Play Again | 2️⃣ View Leaderboard | 3️⃣ Claim Prize | 4️⃣ Share Victory Card
    // ============================================
    if (isInPostGameWindow) {
      const isPracticeMode = postGameData && postGameData.gameType === 'practice';
      
      if (input === '1' || input.includes('PLAY') || input.includes('AGAIN')) {
        await redis.del(`post_game:${user.id}`);
        await this.showGameModeMenu(user);
        return;
      } else if (input === '2' || input.includes('LEADERBOARD')) {
        await this.sendLeaderboardMenu(user.phone_number);
        return;
      } else if (input === '3') {
        await redis.del(`post_game:${user.id}`);
        // Check if user has actual winnings to claim - check DB directly as backup
        let hasWinnings = postGameData && postGameData.finalScore > 0 && postGameData.gameType !== 'practice';
        
        // Double-check with database in case postGameData is stale
        if (!hasWinnings) {
          const pendingTx = await payoutService.getPendingTransaction(user.id);
          hasWinnings = pendingTx && parseFloat(pendingTx.amount) > 0;
        }
        
        if (hasWinnings) {
          // Classic/Tournament mode with winnings: Option 3 = Claim Prize
          await this.handleClaimPrize(user);
        } else {
          // Practice mode OR no winnings: Option 3 = Main Menu
          await this.sendMainMenu(user.phone_number);
        }
        return;
      } else if (input.includes('CLAIM')) {
        // Explicit CLAIM keyword always goes to claim prize
        await redis.del(`post_game:${user.id}`);
        await this.handleClaimPrize(user);
        return;
      } else if (input === '4' || input.includes('SHARE') || input.includes('VICTORY') || input.includes('CARD')) {
        if (winSharePending) {
          await this.handleWinShare(user, JSON.parse(winSharePending));
          await redis.del(`win_share_pending:${user.id}`);
          await redis.del(`post_game:${user.id}`);
        } else {
          // Fallback: check if user has unshared win
          const winData = await victoryCardsService.getWinDataForShare(user.id);
          if (winData) {
            await this.handleWinShare(user, winData);
            await redis.del(`post_game:${user.id}`);
          } else {
            await messagingService.sendMessage(
              user.phone_number,
              '❌ No victory card available.\n\nType MENU for main menu.'
            );
          }
        }
        return;
      } else if (input === 'MENU' || input.includes('MAIN')) {
        await redis.del(`post_game:${user.id}`);
        await this.sendMainMenu(user.phone_number);
        return;
      }
      // If input doesn't match post-game options, fall through to regular menu
    }

    // ============================================
    // REGULAR MAIN MENU HANDLING
    // Payment ENABLED:
    //   1️⃣ Play Now | 2️⃣ How to Play | 3️⃣ Leaderboard | 4️⃣ Buy Games | 5️⃣ Stats
    // Payment DISABLED:
    //   1️⃣ Play Now | 2️⃣ How to Play | 3️⃣ Leaderboard | 4️⃣ Stats
    // ============================================
    if (input === '1' || input.includes('PLAY')) {
      await this.showGameModeMenu(user);
    } else if (input === '2' || input.includes('HOW')) {
      await this.sendHowToPlay(user.phone_number);
    } else if (input === '3' || input.includes('LEADERBOARD')) {
      await this.sendLeaderboardMenu(user.phone_number);
    } else if (input === '4') {
      // Option 4 depends on payment mode
      if (isPaymentEnabled) {
        await this.handleBuyGames(user);
      } else {
        await this.handleStatsRequest(user);
      }
    } else if (input === '5') {
      // Option 5 is Stats (only when payment is enabled)
      if (isPaymentEnabled) {
        await this.handleStatsRequest(user);
      } else {
        await this.sendMainMenu(user.phone_number);
      }
    } else if (input === 'RESET' || input === 'RESTART') {
      await this.handleReset(user);
    } else if (input === 'STREAK' || input === 'STREAKS') {
      await this.handleStreakCommand(user);
    } else {
      await this.sendMainMenu(user.phone_number);
    }
  }

  // ============================================
  // STREAK COMMAND
  // ============================================

  async handleStreakCommand(user) {
    try {
      // Get user's streak info
      const streakInfo = await streakService.getStreakInfo(user.id);
      
      // Get streak leaderboard
      const leaderboard = await streakService.getStreakLeaderboard(10);
      
      let message = `🔥 *DAILY STREAK* 🔥\n\n`;
      
      // User's streak info
      message += `*Your Streak:*\n`;
      if (streakInfo && streakInfo.currentStreak > 0) {
        message += `🔥 Current: ${streakInfo.currentStreak} days ${streakInfo.badgeEmoji}\n`;
        message += `🏆 Longest: ${streakInfo.longestStreak} days\n`;
        if (streakInfo.playedToday) {
          message += `✅ Played today!\n`;
        } else if (streakInfo.isActive) {
          message += `⚠️ Play today to keep your streak!\n`;
        }
        if (streakInfo.nextMilestone) {
          message += `📍 ${streakInfo.daysToNextMilestone} day(s) to next reward!\n`;
        }
      } else {
        message += `You don't have an active streak.\n`;
        message += `Play Classic or Tournament mode to start!\n`;
      }
      
      message += `\n━━━━━━━━━━━━━━━━\n\n`;
      
      // Streak rewards info
      message += `*🎁 STREAK REWARDS:*\n`;
      message += `3 days: 1 Free Game 🔥\n`;
      message += `7 days: 2 Free Games 🔥🔥\n`;
      message += `14 days: 3 Free Games 🔥🔥🔥\n`;
      message += `30 days: 5 Free Games 🏆\n`;
      message += `60 days: 10 Free Games 💎\n\n`;
      
      message += `━━━━━━━━━━━━━━━━\n\n`;
      
      // Streak leaderboard
      message += `*🏅 STREAK LEADERBOARD:*\n\n`;
      
      if (leaderboard.length === 0) {
        message += `No active streaks yet!\nBe the first! 🎯\n`;
      } else {
        for (const player of leaderboard) {
          const medal = player.rank === 1 ? '🥇' : player.rank === 2 ? '🥈' : player.rank === 3 ? '🥉' : '';
          message += `${player.rank}. @${player.username} - ${player.currentStreak} days ${player.badgeEmoji} ${medal}\n`;
        }
      }
      
      message += `\n_Practice mode doesn't count toward streak._\n`;
      message += `\nType MENU for main menu.`;
      
      await messagingService.sendMessage(user.phone_number, message);
      
    } catch (error) {
      logger.error('Error handling streak command:', error);
      await messagingService.sendMessage(
        user.phone_number,
        '❌ Error loading streak info. Please try again.'
      );
    }
  }

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

      await messagingService.sendMessage(user.phone_number, message);

    } catch (error) {
      logger.error('Error handling profile command:', error);
      await messagingService.sendMessage(
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

      await messagingService.sendMessage(user.phone_number, message);

    } catch (error) {
      logger.error('Error handling referral command:', error);
      await messagingService.sendMessage(
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
      const isPaymentEnabled = paymentService.isEnabled();

      if (!stats) {
        await messagingService.sendMessage(
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

      // Add streak info
      try {
        const streakInfo = await streakService.getStreakInfo(user.id);
        message += `🔥 STREAK\n`;
        message += `━━━━━━━━━━━━━━━━\n`;
        if (streakInfo && streakInfo.currentStreak > 0) {
          message += `Current: ${streakInfo.currentStreak} days ${streakInfo.badgeEmoji}\n`;
          message += `Longest: ${streakInfo.longestStreak} days\n`;
          if (streakInfo.nextMilestone) {
            message += `Next reward: ${streakInfo.daysToNextMilestone} day(s)\n`;
          }
        } else {
          message += `No active streak\n`;
        }
        message += `\n`;
      } catch (err) {
        // Don't fail stats if streak fetch fails
      }

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

      if (isPaymentEnabled) {
        message += `💎 GAMES\n`;
        message += `━━━━━━━━━━━━━━━━\n`;
        message += `Games Remaining: ${stats.gamesRemaining}\n`;
        message += `Total Purchased: ${stats.totalGamesPurchased}\n\n`;
      }

      message += `📅 Member Since: ${new Date(stats.joinedDate).toLocaleDateString()}\n\n`;
      message += `_Proudly brought to you by SummerIsland Systems._\n\n`;
      message += `Keep playing to climb the ranks! 🚀\n\n`;
      message += `1️⃣ Play Now\n`;
      message += `2️⃣ How to Play\n`;
      message += `3️⃣ View Leaderboard\n`;
      if (isPaymentEnabled) {
        message += `4️⃣ Buy Games\n`;
      }
      message += `\nType MENU for main menu.`;

      await messagingService.sendMessage(user.phone_number, message);

    } catch (error) {
      logger.error('Error handling stats request:', error);
      await messagingService.sendMessage(
        user.phone_number,
        '❌ Error retrieving stats. Please try again later.'
      );
    }
  }

  // ============================================
  // PAYMENT HANDLERS
  // ============================================

  async handleBuyGames(user) {
    try {
      if (!paymentService.isEnabled()) {
        await messagingService.sendMessage(
          user.phone_number,
          '🎉 Good news! The game is currently FREE!\n\nType PLAY to start a game.'
        );
        return;
      }

      const packages = await paymentService.getPackages();
      const message = paymentService.formatPaymentMessage(packages);

      await messagingService.sendMessage(user.phone_number, message);
      await userService.setUserState(user.phone_number, 'SELECT_PACKAGE', { packages });

    } catch (error) {
      logger.error('Error handling buy games:', error);
      await messagingService.sendMessage(
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
        await messagingService.sendMessage(
          user.phone_number,
          '❌ Invalid selection. Please reply with 1, 2, or 3.'
        );
        return;
      }

      const selectedPackage = packages[packageIndex];
      const payment = await paymentService.initializePayment(user, selectedPackage.id);

      await userService.clearUserState(user.phone_number);

      await messagingService.sendMessage(
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
      await messagingService.sendMessage(
        user.phone_number,
        '❌ Error processing payment. Please try again.'
      );
    }
  }

// ============================================
// END OF PART 4/6
// Next: Payout Handlers & Menu Senders
// ============================================
// ============================================
// Part 5/6: Complete Payout Handlers
// APPEND TO PART 4
// ============================================

  // ============================================
  // PAYOUT HANDLERS (COMPLETE BANK DETAILS FLOW)
  // ============================================

  async handleClaimPrize(user) {
    try {
      const transaction = await payoutService.getPendingTransaction(user.id);

      if (!transaction) {
        await messagingService.sendMessage(
          user.phone_number,
          '❌ No pending prizes to claim.\n\nPlay games to win prizes! 🎮\n\nType PLAY to start.'
        );
        return;
      }

      // Check if victory card must be shared first
      const canClaim = await victoryCardsService.canUserClaim(user.id);
      if (!canClaim.canClaim && canClaim.reason === 'victory_card_required') {
        // Regenerate win_share_pending so user can share their card
        const winData = await victoryCardsService.getWinDataForShare(user.id);
        if (winData) {
          await redis.setex(`win_share_pending:${user.id}`, 86400, JSON.stringify(winData)); // 24 hours
          logger.info(`Regenerated win_share_pending for user ${user.id} during claim attempt`);
        }
        
        await messagingService.sendMessage(
          user.phone_number,
          victoryCardsService.getVictoryCardRequiredMessage(parseFloat(transaction.amount))
        );
        return;
      }

      const existingDetails = await payoutService.getPayoutDetails(transaction.id);

      if (existingDetails) {
        await messagingService.sendMessage(
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

        await messagingService.sendMessage(
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

      await messagingService.sendMessage(
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
      await messagingService.sendMessage(
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

        await messagingService.sendMessage(
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
        await messagingService.sendMessage(
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

      await messagingService.sendMessage(
        phone,
        `🔄 UPDATE BANK DETAILS\n\n` +
        `Step 1 of 3\n\n` +
        `Please send your NEW ACCOUNT NAME\n` +
        `(exactly as it appears on your bank statement)\n\n` +
        `Reply with your account name:`
      );
    } else if (input === 'CANCEL' || input === '❌') {
      await userService.clearUserState(phone);

      await messagingService.sendMessage(
        phone,
        '❌ Claim cancelled.\n\nType CLAIM when you\'re ready to proceed.'
      );
    } else {
      await messagingService.sendMessage(
        phone,
        '⚠️ Invalid response.\n\nReply:\n✅ YES\n🔄 UPDATE\n❌ CANCEL'
      );
    }
  }

  async handleAccountNameInput(phone, message, stateData) {
    const accountName = message.trim();

    if (accountName.length < 3) {
      await messagingService.sendMessage(
        phone,
        '❌ Account name too short. Please enter your full name as it appears on your bank account.'
      );
      return;
    }

    if (accountName.length > 100) {
      await messagingService.sendMessage(
        phone,
        '❌ Account name too long. Please enter a valid name (max 100 characters).'
      );
      return;
    }

    if (!/[a-zA-Z]/.test(accountName)) {
      await messagingService.sendMessage(
        phone,
        '❌ Invalid account name. Please enter letters only (no numbers or special characters).'
      );
      return;
    }

    await userService.setUserState(phone, 'COLLECT_ACCOUNT_NUMBER', {
      ...stateData.data,
      accountName: accountName.toUpperCase()
    });

    await messagingService.sendMessage(
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
      await messagingService.sendMessage(
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

    await messagingService.sendMessage(
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

      await messagingService.sendMessage(
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
      await messagingService.sendMessage(
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
      await messagingService.sendMessage(
        phone,
        '❌ Bank name too short. Please enter a valid bank name.'
      );
      return;
    }

    if (bankName.length > 100) {
      await messagingService.sendMessage(
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

      await messagingService.sendMessage(
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
      await messagingService.sendMessage(
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
        await messagingService.sendMessage(
          user.phone_number,
          '❌ No recent payments found to confirm.'
        );
        return;
      }

      const transaction = result.rows[0];

      await payoutService.confirmPayout(transaction.id);

      await messagingService.sendMessage(
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
// END OF PART 5/6
// Next: Game Input, Menu Senders, Leaderboard, Reset, Victory Card
// ============================================
// ============================================
// Part 6/6 FINAL: Game Input, Menu Senders, Leaderboard, Reset, Victory Card
// APPEND TO PART 5 - THIS COMPLETES THE FILE
// ============================================

  // ============================================
  // GAME INPUT HANDLER
  // ============================================

  async handleGameInput(user, session, message) {
    const input = message.trim().toUpperCase();
    const gameReady = await redis.get(`game_ready:${user.id}`);

    if (gameReady && input === 'START') {
      await redis.del(`game_ready:${user.id}`);

      await messagingService.sendMessage(
        user.phone_number,
        '🎮 LET\'S GO! 🎮\n\nStarting in 3... 2... 1...'
      );

      setTimeout(async () => {
        await gameService.sendQuestion(session, user);
      }, 2000);

      return;
    }

    if (gameReady) {
      await messagingService.sendMessage(
        user.phone_number,
        '⚠️ Reply START to begin the game!'
      );
      return;
    }

    // ==========================================
    // CHECK FOR TURBO MODE GO WAIT
    // User must type GO to continue after turbo mode warning
    // ==========================================
    const isWaitingForGo = await gameService.isWaitingForTurboGo(session.session_key);
    if (isWaitingForGo) {
      if (input === 'GO') {
        await gameService.handleTurboGoInput(session, user);
        return;
      } else {
        // User typed something other than GO
        await messagingService.sendMessage(
          user.phone_number,
          `⚡ TURBO MODE ACTIVE ⚡\n\nType *GO* to continue.\n\n⏱️ Clock is ticking...`
        );
        return;
      }
    }

    // ==========================================
    // CHECK FOR PENDING CAPTCHA FIRST
    // This must come before the A/B/C/D check
    // ==========================================
    const hasPendingCaptcha = await gameService.hasPendingCaptcha(session.session_key);
    if (hasPendingCaptcha) {
      // User is responding to a CAPTCHA, not a game question
      const handled = await gameService.processCaptchaAnswer(session, user, input);
      if (handled) {
        return;
      }
    }

    // Lifelines
    if (input.includes('50') || input.includes('5050')) {
      await gameService.useLifeline(session, user, 'fifty_fifty');
      return;
    }

    if (input.includes('SKIP')) {
      await gameService.useLifeline(session, user, 'skip');
      return;
    }

    // Answer
    if (['A', 'B', 'C', 'D'].includes(input)) {
      await gameService.processAnswer(session, user, input);
    } else {
      await messagingService.sendMessage(
        user.phone_number,
        '⚠️ Please reply with A, B, C, or D\n\n' +
        'Or use a lifeline:\n' +
        '- Type "50" to activate 50:50\n' +
        '- Type "Skip" to skip question\n' +
        '- Type "RESET" to start over'
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
      await redis.del(`post_game:${user.id}`);
      await redis.del(`win_share_pending:${user.id}`);

      const isPaymentEnabled = paymentService.isEnabled();

      let message = `🔄 Game Reset! 🔄\n\n`;
      message += `All active games have been cancelled.\n\n`;
      message += `Ready to start fresh?\n\n`;
      message += `1️⃣ Play Now\n`;
      message += `2️⃣ How to Play\n`;
      message += `3️⃣ Leaderboard\n`;

      if (isPaymentEnabled) {
        message += `4️⃣ Buy Games\n`;
        message += `5️⃣ My Stats`;
      } else {
        message += `4️⃣ My Stats`;
      }

      await messagingService.sendMessage(user.phone_number, message);

    } catch (error) {
      logger.error('Error resetting game:', error);
      await messagingService.sendMessage(
        user.phone_number,
        'Reset complete! Type 1 to start a new game.'
      );
    }
  }

  // ============================================
  // MENU SENDERS
  // ============================================

  async sendMainMenu(phone) {
  // 🔧 ADD THIS: Clear post-game state when showing main menu
  const user = await userService.getUserByPhone(phone);
  if (user) {
    await redis.del(`post_game:${user.id}`);
  }
  
  const isPaymentEnabled = paymentService.isEnabled();

  let message = '🏠 MAIN MENU 🏠\n\n';

  if (user) {
    // Show streak info
    try {
      const streakInfo = await streakService.getStreakInfo(user.id);
      if (streakInfo && streakInfo.currentStreak > 0) {
        message += `🔥 Streak: ${streakInfo.currentStreak} days ${streakInfo.badgeEmoji}\n`;
        if (!streakInfo.playedToday && streakInfo.isActive) {
          message += `   ⚠️ Play today to keep it!\n`;
        }
        message += '\n';
      }
    } catch (err) {
      // Don't fail menu if streak fetch fails
    }
    
    if (isPaymentEnabled) {
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

  message += '\nType STREAK to see streak leaderboard 🔥\n';
  message += 'Having issues? Type RESET to start fresh.\n\nReply with your choice.';

  await messagingService.sendMessage(phone, message);
}

  async sendHowToPlay(phone) {
    let message = `📖 HOW TO PLAY 📖\n\n`;
    
    message += `🎮 *GAME MODES:*\n\n`;
    
    message += `1️⃣ *Practice Mode* (FREE)\n`;
    message += `   • Learn the game\n`;
    message += `   • No real prizes\n`;
    message += `   • Unlimited plays\n\n`;
    
    message += `2️⃣ *Classic Mode*\n`;
    message += `   • 15 questions\n`;
    message += `   • Win up to ₦50,000\n`;
    message += `   • Uses game tokens\n\n`;
    
    message += `3️⃣ *Tournaments*\n`;
    message += `   • Compete with others\n`;
    message += `   • MEGA prize pools\n`;
    message += `   • Free or paid entry\n\n`;
    
    message += `━━━━━━━━━━━━━━━━\n\n`;
    
    message += `⏱️ *TIME LIMIT:* 15 seconds per question\n\n`;
    
    message += `💎 *LIFELINES:*\n`;
    message += `• 50:50 - Remove 2 wrong answers\n`;
    message += `• Skip - Move to next question\n\n`;
    
    message += `🏆 *PRIZE LADDER:*\n`;
    message += `Q15: ₦50,000 🥇\n`;
    message += `Q12: ₦25,000\n`;
    message += `Q10: ₦10,000 (SAFE)\n`;
    message += `Q8: ₦5,000\n`;
    message += `Q5: ₦1,000 (SAFE)\n\n`;
    
    message += `Safe amounts are guaranteed!\n\n`;
    message += `Ready to play? Reply "PLAY NOW"`;
    
    await messagingService.sendMessage(phone, message);
  }

  // ============================================
  // LEADERBOARD HANDLERS
  // ============================================

  async sendLeaderboardMenu(phone) {
    await userService.setUserState(phone, 'SELECT_LEADERBOARD');

    await messagingService.sendMessage(
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
        await messagingService.sendMessage(
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

    await messagingService.sendMessage(phone, message);
  }

  // ============================================
  // VICTORY CARD HANDLER (WITH BRANDING)
  // ============================================

  async handleWinShare(user, winData) {
    const ImageService = require('../services/image.service');
    const imageService = new ImageService();
    const fs = require('fs');

    try {
      await messagingService.sendMessage(
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

      await messagingService.sendImage(
        user.phone_number,
        imagePath,
        `🏆 @${user.username} won ₦${winData.amount.toLocaleString()} playing What's Up Trivia Game! Join now: https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}`
      );

      // Mark ALL victory cards as shared in database (user may have multiple pending)
      try {
        await victoryCardsService.markAllCardsAsShared(user.id);
        logger.info(`All pending victory cards marked as shared for user ${user.id}`);
      } catch (vcError) {
        logger.error('Error marking victory cards as shared:', vcError);
      }

      // Check and award achievements
      try {
        const newAchievements = await achievementsService.checkAndAwardAchievements(user.id);
        if (newAchievements.length > 0) {
          for (const achievement of newAchievements) {
            await messagingService.sendMessage(
              user.phone_number,
              achievementsService.formatNewAchievementMessage(achievement)
            );
          }
        }
      } catch (achError) {
        logger.error('Error checking achievements:', achError);
      }

      await messagingService.sendMessage(
        user.phone_number,
        `✅ Victory card sent! 🎉

Save it and share on your WhatsApp Status to inspire others!

You can now claim your prize! 💰

1️⃣ Play Again
2️⃣ View Leaderboard
3️⃣ Claim Prize`
      );

      fs.unlinkSync(imagePath);
      imageService.cleanupTempFiles();

    } catch (error) {
      logger.error('Error handling win share:', error);
      await messagingService.sendMessage(
        user.phone_number,
        '❌ Sorry, something went wrong creating your victory card. Please try again later.'
      );
    }
  }

  // ============================================
  // ACHIEVEMENTS COMMAND
  // ============================================
  
  async handleAchievementsCommand(user) {
    try {
      const achievements = await achievementsService.getUserAchievements(user.id);
      const message = achievementsService.formatAchievementsMessage(achievements);
      await messagingService.sendMessage(user.phone_number, message);
    } catch (error) {
      logger.error('Error handling achievements command:', error);
      await messagingService.sendMessage(
        user.phone_number,
        '❌ Error loading achievements. Please try again.'
      );
    }
  }
}

// ============================================
// EXPORT
// ============================================

module.exports = new WebhookController();

// ============================================
// COMPLETE FILE END
// ============================================
// This is the COMPLETE webhook.controller.js with:
// ✅ All imports and setup
// ✅ verify() and handleMessage() methods
// ✅ Complete routeMessage() with ALL state handlers
// ✅ All registration handlers (with referrals)
// ✅ Updated game mode selection (Practice, Classic, Tournaments)
// ✅ Complete tournament selection and payment handlers
// ✅ Profile, referral, and stats commands
// ✅ Enhanced menu input handler
// ✅ Payment handlers (buy games, package selection)
// ✅ Complete payout handlers (full bank details flow)
// ✅ Game input handler with lifelines
// ✅ Reset handler
// ✅ All menu senders (main menu, how to play)
// ✅ Complete leaderboard handlers
// ✅ Victory card handler with branding
// ✅ NO TRUNCATIONS - FULLY COMPLETE