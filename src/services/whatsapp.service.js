const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { logger } = require('../utils/logger');

class WhatsAppService {
  constructor() {
    this.apiUrl = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v18.0';
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
  }

  async sendMessage(to, text) {
    try {
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
      logger.error('Error sending WhatsApp message:', error.response?.data || error.message);
      throw error;
    }
  }

  async sendImage(phoneNumber, imagePath, caption = '') {
    try {
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
      logger.error('Error sending image:', error.response?.data || error.message);
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
      logger.error('Error uploading media:', error.response?.data || error.message);
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
      logger.error('Error sending video:', error.response?.data || error.message);
      throw error;
    }
  }

  async sendAudio(phoneNumber, audioBuffer, mimeType = 'audio/ogg') {
    try {
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
      logger.error('Error sending audio:', error.response?.data || error.message);
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
      logger.error('Error uploading media buffer:', error.response?.data || error.message);
      throw error;
    }
  }
}

module.exports = WhatsAppService;