javascript
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { logger } = require('../utils/logger');

class TelegramService {
  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const enabled = process.env.TELEGRAM_ENABLED === 'true';

    if (!enabled || !token) {
      logger.warn('Telegram bot is disabled or token missing');
      this.bot = null;
      return;
    }

    // WEBHOOK MODE - NO POLLING
    this.bot = new TelegramBot(token, { polling: false });
    this.setupWebhook();
    logger.info('✅ Telegram bot initialized with webhook');
  }

  async setupWebhook() {
    if (!this.bot) return;

    try {
      const webhookUrl = `${process.env.APP_URL}/webhook/telegram`;
      
      // Delete old webhook/polling first
      await this.bot.deleteWebHook();
      logger.info('Old webhook deleted');
      
      // Set new webhook
      await this.bot.setWebHook(webhookUrl);
      logger.info(`✅ Webhook set to: ${webhookUrl}`);
      
      // Verify
      const info = await this.bot.getWebHookInfo();
      logger.info('Webhook info:', JSON.stringify(info));
      
    } catch (error) {
      logger.error('Error setting webhook:', error);
    }
  }

  async processUpdate(update) {
    if (!this.bot) return;

    try {
      // Handle regular messages
      if (update.message) {
        const chatId = update.message.chat.id;
        const text = update.message.text || '';
        
        const webhookController = require('../controllers/webhook.controller');
        const identifier = `tg_${chatId}`;
        
        await webhookController.routeMessage(identifier, text);
      }
      
      // Handle button clicks
      if (update.callback_query) {
        const chatId = update.callback_query.message.chat.id;
        const data = update.callback_query.data;
        
        await this.bot.answerCallbackQuery(update.callback_query.id);
        
        const webhookController = require('../controllers/webhook.controller');
        const identifier = `tg_${chatId}`;
        
        await webhookController.routeMessage(identifier, data);
      }
      
    } catch (error) {
      logger.error('Error processing update:', error);
    }
  }

  async sendMessage(chatId, text) {
    if (!this.bot) {
      logger.warn('Bot not initialized');
      return;
    }

    try {
      const formatted = this.convertFormatting(text);
      
      await this.bot.sendMessage(chatId, formatted, {
        parse_mode: 'Markdown'
      });
      
      logger.info(`Message sent to ${chatId}`);
    } catch (error) {
      logger.error('Error sending message:', error);
      throw error;
    }
  }

  async sendImage(chatId, imagePath, caption = '') {
    if (!this.bot) {
      logger.warn('Bot not initialized');
      return;
    }

    try {
      const formatted = this.convertFormatting(caption);
      
      await this.bot.sendPhoto(chatId, imagePath, {
        caption: formatted,
        parse_mode: 'Markdown'
      });
      
      logger.info(`Image sent to ${chatId}`);
      
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    } catch (error) {
      logger.error('Error sending image:', error);
      throw error;
    }
  }

  convertFormatting(text) {
    return text
      .replace(/\*([^*]+)\*/g, '*$1*')
      .replace(/_([^_]+)_/g, '_$1_')
      .replace(/~([^~]+)~/g, '~$1~')
      .replace(/```([^`]+)```/g, '```$1```');
  }

  async sendWithButtons(chatId, text, buttons) {
    if (!this.bot) return;

    try {
      await this.bot.sendMessage(chatId, this.convertFormatting(text), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: buttons
        }
      });
    } catch (error) {
      logger.error('Error sending buttons:', error);
    }
  }
}

module.exports = TelegramService;