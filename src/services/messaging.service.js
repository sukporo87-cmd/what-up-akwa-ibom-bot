// ============================================
// FILE: src/services/messaging.service.js
<<<<<<< HEAD
// FIXED: Platform-Agnostic Messaging Service
// Handles BOTH WhatsApp and Telegram WITHOUT breaking WhatsApp
=======
// Platform-Agnostic Messaging Service
// Handles BOTH WhatsApp and Telegram
>>>>>>> e2a793d8761b3612d4ad5e46fa2f754973c1e3ee
// ============================================

const WhatsAppService = require('./whatsapp.service');
const TelegramService = require('./telegram.service');
const { logger } = require('../utils/logger');

class MessagingService {
  constructor() {
<<<<<<< HEAD
    console.log('🔧 Initializing MessagingService...');
    
    // ALWAYS initialize WhatsApp (primary platform)
    try {
      this.whatsapp = new WhatsAppService();
      console.log('✅ WhatsApp service initialized');
    } catch (error) {
      console.error('❌ CRITICAL: WhatsApp service failed to initialize:', error);
      throw error; // WhatsApp is critical, fail if it doesn't work
    }
    
    // Initialize Telegram ONLY if enabled (optional platform)
    this.telegram = null;
    if (process.env.TELEGRAM_ENABLED === 'true') {
      try {
        this.telegram = new TelegramService();
        console.log('✅ Telegram service initialized');
      } catch (error) {
        console.error('⚠️ Telegram service failed to initialize (continuing with WhatsApp only):', error);
        // Don't throw - Telegram is optional, WhatsApp should still work
        this.telegram = null;
      }
    } else {
      console.log('ℹ️ Telegram disabled (WhatsApp only mode)');
    }
    
    console.log('✅ MessagingService ready');
=======
    this.whatsapp = new WhatsAppService();
    this.telegram = new TelegramService();
>>>>>>> e2a793d8761b3612d4ad5e46fa2f754973c1e3ee
  }

  /**
   * Determine platform from identifier
   * WhatsApp: numeric (234916...)
   * Telegram: starts with 'tg_' (tg_123456789)
   */
  getPlatform(identifier) {
<<<<<<< HEAD
    if (!identifier) {
      console.log('⚠️ No identifier provided, defaulting to WhatsApp');
      return 'whatsapp';
    }
=======
    if (!identifier) return 'whatsapp';
>>>>>>> e2a793d8761b3612d4ad5e46fa2f754973c1e3ee
    
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
<<<<<<< HEAD
    if (platform === 'telegram') {
      return identifier.toString().replace('tg_', '');
    }
=======
    
    if (platform === 'telegram') {
      return identifier.toString().replace('tg_', '');
    }
    
>>>>>>> e2a793d8761b3612d4ad5e46fa2f754973c1e3ee
    return identifier.toString();
  }

  /**
   * Send text message to any platform
   */
  async sendMessage(identifier, text) {
    const platform = this.getPlatform(identifier);
    const id = this.extractId(identifier);
    
<<<<<<< HEAD
    console.log(`📨 Sending message via ${platform} to ${id.substring(0, 10)}...`);

    try {
      if (platform === 'telegram') {
        if (!this.telegram) {
          console.error('❌ Telegram service not available');
          throw new Error('Telegram service not initialized');
        }
        console.log('   Using Telegram service...');
        return await this.telegram.sendMessage(id, text);
      } else {
        if (!this.whatsapp) {
          console.error('❌ WhatsApp service not available');
          throw new Error('WhatsApp service not initialized');
        }
        console.log('   Using WhatsApp service...');
        return await this.whatsapp.sendMessage(id, text);
      }
    } catch (error) {
      console.error(`❌ Failed to send message via ${platform}:`, error.message);
=======
    try {
      if (platform === 'telegram') {
        return await this.telegram.sendMessage(id, text);
      } else {
        return await this.whatsapp.sendMessage(id, text);
      }
    } catch (error) {
>>>>>>> e2a793d8761b3612d4ad5e46fa2f754973c1e3ee
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
    
<<<<<<< HEAD
    console.log(`📸 Sending image via ${platform} to ${id.substring(0, 10)}...`);

    try {
      if (platform === 'telegram') {
        if (!this.telegram) {
          throw new Error('Telegram service not initialized');
        }
        return await this.telegram.sendImage(id, imagePath, caption);
      } else {
        if (!this.whatsapp) {
          throw new Error('WhatsApp service not initialized');
        }
        return await this.whatsapp.sendImage(id, imagePath, caption);
      }
    } catch (error) {
      console.error(`❌ Failed to send image via ${platform}:`, error.message);
=======
    try {
      if (platform === 'telegram') {
        return await this.telegram.sendImage(id, imagePath, caption);
      } else {
        return await this.whatsapp.sendImage(id, imagePath, caption);
      }
    } catch (error) {
>>>>>>> e2a793d8761b3612d4ad5e46fa2f754973c1e3ee
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
<<<<<<< HEAD
=======
    
>>>>>>> e2a793d8761b3612d4ad5e46fa2f754973c1e3ee
    if (id.startsWith('tg_')) {
      return {
        platform: 'telegram',
        id: id.replace('tg_', '')
      };
    }
<<<<<<< HEAD

=======
    
>>>>>>> e2a793d8761b3612d4ad5e46fa2f754973c1e3ee
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
<<<<<<< HEAD
      if (platform === 'telegram' && this.telegram) {
        // Telegram supports inline keyboards
        return await this.telegram.sendWithButtons(id, text, buttons);
      } else if (platform === 'whatsapp' && this.whatsapp) {
        // WhatsApp doesn't support buttons in bot messages
        // Just send the text
        return await this.whatsapp.sendMessage(id, text);
      } else {
        throw new Error(`${platform} service not available`);
      }
    } catch (error) {
      console.error(`❌ Error sending buttons via ${platform}:`, error.message);
=======
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
>>>>>>> e2a793d8761b3612d4ad5e46fa2f754973c1e3ee
      // Fallback to regular message
      return await this.sendMessage(identifier, text);
    }
  }

  /**
   * Check if platform is enabled
   */
  isEnabled(platform) {
    if (platform === 'telegram') {
<<<<<<< HEAD
      return process.env.TELEGRAM_ENABLED === 'true' && this.telegram !== null;
    }
    // WhatsApp is always enabled (primary platform)
    return this.whatsapp !== null;
=======
      return process.env.TELEGRAM_ENABLED === 'true';
    }
    // WhatsApp is always enabled
    return true;
>>>>>>> e2a793d8761b3612d4ad5e46fa2f754973c1e3ee
  }

  /**
   * Get active platforms
   */
  getActivePlatforms() {
<<<<<<< HEAD
    const platforms = [];
    
    if (this.whatsapp) {
      platforms.push('whatsapp');
    }
    
    if (this.telegram) {
=======
    const platforms = ['whatsapp'];
    
    if (this.isEnabled('telegram')) {
>>>>>>> e2a793d8761b3612d4ad5e46fa2f754973c1e3ee
      platforms.push('telegram');
    }
    
    return platforms;
  }
}

module.exports = MessagingService;