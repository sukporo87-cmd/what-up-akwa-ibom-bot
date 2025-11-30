const { createCanvas, loadImage } = require('canvas');
const GIFEncoder = require('gif-encoder-2');
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
    
    // Generate animated GIF based on prize type
    if (isGrandPrize) {
      return await this.generateGrandPrizeGif(winData);
    } else {
      return await this.generateRegularWinGif(winData);
    }
  }

  async generateRegularWinGif(winData) {
    const { name, lga, amount, questionsAnswered, totalQuestions } = winData;
    
    const width = 1080;
    const height = 1080;
    const frames = 30; // 30 frames for smooth animation
    
    // Create GIF encoder
    const encoder = new GIFEncoder(width, height);
    const filename = `win_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.gif`;
    const filepath = path.join(this.tempDir, filename);
    
    encoder.createReadStream().pipe(fs.createWriteStream(filepath));
    encoder.start();
    encoder.setRepeat(0); // Loop forever
    encoder.setDelay(100); // 100ms between frames = ~10fps
    encoder.setQuality(10); // 10 is best quality
    
    // Generate QR code once
    const whatsappLink = `https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}`;
    const qrDataUrl = await QRCode.toDataURL(whatsappLink, {
      width: 180,
      margin: 1,
      color: {
        dark: '#FF6B35',
        light: '#FFFFFF'
      }
    });
    const qrImage = await loadImage(qrDataUrl);
    
    // Initialize confetti particles
    const confettiParticles = this.initConfetti(40, width, height, [
      '#FF6B6B', '#4ECDC4', '#FFD93D', '#95E1D3', 
      '#F38181', '#AA96DA', '#FCBAD3', '#FFFFD2', 
      '#A8E6CF', '#FFB3BA'
    ]);
    
    // Generate frames
    for (let frame = 0; frame < frames; frame++) {
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      
      // BACKGROUND - Orange-Yellow Gradient
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#FF6B35');
      gradient.addColorStop(0.5, '#F7931E');
      gradient.addColorStop(1, '#FFD23F');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      
      // ANIMATED CONFETTI
      this.drawAnimatedConfetti(ctx, confettiParticles, frame, frames, height);
      
      // QR CODE - Top Right
      const qrSize = 180;
      const qrPadding = 40;
      ctx.fillStyle = 'white';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 20;
      const qrBgSize = qrSize + 20;
      ctx.fillRect(width - qrBgSize - qrPadding, qrPadding, qrBgSize, qrBgSize);
      ctx.shadowBlur = 0;
      ctx.drawImage(qrImage, width - qrSize - qrPadding - 10, qrPadding + 10, qrSize, qrSize);
      
      ctx.fillStyle = 'white';
      ctx.font = 'bold 24px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 5;
      ctx.fillText('Scan to Play!', width - qrPadding - qrBgSize/2, qrPadding + qrBgSize + 35);
      ctx.shadowBlur = 0;
      
      // BOUNCING TROPHY
      const bounceOffset = Math.sin((frame / frames) * Math.PI * 4) * 15;
      this.drawTrophy(ctx, width / 2, 330 + bounceOffset, 140, '#FFD700');
      
      // WINNER BADGE
      const badgeY = 480;
      ctx.fillStyle = 'white';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
      ctx.shadowBlur = 15;
      this.roundRect(ctx, width/2 - 120, badgeY, 240, 50, 25);
      ctx.fill();
      ctx.shadowBlur = 0;
      
      ctx.fillStyle = '#FF6B35';
      ctx.font = 'bold 28px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('WINNER!', width / 2, badgeY + 35);
      
      // AMOUNT
      ctx.fillStyle = 'white';
      ctx.font = 'bold 96px Arial, sans-serif';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 6;
      ctx.fillText(`₦${amount.toLocaleString()}`, width / 2, 630);
      ctx.shadowBlur = 0;
      
      // MESSAGE - "I just won"
      ctx.font = 'bold 42px Arial, sans-serif';
      ctx.fillStyle = 'white';
      ctx.fillText('I just won', width / 2, 710);
      
      // PLAYER NAME
      ctx.font = 'bold 38px Arial, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.fillText(this.truncateText(ctx, name, width - 200), width / 2, 770);
      
      // LOCATION
      ctx.font = '32px Arial, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillText(lga, width / 2, 820);
      
      // STATS BOX
      const statsY = 870;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
      ctx.shadowBlur = 10;
      this.roundRect(ctx, width/2 - 220, statsY, 440, 70, 15);
      ctx.fill();
      ctx.shadowBlur = 0;
      
      ctx.font = 'bold 32px Arial, sans-serif';
      ctx.fillStyle = 'white';
      ctx.fillText(`${questionsAnswered}/${totalQuestions} Questions Correct`, width / 2, statsY + 45);
      
      // GAME BRANDING
      ctx.font = 'bold 48px Arial, sans-serif';
      ctx.fillStyle = 'white';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
      ctx.shadowBlur = 8;
      ctx.fillText("What's Up Akwa Ibom", width / 2, 990);
      
      ctx.font = 'bold 28px Arial, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.fillText('The Ultimate Trivia Game', width / 2, 1030);
      ctx.shadowBlur = 0;
      
      // GOVERNMENT CREDIT
      ctx.font = 'italic 20px Arial, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillText('Akwa Ibom State Government', width / 2, 1065);
      
      // Add frame to GIF
      encoder.addFrame(ctx);
    }
    
    encoder.finish();
    logger.info(`Regular win GIF generated: ${filename}`);
    
    return filepath;
  }

  async generateGrandPrizeGif(winData) {
    const { name, lga, amount, questionsAnswered, totalQuestions } = winData;
    
    const width = 1080;
    const height = 1080;
    const frames = 30;
    
    // Create GIF encoder
    const encoder = new GIFEncoder(width, height);
    const filename = `grand_prize_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.gif`;
    const filepath = path.join(this.tempDir, filename);
    
    encoder.createReadStream().pipe(fs.createWriteStream(filepath));
    encoder.start();
    encoder.setRepeat(0);
    encoder.setDelay(100);
    encoder.setQuality(10);
    
    // Generate QR code
    const whatsappLink = `https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}`;
    const qrDataUrl = await QRCode.toDataURL(whatsappLink, {
      width: 180,
      margin: 1,
      color: {
        dark: '#1a1a2e',
        light: '#FFD700'
      }
    });
    const qrImage = await loadImage(qrDataUrl);
    
    // Initialize GOLD confetti
    const confettiParticles = this.initConfetti(35, width, height, [
      '#FFD700', '#FFA500', '#FFFF00'
    ], true);
    
    // Generate frames
    for (let frame = 0; frame < frames; frame++) {
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      
      // BACKGROUND - Dark
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, width, height);
      
      // PATTERN OVERLAY
      this.drawPatternOverlay(ctx, width, height);
      
      // ANIMATED GOLD CONFETTI
      this.drawAnimatedConfetti(ctx, confettiParticles, frame, frames, height, true);
      
      // QR CODE with glow
      const qrSize = 180;
      const qrPadding = 40;
      const qrGradient = ctx.createRadialGradient(
        width - qrPadding - qrSize/2, qrPadding + qrSize/2, 0,
        width - qrPadding - qrSize/2, qrPadding + qrSize/2, qrSize
      );
      qrGradient.addColorStop(0, 'rgba(255, 215, 0, 0.3)');
      qrGradient.addColorStop(1, 'rgba(255, 215, 0, 0)');
      ctx.fillStyle = qrGradient;
      ctx.fillRect(width - qrSize - qrPadding - 30, qrPadding - 30, qrSize + 60, qrSize + 60);
      
      ctx.drawImage(qrImage, width - qrSize - qrPadding, qrPadding, qrSize, qrSize);
      
      ctx.fillStyle = '#FFD700';
      ctx.font = 'bold 24px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(255, 215, 0, 0.5)';
      ctx.shadowBlur = 10;
      ctx.fillText('Scan & Win!', width - qrPadding - qrSize/2, qrPadding + qrSize + 35);
      ctx.shadowBlur = 0;
      
      // ANIMATED GLOWING BANNER
      const bannerY = 150;
      const glowIntensity = 0.6 + Math.sin((frame / frames) * Math.PI * 4) * 0.3;
      const bannerGradient = ctx.createLinearGradient(width/2 - 300, bannerY, width/2 + 300, bannerY);
      bannerGradient.addColorStop(0, '#FFD700');
      bannerGradient.addColorStop(1, '#FFA500');
      ctx.fillStyle = bannerGradient;
      ctx.shadowColor = `rgba(255, 215, 0, ${glowIntensity})`;
      ctx.shadowBlur = 25;
      this.roundRect(ctx, width/2 - 340, bannerY, 680, 65, 32);
      ctx.fill();
      ctx.shadowBlur = 0;
      
      ctx.fillStyle = '#1a1a2e';
      ctx.font = 'bold 34px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🌟 GRAND PRIZE WINNER! 🌟', width / 2, bannerY + 44);
      
      // PULSING TROPHY
      const pulseScale = 1 + Math.sin((frame / frames) * Math.PI * 4) * 0.1;
      const trophySize = 180 * pulseScale;
      this.drawTrophy(ctx, width / 2, 370, trophySize, '#FFD700', true);
      
      // AMOUNT
      ctx.fillStyle = '#FFD700';
      ctx.font = 'bold 72px Arial, sans-serif';
      ctx.fillText('₦', width / 2, 580);
      
      ctx.fillStyle = 'white';
      ctx.font = 'bold 120px Arial, sans-serif';
      ctx.shadowColor = 'rgba(255, 215, 0, 0.8)';
      ctx.shadowBlur = 30;
      ctx.fillText(amount.toLocaleString(), width / 2, 700);
      ctx.shadowBlur = 0;
      
      // MESSAGE
      ctx.font = 'bold 44px Arial, sans-serif';
      ctx.fillStyle = '#FFD700';
      ctx.fillText('I just won', width / 2, 770);
      
      // WINNER CARD
      const cardY = 810;
      const cardHeight = 160;
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
      ctx.font = 'bold 42px Arial, sans-serif';
      ctx.fillStyle = 'white';
      ctx.fillText(this.truncateText(ctx, name, 750), width / 2, cardY + 55);
      
      // LOCATION
      ctx.font = 'bold 30px Arial, sans-serif';
      ctx.fillStyle = '#FFD700';
      ctx.fillText(lga, width / 2, cardY + 100);
      
      // ACHIEVEMENT
      ctx.font = 'bold 26px Arial, sans-serif';
      ctx.fillText('15/15 PERFECT! ⭐', width / 2, cardY + 140);
      
      // GAME BRANDING
      ctx.font = 'bold 50px Arial, sans-serif';
      ctx.fillStyle = 'white';
      ctx.shadowColor = 'rgba(255, 215, 0, 0.5)';
      ctx.shadowBlur = 15;
      ctx.fillText("What's Up Akwa Ibom", width / 2, 1020);
      
      ctx.font = 'bold 28px Arial, sans-serif';
      ctx.fillStyle = '#FFD700';
      ctx.fillText('The Ultimate Trivia Game', width / 2, 1060);
      ctx.shadowBlur = 0;
      
      encoder.addFrame(ctx);
    }
    
    encoder.finish();
    logger.info(`Grand prize GIF generated: ${filename}`);
    
    return filepath;
  }

  initConfetti(count, width, height, colors, isGold = false) {
    const particles = [];
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height - height, // Start above screen
        size: isGold ? (Math.random() * 8 + 6) : (Math.random() * 10 + 5),
        speed: Math.random() * 3 + 2,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.2,
        color: colors[Math.floor(Math.random() * colors.length)],
        shape: Math.random() > 0.5 ? 'circle' : 'rect'
      });
    }
    return particles;
  }

  drawAnimatedConfetti(ctx, particles, frame, totalFrames, height, isGold = false) {
    particles.forEach(particle => {
      ctx.save();
      
      // Update position
      const progress = (frame / totalFrames);
      const y = particle.y + (particle.speed * height * progress * 2);
      const x = particle.x + Math.sin(progress * Math.PI * 4) * 20;
      
      // Wrap around
      const wrappedY = y % (height + 100);
      
      ctx.translate(x, wrappedY);
      ctx.rotate(particle.rotation + progress * Math.PI * 4);
      
      ctx.fillStyle = particle.color;
      
      if (isGold) {
        ctx.shadowColor = particle.color;
        ctx.shadowBlur = 10;
      }
      
      if (particle.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, particle.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * 1.5);
      }
      
      ctx.restore();
    });
  }

  drawTrophy(ctx, x, y, size, color, hasGlow = false) {
    ctx.save();
    
    if (hasGlow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 40;
    }
    
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, size * 0.5, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillRect(x - size * 0.3, y + size * 0.4, size * 0.6, size * 0.2);
    
    ctx.beginPath();
    ctx.arc(x - size * 0.55, y, size * 0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + size * 0.55, y, size * 0.25, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.beginPath();
    ctx.arc(x - size * 0.2, y - size * 0.2, size * 0.2, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore();
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
      const maxAge = 3600000;
      
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