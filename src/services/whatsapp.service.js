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
      logger.error('Error sending image:', error);
      throw error;
    }
  }

  async uploadMedia(filepath) {
    try {
      const url = `${this.apiUrl}/${this.phoneNumberId}/media`;
      
      const formData = new FormData();
      formData.append('messaging_product', 'whatsapp');
      formData.append('file', fs.createReadStream(filepath), {
        filename: 'win_image.png',
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
      logger.error('Error uploading media:', error);
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
}

module.exports = WhatsAppService;