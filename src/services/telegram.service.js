const TelegramBot = require('node-telegram-bot-api');
const { logger } = require('../utils/logger');

// Singleton instance
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
      this.bot = null;
      instance = this;
      return instance;
    }

    try {
      this.bot = new TelegramBot(token, {
        polling: false,
        webHook: false
      });
      
      this.webhookSetup = false;
      instance = this;
      
      logger.info('✅ Telegram bot instance created');
    } catch (error) {
      logger.error('Failed to create Telegram bot:', error);
      this.bot = null;
      instance = this;
    }
  }

  async setupWebhook(webhookUrl) {
    if (this.webhookSetup || !this.bot) {
      return;
    }

    try {
      const currentWebhook = await this.bot.getWebHookInfo();
      
      if (currentWebhook.url === webhookUrl) {
        logger.info(`✅ Telegram webhook already configured: ${webhookUrl}`);
        this.webhookSetup = true;
        return;
      }

      if (currentWebhook.url) {
        await this.bot.deleteWebHook();
        logger.info('Old webhook deleted');
        await this.sleep(1000);
      }

      await this.bot.setWebHook(webhookUrl);
      this.webhookSetup = true;
      
      logger.info(`✅ Telegram webhook set: ${webhookUrl}`);
      
      const info = await this.bot.getWebHookInfo();
      logger.info('Webhook info:', {
        url: info.url,
        pending_update_count: info.pending_update_count
      });
      
    } catch (error) {
      if (error.response?.statusCode === 429) {
        logger.warn('Rate limited by Telegram (webhook already set)');
        this.webhookSetup = true;
      } else {
        logger.error('Error setting webhook:', error.message);
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async processUpdate(update) {
    if (!this.bot) {
      logger.warn('Bot not initialized');
      return;
    }

    try {
      logger.info('📥 Processing Telegram update');
      
      if (update.message) {
        const chatId = update.message.chat.id;
        const text = update.message.text || '';
        const identifier = `tg_${chatId}`;
        
        logger.info(`💬 Telegram message from ${chatId}: ${text}`);
        
        // Route through webhook controller
        const webhookController = require('../controllers/webhook.controller');
        await webhookController.routeMessage(identifier, text);
        
        logger.info('✅ Message routed successfully');
      }
      
      if (update.callback_query) {
        const chatId = update.callback_query.message.chat.id;
        const data = update.callback_query.data;
        const identifier = `tg_${chatId}`;
        
        logger.info(`🔘 Telegram callback from ${chatId}: ${data}`);
        
        await this.bot.answerCallbackQuery(update.callback_query.id);
        
        const webhookController = require('../controllers/webhook.controller');
        await webhookController.routeMessage(identifier, data);
        
        logger.info('✅ Callback routed successfully');
      }
      
    } catch (error) {
      logger.error('❌ Error processing Telegram update:', error);
    }
  }

  async sendMessage(chatId, text, options = {}) {
    if (!this.bot) {
      logger.error('Cannot send message - bot not initialized');
      return false;
    }

    try {
      const defaultOptions = {
        parse_mode: 'Markdown',
        ...options
      };

      await this.bot.sendMessage(chatId, text, defaultOptions);
      logger.info(`✅ Message sent to ${chatId}`);
      return true;
    } catch (error) {
      logger.error(`Error sending message to ${chatId}:`, error.message);
      return false;
    }
  }

  async sendPhoto(chatId, photo, options = {}) {
    if (!this.bot) return false;

    try {
      await this.bot.sendPhoto(chatId, photo, options);
      logger.info(`✅ Photo sent to ${chatId}`);
      return true;
    } catch (error) {
      logger.error(`Error sending photo to ${chatId}:`, error.message);
      return false;
    }
  }

  async sendImage(chatId, imagePath, caption = '') {
    return this.sendPhoto(chatId, imagePath, { caption });
  }

  async sendWithButtons(chatId, text, buttons) {
    if (!this.bot) return false;

    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: buttons
        }
      });
      logger.info(`✅ Buttons sent to ${chatId}`);
      return true;
    } catch (error) {
      logger.error(`Error sending buttons:`, error.message);
      return false;
    }
  }

  static getInstance() {
    if (!instance) {
      new TelegramService();
    }
    return instance;
  }

  static resetInstance() {
    instance = null;
  }
}

module.exports = TelegramService;