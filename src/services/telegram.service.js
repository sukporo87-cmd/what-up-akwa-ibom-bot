// src/services/telegram.service.js

const TelegramBot = require('node-telegram-bot-api');
const logger = require('../utils/logger');

class TelegramService {
  constructor() {
    this.bot = null;
    this.initialized = false;
  }

  /**
   * Initialize Telegram Bot
   */
  initialize() {
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;

      if (!token) {
        logger.warn('Telegram bot token not found. Telegram integration disabled.');
        return;
      }

      // Initialize bot (we'll use webhooks in production, polling for development)
      const useWebhook = process.env.NODE_ENV === 'production';
      
      if (useWebhook) {
        // Webhook mode (production)
        this.bot = new TelegramBot(token, { webHook: false });
        logger.info('Telegram bot initialized in webhook mode');
      } else {
        // Polling mode (development)
        this.bot = new TelegramBot(token, { polling: true });
        logger.info('Telegram bot initialized in polling mode');
      }

      this.setupHandlers();
      this.initialized = true;
      logger.info('✅ Telegram bot service initialized successfully');

    } catch (error) {
      logger.error('Error initializing Telegram bot:', error);
    }
  }

  /**
   * Setup webhook (for production)
   */
  async setupWebhook(webhookUrl) {
    try {
      if (!this.bot) {
        throw new Error('Bot not initialized');
      }

      await this.bot.setWebHook(webhookUrl);
      logger.info(`Telegram webhook set to: ${webhookUrl}`);
      
      // Verify webhook
      const webhookInfo = await this.bot.getWebHookInfo();
      logger.info('Webhook info:', webhookInfo);

    } catch (error) {
      logger.error('Error setting up webhook:', error);
      throw error;
    }
  }

  /**
   * Process webhook update (called from webhook route)
   */
  processWebhookUpdate(update) {
    if (this.bot) {
      this.bot.processUpdate(update);
    }
  }

  /**
   * Setup message and command handlers
   */
  setupHandlers() {
    if (!this.bot) return;

    // Command: /start
    this.bot.onText(/\/start/, async (msg) => {
      await this.handleStartCommand(msg);
    });

    // Command: /play
    this.bot.onText(/\/play/, async (msg) => {
      await this.handlePlayCommand(msg);
    });

    // Command: /tournaments
    this.bot.onText(/\/tournaments/, async (msg) => {
      await this.handleTournamentsCommand(msg);
    });

    // Command: /profile
    this.bot.onText(/\/profile/, async (msg) => {
      await this.handleProfileCommand(msg);
    });

    // Command: /leaderboard
    this.bot.onText(/\/leaderboard/, async (msg) => {
      await this.handleLeaderboardCommand(msg);
    });

    // Command: /help
    this.bot.onText(/\/help/, async (msg) => {
      await this.handleHelpCommand(msg);
    });

    // Handle callback queries (button clicks)
    this.bot.on('callback_query', async (query) => {
      await this.handleCallbackQuery(query);
    });

    // Handle all other messages (game answers, etc.)
    this.bot.on('message', async (msg) => {
      // Skip if it's a command (already handled above)
      if (msg.text && msg.text.startsWith('/')) return;
      
      await this.handleMessage(msg);
    });

    logger.info('Telegram bot handlers registered');
  }

  /**
   * Handle /start command
   */
  async handleStartCommand(msg) {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || 'Player';

    const welcomeMessage = `
🎮 *Welcome to What's Up Trivia!*
Hello ${firstName}! 👋

Nigeria's premier trivia game where you can win real cash prizes!

*How to Play:*
📱 Answer 15 questions correctly
💰 Win up to ₦2,000,000
🎯 Use lifelines strategically
🏆 Compete in tournaments

*Quick Start:*
• Type /play - Start a new game
• Type /tournaments - Join tournaments
• Type /profile - View your stats
• Type /help - Game rules & FAQ

Ready to test your knowledge? 🧠
    `.trim();

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🎮 Play Now', callback_data: 'play' },
          { text: '🏆 Tournaments', callback_data: 'tournaments' }
        ],
        [
          { text: '👤 My Profile', callback_data: 'profile' },
          { text: '🏅 Leaderboard', callback_data: 'leaderboard' }
        ],
        [
          { text: '❓ Help', callback_data: 'help' }
        ]
      ]
    };

    await this.sendMessage(chatId, welcomeMessage, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }

  /**
   * Handle /play command
   */
  async handlePlayCommand(msg) {
    const chatId = msg.chat.id;
    
    // This will be integrated with your existing game service
    const message = `
🎮 *Start Your Trivia Game*

Choose your game mode:

*🆓 Free Play*
• Play once per day for free
• Win up to ₦2,000,000
• Use 2 lifelines

*🏆 Tournament Mode*
• Join active tournaments
• Compete with other players
• Special prizes & rewards

What would you like to play?
    `.trim();

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🎮 Free Play', callback_data: 'play_free' }
        ],
        [
          { text: '🏆 View Tournaments', callback_data: 'tournaments' }
        ],
        [
          { text: '« Back to Menu', callback_data: 'start' }
        ]
      ]
    };

    await this.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }

  /**
   * Handle /tournaments command
   */
  async handleTournamentsCommand(msg) {
    const chatId = msg.chat.id;
    
    // Placeholder - will be integrated with tournament service
    const message = `
🏆 *Active Tournaments*

No active tournaments at the moment.

Check back soon for exciting tournaments with bigger prizes!

_Want to know when tournaments start?_
Enable notifications to get alerts!
    `.trim();

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔔 Enable Notifications', callback_data: 'enable_notifications' }
        ],
        [
          { text: '« Back to Menu', callback_data: 'start' }
        ]
      ]
    };

    await this.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }

  /**
   * Handle /profile command
   */
  async handleProfileCommand(msg) {
    const chatId = msg.chat.id;
    
    // Placeholder - will be integrated with user service
    const message = `
👤 *Your Profile*

*Stats:*
📊 Games Played: 0
🏆 Games Won: 0
💰 Total Winnings: ₦0
🎯 Success Rate: 0%

*Wallet:*
💵 Available Balance: ₦0
⏳ Pending Payouts: ₦0

_Play your first game to start earning!_
    `.trim();

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🎮 Play Now', callback_data: 'play' }
        ],
        [
          { text: '« Back to Menu', callback_data: 'start' }
        ]
      ]
    };

    await this.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }

  /**
   * Handle /leaderboard command
   */
  async handleLeaderboardCommand(msg) {
    const chatId = msg.chat.id;
    
    const message = `
🏅 *Top Players - This Week*

_No players on the leaderboard yet_

Be the first to make it to the top!
Play games and win prizes to climb the ranks.
    `.trim();

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🎮 Play Now', callback_data: 'play' }
        ],
        [
          { text: '« Back to Menu', callback_data: 'start' }
        ]
      ]
    };

    await this.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }

  /**
   * Handle /help command
   */
  async handleHelpCommand(msg) {
    const chatId = msg.chat.id;
    
    const message = `
❓ *Help & Game Rules*

*How to Play:*
1️⃣ Start a game with /play
2️⃣ Answer 15 questions
3️⃣ Each correct answer wins money
4️⃣ Wrong answer ends the game
5️⃣ Withdraw your winnings anytime!

*Lifelines:*
🔀 *50:50* - Remove 2 wrong answers
⏭️ *Skip* - Skip to next question

*Prize Structure:*
Q1-Q5: ₦1K - ₦20K (Easy)
Q6-Q10: ₦30K - ₦150K (Medium)
Q11-Q15: ₦250K - ₦2M (Hard)

*Need More Help?*
Contact support: @YourSupportHandle
    `.trim();

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🎮 Play Now', callback_data: 'play' }
        ],
        [
          { text: '« Back to Menu', callback_data: 'start' }
        ]
      ]
    };

    await this.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }

  /**
   * Handle callback queries (button clicks)
   */
  async handleCallbackQuery(query) {
    const chatId = query.message.chat.id;
    const data = query.data;

    // Answer the callback query to remove loading state
    await this.bot.answerCallbackQuery(query.id);

    // Route to appropriate handler based on callback data
    switch (data) {
      case 'start':
        await this.handleStartCommand(query.message);
        break;
      case 'play':
        await this.handlePlayCommand(query.message);
        break;
      case 'tournaments':
        await this.handleTournamentsCommand(query.message);
        break;
      case 'profile':
        await this.handleProfileCommand(query.message);
        break;
      case 'leaderboard':
        await this.handleLeaderboardCommand(query.message);
        break;
      case 'help':
        await this.handleHelpCommand(query.message);
        break;
      case 'play_free':
        await this.startFreeGame(chatId);
        break;
      case 'enable_notifications':
        await this.enableNotifications(chatId);
        break;
      default:
        logger.warn(`Unhandled callback query: ${data}`);
    }
  }

  /**
   * Handle regular messages (game answers, etc.)
   */
  async handleMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text;

    // For now, just acknowledge
    logger.info(`Message from ${chatId}: ${text}`);
    
    // This will be integrated with game service to handle answers
  }

  /**
   * Start a free game
   */
  async startFreeGame(chatId) {
    const message = `
🎮 *Starting Free Game...*

Get ready! Your game will begin in a moment.

_Remember:_
• You have 30 seconds per question
• Use lifelines wisely
• Wrong answer ends the game

Good luck! 🍀
    `.trim();

    await this.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    
    // TODO: Integrate with game service to actually start game
  }

  /**
   * Enable notifications
   */
  async enableNotifications(chatId) {
    const message = `
🔔 *Notifications Enabled!*

You'll now receive alerts for:
✅ New tournaments
✅ Game results
✅ Payout updates
✅ Special events

You can disable notifications anytime in settings.
    `.trim();

    await this.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  }

  /**
   * Send a text message
   */
  async sendMessage(chatId, text, options = {}) {
    try {
      if (!this.bot) {
        throw new Error('Bot not initialized');
      }

      return await this.bot.sendMessage(chatId, text, options);
    } catch (error) {
      logger.error(`Error sending message to ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Send a photo
   */
  async sendPhoto(chatId, photo, options = {}) {
    try {
      if (!this.bot) {
        throw new Error('Bot not initialized');
      }

      return await this.bot.sendPhoto(chatId, photo, options);
    } catch (error) {
      logger.error(`Error sending photo to ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Edit a message
   */
  async editMessage(chatId, messageId, text, options = {}) {
    try {
      if (!this.bot) {
        throw new Error('Bot not initialized');
      }

      return await this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...options
      });
    } catch (error) {
      logger.error(`Error editing message:`, error);
      throw error;
    }
  }

  /**
   * Delete a message
   */
  async deleteMessage(chatId, messageId) {
    try {
      if (!this.bot) {
        throw new Error('Bot not initialized');
      }

      return await this.bot.deleteMessage(chatId, messageId);
    } catch (error) {
      logger.error(`Error deleting message:`, error);
      throw error;
    }
  }

  /**
   * Get user info
   */
  getUserIdentifier(msg) {
    return {
      telegramId: msg.from.id,
      username: msg.from.username,
      firstName: msg.from.first_name,
      lastName: msg.from.last_name,
      chatId: msg.chat.id
    };
  }
}

module.exports = new TelegramService();