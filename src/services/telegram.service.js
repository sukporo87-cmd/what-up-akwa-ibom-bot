// ============================================
// FILE: src/services/telegram.service.js
// UPDATED: Safe lazy access to MessagingService
// ============================================

const TelegramBot = require('node-telegram-bot-api');
const { logger } = require('../utils/logger');

// Singleton
let instance = null;

class TelegramService {
  constructor() {
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
      this.bot = new TelegramBot(token, { polling: false, webHook: false });
      this.webhookSetup = false;
      this.messagingService = null; // Lazy-loaded

      instance = this;
      logger.info('Telegram bot instance created');
    } catch (error) {
      logger.error('Failed to create Telegram bot:', error);
      throw error;
    }
  }

  getMessagingService() {
    if (!this.messagingService) {
      const MessagingService = require('./messaging.service');
      this.messagingService = new MessagingService();
    }
    return this.messagingService;
  }

  async setupWebhook(webhookUrl) {
    if (this.webhookSetup) {
      logger.info('Webhook already configured');
      return;
    }

    try {
      const current = await this.bot.getWebHookInfo();
      if (current.url === webhookUrl) {
        logger.info(`Telegram webhook already set: ${webhookUrl}`);
        this.webhookSetup = true;
        return;
      }

      if (current.url) {
        await this.bot.deleteWebHook();
        logger.info('Old webhook deleted');
        await this.sleep(1000);
      }

      await this.bot.setWebHook(webhookUrl);
      this.webhookSetup = true;
      logger.info(`Telegram webhook set: ${webhookUrl}`);

      const info = await this.bot.getWebHookInfo();
      logger.info('Webhook info:', info);
    } catch (error) {
      if (error.response?.statusCode === 429) {
        this.webhookSetup = true;
      } else {
        logger.error('Webhook setup error:', error.message);
        throw error;
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async processUpdate(update) {
    try {
      logger.info('Processing Telegram update');

      if (!update.message?.text) {
        logger.info('Ignored non-text message');
        return;
      }

      const { chat: { id: chatId }, text, from } = update.message;

      const userName = from.first_name 
        ? `${from.first_name}${from.last_name ? ' ' + from.last_name : ''}`.trim()
        : from.username || 'Telegram User';

      logger.info(`Telegram message from ${chatId}: ${text}`);

      await this.getMessagingService().processIncomingMessage({
        from: chatId.toString(),
        body: text.trim(),
        name: userName,
        platform: 'telegram',
        telegramChatId: chatId
      });

    } catch (error) {
      logger.error('Error processing Telegram update:', error);
      if (update.message?.chat?.id) {
        await this.sendMessage(update.message.chat.id, "Sorry, an error occurred. Try again later.");
      }
    }
  }

  async sendMessage(chatId, text, options = {}) {
    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...options
      });
      logger.info(`Sent message to ${chatId}`);
      return true;
    } catch (error) {
      logger.error(`Send message error to ${chatId}:`, error);
      return false;
    }
  }

  async sendPhoto(chatId, photo, options = {}) {
    try {
      await this.bot.sendPhoto(chatId, photo, options);
      logger.info(`Sent photo to ${chatId}`);
      return true;
    } catch (error) {
      logger.error(`Send photo error to ${chatId}:`, error);
      return false;
    }
  }

  async sendImage(chatId, imagePath, caption = '') {
    return this.sendPhoto(chatId, imagePath, { caption });
  }

  async sendWithButtons(chatId, text, buttons) {
    const keyboard = {
      inline_keyboard: buttons.map(row =>
        row.map(btn => ({ text: btn.title || btn, callback_data: btn.id || btn }))
      )
    };
    return this.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  static getInstance() {
    if (!instance) throw new Error('TelegramService not initialized');
    return instance;
  }

  static resetInstance() {
    instance = null;
  }
}

module.exports = TelegramService;