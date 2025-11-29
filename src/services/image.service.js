// src/services/image.service.js
const { createCanvas, loadImage, registerFont } = require('canvas');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

class ImageService {
  async generateWinImage(userData) {
    try {
      const { name, lga, amount, questionsAnswered, totalQuestions } = userData;
      
      // Create canvas (1080x1080 for Instagram-friendly size)
      const width = 1080;
      const height = 1080;
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');

      // Background gradient (Akwa Ibom orange theme)
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, '#FF6B35'); // Akwa Ibom orange
      gradient.addColorStop(1, '#FF8C42');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      // Add decorative circles
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.beginPath();
      ctx.arc(200, 200, 300, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(900, 900, 250, 0, Math.PI * 2);
      ctx.fill();

      // White rounded rectangle card
      const cardX = 80;
      const cardY = 200;
      const cardWidth = width - 160;
      const cardHeight = 680;
      const cornerRadius = 30;

      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.moveTo(cardX + cornerRadius, cardY);
      ctx.lineTo(cardX + cardWidth - cornerRadius, cardY);
      ctx.quadraticCurveTo(cardX + cardWidth, cardY, cardX + cardWidth, cardY + cornerRadius);
      ctx.lineTo(cardX + cardWidth, cardY + cardHeight - cornerRadius);
      ctx.quadraticCurveTo(cardX + cardWidth, cardY + cardHeight, cardX + cardWidth - cornerRadius, cardY + cardHeight);
      ctx.lineTo(cardX + cornerRadius, cardY + cardHeight);
      ctx.quadraticCurveTo(cardX, cardY + cardHeight, cardX, cardY + cardHeight - cornerRadius);
      ctx.lineTo(cardX, cardY + cornerRadius);
      ctx.quadraticCurveTo(cardX, cardY, cardX + cornerRadius, cardY);
      ctx.closePath();
      ctx.fill();

      // Trophy emoji/icon at top
      ctx.font = 'bold 120px Arial';
      ctx.fillText('🏆', width / 2 - 60, 350);

      // Main heading
      ctx.fillStyle = '#FF6B35';
      ctx.font = 'bold 60px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('I WON!', width / 2, 470);

      // Amount won
      ctx.fillStyle = '#2C3E50';
      ctx.font = 'bold 80px Arial';
      ctx.fillText(`₦${amount.toLocaleString()}`, width / 2, 570);

      // Player details
      ctx.font = '40px Arial';
      ctx.fillStyle = '#555555';
      ctx.fillText(name, width / 2, 650);
      
      ctx.font = '32px Arial';
      ctx.fillStyle = '#888888';
      ctx.fillText(`from ${lga}`, width / 2, 700);

      // Score details
      ctx.font = '36px Arial';
      ctx.fillStyle = '#34495E';
      ctx.fillText(`${questionsAnswered}/${totalQuestions} Questions Correct`, width / 2, 770);

      // Game branding
      ctx.font = 'bold 32px Arial';
      ctx.fillStyle = '#FF6B35';
      ctx.fillText('What\'s Up Akwa Ibom', width / 2, 830);

      // Tagline
      ctx.font = '24px Arial';
      ctx.fillStyle = '#999999';
      ctx.fillText('The Ultimate Trivia Game', width / 2, 865);

      // Generate QR code for joining
      const qrDataUrl = await QRCode.toDataURL(`https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}`, {
        width: 150,
        margin: 1,
        color: {
          dark: '#FF6B35',
          light: '#FFFFFF'
        }
      });

      const qrImage = await loadImage(qrDataUrl);
      ctx.drawImage(qrImage, width / 2 - 75, 270, 150, 150);

      // Call to action
      ctx.font = 'bold 28px Arial';
      ctx.fillStyle = '#2C3E50';
      ctx.fillText('Scan to Play & Win!', width / 2, 450);

      // Convert to buffer
      const buffer = canvas.toBuffer('image/png');
      
      // Save temporarily
      const tempDir = path.join(__dirname, '../../temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const filename = `win_${Date.now()}.png`;
      const filepath = path.join(tempDir, filename);
      fs.writeFileSync(filepath, buffer);

      logger.info(`Win image generated: ${filename}`);
      
      return filepath;

    } catch (error) {
      logger.error('Error generating win image:', error);
      throw error;
    }
  }

  // Clean up temp files older than 1 hour
  cleanupTempFiles() {
    try {
      const tempDir = path.join(__dirname, '../../temp');
      if (!fs.existsSync(tempDir)) return;

      const files = fs.readdirSync(tempDir);
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      files.forEach(file => {
        const filepath = path.join(tempDir, file);
        const stats = fs.statSync(filepath);
        
        if (now - stats.mtimeMs > oneHour) {
          fs.unlinkSync(filepath);
          logger.info(`Cleaned up old temp file: ${file}`);
        }
      });
    } catch (error) {
      logger.error('Error cleaning temp files:', error);
    }
  }
}

module.exports = ImageService;