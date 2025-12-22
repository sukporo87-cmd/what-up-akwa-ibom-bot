// ============================================
// FILE: src/services/telegram.service.js
// Complete Telegram Bot Service
// ============================================

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { logger } = require('../utils/logger');

class TelegramService {
  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const enabled = process.env.TELEGRAM_ENABLED === 'true';

    if (!enabled) {
      logger.info('Telegram bot is disabled via TELEGRAM_ENABLED flag');
      this.bot = null;
      return;
    }

    if (!token) {
      logger.warn('Telegram bot token missing. Set TELEGRAM_BOT_TOKEN in .env');
      this.bot = null;
      return;
    }

    try {
      // Initialize bot with polling
      this.bot = new TelegramBot(token, { 
        polling: true,
        onlyFirstMatch: true
      });

      this.setupHandlers();
      this.setupErrorHandlers();
      
      logger.info('✅ Telegram bot initialized and polling started');
    } catch (error) {
      logger.error('Failed to initialize Telegram bot:', error);
      this.bot = null;
    }
  }

  /**
   * Setup message handlers
   */
  setupHandlers() {
    if (!this.bot) return;

    // Handle /start command
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      await this.handleStart(chatId, msg.from);
    });

    // Handle /help command
    this.bot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id;
      await this.handleHelp(chatId);
    });

    // Handle all other text messages
    this.bot.on('message', async (msg) => {
      // Skip if it's a command (already handled above)
      if (msg.text && msg.text.startsWith('/')) return;

      try {
        const chatId = msg.chat.id;
        const text = msg.text || '';
        
        // Import webhook controller
        const webhookController = require('../controllers/webhook.controller');
        
        // Create unified identifier with tg_ prefix
        const identifier = `tg_${chatId}`;
        
        // Route through the same controller as WhatsApp
        await webhookController.routeMessage(identifier, text);
        
      } catch (error) {
        logger.error('Error handling Telegram message:', error);
        await this.sendErrorMessage(msg.chat.id);
      }
    });

    // Handle callback queries (inline button clicks)
    this.bot.on('callback_query', async (query) => {
      try {
        const chatId = query.message.chat.id;
        const data = query.data;
        
        // Acknowledge the callback immediately
        await this.bot.answerCallbackQuery(query.id);
        
        // Process the button click as a regular message
        const identifier = `tg_${chatId}`;
        const webhookController = require('../controllers/webhook.controller');
        await webhookController.routeMessage(identifier, data);
        
      } catch (error) {
        logger.error('Error handling Telegram callback:', error);
        await this.bot.answerCallbackQuery(query.id, {
          text: '❌ Error processing your request',
          show_alert: true
        });
      }
    });

    logger.info('Telegram handlers registered');
  }

  /**
   * Setup error handlers
   */
  setupErrorHandlers() {
    if (!this.bot) return;

    this.bot.on('polling_error', (error) => {
      logger.error('Telegram polling error:', error);
    });

    this.bot.on('error', (error) => {
      logger.error('Telegram bot error:', error);
    });
  }

  /**
   * Handle /start command
   */
  async handleStart(chatId, from) {
    const firstName = from.first_name || 'there';
    
    const welcomeText = `👋 Hello ${firstName}!

Welcome to *What's Up Trivia Game*! 🎮

Play trivia questions and win real money prizes up to ₦50,000!

To get started, just say *Hello* or *Hi*

_Proudly brought to you by SummerIsland Systems._`;

    await this.sendMessage(chatId, welcomeText);
  }

  /**
   * Handle /help command
   */
  async handleHelp(chatId) {
    const helpText = `📖 *HELP - What's Up Trivia Game*

*Available Commands:*
/start - Start the bot
/help - Show this help message

*How to Play:*
1. Send "Hello" to register or start
2. Choose a game mode
3. Answer 15 questions
4. Win prizes up to ₦50,000!

*Game Modes:*
🎓 Practice - Learn the game (no prizes)
🎮 Classic - Win real money!
🏆 Tournaments - Compete for mega prizes!

*Need Help?*
Just type your question or command!

_Proudly brought to you by SummerIsland Systems._`;

    await this.sendMessage(chatId, helpText);
  }

  /**
   * Send error message
   */
  async sendErrorMessage(chatId) {
    await this.sendMessage(
      chatId,
      '❌ Sorry, something went wrong. Please try again or type /help for assistance.'
    );
  }

  /**
   * Send text message with Markdown formatting
   */
  async sendMessage(chatId, text) {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized - cannot send message');
      return;
    }

    try {
      // Convert WhatsApp-style formatting to Telegram Markdown
      const formatted = this.convertFormatting(text);
      
      await this.bot.sendMessage(chatId, formatted, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
      
      logger.info(`Telegram message sent to ${chatId}`);
    } catch (error) {
      logger.error('Error sending Telegram message:', error);
      
      // If formatting fails, try sending as plain text
      try {
        await this.bot.sendMessage(chatId, text, {
          disable_web_page_preview: true
        });
      } catch (retryError) {
        logger.error('Failed to send message even as plain text:', retryError);
        throw retryError;
      }
    }
  }

  /**
   * Send image with caption
   */
  async sendImage(chatId, imagePath, caption = '') {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized - cannot send image');
      return;
    }

    try {
      const formatted = this.convertFormatting(caption);
      
      // Send as photo
      await this.bot.sendPhoto(chatId, imagePath, {
        caption: formatted,
        parse_mode: 'Markdown'
      });
      
      logger.info(`Telegram image sent to ${chatId}`);
      
      // Clean up local file after sending
      if (fs.existsSync(imagePath)) {
        setTimeout(() => {
          try {
            fs.unlinkSync(imagePath);
          } catch (err) {
            logger.error('Error deleting image file:', err);
          }
        }, 1000);
      }
    } catch (error) {
      logger.error('Error sending Telegram image:', error);
      throw error;
    }
  }

  /**
   * Convert WhatsApp formatting to Telegram Markdown
   * WhatsApp uses: *bold* _italic_ ~strikethrough~ ```code```
   * Telegram uses the same! But we need to escape special chars
   */
  convertFormatting(text) {
    if (!text) return '';

    return text
      // Keep existing formatting
      .replace(/\*([^*]+)\*/g, '*$1*')      // Bold
      .replace(/_([^_]+)_/g, '_$1_')        // Italic  
      .replace(/~([^~]+)~/g, '~$1~')        // Strikethrough
      .replace(/```([^`]+)```/g, '```$1```') // Code block
      // Escape special Markdown characters that aren't formatting
      .replace(/([[\]()>#+\-=|{}.!])/g, '\\$1');
  }

  /**
   * Send message with inline keyboard buttons
   */
  async sendWithButtons(chatId, text, buttons) {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized - cannot send buttons');
      return;
    }

    try {
      // Convert button format if needed
      // Expected format: [[{text: 'Button 1', callback_data: '1'}], [{text: 'Button 2', callback_data: '2'}]]
      
      await this.bot.sendMessage(chatId, this.convertFormatting(text), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: buttons
        },
        disable_web_page_preview: true
      });
      
      logger.info(`Telegram message with buttons sent to ${chatId}`);
    } catch (error) {
      logger.error('Error sending Telegram buttons:', error);
      // Fallback to regular message
      await this.sendMessage(chatId, text);
    }
  }

  /**
   * Send typing action (show "typing..." indicator)
   */
  async sendTyping(chatId) {
    if (!this.bot) return;

    try {
      await this.bot.sendChatAction(chatId, 'typing');
    } catch (error) {
      logger.error('Error sending typing action:', error);
    }
  }

  /**
   * Get bot info
   */
  async getBotInfo() {
    if (!this.bot) return null;

    try {
      return await this.bot.getMe();
    } catch (error) {
      logger.error('Error getting bot info:', error);
      return null;
    }
  }

  /**
   * Check if bot is active
   */
  isActive() {
    return this.bot !== null;
  }

  /**
   * Stop bot polling (for shutdown)
   */
  async stop() {
    if (this.bot) {
      try {
        await this.bot.stopPolling();
        logger.info('Telegram bot stopped');
      } catch (error) {
        logger.error('Error stopping Telegram bot:', error);
      }
    }
  }
}

module.exports = TelegramService;