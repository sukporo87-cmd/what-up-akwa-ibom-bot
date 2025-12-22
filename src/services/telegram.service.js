// ============================================
// FILE: src/services/telegram.service.js
// UPDATED: Full integration with MessagingService (shared logic)
// Removes dependency on non-existent message.handler
// ============================================

const TelegramBot = require('node-telegram-bot-api');
const { logger } = require('../utils/logger');
const MessagingService = require('./messaging.service');

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

      // Instantiate MessagingService for unified handling
      this.messagingService = new MessagingService();

      // Set singleton instance
      instance = this;

      logger.info('Telegram bot instance created');
      
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
        logger.info(`Telegram webhook already configured: ${webhookUrl}`);
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
      
      logger.info(`Telegram webhook set: ${webhookUrl}`);
      
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
   * Now uses MessagingService.processIncomingMessage for full shared logic
   */
  async processUpdate(update) {
    try {
      logger.info('Processing Telegram update');

      if (!update.message) {
        logger.info('Non-message update ignored (e.g., edited message, callback, etc.)');
        return;
      }

      const message = update.message;
      const chatId = message.chat.id;
      const text = (message.text || '').trim();
      const from = message.from;

      if (!text) {
        logger.info('Empty text message ignored');
        return;
      }

      logger.info(`Telegram message from ${chatId}: ${text}`);

      // Build user name
      const userName = from.first_name 
        ? `${from.first_name}${from.last_name ? ' ' + from.last_name : ''}`.trim()
        : from.username || 'Telegram User';

      // Delegate to shared MessagingService
      // This gives Telegram full access to the same game flow as WhatsApp
      await this.messagingService.processIncomingMessage({
        from: chatId.toString(),           // Raw chat ID (MessagingService will prefix with tg_)
        body: text,
        name: userName,
        platform: 'telegram',
        telegramChatId: chatId             // Passed explicitly for identifier creation and sending
      });

      logger.info('Telegram update processed successfully');

    } catch (error) {
      logger.error('Error processing Telegram update:', error);

      // Try to send a friendly error message to the user
      if (update.message && update.message.chat && update.message.chat.id) {
        try {
          await this.sendMessage(
            update.message.chat.id,
            "Sorry, something went wrong. Please try again in a moment."
          );
        } catch (sendError) {
          logger.error('Failed to send error message to user:', sendError);
        }
      }
    }
  }

  /**
   * Send message to Telegram user
   */
  async sendMessage(chatId, text, options = {}) {
    try {
      const defaultOptions = {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
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
   * Send message with inline buttons (for future use)
   */
  async sendWithButtons(chatId, text, buttons) {
    const keyboard = {
      inline_keyboard: buttons.map(row => 
        row.map(btn => ({ text: btn.title || btn, callback_data: btn.id || btn }))
      )
    };

    return this.sendMessage(chatId, text, { reply_markup: keyboard });
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