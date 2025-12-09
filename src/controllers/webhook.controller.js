const pool = require('../config/database');
const redis = require('../config/redis');
const WhatsAppService = require('../services/whatsapp.service');
const GameService = require('../services/game.service');
const UserService = require('../services/user.service');
const PaymentService = require('../services/payment.service');
const PayoutService = require('../services/payout.service');
const { logger } = require('../utils/logger');

const whatsappService = new WhatsAppService();
const gameService = new GameService();
const userService = new UserService();
const paymentService = new PaymentService();
const payoutService = new PayoutService();

const LGA_LIST = [
  'Abak', 'Eastern Obolo', 'Eket', 'Esit Eket', 'Essien Udim',
  'Etim Ekpo', 'Etinan', 'Ibeno', 'Ibesikpo Asutan', 'Ibiono-Ibom',
  'Ika', 'Ikono', 'Ikot Abasi', 'Ikot Ekpene', 'Ini',
  'Itu', 'Mbo', 'Mkpat-Enin', 'Nsit-Atai', 'Nsit-Ibom',
  'Nsit-Ubium', 'Obot Akara', 'Okobo', 'Onna', 'Oron',
  'Oruk Anam', 'Udung-Uko', 'Ukanafun', 'Uruan', 'Urue-Offong/Oruko', 'Uyo',
  'Other'
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

      // Registration states
      if (userState && userState.state === 'REGISTRATION_NAME') {
        await this.handleRegistrationName(phone, message);
        return;
      }

      if (userState && userState.state === 'REGISTRATION_LGA') {
        await this.handleRegistrationLGA(phone, message, userState.data.name);
        return;
      }

      // Payment states
      if (userState && userState.state === 'SELECT_PACKAGE') {
        await this.handlePackageSelection(user, message, userState.data);
        return;
      }

      // Leaderboard states
      if (userState && userState.state === 'SELECT_LEADERBOARD') {
        await this.handleLeaderboardSelection(phone, message);
        return;
      }

      // Bank details confirmation state
      if (userState && userState.state === 'CONFIRM_BANK_DETAILS') {
        await this.handleBankDetailsConfirmation(phone, message, userState.data);
        return;
      }

      // Payout collection states
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
      `🎉 Welcome to WHAT'S UP TRIVIA GAME - AKWA IBOM EDITION! 🎉

The ultimate trivia game about our great state!

Test your knowledge and win amazing prizes! 🏆

Developed by SummerIsland Systems

This Akwa Ibom Edition proudly brought to you by the Department of Brand Management & Marketing, Office of the Governor.

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

    let lgaMessage = `Nice to meet you, ${name}! 👋\n\nWhich Local Government Area are you from? Select "Other" if not from Akwa Ibom.\n\nReply with the number:\n\n`;

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
      welcomeMsg += `3️⃣ Leaderboard\n`;
      welcomeMsg += `4️⃣ My Stats`;
    } else {
      welcomeMsg += `Ready to play? Reply:\n\n`;
      welcomeMsg += `1️⃣ Play Now\n`;
      welcomeMsg += `2️⃣ How to Play\n`;
      welcomeMsg += `3️⃣ Leaderboard\n`;
      welcomeMsg += `4️⃣ My Stats`;
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

  async handleStatsRequest(user) {
    try {
      const stats = await userService.getUserStats(user.id);

      if (!stats) {
        await whatsappService.sendMessage(
          user.phone_number,
          '❌ Unable to retrieve your stats. Please try again later.'
        );
        return;
      }

      let message = `📊 YOUR STATS - ${stats.fullName} 📊\n\n`;
      
      message += `📍 Location: ${stats.lga}\n`;
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

      if (paymentService.isEnabled()) {
        message += `💎 GAMES\n`;
        message += `━━━━━━━━━━━━━━━━\n`;
        message += `Games Remaining: ${stats.gamesRemaining}\n`;
        message += `Total Purchased: ${stats.totalGamesPurchased}\n\n`;
      }

      message += `📅 Member Since: ${new Date(stats.joinedDate).toLocaleDateString()}\n\n`;
      
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

      // Check if user has bank details on file
      const hasBankDetails = await payoutService.hasBankDetails(user.id);
      
      if (hasBankDetails) {
        const userBankDetails = await payoutService.getUserBankDetails(user.id);
        
        // Show confirmation message with existing details
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

      // No bank details on file - start collection
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
      // User confirmed - link existing details to transaction
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
      // User wants to update - start collection
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

    // Bank selection mapping
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
      // User selected "Others", ask them to type bank name
      await userService.setUserState(phone, 'COLLECT_CUSTOM_BANK', stateData.data);
      
      await whatsappService.sendMessage(
        phone,
        `Please type your bank name:\n\n` +
        `Example: Sterling Bank\n\n` +
        `Make sure to spell it correctly:`
      );
      return;
    }

    // Check if it's a number selection
    if (bankMap[input]) {
      bankName = bankMap[input];
    } else {
      // User typed a bank name directly
      bankName = input;
    }

    // Validate bank name length
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

  async handleMenuInput(user, message) {
    const input = message.trim().toUpperCase();

    // Handle CLAIM command
    if (input === 'CLAIM' || input.includes('CLAIM')) {
      await this.handleClaimPrize(user);
      return;
    }

    // Handle RECEIVED confirmation
    if (input === 'RECEIVED' || input.includes('CONFIRM')) {
      await this.handlePaymentConfirmation(user);
      return;
    }

    // Check for stats request
    if (input === '5' || input === '4' || input.includes('STATS') || input.includes('STATISTICS')) {
      await this.handleStatsRequest(user);
      return;
    }

    // Check for win sharing response
    const winSharePending = await redis.get(`win_share_pending:${user.id}`);
    if (winSharePending && (input === 'YES' || input === 'Y')) {
      await this.handleWinShare(user, JSON.parse(winSharePending));
      await redis.del(`win_share_pending:${user.id}`);
      return;
    }

    // Handle BUY command
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

    // Check if this is first interaction after coming back
    const lastActiveMinutesAgo = user.last_active ?
      (Date.now() - new Date(user.last_active).getTime()) / 60000 : 999;

    if (lastActiveMinutesAgo > 5 && !input.includes('PLAY') && input !== '1' && input !== '2' && input !== '3' && input !== '4' && input !== '5') {
      let welcomeMessage = `Hello again ${user.full_name} from ${user.lga}! 👋\n\nWelcome back to What's Up Trivia Game - Akwa Ibom Edition! 🎉\n\n`;

      if (paymentService.isEnabled()) {
        const gamesRemaining = await paymentService.getGamesRemaining(user.id);
        welcomeMessage += `💎 Games Remaining: ${gamesRemaining}\n\n`;
      }

      welcomeMessage += `The ultimate trivia game about our great state!\n\n`;
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

🎯 Answer 15 questions about Akwa Ibom & others

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
        `🏆 ${user.full_name} won ₦${winData.amount.toLocaleString()} playing What's Up Trivia Game - Akwa Ibom Edition! Join now: https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}`
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