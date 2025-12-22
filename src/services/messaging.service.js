// ============================================
// FILE: src/services/messaging.service.js
// Platform-Agnostic Messaging Service
// Handles BOTH WhatsApp and Telegram
// ============================================

const WhatsAppService = require('./whatsapp.service');
const TelegramService = require('./telegram.service');
const { logger } = require('../utils/logger');

class MessagingService {
  constructor() {
    this.whatsapp = new WhatsAppService();
    this.telegram = new TelegramService();
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
    // Only format if it's a WhatsApp number
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
    // WhatsApp uses phone number directly
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
        // Telegram supports inline keyboards
        return await this.telegram.sendWithButtons(id, text, buttons);
      } else {
        // WhatsApp doesn't support buttons in bot messages
        // Just send the text
        return await this.whatsapp.sendMessage(id, text);
      }
    } catch (error) {
      logger.error(`Error sending buttons via ${platform}:`, error);
      // Fallback to regular message
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
    // WhatsApp is always enabled
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
}

module.exports = MessagingService;