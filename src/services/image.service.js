const { createCanvas, loadImage, registerFont } = require('canvas');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { logger } = require('../utils/logger');

class ImageService {
  constructor() {
    this.tempDir = path.join(__dirname, '../temp');
    this.ensureTempDir();
    
    // Register fonts if available (optional - will use default if not found)
    try {
      const fontsDir = path.join(__dirname, '../assets/fonts');
      if (fs.existsSync(fontsDir)) {
        registerFont(path.join(fontsDir, 'Arial-Bold.ttf'), { family: 'Arial', weight: 'bold' });
      }
    } catch (error) {
      logger.warn('Custom fonts not loaded, using system fonts');
    }
  }

  ensureTempDir() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async generateWinImage(winData) {
    const { name, lga, amount, questionsAnswered, totalQuestions } = winData;
    
    // Determine if this is a GRAND PRIZE (15/15 correct)
    const isGrandPrize = questionsAnswered === totalQuestions && totalQuestions === 15;
    
    // Generate image based on prize type
    if (isGrandPrize) {
      return await this.generateGrandPrizeImage(winData);
    } else {
      return await this.generateRegularWinImage(winData);
    }
  }

  async generateRegularWinImage(winData) {
    const { name, lga, amount, questionsAnswered, totalQuestions } = winData;
    
    // Create canvas - 1080x1080 (perfect for WhatsApp)
    const width = 1080;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // BACKGROUND - Orange-Yellow Gradient
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#FF6B35');
    gradient.addColorStop(0.5, '#F7931E');
    gradient.addColorStop(1, '#FFD23F');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // CONFETTI PARTICLES
    this.drawConfetti(ctx, width, height, [
      '#FF6B6B', '#4ECDC4', '#FFD93D', '#95E1D3', 
      '#F38181', '#AA96DA', '#FCBAD3', '#FFFFD2', 
      '#A8E6CF', '#FFB3BA'
    ]);

    // QR CODE - Top Right Corner
    const qrSize = 180;
    const qrPadding = 40;
    const whatsappLink = `https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}`;
    const qrDataUrl = await QRCode.toDataURL(whatsappLink, {
      width: qrSize,
      margin: 1,
      color: {
        dark: '#FF6B35',
        light: '#FFFFFF'
      }
    });
    const qrImage = await loadImage(qrDataUrl);
    
    // QR Code with white background
    ctx.fillStyle = 'white';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 5;
    const qrBgSize = qrSize + 20;
    ctx.fillRect(width - qrBgSize - qrPadding, qrPadding, qrBgSize, qrBgSize);
    ctx.shadowBlur = 0;
    
    ctx.drawImage(qrImage, width - qrSize - qrPadding - 10, qrPadding + 10, qrSize, qrSize);

    // "Scan to Play" text under QR
    ctx.fillStyle = 'white';
    ctx.font = 'bold 22px Arial';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 5;
    ctx.fillText('Scan to Play!', width - qrPadding - qrBgSize/2, qrPadding + qrBgSize + 35);
    ctx.shadowBlur = 0;

    // TROPHY EMOJI
    ctx.font = '140px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('🏆', width / 2, 380);

    // WINNER BADGE
    const badgeY = 450;
    ctx.fillStyle = 'white';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
    ctx.shadowBlur = 15;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 4;
    this.roundRect(ctx, width/2 - 120, badgeY, 240, 50, 25);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.fillStyle = '#FF6B35';
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('WINNER!', width / 2, badgeY + 35);

    // AMOUNT
    ctx.fillStyle = 'white';
    ctx.font = 'bold 96px Arial';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 6;
    ctx.fillText(`₦${amount.toLocaleString()}`, width / 2, 600);
    ctx.shadowBlur = 0;

    // PLAYER NAME
    ctx.font = 'bold 48px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.fillText(this.truncateText(ctx, name, width - 200), width / 2, 690);

    // LOCATION
    ctx.font = '32px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillText(lga, width / 2, 740);

    // STATS BOX
    const statsY = 800;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
    ctx.shadowBlur = 10;
    this.roundRect(ctx, width/2 - 200, statsY, 400, 70, 15);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.fillText(`${questionsAnswered}/${totalQuestions} Questions Correct`, width / 2, statsY + 45);

    // FOOTER - Game Branding
    ctx.font = 'bold 26px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.fillText("What's Up Akwa Ibom", width / 2, 950);
    
    ctx.font = '20px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillText('The Ultimate Trivia Game', width / 2, 985);

    // GOVERNMENT CREDIT
    ctx.font = 'italic 18px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText('Akwa Ibom State Government', width / 2, 1040);

    // Save to temp file
    const filename = `win_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
    const filepath = path.join(this.tempDir, filename);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(filepath, buffer);

    return filepath;
  }

  async generateGrandPrizeImage(winData) {
    const { name, lga, amount, questionsAnswered, totalQuestions } = winData;
    
    // Create canvas - 1080x1080
    const width = 1080;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // BACKGROUND - Dark dramatic
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, width, height);

    // SUBTLE PATTERN OVERLAY
    this.drawPatternOverlay(ctx, width, height);

    // GOLD CONFETTI PARTICLES
    this.drawConfetti(ctx, width, height, [
      '#FFD700', '#FFA500', '#FFFF00', '#FFD700', 
      '#FFA500', '#FFFF00', '#FFD700', '#FFA500'
    ], true); // Gold theme

    // QR CODE - Top Right Corner (Gold theme)
    const qrSize = 180;
    const qrPadding = 40;
    const whatsappLink = `https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}`;
    const qrDataUrl = await QRCode.toDataURL(whatsappLink, {
      width: qrSize,
      margin: 1,
      color: {
        dark: '#1a1a2e',
        light: '#FFD700'
      }
    });
    const qrImage = await loadImage(qrDataUrl);
    
    // QR Code with gold glow
    const qrGradient = ctx.createRadialGradient(
      width - qrPadding - qrSize/2, 
      qrPadding + qrSize/2, 
      0,
      width - qrPadding - qrSize/2, 
      qrPadding + qrSize/2, 
      qrSize
    );
    qrGradient.addColorStop(0, 'rgba(255, 215, 0, 0.3)');
    qrGradient.addColorStop(1, 'rgba(255, 215, 0, 0)');
    ctx.fillStyle = qrGradient;
    ctx.fillRect(width - qrSize - qrPadding - 30, qrPadding - 30, qrSize + 60, qrSize + 60);
    
    ctx.drawImage(qrImage, width - qrSize - qrPadding, qrPadding, qrSize, qrSize);

    // "Scan to Play" text under QR
    ctx.fillStyle = '#FFD700';
    ctx.font = 'bold 22px Arial';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(255, 215, 0, 0.5)';
    ctx.shadowBlur = 10;
    ctx.fillText('Scan & Win!', width - qrPadding - qrSize/2, qrPadding + qrSize + 35);
    ctx.shadowBlur = 0;

    // GRAND PRIZE BANNER
    const bannerY = 150;
    const bannerGradient = ctx.createLinearGradient(width/2 - 300, bannerY, width/2 + 300, bannerY);
    bannerGradient.addColorStop(0, '#FFD700');
    bannerGradient.addColorStop(1, '#FFA500');
    ctx.fillStyle = bannerGradient;
    ctx.shadowColor = 'rgba(255, 215, 0, 0.6)';
    ctx.shadowBlur = 20;
    this.roundRect(ctx, width/2 - 300, bannerY, 600, 60, 30);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.fillStyle = '#1a1a2e';
    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('🌟 GRAND PRIZE WINNER! 🌟', width / 2, bannerY + 42);

    // MEGA TROPHY
    ctx.font = '200px Arial';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(255, 215, 0, 0.7)';
    ctx.shadowBlur = 30;
    ctx.fillText('🏆', width / 2, 430);
    ctx.shadowBlur = 0;

    // AMOUNT DISPLAY
    ctx.fillStyle = '#FFD700';
    ctx.font = 'bold 72px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('₦', width / 2, 560);
    
    ctx.fillStyle = 'white';
    ctx.font = 'bold 120px Arial';
    ctx.shadowColor = 'rgba(255, 215, 0, 0.8)';
    ctx.shadowBlur = 30;
    ctx.fillText(amount.toLocaleString(), width / 2, 680);
    ctx.shadowBlur = 0;

    // WINNER CARD
    const cardY = 720;
    const cardHeight = 220;
    
    // Card background with gold border
    const cardGradient = ctx.createLinearGradient(0, cardY, 0, cardY + cardHeight);
    cardGradient.addColorStop(0, 'rgba(255, 215, 0, 0.15)');
    cardGradient.addColorStop(1, 'rgba(255, 165, 0, 0.15)');
    ctx.fillStyle = cardGradient;
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.4)';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(255, 215, 0, 0.2)';
    ctx.shadowBlur = 20;
    this.roundRect(ctx, width/2 - 400, cardY, 800, cardHeight, 15);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // PLAYER NAME
    ctx.font = 'bold 52px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.fillText(this.truncateText(ctx, name, 750), width / 2, cardY + 65);

    // LOCATION
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = '#FFD700';
    ctx.fillText(lga, width / 2, cardY + 115);

    // ACHIEVEMENT BADGE
    const achievementGradient = ctx.createLinearGradient(width/2 - 150, cardY + 140, width/2 + 150, cardY + 140);
    achievementGradient.addColorStop(0, 'rgba(255, 215, 0, 0.3)');
    achievementGradient.addColorStop(1, 'rgba(255, 165, 0, 0.3)');
    ctx.fillStyle = achievementGradient;
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.5)';
    ctx.lineWidth = 2;
    this.roundRect(ctx, width/2 - 150, cardY + 145, 300, 50, 25);
    ctx.fill();
    ctx.stroke();
    
    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = '#FFD700';
    ctx.textAlign = 'center';
    ctx.fillText('15/15 PERFECT! ⭐', width / 2, cardY + 180);

    // FOOTER - Game Branding
    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.fillText("What's Up Akwa Ibom", width / 2, 1000);
    
    ctx.font = '22px Arial';
    ctx.fillStyle = '#FFD700';
    ctx.fillText('The Ultimate Trivia Game', width / 2, 1035);

    // Save to temp file
    const filename = `grand_prize_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
    const filepath = path.join(this.tempDir, filename);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(filepath, buffer);

    return filepath;
  }

  drawConfetti(ctx, width, height, colors, isGold = false) {
    const confettiCount = isGold ? 35 : 40;
    
    for (let i = 0; i < confettiCount; i++) {
      ctx.save();
      
      const x = Math.random() * width;
      const y = Math.random() * height;
      const size = isGold ? (Math.random() * 8 + 6) : (Math.random() * 10 + 5);
      const rotation = Math.random() * Math.PI * 2;
      const color = colors[Math.floor(Math.random() * colors.length)];
      
      ctx.translate(x, y);
      ctx.rotate(rotation);
      
      // Draw confetti particle
      if (Math.random() > 0.5) {
        // Circle
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Rectangle
        ctx.fillStyle = color;
        ctx.fillRect(-size / 2, -size / 2, size, size * 1.5);
      }
      
      // Add glow for gold confetti
      if (isGold) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
      }
      
      ctx.restore();
    }
  }

  drawPatternOverlay(ctx, width, height) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.03)';
    ctx.lineWidth = 1;
    
    const spacing = 20;
    for (let i = 0; i < width + height; i += spacing) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(0, i);
      ctx.stroke();
    }
    
    ctx.restore();
  }

  roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  truncateText(ctx, text, maxWidth) {
    let width = ctx.measureText(text).width;
    if (width <= maxWidth) return text;
    
    while (width > maxWidth && text.length > 0) {
      text = text.slice(0, -1);
      width = ctx.measureText(text + '...').width;
    }
    return text + '...';
  }

  cleanupTempFiles() {
    try {
      const files = fs.readdirSync(this.tempDir);
      const now = Date.now();
      const maxAge = 3600000; // 1 hour
      
      files.forEach(file => {
        const filepath = path.join(this.tempDir, file);
        const stats = fs.statSync(filepath);
        const age = now - stats.mtimeMs;
        
        if (age > maxAge) {
          fs.unlinkSync(filepath);
          logger.info(`Cleaned up old temp file: ${file}`);
        }
      });
    } catch (error) {
      logger.error('Error cleaning up temp files:', error);
    }
  }
}

module.exports = ImageService;