// ============================================
// FILE: src/services/telegram.service.js
// FIXED: Proper bot initialization with webhook
// ============================================

const TelegramBot = require('node-telegram-bot-api');
const { logger } = require('../utils/logger');

// Singleton instance
let instance = null;

class TelegramService {
  constructor() {
    // Return existing instance if already created
    if (instance) {
      logger.info('Returning existing Telegram service instance');
      return instance;
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      logger.error('TELEGRAM_BOT_TOKEN not provided');
      throw new Error('TELEGRAM_BOT_TOKEN is required');
    }

    try {
      // Create bot instance WITHOUT polling or webhook initially
      this.bot = new TelegramBot(token, {
        polling: false,
        webHook: false
      });

      this.webhookSetup = false;
      
      // Set singleton instance
      instance = this;

      logger.info('✅ Telegram bot instance created');
      
    } catch (error) {
      logger.error('Failed to create Telegram bot:', error);
      throw error;
    }
  }

  /**
   * Setup webhook (called from server.js after server starts)
   */
  async setupWebhook(webhookUrl) {
    if (this.webhookSetup) {
      logger.info('Webhook already configured');
      return;
    }

    try {
      // Check current webhook status
      const currentWebhook = await this.bot.getWebHookInfo();
      
      if (currentWebhook.url === webhookUrl) {
        logger.info(`✅ Telegram webhook already configured: ${webhookUrl}`);
        this.webhookSetup = true;
        return;
      }

      // Delete old webhook if different
      if (currentWebhook.url) {
        await this.bot.deleteWebHook();
        logger.info('Old webhook deleted');
        // Wait a bit to avoid rate limits
        await this.sleep(1000);
      }

      // Set new webhook
      await this.bot.setWebHook(webhookUrl);
      this.webhookSetup = true;
      
      logger.info(`✅ Telegram webhook set: ${webhookUrl}`);
      
      // Verify
      const info = await this.bot.getWebHookInfo();
      logger.info('Webhook info:', {
        url: info.url,
        pending_update_count: info.pending_update_count,
        last_error_date: info.last_error_date,
        last_error_message: info.last_error_message
      });

    } catch (error) {
      if (error.response?.statusCode === 429) {
        logger.warn('Rate limited by Telegram (webhook already set)');
        this.webhookSetup = true; // Assume it's set
      } else {
        logger.error('Error setting webhook:', error.message);
        throw error;
      }
    }
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Process incoming webhook update
   */
  async processUpdate(update) {
    try {
      logger.info('Processing Telegram update');

      if (update.message) {
        const message = update.message;
        const chatId = message.chat.id;
        const text = message.text || '';
        const from = message.from;

        logger.info(`Telegram message from ${chatId}: ${text}`);

        // Import handler here to avoid circular dependencies
        const MessageHandler = require('../handlers/message.handler');
        const messageHandler = new MessageHandler();

        // Use chat ID as identifier with 'tg_' prefix
        const identifier = `tg_${chatId}`;
        
        // Handle the message
        const response = await messageHandler.handleIncomingMessage({
          from: identifier,
          body: text,
          name: from.first_name || from.username || 'User',
          platform: 'telegram'
        });

        if (response) {
          await this.sendMessage(chatId, response);
        }

        logger.info('Telegram update processed successfully');
      }

    } catch (error) {
      logger.error('Error processing Telegram update:', error);
      throw error;
    }
  }

  /**
   * Send message to Telegram user
   */
  async sendMessage(chatId, text, options = {}) {
    try {
      const defaultOptions = {
        parse_mode: 'Markdown',
        ...options
      };

      await this.bot.sendMessage(chatId, text, defaultOptions);
      logger.info(`Message sent to ${chatId}`);
      return true;
    } catch (error) {
      logger.error(`Error sending message to ${chatId}:`, error);
      return false;
    }
  }

  /**
   * Send photo to Telegram user
   */
  async sendPhoto(chatId, photo, options = {}) {
    try {
      await this.bot.sendPhoto(chatId, photo, options);
      logger.info(`Photo sent to ${chatId}`);
      return true;
    } catch (error) {
      logger.error(`Error sending photo to ${chatId}:`, error);
      return false;
    }
  }

  /**
   * Send image (alias for sendPhoto)
   */
  async sendImage(chatId, imagePath, caption = '') {
    return this.sendPhoto(chatId, imagePath, { caption });
  }

  /**
   * Get singleton instance
   */
  static getInstance() {
    if (!instance) {
      throw new Error('TelegramService not initialized');
    }
    return instance;
  }

  /**
   * Reset singleton (for testing)
   */
  static resetInstance() {
    instance = null;
  }
}

module.exports = TelegramService;