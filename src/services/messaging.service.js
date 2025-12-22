// ============================================
// FILE: src/services/messaging.service.js
// Platform-Agnostic Messaging Service
// Handles BOTH WhatsApp and Telegram
// Now includes processIncomingMessage for unified handling
// ============================================

const WhatsAppService = require('./whatsapp.service');
const TelegramService = require('./telegram.service');
const { logger } = require('../utils/logger');

// Import your core game/user services here (adjust paths if needed)
const UserService = require('./user.service');
const GameService = require('./game.service');
// Add other services as needed: TournamentService, ReferralService, etc.

class MessagingService {
  constructor() {
    this.whatsapp = new WhatsAppService();
    this.telegram = new TelegramService();

    // Optional: initialize singletons for core services
    this.userService = new UserService();
    this.gameService = new GameService();
  }

  /**
   * Determine platform from identifier
   * WhatsApp: numeric (234916...)
   * Telegram: starts with 'tg_' (tg_123456789)
   */
  getPlatform(identifier) {
    if (!identifier) return 'whatsapp';
    
    const id = identifier.toString();
    if (id.startsWith('tg_')) {
      return 'telegram';
    }
    return 'whatsapp';
  }

  /**
   * Extract platform-specific ID from identifier
   */
  extractId(identifier) {
    const platform = this.getPlatform(identifier);
    
    if (platform === 'telegram') {
      return identifier.toString().replace('tg_', '');
    }
    
    return identifier.toString();
  }

  /**
   * Send text message to any platform
   */
  async sendMessage(identifier, text) {
    const platform = this.getPlatform(identifier);
    const id = this.extractId(identifier);
    
    try {
      if (platform === 'telegram') {
        return await this.telegram.sendMessage(id, text);
      } else {
        return await this.whatsapp.sendMessage(id, text);
      }
    } catch (error) {
      logger.error(`Error sending message via ${platform}:`, error);
      throw error;
    }
  }

  /**
   * Send image with caption to any platform
   */
  async sendImage(identifier, imagePath, caption = '') {
    const platform = this.getPlatform(identifier);
    const id = this.extractId(identifier);
    
    try {
      if (platform === 'telegram') {
        return await this.telegram.sendImage(id, imagePath, caption);
      } else {
        return await this.whatsapp.sendImage(id, imagePath, caption);
      }
    } catch (error) {
      logger.error(`Error sending image via ${platform}:`, error);
      throw error;
    }
  }

  /**
   * Format phone number (WhatsApp specific)
   */
  formatPhoneNumber(phone) {
    if (this.getPlatform(phone) === 'whatsapp') {
      return this.whatsapp.formatPhoneNumber(phone);
    }
    return phone;
  }

  /**
   * Create unified identifier for database storage
   */
  createIdentifier(platform, id) {
    if (platform === 'telegram') {
      return `tg_${id}`;
    }
    return this.formatPhoneNumber(id);
  }

  /**
   * Parse identifier back to platform and ID
   */
  parseIdentifier(identifier) {
    if (!identifier) {
      return { platform: 'whatsapp', id: '' };
    }

    const id = identifier.toString();
    
    if (id.startsWith('tg_')) {
      return {
        platform: 'telegram',
        id: id.replace('tg_', '')
      };
    }
    
    return {
      platform: 'whatsapp',
      id: id
    };
  }

  /**
   * Check if identifier is from Telegram
   */
  isTelegram(identifier) {
    return this.getPlatform(identifier) === 'telegram';
  }

  /**
   * Check if identifier is from WhatsApp
   */
  isWhatsApp(identifier) {
    return this.getPlatform(identifier) === 'whatsapp';
  }

  /**
   * Get platform display name
   */
  getPlatformName(identifier) {
    const platform = this.getPlatform(identifier);
    return platform === 'telegram' ? 'Telegram' : 'WhatsApp';
  }

  /**
   * Send platform-specific buttons (if supported)
   */
  async sendWithButtons(identifier, text, buttons) {
    const platform = this.getPlatform(identifier);
    const id = this.extractId(identifier);
    
    try {
      if (platform === 'telegram') {
        return await this.telegram.sendWithButtons(id, text, buttons);
      } else {
        return await this.whatsapp.sendMessage(id, text);
      }
    } catch (error) {
      logger.error(`Error sending buttons via ${platform}:`, error);
      return await this.sendMessage(identifier, text);
    }
  }

  /**
   * Check if platform is enabled
   */
  isEnabled(platform) {
    if (platform === 'telegram') {
      return process.env.TELEGRAM_ENABLED === 'true';
    }
    return true;
  }

  /**
   * Get active platforms
   */
  getActivePlatforms() {
    const platforms = ['whatsapp'];
    if (this.isEnabled('telegram')) {
      platforms.push('telegram');
    }
    return platforms;
  }

  // ============================================
  // NEW: Unified incoming message processor
  // Called from both WhatsApp webhook and Telegram service
  // ============================================
  async processIncomingMessage({ from, body, name, platform = 'whatsapp', telegramChatId }) {
    try {
      logger.info(`Incoming message from ${from} (${platform}): ${body}`);

      // Create unified identifier (tg_ prefix for Telegram)
      const identifier = platform === 'telegram' 
        ? `tg_${telegramChatId || from}` 
        : this.formatPhoneNumber(from);

      // Your existing game logic goes here — reuse everything!
      // Example flow: registration → menu → game → stats → etc.

      // 1. Get or create user
      let user = await this.userService.getUserByIdentifier(identifier);
      if (!user) {
        user = await this.userService.createUser({
          identifier,
          full_name: name,
          platform,
          telegram_chat_id: platform === 'telegram' ? telegramChatId : null
        });
        // Send welcome message
        await this.sendMessage(identifier, this.whatsapp.getWelcomeMessage(name)); // or a unified welcome
        return { text: null }; // Welcome already sent
      }

      // 2. Delegate to game service (or your existing command handler)
      const response = await this.gameService.handleUserInput(user, body.trim().toUpperCase());

      // response should be: { text: string, image?: string, options?: {} }
      if (response) {
        if (response.text) {
          await this.sendMessage(identifier, response.text);
        }
        if (response.image) {
          await this.sendImage(identifier, response.image, response.caption || '');
        }
        if (response.buttons) {
          await this.sendWithButtons(identifier, response.text || '', response.buttons);
        }
      }

      return response;

    } catch (error) {
      logger.error('Error in processIncomingMessage:', error);
      await this.sendMessage(from, "😔 Sorry, something went wrong. Please try again later.");
      return { text: "Error handled" };
    }
  }
}

module.exports = MessagingService;