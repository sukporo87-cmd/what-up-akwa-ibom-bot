const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { logger } = require('../utils/logger');

// Singleton instance
let instance = null;

class TelegramService {
  constructor() {
    // Return existing instance
    if (instance) {
      return instance;
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const enabled = process.env.TELEGRAM_ENABLED === 'true';

    if (!enabled || !token) {
      logger.warn('Telegram bot disabled');
      this.bot = null;
      instance = this;
      return instance;
    }

    // Create bot in webhook mode - NO setup here
    this.bot = new TelegramBot(token, { polling: false });
    
    instance = this;
    logger.info('✅ Telegram bot instance created');
    
    return instance;
  }

  // Process incoming webhook updates
  async processUpdate(update) {
    if (!this.bot) return;

    try {
      if (update.message) {
        const chatId = update.message.chat.id;
        const text = update.message.text || '';
        const identifier = `tg_${chatId}`;
        
        logger.info(`💬 Telegram message from ${chatId}: ${text}`);
        
        const webhookController = require('../controllers/webhook.controller');
        await webhookController.routeMessage(identifier, text);
      }
      
      if (update.callback_query) {
        const chatId = update.callback_query.message.chat.id;
        const data = update.callback_query.data;
        const identifier = `tg_${chatId}`;
        
        await this.bot.answerCallbackQuery(update.callback_query.id);
        
        const webhookController = require('../controllers/webhook.controller');
        await webhookController.routeMessage(identifier, data);
      }
      
    } catch (error) {
      logger.error('Error processing Telegram update:', error);
    }
  }

  async sendMessage(chatId, text) {
    if (!this.bot) {
      logger.error('Cannot send - bot not initialized');
      return;
    }

    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown'
      });
      logger.info(`✅ Message sent to ${chatId}`);
    } catch (error) {
      logger.error(`Error sending to ${chatId}:`, error.message);
      throw error;
    }
  }

  async sendImage(chatId, imagePath, caption = '') {
    if (!this.bot) return;

    try {
      await this.bot.sendPhoto(chatId, imagePath, {
        caption: caption,
        parse_mode: 'Markdown'
      });
      
      logger.info(`✅ Image sent to ${chatId}`);
      
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    } catch (error) {
      logger.error(`Error sending image to ${chatId}:`, error.message);
      throw error;
    }
  }

  async sendWithButtons(chatId, text, buttons) {
    if (!this.bot) return;

    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: buttons
        }
      });
      logger.info(`✅ Buttons sent to ${chatId}`);
    } catch (error) {
      logger.error(`Error sending buttons:`, error.message);
    }
  }
}

module.exports = TelegramService;