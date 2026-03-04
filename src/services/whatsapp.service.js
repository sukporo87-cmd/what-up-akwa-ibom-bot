const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { logger } = require('../utils/logger');

// Per-user message tracking to prevent WhatsApp pair rate limits (error #131056)
const userMessageCounts = new Map();
const PAIR_RATE_LIMIT = 60;       // Max messages to same user per window
const PAIR_RATE_WINDOW = 60000;   // 1-minute window (ms)

class WhatsAppService {
  constructor() {
    this.apiUrl = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v18.0';
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
  }

  /**
   * Sanitize error for logging — strips tokens, headers, TLS data
   * Prevents credentials from leaking into Render logs
   */
  _sanitizeError(error) {
    if (error.response) {
      return {
        status: error.response.status,
        data: error.response.data
      };
    }
    return { message: error.message, code: error.code };
  }

  /**
   * Track messages per recipient to stay under WhatsApp's pair rate limit
   */
  _checkPairRate(phone) {
    const now = Date.now();
    const record = userMessageCounts.get(phone);

    if (!record || now > record.resetAt) {
      userMessageCounts.set(phone, { count: 1, resetAt: now + PAIR_RATE_WINDOW });
      return { allowed: true, count: 1 };
    }

    record.count++;

    if (record.count > PAIR_RATE_LIMIT) {
      return { allowed: false, count: record.count };
    }

    return { allowed: true, count: record.count };
  }

  /**
   * Check if a WhatsApp API error is the pair rate limit (#131056)
   */
  _isPairRateLimit(error) {
    const data = error.response?.data?.error;
    return data && (data.code === 131056 ||
      (data.message && data.message.includes('pair rate limit')));
  }

  async sendMessage(to, text) {
    try {
      const rateCheck = this._checkPairRate(to);
      if (!rateCheck.allowed) {
        logger.warn(`⚠️ Pair rate limit reached for ${to} (${rateCheck.count} msgs in window). Skipping.`);
        return { skipped: true, reason: 'pair_rate_limit' };
      }

      const url = `${this.apiUrl}/${this.phoneNumberId}/messages`;
      const data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: {
          preview_url: false,
          body: text
        }
      };

      const response = await axios.post(url, data, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      logger.info(`Message sent to ${to}`);
      return response.data;
    } catch (error) {
      if (this._isPairRateLimit(error)) {
        logger.warn(`⚠️ WhatsApp pair rate limit hit for ${to}. Message not delivered.`);
        userMessageCounts.set(to, { count: PAIR_RATE_LIMIT + 1, resetAt: Date.now() + PAIR_RATE_WINDOW * 2 });
        return { skipped: true, reason: 'pair_rate_limit_api' };
      }
      logger.error('Error sending WhatsApp message:', this._sanitizeError(error));
      throw error;
    }
  }

  async sendImage(phoneNumber, imagePath, caption = '') {
    try {
      const rateCheck = this._checkPairRate(phoneNumber);
      if (!rateCheck.allowed) {
        logger.warn(`⚠️ Pair rate limit reached for ${phoneNumber}. Skipping image.`);
        return { skipped: true, reason: 'pair_rate_limit' };
      }

      // Step 1: Upload media to WhatsApp
      const mediaId = await this.uploadMedia(imagePath);

      // Step 2: Send image message with media ID
      const url = `${this.apiUrl}/${this.phoneNumberId}/messages`;
      
      const payload = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'image',
        image: {
          id: mediaId,
          caption: caption
        }
      };

      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      logger.info(`Image sent to ${phoneNumber}`);
      return response.data;

    } catch (error) {
      if (this._isPairRateLimit(error)) {
        logger.warn(`⚠️ WhatsApp pair rate limit hit for ${phoneNumber}. Image not delivered.`);
        return { skipped: true, reason: 'pair_rate_limit_api' };
      }
      logger.error('Error sending image:', this._sanitizeError(error));
      throw error;
    }
  }

  async uploadMedia(filepath) {
    try {
      const url = `${this.apiUrl}/${this.phoneNumberId}/media`;
      
      const formData = new FormData();
      formData.append('messaging_product', 'whatsapp');
      formData.append('file', fs.createReadStream(filepath), {
        filename: 'victory_card.png',
        contentType: 'image/png'
      });

      const response = await axios.post(url, formData, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          ...formData.getHeaders()
        }
      });

      logger.info(`Media uploaded: ${response.data.id}`);
      return response.data.id;

    } catch (error) {
      logger.error('Error uploading media:', this._sanitizeError(error));
      throw error;
    }
  }

  formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.startsWith('0')) {
      cleaned = '234' + cleaned.substring(1);
    }
    
    if (!cleaned.startsWith('234')) {
      cleaned = '234' + cleaned;
    }
    
    return cleaned;
  }

  async sendVideo(phoneNumber, videoBuffer, caption = '') {
    try {
      const rateCheck = this._checkPairRate(phoneNumber);
      if (!rateCheck.allowed) {
        logger.warn(`⚠️ Pair rate limit reached for ${phoneNumber}. Skipping video.`);
        return { skipped: true, reason: 'pair_rate_limit' };
      }

      // Step 1: Upload video to WhatsApp
      const mediaId = await this.uploadMediaBuffer(videoBuffer, 'video/mp4', 'video.mp4');
      
      // Step 2: Send video message with media ID
      const url = `${this.apiUrl}/${this.phoneNumberId}/messages`;
      
      const payload = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'video',
        video: {
          id: mediaId,
          caption: caption
        }
      };

      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      logger.info(`Video sent to ${phoneNumber}`);
      return response.data;

    } catch (error) {
      if (this._isPairRateLimit(error)) {
        logger.warn(`⚠️ WhatsApp pair rate limit hit for ${phoneNumber}. Video not delivered.`);
        return { skipped: true, reason: 'pair_rate_limit_api' };
      }
      logger.error('Error sending video:', this._sanitizeError(error));
      throw error;
    }
  }

  async sendAudio(phoneNumber, audioBuffer, mimeType = 'audio/ogg') {
    try {
      const rateCheck = this._checkPairRate(phoneNumber);
      if (!rateCheck.allowed) {
        logger.warn(`⚠️ Pair rate limit reached for ${phoneNumber}. Skipping audio.`);
        return { skipped: true, reason: 'pair_rate_limit' };
      }

      // Step 1: Upload audio to WhatsApp
      const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp3') ? 'mp3' : 'ogg';
      const mediaId = await this.uploadMediaBuffer(audioBuffer, mimeType, `audio.${ext}`);
      
      // Step 2: Send audio message with media ID
      const url = `${this.apiUrl}/${this.phoneNumberId}/messages`;
      
      const payload = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'audio',
        audio: {
          id: mediaId
        }
      };

      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      logger.info(`Audio sent to ${phoneNumber}`);
      return response.data;

    } catch (error) {
      if (this._isPairRateLimit(error)) {
        logger.warn(`⚠️ WhatsApp pair rate limit hit for ${phoneNumber}. Audio not delivered.`);
        return { skipped: true, reason: 'pair_rate_limit_api' };
      }
      logger.error('Error sending audio:', this._sanitizeError(error));
      throw error;
    }
  }

  async uploadMediaBuffer(buffer, mimeType, filename) {
    try {
      const url = `${this.apiUrl}/${this.phoneNumberId}/media`;
      
      const formData = new FormData();
      formData.append('messaging_product', 'whatsapp');
      formData.append('file', buffer, {
        filename: filename,
        contentType: mimeType
      });

      const response = await axios.post(url, formData, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          ...formData.getHeaders()
        }
      });

      logger.info(`Media uploaded: ${response.data.id}`);
      return response.data.id;

    } catch (error) {
      logger.error('Error uploading media buffer:', this._sanitizeError(error));
      throw error;
    }
  }
}

module.exports = WhatsAppService;