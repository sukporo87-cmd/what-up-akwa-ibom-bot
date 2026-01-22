// ============================================
// FILE: src/services/image.service.js
// BACKWARD COMPATIBLE: Works with existing code!
// Auto-detects platform from winData
// ============================================

const { createCanvas, loadImage } = require('canvas');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { logger } = require('../utils/logger');

// Optional: Only needed for Telegram GIF support
let GIFEncoder;
try {
  GIFEncoder = require('gifencoder');
} catch (e) {
  logger.warn('GIFEncoder not installed - Telegram animations disabled. Install with: npm install gifencoder');
}

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

  /**
   * BACKWARD COMPATIBLE: Auto-detects platform and returns appropriate format
   * @param {Object} winData - { username, city, amount, questionsAnswered, totalQuestions, platform? }
   * @returns {String|Object} - Filepath (for WhatsApp) OR { filepath, type, caption } (for Telegram)
   */
  async generateWinImage(winData) {
    const { username, city, amount, questionsAnswered, totalQuestions } = winData;
    
    // Auto-detect platform from winData or default to WhatsApp
    const platform = winData.platform || 'whatsapp';
    const isGrandPrize = questionsAnswered === totalQuestions && totalQuestions === 15;

    // TELEGRAM: Return animated GIF (if available)
    if (platform === 'telegram' && GIFEncoder) {
      try {
        const filepath = await this.generateTelegramAnimatedGif(winData, isGrandPrize);
        const caption = this.generateTelegramCaption(winData, isGrandPrize);
        
        // Return object for Telegram
        return { filepath, type: 'gif', caption, platform: 'telegram' };
      } catch (error) {
        logger.error('Failed to generate Telegram GIF, falling back to PNG:', error);
        // Fall through to PNG generation
      }
    }

    // WHATSAPP or FALLBACK: Generate PNG
    const filepath = isGrandPrize 
      ? await this.generateGrandPrizePNG(winData)
      : await this.generateRegularWinPNG(winData);
    
    // BACKWARD COMPATIBLE: Return just filepath string
    // Your existing code expects: const imagePath = await generateWinImage(...)
    return filepath;
  }

  /**
   * Generate Tournament Performance Card
   * Shows questions reached, time taken, rank instead of prize amount
   * @param {Object} cardData - { username, city, questionsAnswered, timeTaken, rank, tournamentName, platform? }
   * @returns {String} - Filepath to generated image
   */
  async generateTournamentCard(cardData) {
    const { username, city, questionsAnswered, timeTaken, rank, tournamentName } = cardData;
    const platform = cardData.platform || 'whatsapp';
    const isPerfectGame = questionsAnswered === 15;

    const width = 1080;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    if (isPerfectGame) {
      // PERFECT GAME - Gold/Dark theme
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, width, height);
      this.drawPatternOverlay(ctx, width, height);
      this.drawConfetti(ctx, width, height, ['#FFD700', '#FFA500', '#FFFF00', '#00BFFF'], 60, true);
    } else {
      // Regular tournament card - Blue/Purple gradient
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#1e3c72');
      gradient.addColorStop(0.5, '#2a5298');
      gradient.addColorStop(1, '#4B0082');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      
      // Confetti with tournament colors
      this.drawConfetti(ctx, width, height, [
        '#FFD700', '#00BFFF', '#FF6B6B', '#4ECDC4', '#FFFFFF'
      ], 50);
    }

    // QR Code
    await this.drawQRCode(ctx, width, isPerfectGame ? '#FFD700' : '#00BFFF', 'Join Tournament!');

    // Tournament Badge
    this.drawTournamentBadge(ctx, width, 80, tournamentName || 'TOURNAMENT', isPerfectGame);

    // Performance Icon (Leaderboard/Podium instead of Trophy)
    await this.drawLeaderboardIcon(ctx, width, 180, isPerfectGame);

    // Performance Stats
    this.drawTournamentStats(ctx, width, {
      username,
      city,
      questionsAnswered,
      timeTaken,
      rank,
      tournamentName,
      isPerfectGame
    });

    // Save PNG
    const filename = `tournament_${Date.now()}.png`;
    const filepath = path.join(this.tempDir, filename);
    const buffer = canvas.toBuffer('image/png', { compressionLevel: 6 });
    fs.writeFileSync(filepath, buffer);

    logger.info(`Tournament card generated: ${filename}`);
    return filepath;
  }

  /**
   * Draw tournament badge at top
   */
  drawTournamentBadge(ctx, width, y, tournamentName, isPerfect) {
    // Background badge
    const gradient = ctx.createLinearGradient(width/2 - 400, y, width/2 + 400, y);
    if (isPerfect) {
      gradient.addColorStop(0, '#FFD700');
      gradient.addColorStop(0.5, '#FFA500');
      gradient.addColorStop(1, '#FFD700');
    } else {
      gradient.addColorStop(0, '#00BFFF');
      gradient.addColorStop(0.5, '#1E90FF');
      gradient.addColorStop(1, '#00BFFF');
    }
    
    ctx.fillStyle = gradient;
    ctx.shadowColor = isPerfect ? 'rgba(255, 215, 0, 0.5)' : 'rgba(0, 191, 255, 0.5)';
    ctx.shadowBlur = 20;
    this.roundRect(ctx, width/2 - 400, y, 800, 80, 40);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Tournament name text
    ctx.fillStyle = isPerfect ? '#1a1a2e' : '#FFFFFF';
    ctx.font = 'bold 36px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`🏆 ${tournamentName.toUpperCase()} 🏆`, width / 2, y + 52);
  }

  /**
   * Draw leaderboard/podium icon for tournaments
   */
  async drawLeaderboardIcon(ctx, width, y, isPerfect) {
    const centerX = width / 2;
    const iconSize = 180;
    
    // Draw podium bars
    const barWidth = 50;
    const barSpacing = 10;
    const colors = isPerfect 
      ? ['#FFD700', '#C0C0C0', '#CD7F32']  // Gold theme
      : ['#FFD700', '#C0C0C0', '#CD7F32']; // Standard
    
    // Middle (1st place) - tallest
    ctx.fillStyle = colors[0];
    ctx.shadowColor = 'rgba(255, 215, 0, 0.5)';
    ctx.shadowBlur = 20;
    this.roundRect(ctx, centerX - barWidth/2, y + 40, barWidth, 140, 8);
    ctx.fill();
    
    // Left (2nd place)
    ctx.fillStyle = colors[1];
    ctx.shadowColor = 'rgba(192, 192, 192, 0.5)';
    this.roundRect(ctx, centerX - barWidth*1.5 - barSpacing, y + 70, barWidth, 110, 8);
    ctx.fill();
    
    // Right (3rd place)
    ctx.fillStyle = colors[2];
    ctx.shadowColor = 'rgba(205, 127, 50, 0.5)';
    this.roundRect(ctx, centerX + barWidth/2 + barSpacing, y + 90, barWidth, 90, 8);
    ctx.fill();
    
    ctx.shadowBlur = 0;

    // Position numbers
    ctx.fillStyle = '#1a1a2e';
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('1', centerX, y + 65);
    ctx.fillText('2', centerX - barWidth - barSpacing, y + 95);
    ctx.fillText('3', centerX + barWidth + barSpacing, y + 115);
  }

  /**
   * Draw tournament performance stats
   */
  drawTournamentStats(ctx, width, data) {
    const { username, city, questionsAnswered, timeTaken, rank, isPerfect } = data;
    const textColor = isPerfect ? '#FFD700' : '#FFFFFF';
    const secondaryColor = isPerfect ? '#FFA500' : '#00BFFF';
    
    // "PERFORMANCE RECORD" header
    ctx.fillStyle = textColor;
    ctx.font = 'bold 48px Arial';
    ctx.textAlign = 'center';
    ctx.shadowColor = isPerfect ? 'rgba(255, 215, 0, 0.5)' : 'rgba(255, 255, 255, 0.3)';
    ctx.shadowBlur = 15;
    
    if (isPerfect) {
      ctx.fillText('⭐ PERFECT GAME! ⭐', width / 2, 420);
    } else {
      ctx.fillText('📊 TOURNAMENT RECORD', width / 2, 420);
    }
    ctx.shadowBlur = 0;

    // Stats box
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    this.roundRect(ctx, width/2 - 350, 460, 700, 280, 20);
    ctx.fill();

    // Questions reached
    ctx.fillStyle = secondaryColor;
    ctx.font = 'bold 32px Arial';
    ctx.fillText('Questions Reached', width / 2, 510);
    ctx.fillStyle = textColor;
    ctx.font = 'bold 72px Arial';
    ctx.fillText(`Q${questionsAnswered}/15`, width / 2, 580);

    // Time taken
    ctx.fillStyle = secondaryColor;
    ctx.font = 'bold 28px Arial';
    ctx.fillText('⏱️ Time', width / 2 - 150, 660);
    ctx.fillStyle = textColor;
    ctx.font = 'bold 36px Arial';
    ctx.fillText(`${timeTaken}s`, width / 2 - 150, 710);

    // Rank (if provided)
    if (rank) {
      ctx.fillStyle = secondaryColor;
      ctx.font = 'bold 28px Arial';
      ctx.fillText('🏆 Rank', width / 2 + 150, 660);
      ctx.fillStyle = textColor;
      ctx.font = 'bold 36px Arial';
      ctx.fillText(`#${rank}`, width / 2 + 150, 710);
    }

    // Username and city
    ctx.fillStyle = textColor;
    ctx.font = 'bold 42px Arial';
    ctx.fillText(`@${username}`, width / 2, 810);
    
    if (city) {
      ctx.fillStyle = secondaryColor;
      ctx.font = '28px Arial';
      ctx.fillText(`📍 ${city}`, width / 2, 855);
    }

    // Call to action
    ctx.fillStyle = isPerfect ? 'rgba(255, 215, 0, 0.3)' : 'rgba(0, 191, 255, 0.3)';
    this.roundRect(ctx, width/2 - 300, 900, 600, 60, 30);
    ctx.fill();
    
    ctx.fillStyle = textColor;
    ctx.font = 'bold 24px Arial';
    ctx.fillText('Join the tournament at whatsuptrivia.com.ng', width / 2, 940);

    // Branding
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '20px Arial';
    ctx.fillText("What's Up Trivia 🎮", width / 2, 1010);
  }

  // ============================================
  // WHATSAPP PNG GENERATION
  // ============================================

  async generateRegularWinPNG(winData) {
    const { username, city, amount, questionsAnswered, totalQuestions } = winData;

    const width = 1080;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Orange gradient background
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#FF6B35');
    gradient.addColorStop(0.5, '#F7931E');
    gradient.addColorStop(1, '#FFD23F');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Confetti
    this.drawConfetti(ctx, width, height, [
      '#FF6B6B', '#4ECDC4', '#FFD93D', '#95E1D3',
      '#F38181', '#AA96DA', '#FCBAD3', '#FFFFD2'
    ], 70);

    // QR Code
    await this.drawQRCode(ctx, width, '#FF6B35', 'Scan to Play!');

    // Trophy
    await this.drawTrophyImage(ctx, width, 120, 220, false);

    // Winner badge
    this.drawWinnerBadge(ctx, width, 350, '#FF6B35');

    // Text content
    this.drawVictoryText(ctx, width, {
      username,
      city,
      amount,
      questionsAnswered,
      totalQuestions,
      textColor: 'white',
      isGrandPrize: false
    });

    // Save PNG
    const filename = `win_${Date.now()}.png`;
    const filepath = path.join(this.tempDir, filename);
    const buffer = canvas.toBuffer('image/png', { compressionLevel: 6 });
    fs.writeFileSync(filepath, buffer);

    logger.info(`Victory PNG generated: ${filename}`);
    return filepath;
  }

  async generateGrandPrizePNG(winData) {
    const { username, city, amount } = winData;

    const width = 1080;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Dark background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, width, height);
    this.drawPatternOverlay(ctx, width, height);

    // Gold confetti
    this.drawConfetti(ctx, width, height, ['#FFD700', '#FFA500', '#FFFF00'], 60, true);

    // Gold QR Code
    await this.drawQRCode(ctx, width, '#FFD700', 'Scan & Win!');

    // Grand prize banner
    this.drawGrandPrizeBanner(ctx, width, 120);

    // Mega trophy
    await this.drawTrophyImage(ctx, width, 150, 260, true);

    // Text content
    this.drawVictoryText(ctx, width, {
      username,
      city,
      amount,
      questionsAnswered: 15,
      totalQuestions: 15,
      textColor: '#FFD700',
      isGrandPrize: true
    });

    // Save PNG
    const filename = `grand_${Date.now()}.png`;
    const filepath = path.join(this.tempDir, filename);
    const buffer = canvas.toBuffer('image/png', { compressionLevel: 6 });
    fs.writeFileSync(filepath, buffer);

    logger.info(`Grand Prize PNG generated: ${filename}`);
    return filepath;
  }

  // ============================================
  // TELEGRAM ANIMATED GIF (Premium Feature!)
  // ============================================

  async generateTelegramAnimatedGif(winData, isGrandPrize) {
    if (!GIFEncoder) {
      throw new Error('GIFEncoder not available');
    }

    const { username, city, amount, questionsAnswered, totalQuestions } = winData;
    const width = 1080;
    const height = 1080;
    const totalFrames = 60; // 2 seconds at 30fps
    const fps = 30;

    const filename = `win_tg_${Date.now()}.gif`;
    const filepath = path.join(this.tempDir, filename);

    const encoder = new GIFEncoder(width, height);
    encoder.createReadStream().pipe(fs.createWriteStream(filepath));
    encoder.start();
    encoder.setRepeat(0);
    encoder.setDelay(1000 / fps);
    encoder.setQuality(10);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    for (let frame = 0; frame < totalFrames; frame++) {
      const progress = frame / totalFrames;
      ctx.clearRect(0, 0, width, height);

      if (isGrandPrize) {
        await this.drawGrandPrizeFrame(ctx, width, height, progress, { username, city, amount });
      } else {
        await this.drawRegularWinFrame(ctx, width, height, progress, { 
          username, city, amount, questionsAnswered, totalQuestions 
        });
      }

      encoder.addFrame(ctx);
    }

    encoder.finish();
    logger.info(`Telegram animated GIF generated: ${filename}`);
    return filepath;
  }

  async drawRegularWinFrame(ctx, width, height, progress, data) {
    const { username, city, amount, questionsAnswered, totalQuestions } = data;

    // Background fade in
    const alpha = this.easeInOut(Math.min(progress * 2, 1));
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `rgba(255, 107, 53, ${alpha})`);
    gradient.addColorStop(0.5, `rgba(247, 147, 30, ${alpha})`);
    gradient.addColorStop(1, `rgba(255, 210, 63, ${alpha})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Animated confetti
    if (progress > 0.2) {
      this.drawAnimatedConfetti(ctx, width, height, progress, [
        '#FF6B6B', '#4ECDC4', '#FFD93D', '#95E1D3'
      ], false);
    }

    // QR Code fade in
    if (progress > 0.1) {
      ctx.globalAlpha = this.easeInOut((progress - 0.1) / 0.2);
      await this.drawQRCode(ctx, width, '#FF6B35', 'Scan to Play!');
      ctx.globalAlpha = 1;
    }

    // Trophy bounce
    if (progress > 0.2) {
      const trophyProgress = (progress - 0.2) / 0.3;
      const bounce = this.bounceEffect(trophyProgress);
      const trophyY = 120 + (1 - bounce) * 200;
      ctx.globalAlpha = Math.min(trophyProgress * 2, 1);
      await this.drawTrophyImage(ctx, width, trophyY, 220, false);
      ctx.globalAlpha = 1;
    }

    // Winner badge slide
    if (progress > 0.4) {
      ctx.globalAlpha = this.easeInOut((progress - 0.4) / 0.2);
      this.drawWinnerBadge(ctx, width, 350, '#FF6B35');
      ctx.globalAlpha = 1;
    }

    // Text reveal
    if (progress > 0.5) {
      const textProgress = (progress - 0.5) / 0.5;
      ctx.globalAlpha = this.easeInOut(textProgress);
      this.drawVictoryText(ctx, width, {
        username, city, amount, questionsAnswered, totalQuestions,
        textColor: 'white', isGrandPrize: false
      });
      ctx.globalAlpha = 1;
    }
  }

  async drawGrandPrizeFrame(ctx, width, height, progress, data) {
    const { username, city, amount } = data;

    // Dark background
    const alpha = this.easeInOut(Math.min(progress * 2, 1));
    ctx.fillStyle = `rgba(26, 26, 46, ${alpha})`;
    ctx.fillRect(0, 0, width, height);
    
    if (progress > 0.1) {
      ctx.globalAlpha = (progress - 0.1) * 2;
      this.drawPatternOverlay(ctx, width, height);
      ctx.globalAlpha = 1;
    }

    // Gold confetti rain
    if (progress > 0.15) {
      this.drawAnimatedConfetti(ctx, width, height, progress, ['#FFD700', '#FFA500', '#FFFF00'], true);
    }

    // QR Code
    if (progress > 0.1) {
      ctx.globalAlpha = this.easeInOut((progress - 0.1) / 0.2);
      await this.drawQRCode(ctx, width, '#FFD700', 'Scan & Win!');
      ctx.globalAlpha = 1;
    }

    // Banner slide down
    if (progress > 0.2) {
      const bannerProgress = (progress - 0.2) / 0.2;
      const bannerY = 120 - (1 - this.easeInOut(bannerProgress)) * 150;
      ctx.globalAlpha = this.easeInOut(bannerProgress);
      this.drawGrandPrizeBanner(ctx, width, bannerY);
      ctx.globalAlpha = 1;
    }

    // Trophy with extra bounce
    if (progress > 0.3) {
      const trophyProgress = (progress - 0.3) / 0.3;
      const bounce = this.bounceEffect(trophyProgress) * 1.5;
      const scale = 0.5 + bounce * 0.5;
      
      ctx.save();
      ctx.globalAlpha = Math.min(trophyProgress * 2, 1);
      ctx.translate(width / 2, 280);
      ctx.scale(scale, scale);
      ctx.translate(-width / 2, -280);
      await this.drawTrophyImage(ctx, width, 150, 260, true);
      ctx.restore();
    }

    // Text reveal
    if (progress > 0.6) {
      ctx.globalAlpha = this.easeInOut((progress - 0.6) / 0.4);
      this.drawVictoryText(ctx, width, {
        username, city, amount,
        questionsAnswered: 15, totalQuestions: 15,
        textColor: '#FFD700', isGrandPrize: true
      });
      ctx.globalAlpha = 1;
    }
  }

  // ============================================
  // DRAWING UTILITIES
  // ============================================

  async drawQRCode(ctx, width, color, text) {
    const qrSize = 180;
    const qrPadding = 40;
    const whatsappLink = `https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER || '2348012345678'}`;

    const qrDataUrl = await QRCode.toDataURL(whatsappLink, {
      width: qrSize,
      margin: 1,
      color: { 
        dark: color === '#FFD700' ? '#1a1a2e' : color, 
        light: color === '#FFD700' ? '#FFD700' : '#FFFFFF' 
      }
    });

    const qrImage = await loadImage(qrDataUrl);
    ctx.drawImage(qrImage, width - qrSize - qrPadding, qrPadding, qrSize, qrSize);

    ctx.fillStyle = color === '#FFD700' ? '#FFD700' : 'white';
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'center';
    ctx.shadowColor = color === '#FFD700' ? 'rgba(255, 215, 0, 0.5)' : 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 10;
    ctx.fillText(text, width - qrPadding - qrSize/2, qrPadding + qrSize + 35);
    ctx.shadowBlur = 0;
  }

  async drawTrophyImage(ctx, width, trophyY, size, isGold) {
    const trophyPath = path.join(__dirname, '../assets/trophy.png');
    try {
      const trophyImage = await loadImage(trophyPath);
      const trophyX = width / 2 - size / 2;

      ctx.shadowColor = isGold ? 'rgba(255, 215, 0, 0.8)' : 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = isGold ? 40 : 20;
      ctx.shadowOffsetY = 10;
      ctx.drawImage(trophyImage, trophyX, trophyY, size, size);
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    } catch (error) {
      this.drawTrophy(ctx, width / 2, trophyY + size/2, size * 0.7, isGold ? '#FFD700' : '#FFD700', isGold);
    }
  }

  drawWinnerBadge(ctx, width, y, color) {
    ctx.fillStyle = 'white';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 15;
    this.roundRect(ctx, width/2 - 150, y, 300, 60, 30);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = color;
    ctx.font = 'bold 36px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('WINNER!!!', width / 2, y + 43);
  }

  drawGrandPrizeBanner(ctx, width, y) {
    const gradient = ctx.createLinearGradient(width/2 - 350, y, width/2 + 350, y);
    gradient.addColorStop(0, '#FFD700');
    gradient.addColorStop(1, '#FFA500');
    ctx.fillStyle = gradient;
    ctx.shadowColor = 'rgba(255, 215, 0, 0.7)';
    ctx.shadowBlur = 25;
    this.roundRect(ctx, width/2 - 380, y, 760, 70, 35);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#1a1a2e';
    ctx.font = 'bold 38px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('🌟 GRAND PRIZE WINNER!!! 🌟', width / 2, y + 48);
  }

  drawVictoryText(ctx, width, data) {
    const { username, city, amount, questionsAnswered, totalQuestions, textColor, isGrandPrize } = data;
    let y = 480;

    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.shadowColor = isGrandPrize ? 'rgba(255, 215, 0, 0.6)' : 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = isGrandPrize ? 15 : 8;

    ctx.font = 'bold 72px Arial';
    ctx.fillText(`@${username}`, width / 2, y);
    y += 60;

    ctx.font = 'bold 52px Arial';
    ctx.fillText(`from ${city}`, width / 2, y);
    y += 100;

    ctx.font = 'bold 68px Arial';
    ctx.fillText('WON', width / 2, y);
    y += 100;

    if (isGrandPrize) ctx.fillStyle = 'white';
    ctx.font = 'bold 110px Arial';
    ctx.fillText(`₦${amount.toLocaleString()}`, width / 2, y);
    y += 100;

    ctx.fillStyle = textColor;
    ctx.font = 'bold 68px Arial';
    ctx.fillText('ON', width / 2, y);
    y += 100;

    if (isGrandPrize) ctx.fillStyle = 'white';
    ctx.font = 'bold 76px Arial';
    ctx.fillText("WHAT'S UP TRIVIA GAME", width / 2, y);
    ctx.shadowBlur = 0;
    y += 80;

    ctx.font = 'bold 38px Arial';
    ctx.fillStyle = isGrandPrize ? 'white' : 'rgba(255, 255, 255, 0.95)';
    const scoreText = isGrandPrize ? '15/15 PERFECT! ⭐' : `${questionsAnswered}/${totalQuestions} Questions Correct`;
    ctx.fillText(scoreText, width / 2, y);

    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = isGrandPrize ? '#FFD700' : 'white';
    ctx.fillText('SummerIsland Systems', width / 2, 1040);
  }

  drawAnimatedConfetti(ctx, width, height, progress, colors, isGold) {
    const count = isGold ? 60 : 70;
    const fallSpeed = height * 0.3;
    
    for (let i = 0; i < count; i++) {
      ctx.save();
      const x = (i / count) * width + Math.sin(progress * Math.PI * 4 + i) * 50;
      const baseY = (i % 10) * (height / 10);
      const y = (baseY + progress * fallSpeed) % height;
      const size = isGold ? (Math.random() * 12 + 8) : (Math.random() * 14 + 6);
      const rotation = progress * Math.PI * 4 + i;
      const color = colors[i % colors.length];

      ctx.translate(x, y);
      ctx.rotate(rotation);
      ctx.fillStyle = color;

      if (isGold) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
      }

      const shape = i % 3;
      if (shape === 0) {
        ctx.beginPath();
        ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (shape === 1) {
        ctx.fillRect(-size / 2, -size / 2, size, size * 1.5);
      } else {
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

  drawConfetti(ctx, width, height, colors, count, isGold = false) {
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

      const shape = Math.random();
      if (shape > 0.66) {
        ctx.beginPath();
        ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (shape > 0.33) {
        ctx.fillRect(-size / 2, -size / 2, size, size * 1.5);
      } else {
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

  drawTrophy(ctx, x, y, size, color, hasGlow) {
    ctx.save();
    ctx.shadowColor = hasGlow ? color : 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = hasGlow ? 40 : 15;
    ctx.fillStyle = color;

    ctx.beginPath();
    ctx.arc(x, y, size * 0.45, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillRect(x - size * 0.12, y + size * 0.35, size * 0.24, size * 0.25);
    ctx.fillRect(x - size * 0.35, y + size * 0.55, size * 0.7, size * 0.15);

    ctx.beginPath();
    ctx.arc(x - size * 0.55, y - size * 0.05, size * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + size * 0.55, y - size * 0.05, size * 0.22, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillRect(x - size * 0.5, y - size * 0.5, size, size * 0.12);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.beginPath();
    ctx.arc(x - size * 0.2, y - size * 0.15, size * 0.25, 0, Math.PI * 2);
    ctx.fill();

    this.drawStar(ctx, x, y - size * 0.65, size * 0.18, 'white');
    ctx.restore();
  }

  drawStar(ctx, cx, cy, radius, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      const innerAngle = angle + Math.PI / 5;
      const innerX = cx + Math.cos(innerAngle) * (radius * 0.4);
      const innerY = cy + Math.sin(innerAngle) * (radius * 0.4);
      ctx.lineTo(innerX, innerY);
    }
    ctx.closePath();
    ctx.fill();
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

  // ============================================
  // ANIMATION EASING FUNCTIONS
  // ============================================

  easeInOut(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  bounceEffect(t) {
    if (t >= 1) return 1;
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  }

  // ============================================
  // CAPTION GENERATION (Optional)
  // ============================================

  generateTelegramCaption(winData, isGrandPrize) {
    const { username, city, amount, questionsAnswered, totalQuestions } = winData;
    
    if (isGrandPrize) {
      return `🏆 *GRAND PRIZE WINNER!* 🏆

🎉 Congratulations *@${username}* from *${city}*!

💰 You've won *₦${amount.toLocaleString()}*!
⭐ Perfect score: *15/15 questions*!

🎮 Play now and win big on *What's Up Trivia*!

_Powered by SummerIsland Systems_`;
    }

    return `🎊 *WINNER!* 🎊

🎉 *@${username}* from *${city}* just won!

💰 Prize: *₦${amount.toLocaleString()}*
📊 Score: *${questionsAnswered}/${totalQuestions} correct*

🎮 Your turn to win! Play What's Up Trivia now!

_Powered by SummerIsland Systems_`;
  }

  // ============================================
  // CLEANUP
  // ============================================

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