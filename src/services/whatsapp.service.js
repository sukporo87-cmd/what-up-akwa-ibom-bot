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
      // Detect file type
      const isGif = imagePath.toLowerCase().endsWith('.gif');
      
      if (isGif) {
        logger.info('Detected GIF file, will be auto-converted to video by WhatsApp');
      }

      // Step 1: Upload media to WhatsApp (works for both PNG and GIF)
      // WhatsApp Cloud API automatically converts GIF to MP4 video
      const mediaId = await this.uploadMedia(imagePath, isGif);

      // Step 2: Send message with media ID
      // For GIF (converted to video), use 'video' type instead of 'image'
      const url = `${this.apiUrl}/${this.phoneNumberId}/messages`;
      
      const payload = isGif ? {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'video',
        video: {
          id: mediaId,
          caption: caption
        }
      } : {
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

      logger.info(`${isGif ? 'Video (from GIF)' : 'Image'} sent to ${phoneNumber}`);
      return response.data;

    } catch (error) {
      logger.error('Error sending image:', error.response?.data || error.message);
      throw error;
    }
  }

  async uploadMedia(filepath, isGif = false) {
    try {
      const url = `${this.apiUrl}/${this.phoneNumberId}/media`;
      
      // Check file size
      const stats = fs.statSync(filepath);
      const fileSizeMB = stats.size / (1024 * 1024);
      logger.info(`Uploading file: ${fileSizeMB.toFixed(2)}MB`);
      
      if (fileSizeMB > 16) {
        throw new Error(`File too large: ${fileSizeMB.toFixed(2)}MB (max 16MB)`);
      }
      
      // Determine correct MIME type and filename
      const mimeType = isGif ? 'image/gif' : 'image/png';
      const filename = isGif ? 'victory_animation.gif' : 'victory_card.png';
      
      const formData = new FormData();
      formData.append('messaging_product', 'whatsapp');
      formData.append('file', fs.createReadStream(filepath), {
        filename: filename,
        contentType: mimeType
      });

      const response = await axios.post(url, formData, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 60000 // 60 second timeout
      });

      logger.info(`Media uploaded: ${response.data.id} (${isGif ? 'GIF->Video' : 'PNG'})`);
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
}

module.exports = WhatsAppService;