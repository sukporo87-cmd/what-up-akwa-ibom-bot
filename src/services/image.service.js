const { createCanvas, loadImage, registerFont } = require('canvas');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { logger } = require('../utils/logger');

class ImageService {
  constructor() {
    this.tempDir = path.join(__dirname, '../temp');
    this.ensureTempDir();
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
    
    // Generate PNG image based on prize type
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

    // CONFETTI PARTICLES - MORE (70 particles)
    this.drawConfetti(ctx, width, height, [
      '#FF6B6B', '#4ECDC4', '#FFD93D', '#95E1D3', 
      '#F38181', '#AA96DA', '#FCBAD3', '#FFFFD2', 
      '#A8E6CF', '#FFB3BA', '#C7CEEA', '#FFDAC1'
    ], 70);

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
    ctx.font = 'bold 24px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 5;
    ctx.fillText('Scan to Play!', width - qrPadding - qrBgSize/2, qrPadding + qrBgSize + 35);
    ctx.shadowBlur = 0;

    // TROPHY IMAGE - Large at top
    try {
      const trophyUrl = 'https://png.pngtree.com/png-clipart/20230401/original/pngtree-golden-trophy-3d-png-image_9015143.png';
      const trophyImage = await loadImage(trophyUrl);
      const trophySize = 220;
      const trophyX = width / 2 - trophySize / 2;
      const trophyY = 120;
      
      // Add shadow for trophy
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 20;
      ctx.shadowOffsetY = 10;
      ctx.drawImage(trophyImage, trophyX, trophyY, trophySize, trophySize);
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    } catch (error) {
      // Fallback to drawn trophy if image fails to load
      logger.warn('Trophy image failed to load, using drawn trophy');
      this.drawTrophy(ctx, width / 2, 230, 160, '#FFD700', false);
    }

    // "WINNER!!!" BADGE
    const winnerY = 350;
    ctx.fillStyle = 'white';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 15;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 4;
    this.roundRect(ctx, width/2 - 150, winnerY, 300, 60, 30);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.fillStyle = '#FF6B35';
    ctx.font = 'bold 36px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('WINNER!!!', width / 2, winnerY + 43);

    // NEW TEXT LAYOUT - LARGE AND BOLD
    let currentY = 480;
    
    // "I JUST WON"
    ctx.fillStyle = 'white';
    ctx.font = 'bold 72px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 8;
    ctx.fillText('I JUST WON', width / 2, currentY);
    currentY += 100;

    // AMOUNT - Even bigger
    ctx.font = 'bold 110px Arial, sans-serif';
    ctx.shadowBlur = 10;
    ctx.fillText(`₦${amount.toLocaleString()}`, width / 2, currentY);
    currentY += 100;

    // "ON"
    ctx.font = 'bold 68px Arial, sans-serif';
    ctx.shadowBlur = 8;
    ctx.fillText('ON', width / 2, currentY);
    currentY += 100;

    // "WHAT'S UP AKWA IBOM"
    ctx.font = 'bold 76px Arial, sans-serif';
    ctx.shadowBlur = 10;
    ctx.fillText("WHAT'S UP AKWA IBOM", width / 2, currentY);
    currentY += 85;

    // "THE ULTIMATE TRIVIA GAME"
    ctx.font = 'bold 52px Arial, sans-serif';
    ctx.shadowBlur = 8;
    ctx.fillText('THE ULTIMATE TRIVIA GAME', width / 2, currentY);
    ctx.shadowBlur = 0;
    currentY += 80;

    // Questions Correct
    ctx.font = 'bold 38px Arial, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillText(`${questionsAnswered}/${totalQuestions} Questions Correct`, width / 2, currentY);
    currentY += 70;

    // BOTTOM - Company Credit
    ctx.font = 'bold 32px Arial, sans-serif';
    ctx.fillStyle = 'white';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 6;
    ctx.fillText('SummerIsland Systems', width / 2, 1040);
    ctx.shadowBlur = 0;

    // Save to temp file as PNG
    const filename = `win_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
    const filepath = path.join(this.tempDir, filename);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(filepath, buffer);

    logger.info(`Regular win PNG generated: ${filename}`);
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

    // GOLD CONFETTI PARTICLES - MORE (60 particles)
    this.drawConfetti(ctx, width, height, [
      '#FFD700', '#FFA500', '#FFFF00', '#FFD700', 
      '#FFA500', '#FFFF00', '#FFD700', '#FFA500'
    ], 60, true);

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

    // "Scan & Win" text under QR
    ctx.fillStyle = '#FFD700';
    ctx.font = 'bold 24px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(255, 215, 0, 0.5)';
    ctx.shadowBlur = 10;
    ctx.fillText('Scan & Win!', width - qrPadding - qrSize/2, qrPadding + qrSize + 35);
    ctx.shadowBlur = 0;

    // GRAND PRIZE BANNER
    const bannerY = 120;
    const bannerGradient = ctx.createLinearGradient(width/2 - 350, bannerY, width/2 + 350, bannerY);
    bannerGradient.addColorStop(0, '#FFD700');
    bannerGradient.addColorStop(1, '#FFA500');
    ctx.fillStyle = bannerGradient;
    ctx.shadowColor = 'rgba(255, 215, 0, 0.7)';
    ctx.shadowBlur = 25;
    this.roundRect(ctx, width/2 - 380, bannerY, 760, 70, 35);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.fillStyle = '#1a1a2e';
    ctx.font = 'bold 38px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🌟 GRAND PRIZE WINNER!!! 🌟', width / 2, bannerY + 48);

    // MEGA TROPHY IMAGE - Grand Prize
    try {
      const trophyUrl = 'https://png.pngtree.com/png-clipart/20230401/original/pngtree-golden-trophy-3d-png-image_9015143.png';
      const trophyImage = await loadImage(trophyUrl);
      const trophySize = 260;
      const trophyX = width / 2 - trophySize / 2;
      const trophyY = 150;
      
      // Add golden glow for trophy
      ctx.shadowColor = 'rgba(255, 215, 0, 0.8)';
      ctx.shadowBlur = 40;
      ctx.shadowOffsetY = 0;
      ctx.drawImage(trophyImage, trophyX, trophyY, trophySize, trophySize);
      ctx.shadowBlur = 0;
    } catch (error) {
      // Fallback to drawn trophy if image fails to load
      logger.warn('Trophy image failed to load, using drawn trophy');
      this.drawTrophy(ctx, width / 2, 280, 200, '#FFD700', true);
    }

    // NEW TEXT LAYOUT - LARGE AND BOLD
    let currentY = 480;
    
    // "I JUST WON"
    ctx.fillStyle = '#FFD700';
    ctx.font = 'bold 72px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(255, 215, 0, 0.6)';
    ctx.shadowBlur = 15;
    ctx.fillText('I JUST WON', width / 2, currentY);
    currentY += 100;

    // AMOUNT - Even bigger with glow
    ctx.fillStyle = 'white';
    ctx.font = 'bold 120px Arial, sans-serif';
    ctx.shadowColor = 'rgba(255, 215, 0, 0.9)';
    ctx.shadowBlur = 20;
    ctx.fillText(`₦${amount.toLocaleString()}`, width / 2, currentY);
    currentY += 100;

    // "ON"
    ctx.fillStyle = '#FFD700';
    ctx.font = 'bold 68px Arial, sans-serif';
    ctx.shadowBlur = 15;
    ctx.fillText('ON', width / 2, currentY);
    currentY += 100;

    // "WHAT'S UP AKWA IBOM"
    ctx.fillStyle = 'white';
    ctx.font = 'bold 76px Arial, sans-serif';
    ctx.shadowColor = 'rgba(255, 215, 0, 0.7)';
    ctx.shadowBlur = 18;
    ctx.fillText("WHAT'S UP AKWA IBOM", width / 2, currentY);
    currentY += 85;

    // "THE ULTIMATE TRIVIA GAME"
    ctx.fillStyle = '#FFD700';
    ctx.font = 'bold 52px Arial, sans-serif';
    ctx.shadowBlur = 15;
    ctx.fillText('THE ULTIMATE TRIVIA GAME', width / 2, currentY);
    ctx.shadowBlur = 0;
    currentY += 80;

    // Questions Correct
    ctx.font = 'bold 40px Arial, sans-serif';
    ctx.fillStyle = 'white';
    ctx.shadowColor = 'rgba(255, 215, 0, 0.5)';
    ctx.shadowBlur = 10;
    ctx.fillText('15/15 PERFECT! ⭐', width / 2, currentY);
    ctx.shadowBlur = 0;

    // BOTTOM - Company Credit
    ctx.font = 'bold 34px Arial, sans-serif';
    ctx.fillStyle = '#FFD700';
    ctx.shadowColor = 'rgba(255, 215, 0, 0.6)';
    ctx.shadowBlur = 12;
    ctx.fillText('SummerIsland Systems', width / 2, 1040);
    ctx.shadowBlur = 0;

    // Save to temp file as PNG
    const filename = `grand_prize_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
    const filepath = path.join(this.tempDir, filename);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(filepath, buffer);

    logger.info(`Grand prize PNG generated: ${filename}`);
    return filepath;
  }

  drawConfetti(ctx, width, height, colors, count = 50, isGold = false) {
    for (let i = 0; i < count; i++) {
      ctx.save();
      
      const x = Math.random() * width;
      const y = Math.random() * height;
      const size = isGold ? (Math.random() * 12 + 8) : (Math.random() * 14 + 6);
      const rotation = Math.random() * Math.PI * 2;
      const color = colors[Math.floor(Math.random() * colors.length)];
      
      ctx.translate(x, y);
      ctx.rotate(rotation);
      
      ctx.fillStyle = color;
      
      if (isGold) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
      }
      
      // Draw different confetti shapes
      const shape = Math.random();
      if (shape > 0.66) {
        // Circle
        ctx.beginPath();
        ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (shape > 0.33) {
        // Rectangle
        ctx.fillRect(-size / 2, -size / 2, size, size * 1.5);
      } else {
        // Triangle
        ctx.beginPath();
        ctx.moveTo(0, -size / 2);
        ctx.lineTo(size / 2, size / 2);
        ctx.lineTo(-size / 2, size / 2);
        ctx.closePath();
        ctx.fill();
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