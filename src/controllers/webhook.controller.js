// ============================================
// FILE: src/controllers/webhook.controller.js
// COMPLETE MERGED VERSION + ANTI-CHEAT PATCHES
// Includes: Temp suspension, photo verification,
//           image message handling, Love Quest
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
const loveQuestService = require('../services/love-quest.service');
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

        // Check for image messages (photo verification)
        if (message.type === 'image') {
          logger.info(`📷 Image received from ${from}`);
          await this.handleImageMessage(from, message);
          return;
        }

        // Check for audio messages (Love Quest voice notes)
        if (message.type === 'audio') {
          logger.info(`🎤 Audio received from ${from}`);
          await this.handleAudioMessage(from, message);
          return;
        }

        // Check for video messages (Love Quest videos)
        if (message.type === 'video') {
          logger.info(`🎬 Video received from ${from}`);
          await this.handleVideoMessage(from, message);
          return;
        }

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
        // Check permanent suspension
        const suspension = await restrictionsService.isUserSuspended(user.id);
        if (suspension.suspended) {
          await messagingService.sendMessage(phone, restrictionsService.getSuspensionMessage(suspension.reason));
          return;
        }

        // Check temporary suspension (Q1 timeout abuse)
        const tempSuspension = await restrictionsService.isUserTempSuspended(user.id);
        if (tempSuspension.suspended) {
          // Allow practice mode even during temp suspension
          const isPracticeRequest = input === 'PRACTICE' || input === '2';
          if (!isPracticeRequest) {
            await messagingService.sendMessage(phone, restrictionsService.getTempSuspensionMessage(tempSuspension));
            return;
          }
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

      // Email collection state
      if (userState && userState.state === 'EMAIL_COLLECT') {
        await this.handleEmailCollection(phone, message, user);
        return;
      }

      // ===================================
      // PRIORITY 1.5: LOVE QUEST STATES
      // ===================================
      if (userState && userState.state === 'LOVE_QUEST_PACKAGE_SELECT') {
        await this.handleLoveQuestPackageSelection(phone, message, userState);
        return;
      }

      if (userState && userState.state === 'LOVE_QUEST_PLAYER_PHONE') {
        await this.handleLoveQuestPlayerPhone(phone, message, userState);
        return;
      }

      if (userState && userState.state === 'LOVE_QUEST_PLAYER_NAME') {
        await this.handleLoveQuestPlayerName(phone, message, userState);
        return;
      }

      if (userState && userState.state === 'LOVE_QUEST_VOICE_NOTE') {
        await messagingService.sendMessage(phone, `🎤 Please send a voice note now!\n\nOr type SKIP to continue without audio.`);
        return;
      }

      if (userState && userState.state === 'LOVE_QUEST_VOICE_MENU') {
        await this.handleLoveQuestVoiceMenu(phone, message, userState);
        return;
      }

      if (userState && userState.state === 'LOVE_QUEST_VIDEO_MENU') {
        await this.handleLoveQuestVideoMenu(phone, message, userState);
        return;
      }

      // ===================================
      // PRIORITY 1.6: LOVE QUEST ACTIVE SESSION
      // ===================================
      const loveQuestSession = await loveQuestService.getActiveSession(phone);
      if (loveQuestSession) {
        await this.handleLoveQuestInput(phone, message, loveQuestSession);
        return;
      }

      // ===================================
      // PRIORITY 1.7: LOVE QUEST INVITATION CHECK
      // ===================================
      const loveQuestBooking = await loveQuestService.getBookingByPlayerPhone(phone);
      if (loveQuestBooking && input === 'START') {
        await this.startLoveQuest(phone, loveQuestBooking);
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
        const upperInput = message.trim().toUpperCase();
        if (postGameState || upperInput === 'CLAIM' || upperInput.includes('CLAIM')) {
          // User is in post-game window or trying to claim - clear leaderboard state so it can be handled
          await userService.clearUserState(phone);
          // Don't return - let it fall through to handleMenuInput for post-game/claim handling
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
      // Handle common misspellings: recieved, receved, etc.
      // ===================================
      const receivedVariants = ['RECEIVED', 'RECIEVED', 'RECEVED', 'RECIVED', 'CONFIRM', 'CONFIRMED'];
      if (receivedVariants.includes(input) || input.includes('CONFIRM')) {
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
      // PRIORITY 8.7: HELP COMMAND
      // Allow "HELP" keyword to work anytime
      // ===================================
      if (input === 'HELP' || input === 'COMMANDS') {
        await this.sendHelpMenu(user.phone_number);
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
  // EMAIL COLLECTION
  // Soft prompt after first game, respects 7-day cooldown
  // ============================================
  
  async maybePromptForEmail(user) {
    try {
      // Skip if user already has email
      if (user.email) return;
      
      // Check cooldown: don't ask again within 7 days
      if (user.email_prompted_at) {
        const daysSincePrompt = (Date.now() - new Date(user.email_prompted_at).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSincePrompt < 7) return;
      }
      
      // Count their completed games
      const gameCount = await pool.query(
        'SELECT COUNT(*) as count FROM game_sessions WHERE user_id = $1 AND status = $2',
        [user.id, 'completed']
      );
      const games = parseInt(gameCount.rows[0].count);
      
      // Only prompt after at least 1 completed game
      if (games < 1) return;
      
      // Mark as prompted (even if they skip, we respect the cooldown)
      await pool.query(
        'UPDATE users SET email_prompted_at = NOW() WHERE id = $1',
        [user.id]
      );
      
      await userService.setUserState(user.phone_number, 'EMAIL_COLLECT');
      
      await messagingService.sendMessage(user.phone_number,
        `📧 *Stay in the Loop!*\n\n` +
        `Get notified about upcoming tournaments, events, and exclusive prizes!\n\n` +
        `Share your email address to receive our newsletter.\n\n` +
        `Type your email or SKIP to continue:`
      );
    } catch (error) {
      logger.error('Error in email prompt:', error);
      // Don't block gameplay on email errors
    }
  }
  
  async handleEmailCollection(phone, message, user) {
    const input = message.trim();
    
    if (input.toUpperCase() === 'SKIP' || input.toUpperCase() === 'NO') {
      await userService.clearUserState(phone);
      await messagingService.sendMessage(phone, 
        `👍 No problem! You can add your email anytime by typing *EMAIL*.\n\nType MENU to continue.`
      );
      return;
    }
    
    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(input)) {
      await messagingService.sendMessage(phone,
        `⚠️ That doesn't look like a valid email.\n\nPlease enter your email address or type SKIP:`
      );
      return;
    }
    
    // Save email
    try {
      await pool.query(
        'UPDATE users SET email = $1 WHERE id = $2',
        [input.toLowerCase(), user.id]
      );
      
      await userService.clearUserState(phone);
      await messagingService.sendMessage(phone,
        `✅ Email saved! You'll receive updates about tournaments and events.\n\nType MENU to continue.`
      );
    } catch (error) {
      logger.error('Error saving email:', error);
      await userService.clearUserState(phone);
      await messagingService.sendMessage(phone, `❌ Error saving email. You can try again later by typing *EMAIL*.\n\nType MENU to continue.`);
    }
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
    
    let message = `🎮 SELECT GAME MODE 🎮\n\nChoose your challenge:\n\n`;
    
    const practiceEnabled = restrictionsService.isModeEnabled('practice');
    const classicEnabled = restrictionsService.isModeEnabled('classic');
    const tournamentEnabled = restrictionsService.isModeEnabled('tournament');
    
    message += `1️⃣ *Free Play - Practice Mode*\n`;
    message += practiceEnabled 
      ? `   Familiarize with gameplay\n   ⚠️ No prizes won\n   Perfect for learning!\n\n`
      : `   ⚠️ _Currently unavailable_\n\n`;
    
    message += `2️⃣ *Classic Mode*\n`;
    message += classicEnabled
      ? `   General knowledge questions\n   Win up to ₦50,000! 💰\n\n`
      : `   ⚠️ _Currently unavailable_\n\n`;
    
    message += `3️⃣ *Sponsored Tournaments* 🏆\n`;
    message += tournamentEnabled
      ? `   Compete for MEGA prizes!\n   Special sponsored events\n\n`
      : `   ⚠️ _Currently unavailable_\n\n`;
    
    message += `_Proudly brought to you by SummerIsland Systems._\n\n`;
    message += `Reply with your choice (1, 2, or 3):`;
    
    await messagingService.sendMessage(user.phone_number, message);
  }

  async handleGameModeSelection(user, message) {
    const input = message.trim();
    
    switch(input) {
      case '1':
        // Free Play - Practice Mode
        if (!restrictionsService.isModeEnabled('practice')) {
          await messagingService.sendMessage(user.phone_number, restrictionsService.getModeDisabledMessage('practice'));
          return;
        }
        
        // Check 15 games per hour rate limit
        const practiceRateLimit = await antiFraudService.checkGameRateLimit(user.id);
        if (!practiceRateLimit.allowed) {
          await userService.clearUserState(user.phone_number);
          await messagingService.sendMessage(user.phone_number, practiceRateLimit.message);
          return;
        }
        
        await userService.clearUserState(user.phone_number);
        await messagingService.sendMessage(
          user.phone_number,
          `✅ Practice Mode selected!\n\n⚠️ Remember: No real prizes in practice mode.\n\nStarting game...`
        );
        await gameService.startNewGame(user, 'practice');
        break;
        
      case '2':
        // Classic Mode
        if (!restrictionsService.isModeEnabled('classic')) {
          await messagingService.sendMessage(user.phone_number, restrictionsService.getModeDisabledMessage('classic'));
          return;
        }
        
        // Check all restrictions
        const classicRestriction = await restrictionsService.canUserPlay(user.id, 'classic');
        if (!classicRestriction.canPlay) {
          await userService.clearUserState(user.phone_number);
          await messagingService.sendMessage(user.phone_number, classicRestriction.message);
          return;
        }
        
        // Check 15 games per hour rate limit
        const rateLimit = await antiFraudService.checkGameRateLimit(user.id);
        if (!rateLimit.allowed) {
          await userService.clearUserState(user.phone_number);
          await messagingService.sendMessage(user.phone_number, rateLimit.message);
          return;
        }
        
        await userService.clearUserState(user.phone_number);
        await messagingService.sendMessage(
          user.phone_number,
          `✅ Classic Mode selected!\n\nStarting game...`
        );
        await gameService.startNewGame(user, 'classic');
        break;
        
      case '3':
        // Sponsored Tournaments
        if (!restrictionsService.isModeEnabled('tournament')) {
          await messagingService.sendMessage(user.phone_number, restrictionsService.getModeDisabledMessage('tournament'));
          return;
        }
        
        // Check restrictions
        const tournamentRestriction = await restrictionsService.canUserPlay(user.id, 'tournament');
        if (!tournamentRestriction.canPlay) {
          await userService.clearUserState(user.phone_number);
          await messagingService.sendMessage(user.phone_number, tournamentRestriction.message);
          return;
        }
        
        // Check 15 games per hour rate limit
        const tournamentRateLimit = await antiFraudService.checkGameRateLimit(user.id);
        if (!tournamentRateLimit.allowed) {
          await userService.clearUserState(user.phone_number);
          await messagingService.sendMessage(user.phone_number, tournamentRateLimit.message);
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

    // LOVE QUEST command
    if (input === 'LOVE QUEST' || input === 'LOVEQUEST' || input === 'LQ' || input === 'VALENTINE') {
      await this.showLoveQuestCreatorMenu(user);
      return;
    }

    // PAID command - check for Love Quest payment confirmation
    if (input === 'PAID' || input === 'I PAID' || input === 'PAYMENT MADE') {
      const pendingBooking = await loveQuestService.getActiveBookingByCreator(user.phone_number);
      if (pendingBooking && pendingBooking.status === 'pending') {
        await messagingService.sendMessage(user.phone_number,
          `✅ *Payment Notification Received!*\n\n` +
          `Thank you for notifying us about your payment for Love Quest *${pendingBooking.booking_code}*.\n\n` +
          `Your payment is being verified. Once confirmed, our Love Curator will contact you to begin creating your personalized quiz!\n\n` +
          `This usually takes 1-2 hours during business hours.\n\n` +
          `Questions? Reply HELP 💕`
        );
        
        // Log the payment claim
        await loveQuestService.logAuditEvent(pendingBooking.id, null, 'payment_claimed', {
          claimedAt: new Date().toISOString()
        }, 'creator', user.phone_number);
        
        return;
      }
      // No pending Love Quest - might be regular payment
    }

    // PROFILE command
    if (input === 'PROFILE' || input.includes('PROFILE')) {
      await this.handleProfileCommand(user);
      return;
    }

    // EMAIL command - allow users to add/update email anytime
    if (input === 'EMAIL' || input === 'NEWSLETTER') {
      if (user.email) {
        await messagingService.sendMessage(user.phone_number,
          `📧 Your email is: ${user.email}\n\nTo update it, type your new email address.\nOr type SKIP to keep the current one.`
        );
      } else {
        await messagingService.sendMessage(user.phone_number,
          `📧 *Stay in the Loop!*\n\nShare your email to get notified about tournaments, events, and prizes!\n\nType your email or SKIP:`
        );
      }
      await userService.setUserState(user.phone_number, 'EMAIL_COLLECT');
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

    // RECEIVED confirmation (including common misspellings)
    const receivedWords = ['RECEIVED', 'RECIEVED', 'RECEVED', 'RECIVED'];
    if (receivedWords.includes(input) || input.includes('CONFIRM')) {
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

    // HELP command
    if (input === 'HELP' || input === 'COMMANDS') {
      await this.sendHelpMenu(user.phone_number);
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
      message += `*Age:* ${user.age}\n`;
      message += `*Email:* ${user.email || '_Not set_ (type EMAIL to add)'}\n\n`;

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
        `We're glad you received it without hitch. 🎉\n\n` +
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
    // CHECK FOR PENDING PHOTO VERIFICATION
    // User must send an image, not text
    // ==========================================
    const hasPendingPhoto = await gameService.hasPendingPhotoVerification(session.session_key);
    if (hasPendingPhoto) {
      await messagingService.sendMessage(
        user.phone_number,
        '📸 *PHOTO REQUIRED*\n\nPlease send a photo to continue.\n\n⏱️ Clock is ticking...'
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
  // IMAGE MESSAGE HANDLER (Photo Verification)
  // ============================================
  async handleImageMessage(phone, message) {
    try {
      const user = await userService.getUserByPhone(phone);
      if (!user) return;

      const activeSession = await gameService.getActiveSession(user.id);
      if (!activeSession) return;

      // Check if waiting for photo verification
      const hasPendingPhoto = await gameService.hasPendingPhotoVerification(activeSession.session_key);
      if (hasPendingPhoto) {
        await gameService.processPhotoVerification(activeSession, user);
      } else {
        // Not expecting a photo - ignore or send hint
        await messagingService.sendMessage(
          phone,
          '📷 Image received, but no verification is pending.\n\nPlease reply with A, B, C, or D to answer the question.'
        );
      }
    } catch (error) {
      logger.error('Error handling image message:', error);
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
    // Clear post-game state when showing main menu
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
    message += 'Type LOVE QUEST to create a Valentine surprise! 💘\n';
    message += 'Type HELP for all available commands.\n';
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
    
    message += `⏱️ *PROGRESSIVE TIMERS:*\n`;
    message += `• Standard: 12 seconds per question\n`;
    message += `• Suspicious play patterns may trigger reduced timers\n`;
    message += `• Play fairly to keep your full time!\n\n`;
    
    message += `💎 *LIFELINES:*\n`;
    message += `• 50:50 - Remove 2 wrong answers (+5s bonus)\n`;
    message += `• Skip - Move to a different question\n\n`;
    
    message += `🏆 *PRIZE LADDER:*\n`;
    message += `Q15: ₦50,000 🥇\n`;
    message += `Q12: ₦25,000\n`;
    message += `Q10: ₦10,000 (SAFE) 🔒\n`;
    message += `Q8: ₦5,000\n`;
    message += `Q5: ₦1,000 (SAFE) 🔒\n\n`;
    
    message += `🔒 Safe amounts are guaranteed even if you get the next question wrong or time out!\n\n`;

    message += `━━━━━━━━━━━━━━━━\n\n`;
    
    message += `⚠️ *FAIR PLAY WARNING:*\n`;
    message += `Cheating is strictly prohibited. Any form of external assistance to answer questions will result in:\n`;
    message += `• Account suspension\n`;
    message += `• Forfeiture of all winnings & tokens\n`;
    message += `• Permanent ban from the platform or tournaments ineligibility\n\n`;
    message += `_Our anti-cheat system monitors all gameplay. Play fair, win fair!_ 🛡️\n\n`;
    
    message += `💡 Type HELP for a list of all commands.\n\n`;
    message += `Ready to play? Reply "PLAY NOW"`;
    
    await messagingService.sendMessage(phone, message);
  }

  // ============================================
  // HELP MENU
  // ============================================

  async sendHelpMenu(phone) {
    let message = `❓ *HELP & COMMANDS* ❓\n\n`;
    
    message += `Here are all the commands you can use:\n\n`;
    
    message += `🎮 *GAMEPLAY*\n`;
    message += `• *PLAY* — Start a new game\n`;
    message += `• *PRACTICE* — Play practice mode (free)\n`;
    message += `• *TOURNAMENT* — View available tournaments\n`;
    message += `• *A / B / C / D* — Answer a question\n`;
    message += `• *50:50* — Use 50:50 lifeline\n`;
    message += `• *SKIP* — Use skip lifeline\n\n`;
    
    message += `💰 *PRIZES & PAYMENTS*\n`;
    message += `• *CLAIM* — Claim your prize winnings\n`;
    message += `• *BUY* — Purchase game tokens\n`;
    message += `• *RECEIVED* — Confirm you received payment\n\n`;
    
    message += `📊 *INFO & STATS*\n`;
    message += `• *STATS* — View your game statistics\n`;
    message += `• *STREAK* — Check your daily streak\n`;
    message += `• *ACHIEVEMENTS* — View your badges\n`;
    message += `• *PROFILE* — View your profile\n`;
    message += `• *LEADERBOARD* — View top players\n\n`;
    
    message += `🔧 *OTHER*\n`;
    message += `• *SHARE* — Generate your victory card\n`;
    message += `• *REFERRAL* — Get your referral code\n`;
    message += `• *RESET* — Reset your game session\n`;
    message += `• *MENU* — Return to main menu\n`;
    message += `• *HELP* — Show this menu\n\n`;
    
    message += `━━━━━━━━━━━━━━━━\n\n`;
    message += `💡 _Most commands work from anywhere in the app. Type any command to get started!_`;
    
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
      // Check if this is a tournament share
      const isTournament = winData.isTournament || false;
      
      await messagingService.sendMessage(
        user.phone_number,
        isTournament 
          ? '🎨 Creating your tournament card... Please wait a moment! ✨'
          : '🎨 Creating your victory card... Please wait a moment! ✨'
      );

      let imagePath;
      let caption;

      if (isTournament) {
        // Generate tournament performance card
        imagePath = await imageService.generateTournamentCard({
          username: user.username,
          city: user.city,
          questionsAnswered: winData.questionsAnswered,
          timeTaken: winData.timeTaken || '0',
          rank: winData.rank,
          tournamentName: winData.tournamentName || 'Tournament'
        });
        
        caption = `🏆 @${user.username} reached Q${winData.questionsAnswered} in ${winData.timeTaken}s in ${winData.tournamentName || 'the tournament'}! ` +
                  `Think you can beat that? Join: https://whatsuptrivia.com.ng`;
      } else {
        // Generate classic victory card
        imagePath = await imageService.generateWinImage({
          name: user.full_name,
          username: user.username,
          city: user.city,
          amount: winData.amount,
          questionsAnswered: winData.questionsAnswered,
          totalQuestions: winData.totalQuestions
        });
        
        caption = `🏆 @${user.username} won ₦${winData.amount.toLocaleString()} playing What's Up Trivia Game! Join now: https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}`;
      }

      await messagingService.sendImage(user.phone_number, imagePath, caption);

      // Mark ALL victory cards as shared in database (user may have multiple pending)
      if (!isTournament) {
        try {
          await victoryCardsService.markAllCardsAsShared(user.id);
          logger.info(`All pending victory cards marked as shared for user ${user.id}`);
        } catch (vcError) {
          logger.error('Error marking victory cards as shared:', vcError);
        }
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

      // Send different follow-up message based on game type
      if (isTournament) {
        await messagingService.sendMessage(
          user.phone_number,
          `✅ Tournament card sent! 🎉

Save it and share on your Status to challenge others!

🏆 Keep playing to improve your rank!

1️⃣ Play Again
2️⃣ View Tournament Leaderboard`
        );
      } else {
        await messagingService.sendMessage(
          user.phone_number,
          `✅ Victory card sent! 🎉

Save it and share on your WhatsApp Status to inspire others!

You can now claim your prize! 💰

1️⃣ Play Again
2️⃣ View Leaderboard
3️⃣ Claim Prize`
        );
        // Re-set post_game so option 3 maps to Claim Prize
        await redis.setex(`post_game:${user.id}`, 300, JSON.stringify({
          timestamp: Date.now(), gameType: 'classic',
          isTournament: false, finalScore: winData.amount || 0
        }));
      }

      fs.unlinkSync(imagePath);
      imageService.cleanupTempFiles();

    } catch (error) {
      logger.error('Error handling win share:', error);
      await messagingService.sendMessage(
        user.phone_number,
        '❌ Sorry, something went wrong creating your card. Please try again later.'
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

  // ============================================
  // LOVE QUEST HANDLERS
  // ============================================

  async handleAudioMessage(phone, message) {
    try {
      const userState = await userService.getUserState(phone);
      
      // If user is explicitly in voice note recording state
      if (userState && userState.state === 'LOVE_QUEST_VOICE_NOTE') {
        const { bookingCode, purpose } = userState.data || {};
        
        if (bookingCode && message.audio?.id) {
          try {
            await loveQuestService.saveVoiceNote(bookingCode, message.audio.id, purpose || 'grand_reveal');
            
            await messagingService.sendMessage(phone,
              `✅ Voice note saved for "${purpose || 'grand reveal'}"! 🎤💕\n\n` +
              `Would you like to record more?\n\n` +
              `1️⃣ Intro voice note\n` +
              `2️⃣ Milestone celebration (Q5 or Q10)\n` +
              `3️⃣ Grand reveal voice note\n` +
              `4️⃣ Done recording\n\n` +
              `Reply with the number or type DONE to finish.`
            );
            
            await userService.setUserState(phone, 'LOVE_QUEST_VOICE_MENU', { bookingCode });
          } catch (error) {
            logger.error('Error saving voice note:', error);
            await messagingService.sendMessage(phone, `❌ Sorry, there was an error saving your voice note. Please try again.`);
          }
          return;
        }
      }
      
      // Check if this person has an active booking as creator (CURATING status)
      const activeBooking = await loveQuestService.getActiveBookingByCreator(phone);
      
      if (activeBooking && message.audio?.id) {
        // Auto-detect: Creator is sending voice note for their active booking
        try {
          // Default to grand_reveal if no specific purpose set
          const purpose = userState?.data?.purpose || 'grand_reveal';
          await loveQuestService.saveVoiceNote(activeBooking.booking_code, message.audio.id, purpose);
          
          await messagingService.sendMessage(phone,
            `✅ Voice note saved for your Love Quest! 🎤💕\n\n` +
            `Booking: ${activeBooking.booking_code}\n\n` +
            `Want to record more voice notes?\n\n` +
            `1️⃣ Intro voice note (plays at start)\n` +
            `2️⃣ Milestone voice note (plays at Q5/Q10)\n` +
            `3️⃣ Grand reveal voice note (plays at end)\n` +
            `4️⃣ Done - I'm finished recording\n\n` +
            `Reply with a number, or send another voice note.`
          );
          
          await userService.setUserState(phone, 'LOVE_QUEST_VOICE_MENU', { 
            bookingCode: activeBooking.booking_code,
            purpose: 'grand_reveal'
          });
          
        } catch (error) {
          logger.error('Error auto-saving voice note:', error);
          await messagingService.sendMessage(phone, `❌ Error saving voice note. Please try again.`);
        }
        return;
      }
      
      // No active Love Quest - generic response
      await messagingService.sendMessage(phone,
        `🎤 Voice note received!\n\n` +
        `To add voice notes to a Love Quest, you need an active booking in "curating" status.\n\n` +
        `Type *LOVE QUEST* to create a new booking.`
      );
    } catch (error) {
      logger.error('Error handling audio message:', error);
    }
  }

  async handleVideoMessage(phone, message) {
    try {
      const userState = await userService.getUserState(phone);
      
      // Check if this person has an active booking as creator
      const activeBooking = await loveQuestService.getActiveBookingByCreator(phone);
      
      if (activeBooking && message.video?.id) {
        try {
          // Determine purpose from state or default to intro
          const purpose = userState?.data?.videoPurpose || 'intro';
          await loveQuestService.saveVideo(activeBooking.booking_code, message.video.id, purpose);
          
          await messagingService.sendMessage(phone,
            `✅ Video saved for your Love Quest! 🎬💕\n\n` +
            `Booking: ${activeBooking.booking_code}\n\n` +
            `Want to add more media?\n\n` +
            `1️⃣ Record another intro video\n` +
            `2️⃣ Record a voice note instead\n` +
            `3️⃣ Done - I'm finished\n\n` +
            `Reply with a number, or send another video/voice note.`
          );
          
          await userService.setUserState(phone, 'LOVE_QUEST_VIDEO_MENU', { 
            bookingCode: activeBooking.booking_code
          });
          
        } catch (error) {
          logger.error('Error saving video:', error);
          await messagingService.sendMessage(phone, `❌ Error saving video. Please try again.`);
        }
        return;
      }
      
      // If user is explicitly in video recording state
      if (userState && userState.state === 'LOVE_QUEST_VIDEO' && message.video?.id) {
        const { bookingCode, purpose } = userState.data || {};
        
        if (bookingCode) {
          try {
            await loveQuestService.saveVideo(bookingCode, message.video.id, purpose || 'intro');
            
            await messagingService.sendMessage(phone,
              `✅ Video saved for "${purpose || 'intro'}"! 🎬💕\n\n` +
              `Would you like to record more?\n\n` +
              `1️⃣ Record another video\n` +
              `2️⃣ Record a voice note\n` +
              `3️⃣ Done recording\n\n` +
              `Reply with the number or type DONE to finish.`
            );
            
            await userService.setUserState(phone, 'LOVE_QUEST_VIDEO_MENU', { bookingCode });
          } catch (error) {
            logger.error('Error saving video:', error);
            await messagingService.sendMessage(phone, `❌ Error saving video. Please try again.`);
          }
          return;
        }
      }
      
      // No active Love Quest - generic response
      await messagingService.sendMessage(phone,
        `🎬 Video received!\n\n` +
        `To add videos to a Love Quest, you need an active booking.\n\n` +
        `Type *LOVE QUEST* to create a new booking.`
      );
    } catch (error) {
      logger.error('Error handling video message:', error);
    }
  }

  async startLoveQuest(phone, booking) {
    try {
      const existingSession = await loveQuestService.getActiveSession(phone);
      if (existingSession) {
        await messagingService.sendMessage(phone, `💕 You already have an active Love Quest!\n\nLet's continue where you left off...`);
        const sessionWithBooking = await loveQuestService.getSessionWithBooking(phone);
        await loveQuestService.sendQuestion(existingSession, sessionWithBooking, messagingService);
        return;
      }
      
      const session = await loveQuestService.startSession(booking, phone);
      const creatorName = booking.creator_name || (booking.language === 'es' ? 'Tu persona especial' : 'Your special someone');
      const { getTranslations } = require('../config/love-quest-i18n');
      const t = getTranslations(booking.language);
      
      let welcomeMsg = `${t.welcome_title}\n\n`;
      welcomeMsg += `${t.welcome_body(creatorName, booking.question_count)}\n\n`;
      welcomeMsg += `${t.welcome_rules}\n\n`;
      
      if (booking.allow_retries) {
        welcomeMsg += `${t.welcome_retries(booking.max_retries_per_question || 2)}\n\n`;
      }
      
      welcomeMsg += t.welcome_ready;
      
      await messagingService.sendMessage(phone, welcomeMsg);
      
      const fs = require('fs');
      
      // Check for intro VIDEO in database table first
      const introVideo = await loveQuestService.getMediaByPurpose(booking.id, 'intro', 'video');
      if (introVideo && introVideo.file_path && fs.existsSync(introVideo.file_path)) {
        logger.info(`🎬 Sending intro video for booking ${booking.id}`);
        await new Promise(resolve => setTimeout(resolve, 1500));
        await messagingService.sendMessage(phone, t.video_message(creatorName));
        await loveQuestService.sendVideo(phone, introVideo.file_path);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      // Check for intro AUDIO in database table
      const introAudio = await loveQuestService.getMediaByPurpose(booking.id, 'intro', 'audio');
      if (introAudio && introAudio.file_path && fs.existsSync(introAudio.file_path)) {
        logger.info(`🎤 Sending intro voice note for booking ${booking.id}`);
        await new Promise(resolve => setTimeout(resolve, 1500));
        await messagingService.sendMessage(phone, t.voice_message(creatorName));
        await loveQuestService.sendVoiceNote(phone, introAudio.file_path);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      // Fallback: check legacy media JSON field for backward compatibility
      if (!introAudio && !introVideo) {
        const media = typeof booking.media === 'string' ? JSON.parse(booking.media) : (booking.media || {});
        if (media.intro_audio && fs.existsSync(media.intro_audio)) {
          logger.info(`🎤 Sending intro voice note (legacy JSON) for booking ${booking.id}`);
          await loveQuestService.sendVoiceNote(phone, media.intro_audio);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      setTimeout(async () => {
        await loveQuestService.sendQuestion(session, booking, messagingService);
      }, 3000);
      
    } catch (error) {
      logger.error('Error starting Love Quest:', error);
      await messagingService.sendMessage(phone, `❌ Sorry, there was an error starting your Love Quest. Please try again by replying START. / Lo siento, hubo un error. Intenta de nuevo respondiendo START.`);
    }
  }

  async handleLoveQuestInput(phone, message, session) {
    try {
      const input = message.trim().toUpperCase();
      const sessionWithBooking = await loveQuestService.getSessionWithBooking(phone);
      
      if (!sessionWithBooking) {
        await messagingService.sendMessage(phone, `❌ Session error. Please contact support.`);
        return;
      }
      
      // Check if waiting for continue after milestone
      if (sessionWithBooking.waiting_for_continue) {
        if (input === 'NEXT' || input === 'CONTINUE' || input === 'YES') {
          await loveQuestService.handleContinue(session, sessionWithBooking, messagingService);
          return;
        } else {
          await messagingService.sendMessage(phone, `💕 Reply *NEXT* when you're ready for the next question!`);
          return;
        }
      }
      
      if (sessionWithBooking.waiting_for_treasure_confirmation) {
        if (input === 'FOUND') {
          await loveQuestService.confirmTreasureFound(session, sessionWithBooking, messagingService);
          return;
        } else {
          await messagingService.sendMessage(phone, `🗺️ Still on the treasure hunt!\n\nReply FOUND when you reach the location 💕`);
          return;
        }
      }
      
      if (input === 'HINT') {
        await loveQuestService.sendHint(session, sessionWithBooking, messagingService);
        return;
      }
      
      if (['A', 'B', 'C', 'D'].includes(input)) {
        await loveQuestService.processAnswer(session, sessionWithBooking, input, messagingService);
        return;
      }
      
      await messagingService.sendMessage(phone, `💕 Please reply with A, B, C, or D\n\nOr type HINT if you need help!`);
    } catch (error) {
      logger.error('Error handling Love Quest input:', error);
      await messagingService.sendMessage(phone, `❌ Something went wrong. Please try your answer again.`);
    }
  }

  async showLoveQuestCreatorMenu(user) {
    let msg = `💘 *LOVE QUEST* 💘\n`;
    msg += `Create a personalized trivia experience for your partner!\n\n`;
    msg += `📦 *Packages:*\n\n`;
    
    const packages = await loveQuestService.getPackages();
    packages.forEach((pkg, i) => {
      const isInternational = pkg.package_code === 'international';
      const priceDisplay = isInternational 
        ? `$${parseFloat(pkg.base_price)}` 
        : `₦${parseFloat(pkg.base_price).toLocaleString()}`;
      
      msg += `${i + 1}️⃣ *${pkg.package_name}*\n`;
      msg += `   ${priceDisplay} • ${pkg.question_count} questions\n`;
      
      let features = [];
      if (pkg.voice_notes) features.push('🎤 Voice notes');
      if (pkg.video_support) features.push('🎬 Video');
      if (pkg.treasure_hunt) features.push('🗺️ Treasure hunt');
      if (pkg.dedicated_curator) features.push('👤 Curator');
      if (pkg.proposal_coordination) features.push('💍 Proposal');
      
      if (features.length > 0) {
        msg += `   ${features.join(' • ')}\n`;
      }
      msg += `\n`;
    });
    
    msg += `Reply with the package number (1-${packages.length}) to get started!\n`;
    msg += `Or visit: whatsuptrivia.com.ng/love-quest`;
    
    await messagingService.sendMessage(user.phone_number, msg);
    await userService.setUserState(user.phone_number, 'LOVE_QUEST_PACKAGE_SELECT');
  }

  async handleLoveQuestPackageSelection(phone, message, userState) {
    const input = message.trim();
    const packages = await loveQuestService.getPackages();
    const packageIndex = parseInt(input) - 1;
    
    if (packageIndex < 0 || packageIndex >= packages.length) {
      await messagingService.sendMessage(phone, `⚠️ Please select a valid package (1-${packages.length})`);
      return;
    }
    
    const selectedPackage = packages[packageIndex];
    const isInternational = selectedPackage.package_code === 'international' || selectedPackage.package_code === 'international_es';
    const currency = isInternational ? 'USD' : 'NGN';
    const priceDisplay = isInternational 
      ? `$${parseFloat(selectedPackage.base_price)}` 
      : `₦${parseFloat(selectedPackage.base_price).toLocaleString()}`;
    
    await userService.setUserState(phone, 'LOVE_QUEST_PLAYER_PHONE', {
      package: selectedPackage.package_code,
      price: parseFloat(selectedPackage.base_price),
      currency
    });
    
    let msg = `✅ ${selectedPackage.package_name} selected!\n`;
    msg += `💰 Price: ${priceDisplay}\n\n`;
    
    if (isInternational) {
      msg += `Now, please enter your partner's phone number with country code:\n`;
      msg += `(Example: +521234567890)`;
    } else {
      msg += `Now, please enter your partner's phone number:\n`;
      msg += `(Format: 08012345678 or with country code)`;
    }
    
    await messagingService.sendMessage(phone, msg);
  }

  async handleLoveQuestPlayerPhone(phone, message, userState) {
    let playerPhone = message.trim().replace(/\D/g, '');
    const isInternational = userState.data?.package === 'international' || userState.data?.package === 'international_es';
    
    if (isInternational) {
      // International: accept any phone with country code, minimum 10 digits
      if (playerPhone.length < 10) {
        await messagingService.sendMessage(phone, `⚠️ Please enter a valid phone number with country code\n(Example: +521234567890)`);
        return;
      }
    } else {
      // Nigeria: normalize to 234 format
      if (playerPhone.startsWith('0')) {
        playerPhone = '234' + playerPhone.substring(1);
      } else if (!playerPhone.startsWith('234')) {
        playerPhone = '234' + playerPhone;
      }
      
      if (playerPhone.length < 13) {
        await messagingService.sendMessage(phone, `⚠️ Please enter a valid phone number\n(Format: 08012345678)`);
        return;
      }
    }
    
    // Save player phone and ask for their name
    await userService.setUserState(phone, 'LOVE_QUEST_PLAYER_NAME', {
      ...userState.data,
      playerPhone
    });
    
    await messagingService.sendMessage(phone,
      `💕 Great! Now, what's your partner's name?\n\n` +
      `(This will be used to personalize the messages)`
    );
  }


  // ============================================
  // FIXED: handleLoveQuestPlayerName
  // - Generates Paystack link FIRST
  // - Includes actual URL in message
  // - Updated confirmation text
  // ============================================
  async handleLoveQuestPlayerName(phone, message, userState) {
    const playerName = message.trim();
    
    if (playerName.length < 2) {
      await messagingService.sendMessage(phone, `⚠️ Please enter a valid name`);
      return;
    }
    
    try {
      const user = await userService.getUserByPhone(phone);
      const { package: packageCode, price, playerPhone, currency } = userState.data;
      
      const booking = await loveQuestService.createBooking(
        phone, playerPhone, packageCode, user?.full_name, playerName
      );
      
      await userService.clearUserState(phone);
      
      const isInternational = currency === 'USD';
      const priceDisplay = isInternational ? `$${price}` : `₦${price.toLocaleString()}`;
      
      // Generate Paystack link FIRST (for NGN bookings)
      let paystackUrl = null;
      if (!isInternational) {
        try {
          paystackUrl = await loveQuestService.generatePaystackLink(booking.id, phone, price);
          logger.info(`💳 Paystack URL for ${booking.booking_code}: ${paystackUrl}`);
        } catch (e) {
          logger.error('Error generating Paystack link:', e);
        }
      }
      
      let msg = `🎉 *Love Quest Booking Created!*\n\n`;
      msg += `📋 Booking Code: *${booking.booking_code}*\n`;
      msg += `📦 Package: ${packageCode}\n`;
      msg += `💰 Amount: ${priceDisplay}\n\n`;
      msg += `👤 For: ${playerName}\n`;
      msg += `📱 Phone: ${playerPhone}\n\n`;
      
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `*💳 PAYMENT OPTIONS:*\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      if (!isInternational && paystackUrl) {
        msg += `*Option 1: Pay with Paystack (Card/Transfer)*\n`;
        msg += `Click here: ${paystackUrl}\n\n`;
      } else if (!isInternational) {
        msg += `*Option 1: Pay with Paystack (Card/Transfer)*\n`;
        msg += `Link being generated... Check back in a moment or use bank transfer.\n\n`;
      }
      
      msg += `*Option ${isInternational ? '1' : '2'}: Direct Bank Transfer*\n`;
      msg += `🏦 Bank: Moniepoint\n`;
      msg += `💳 Account: 6529712162\n`;
      msg += `👤 Name: SummerIsland Systems\n`;
      msg += `📝 Reference: ${booking.booking_code}\n\n`;
      
      msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      msg += `Once payment is confirmed and curation begins, you'll be contacted right here to record your personalized voice notes and video message for your Love Quest! 💕\n\n`;
      msg += `Questions? Reply HELP 💕`;
      
      await messagingService.sendMessage(phone, msg);
      
    } catch (error) {
      logger.error('Error creating Love Quest booking:', error);
      await messagingService.sendMessage(phone, `❌ Error creating booking. Please try again later.`);
      await userService.clearUserState(phone);
    }
  }

  async handleLoveQuestVoiceMenu(phone, message, userState) {
    const input = message.trim().toUpperCase();
    const { bookingCode } = userState.data || {};
    
    switch (input) {
      case '1':
        // Intro voice note
        await messagingService.sendMessage(phone,
          `🎤 *Intro Voice Note*\n\n` +
          `This plays when your partner starts the quest.\n\n` +
          `Record a sweet greeting like:\n` +
          `"Hey babe! I made this special quiz just for you..."\n\n` +
          `Send your voice note now! 💕`
        );
        await userService.setUserState(phone, 'LOVE_QUEST_VOICE_NOTE', { 
          bookingCode, 
          purpose: 'intro' 
        });
        break;
        
      case '2':
        // Milestone voice note
        await messagingService.sendMessage(phone,
          `🎤 *Milestone Voice Note*\n\n` +
          `This plays when your partner reaches the halfway point.\n\n` +
          `Record something encouraging like:\n` +
          `"You're doing great! Keep going..."\n\n` +
          `Send your voice note now! 💕`
        );
        await userService.setUserState(phone, 'LOVE_QUEST_VOICE_NOTE', { 
          bookingCode, 
          purpose: 'milestone' 
        });
        break;
        
      case '3':
        // Grand reveal voice note
        await messagingService.sendMessage(phone,
          `🎤 *Grand Reveal Voice Note*\n\n` +
          `This is the big moment! This plays at the end.\n\n` +
          `Pour your heart out:\n` +
          `"I love you because..." or "Will you..."\n\n` +
          `Send your voice note now! 💕`
        );
        await userService.setUserState(phone, 'LOVE_QUEST_VOICE_NOTE', { 
          bookingCode, 
          purpose: 'grand_reveal' 
        });
        break;
        
      case '4':
      case 'DONE':
        await messagingService.sendMessage(phone,
          `✅ *Voice notes complete!*\n\n` +
          `Booking Code: ${bookingCode}\n\n` +
          `Your Love Quest is being prepared.\n` +
          `We'll notify you when it's ready to send! 💕\n\n` +
          `Questions? Reply HELP`
        );
        await userService.clearUserState(phone);
        break;
        
      default:
        await messagingService.sendMessage(phone,
          `Please reply with a number (1-4) or DONE:\n\n` +
          `1️⃣ Intro voice note\n` +
          `2️⃣ Milestone voice note\n` +
          `3️⃣ Grand reveal voice note\n` +
          `4️⃣ Done recording`
        );
    }
  }

  async handleLoveQuestVideoMenu(phone, message, userState) {
    const input = message.trim().toUpperCase();
    const { bookingCode } = userState.data || {};
    
    switch (input) {
      case '1':
        // Record another intro video
        await messagingService.sendMessage(phone,
          `🎬 *Record Another Intro Video*\n\n` +
          `Send a video message for your partner.\n\n` +
          `This will replace your previous intro video.\n\n` +
          `Send your video now! 💕`
        );
        await userService.setUserState(phone, 'LOVE_QUEST_VIDEO', { 
          bookingCode, 
          purpose: 'intro' 
        });
        break;
        
      case '2':
        // Switch to voice note recording
        await messagingService.sendMessage(phone,
          `🎤 *Voice Note Options*\n\n` +
          `1️⃣ Intro voice note (plays at start)\n` +
          `2️⃣ Milestone voice note (plays at Q5/Q10)\n` +
          `3️⃣ Grand reveal voice note (plays at end)\n` +
          `4️⃣ Done - I'm finished recording\n\n` +
          `Reply with a number, or send a voice note.`
        );
        await userService.setUserState(phone, 'LOVE_QUEST_VOICE_MENU', { bookingCode });
        break;
        
      case '3':
      case 'DONE':
        await messagingService.sendMessage(phone,
          `✅ *Media upload complete!*\n\n` +
          `Booking Code: ${bookingCode}\n\n` +
          `Your Love Quest media has been saved.\n` +
          `We'll notify you when it's ready to send! 💕\n\n` +
          `Questions? Reply HELP`
        );
        await userService.clearUserState(phone);
        break;
        
      default:
        await messagingService.sendMessage(phone,
          `Please reply with a number (1-3):\n\n` +
          `1️⃣ Record another intro video\n` +
          `2️⃣ Record a voice note instead\n` +
          `3️⃣ Done - I'm finished`
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
// ✅ All imports and setup (including Love Quest service)
// ✅ verify() and handleMessage() methods
// ✅ Image message detection (photo verification)
// ✅ Audio message detection (Love Quest voice notes)
// ✅ Complete routeMessage() with ALL state handlers
// ✅ Permanent + temporary suspension checks
// ✅ All registration handlers (with referrals)
// ✅ Love Quest state handlers and gameplay
// ✅ Updated game mode selection (Practice, Classic, Tournaments)
// ✅ Complete tournament selection and payment handlers
// ✅ Profile, referral, and stats commands
// ✅ Enhanced menu input handler (with Love Quest command)
// ✅ Payment handlers (buy games, package selection)
// ✅ Complete payout handlers (full bank details flow)
// ✅ Game input handler with photo verification + turbo GO + CAPTCHA + lifelines
// ✅ handleImageMessage() for photo verification via WhatsApp images
// ✅ handleAudioMessage() for Love Quest voice notes
// ✅ Love Quest creator flow and player gameplay handlers
// ✅ Reset handler
// ✅ All menu senders (main menu, how to play)
// ✅ Complete leaderboard handlers
// ✅ Victory card handler with branding
// ✅ NO TRUNCATIONS - FULLY COMPLETE