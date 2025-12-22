// ============================================
// FILE: src/services/messaging.service.js
// FIXED: Lazy loading to avoid circular dependency
// Unified messaging for WhatsApp & Telegram
// ============================================

const WhatsAppService = require('./whatsapp.service');
const { logger } = require('../utils/logger');

// Import core services (adjust paths if needed)
const UserService = require('./user.service');
const GameService = require('./game.service');

class MessagingService {
  constructor() {
    this.whatsapp = new WhatsAppService();
    this.telegram = null; // Lazy-loaded

    // Core services
    this.userService = new UserService();
    this.gameService = new GameService();
  }

  // Lazy getter for TelegramService
  getTelegramService() {
    if (!this.telegram && process.env.TELEGRAM_ENABLED === 'true') {
      try {
        const TelegramService = require('./telegram.service');
        this.telegram = new TelegramService();
      } catch (error) {
        logger.error('Failed to lazy-load TelegramService:', error);
        this.telegram = null;
      }
    }
    return this.telegram;
  }

  /**
   * Determine platform from identifier
   */
  getPlatform(identifier) {
    if (!identifier) return 'whatsapp';
    const id = identifier.toString();
    return id.startsWith('tg_') ? 'telegram' : 'whatsapp';
  }

  /**
   * Extract raw ID
   */
  extractId(identifier) {
    const platform = this.getPlatform(identifier);
    return platform === 'telegram' ? identifier.toString().replace('tg_', '') : identifier.toString();
  }

  /**
   * Send text message
   */
  async sendMessage(identifier, text) {
    const platform = this.getPlatform(identifier);
    const id = this.extractId(identifier);

    try {
      if (platform === 'telegram') {
        const tg = this.getTelegramService();
        if (!tg) throw new Error('Telegram disabled');
        return await tg.sendMessage(id, text);
      }
      return await this.whatsapp.sendMessage(id, text);
    } catch (error) {
      logger.error(`Send message error (${platform}):`, error);
      throw error;
    }
  }

  /**
   * Send image
   */
  async sendImage(identifier, imagePath, caption = '') {
    const platform = this.getPlatform(identifier);
    const id = this.extractId(identifier);

    try {
      if (platform === 'telegram') {
        const tg = this.getTelegramService();
        if (!tg) throw new Error('Telegram disabled');
        return await tg.sendImage(id, imagePath, caption);
      }
      return await this.whatsapp.sendImage(id, imagePath, caption);
    } catch (error) {
      logger.error(`Send image error (${platform}):`, error);
      throw error;
    }
  }

  /**
   * Send with buttons (Telegram inline)
   */
  async sendWithButtons(identifier, text, buttons) {
    const platform = this.getPlatform(identifier);
    const id = this.extractId(identifier);

    try {
      if (platform === 'telegram') {
        const tg = this.getTelegramService();
        if (!tg) return await this.sendMessage(identifier, text);
        return await tg.sendWithButtons(id, text, buttons);
      }
      return await this.whatsapp.sendMessage(id, text);
    } catch (error) {
      logger.error(`Send buttons error (${platform}):`, error);
      return await this.sendMessage(identifier, text);
    }
  }

  /**
   * Format phone (WhatsApp only)
   */
  formatPhoneNumber(phone) {
    return this.getPlatform(phone) === 'whatsapp' ? this.whatsapp.formatPhoneNumber(phone) : phone;
  }

  /**
   * Create unified identifier
   */
  createIdentifier(platform, id) {
    return platform === 'telegram' ? `tg_${id}` : this.formatPhoneNumber(id);
  }

  /**
   * Parse identifier
   */
  parseIdentifier(identifier) {
    if (!identifier) return { platform: 'whatsapp', id: '' };
    const id = identifier.toString();
    if (id.startsWith('tg_')) return { platform: 'telegram', id: id.replace('tg_', '') };
    return { platform: 'whatsapp', id: id };
  }

  // Other helpers
  isTelegram(identifier) { return this.getPlatform(identifier) === 'telegram'; }
  isWhatsApp(identifier) { return this.getPlatform(identifier) === 'whatsapp'; }
  getPlatformName(identifier) { return this.getPlatform(identifier) === 'telegram' ? 'Telegram' : 'WhatsApp'; }
  isEnabled(platform) { return platform === 'telegram' ? process.env.TELEGRAM_ENABLED === 'true' : true; }

  /**
   * Unified incoming message handler
   */
  async processIncomingMessage({ from, body, name, platform = 'whatsapp', telegramChatId }) {
    try {
      logger.info(`Incoming message from ${from} (${platform}): ${body}`);

      const identifier = platform === 'telegram'
        ? `tg_${telegramChatId || from}`
        : this.formatPhoneNumber(from);

      // Get or create user
      let user = await this.userService.getUserByIdentifier(identifier);
      if (!user) {
        user = await this.userService.createUser({
          identifier,
          full_name: name,
          platform,
          telegram_chat_id: platform === 'telegram' ? telegramChatId : null
        });

        const welcomeMsg = this.whatsapp.getWelcomeMessage(name); // Reuse WhatsApp welcome or make unified
        await this.sendMessage(identifier, welcomeMsg);
        return { sentWelcome: true };
      }

      // Handle user input via game service
      const response = await this.gameService.handleUserInput(user, body.trim().toUpperCase());

      if (response) {
        if (response.text) await this.sendMessage(identifier, response.text);
        if (response.image) await this.sendImage(identifier, response.image, response.caption || '');
        if (response.buttons) await this.sendWithButtons(identifier, response.text || '', response.buttons);
      }

      return response;

    } catch (error) {
      logger.error('Error in processIncomingMessage:', error);
      const fallback = "😔 Sorry, something went wrong. Please try again later.";
      if (platform === 'telegram' && telegramChatId) {
        const tg = this.getTelegramService();
        if (tg) await tg.sendMessage(telegramChatId, fallback);
      } else {
        await this.sendMessage(from, fallback);
      }
      return { error: true };
    }
  }
}

module.exports = MessagingService;