// ============================================
// FILE: src/services/image.service.js
// REDESIGNED: Cosmic banner backgrounds for all victory cards
// Auto-detects platform from winData
// ============================================

const { createCanvas, loadImage } = require('canvas');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { logger } = require('../utils/logger');

let GIFEncoder;
try {
  GIFEncoder = require('gifencoder');
} catch (e) {
  logger.warn('GIFEncoder not installed - Telegram animations disabled.');
}

class ImageService {
  constructor() {
    this.tempDir = path.join(__dirname, '../temp');
    this.ensureTempDir();
    this.cosmicBgPath = path.join(__dirname, '../assets/cosmic-bg.png');
    this.trophyPath = path.join(__dirname, '../assets/trophy.png');
    this._bgCache = null;
  }

  ensureTempDir() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async getCosmicBg() {
    if (!this._bgCache) {
      try {
        this._bgCache = await loadImage(this.cosmicBgPath);
        logger.info('Cosmic background loaded successfully');
      } catch (err) {
        logger.warn('Cosmic background not found, will use fallback gradient');
        return null;
      }
    }
    return this._bgCache;
  }

  // ============================================
  // DRAW COSMIC BACKGROUND (shared by all cards)
  // Banner is 1024x1536 portrait, cards are 1080x1080
  // Anchors to bottom so coins/naira bag stay visible
  // ============================================

  async drawCosmicBackground(ctx, width, height, tintColor, tintAlpha) {
    const bg = await this.getCosmicBg();
    
    if (bg) {
      const srcAspect = bg.width / bg.height;
      const dstAspect = width / height;
      let sx, sy, sw, sh;
      
      if (dstAspect > srcAspect) {
        sw = bg.width;
        sh = bg.width / dstAspect;
        sx = 0;
        sy = bg.height - sh;
      } else {
        sh = bg.height;
        sw = bg.height * dstAspect;
        sx = (bg.width - sw) / 2;
        sy = 0;
      }
      
      ctx.drawImage(bg, sx, sy, sw, sh, 0, 0, width, height);
    } else {
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#1e1b4b');
      gradient.addColorStop(0.5, '#3b1f7a');
      gradient.addColorStop(1, '#5b2d8e');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }

    if (tintColor && tintAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = tintAlpha;
      ctx.fillStyle = tintColor;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
  }

  // ============================================
  // MAIN ENTRY POINT
  // ============================================

  async generateWinImage(winData) {
    const platform = winData.platform || 'whatsapp';
    const isGrandPrize = winData.questionsAnswered === winData.totalQuestions && winData.totalQuestions === 15;

    if (platform === 'telegram' && GIFEncoder) {
      try {
        const filepath = await this.generateTelegramAnimatedGif(winData, isGrandPrize);
        const caption = this.generateTelegramCaption(winData, isGrandPrize);
        return { filepath, type: 'gif', caption, platform: 'telegram' };
      } catch (error) {
        logger.error('Failed to generate Telegram GIF, falling back to PNG:', error);
      }
    }

    const filepath = isGrandPrize 
      ? await this.generateGrandPrizePNG(winData)
      : await this.generateRegularWinPNG(winData);
    return filepath;
  }

  // ============================================
  // TOURNAMENT CARD (Cosmic - no tint, natural purple/gold)
  // ============================================

  async generateTournamentCard(cardData) {
    const { username, city, questionsAnswered, timeTaken, rank, tournamentName } = cardData;
    const isPerfect = questionsAnswered === 15;

    const width = 1080;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Cosmic background
    if (isPerfect) {
      await this.drawCosmicBackground(ctx, width, height, '#120a28', 0.25);
    } else {
      await this.drawCosmicBackground(ctx, width, height, null, 0);
    }

    if (isPerfect) {
      this.drawConfetti(ctx, width, height, ['#FFD700', '#FFA500', '#FFFF00', '#00BFFF'], 40, true);
    }

    const accent = isPerfect ? '#FFD700' : '#00BFFF';
    const text = isPerfect ? '#FFD700' : '#FFFFFF';

    // QR code
    await this.drawQRCode(ctx, width, accent, 'Join Tournament!');

    // Tournament name badge
    const badgeY = 55;
    const badgeGrad = ctx.createLinearGradient(width/2 - 380, badgeY, width/2 + 380, badgeY);
    if (isPerfect) {
      badgeGrad.addColorStop(0, 'rgba(255, 215, 0, 0.9)');
      badgeGrad.addColorStop(0.5, 'rgba(255, 165, 0, 0.95)');
      badgeGrad.addColorStop(1, 'rgba(255, 215, 0, 0.9)');
    } else {
      badgeGrad.addColorStop(0, 'rgba(0, 191, 255, 0.85)');
      badgeGrad.addColorStop(0.5, 'rgba(30, 144, 255, 0.9)');
      badgeGrad.addColorStop(1, 'rgba(0, 191, 255, 0.85)');
    }
    ctx.fillStyle = badgeGrad;
    this.roundRect(ctx, width/2 - 380, badgeY, 760, 70, 35);
    ctx.fill();

    ctx.fillStyle = isPerfect ? '#1a1a2e' : '#FFFFFF';
    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'center';
    ctx.fillText((tournamentName || 'TOURNAMENT').toUpperCase(), width / 2, badgeY + 46);

    // Podium icon
    this.drawPodiumIcon(ctx, width / 2, 210, isPerfect);

    // Header
    const headerY = 380;
    ctx.fillStyle = text;
    ctx.font = 'bold 44px Arial';
    ctx.textAlign = 'center';
    ctx.shadowColor = isPerfect ? 'rgba(255, 215, 0, 0.5)' : 'rgba(255, 255, 255, 0.3)';
    ctx.shadowBlur = 15;
    ctx.fillText(isPerfect ? 'PERFECT GAME!' : 'TOURNAMENT RECORD', width / 2, headerY);
    ctx.shadowBlur = 0;

    // Stats box
    const boxY = 410;
    const boxH = 260;
    ctx.fillStyle = 'rgba(15, 10, 40, 0.55)';
    ctx.strokeStyle = isPerfect ? 'rgba(255, 215, 0, 0.3)' : 'rgba(100, 180, 255, 0.25)';
    ctx.lineWidth = 1.5;
    this.roundRect(ctx, width/2 - 340, boxY, 680, boxH, 20);
    ctx.fill();
    ctx.stroke();

    // Questions Reached
    ctx.fillStyle = accent;
    ctx.font = 'bold 28px Arial';
    ctx.fillText('Questions Reached', width / 2, boxY + 48);
    
    ctx.fillStyle = text;
    ctx.font = 'bold 80px Arial';
    ctx.shadowColor = isPerfect ? 'rgba(255, 215, 0, 0.4)' : 'rgba(0, 191, 255, 0.3)';
    ctx.shadowBlur = 15;
    ctx.fillText('Q' + questionsAnswered + '/15', width / 2, boxY + 135);
    ctx.shadowBlur = 0;

    // Time
    ctx.fillStyle = accent;
    ctx.font = 'bold 24px Arial';
    ctx.fillText('Time', width / 2 - 150, boxY + 185);
    ctx.fillStyle = text;
    ctx.font = 'bold 38px Arial';
    const timeStr = typeof timeTaken === 'number' ? timeTaken.toFixed(1) + 's' : timeTaken + 's';
    ctx.fillText(timeStr, width / 2 - 150, boxY + 228);

    // Rank
    if (rank) {
      ctx.fillStyle = accent;
      ctx.font = 'bold 24px Arial';
      ctx.fillText('Rank', width / 2 + 150, boxY + 185);
      ctx.fillStyle = text;
      ctx.font = 'bold 38px Arial';
      ctx.fillText('#' + rank, width / 2 + 150, boxY + 228);
    }

    // Username & city
    ctx.fillStyle = text;
    ctx.font = 'bold 40px Arial';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 8;
    ctx.fillText('@' + (username || 'player'), width / 2, boxY + boxH + 55);
    ctx.shadowBlur = 0;
    
    if (city) {
      ctx.fillStyle = accent;
      ctx.font = '26px Arial';
      ctx.fillText(city, width / 2, boxY + boxH + 90);
    }

    // Branding (above the banner's built-in CTA)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '20px Arial';
    ctx.fillText("What's Up Trivia", width / 2, height - 145);

    const filename = 'tournament_' + Date.now() + '.png';
    const filepath = path.join(this.tempDir, filename);
    fs.writeFileSync(filepath, canvas.toBuffer('image/png', { compressionLevel: 6 }));
    logger.info('Tournament card generated: ' + filename);
    return filepath;
  }

  // ============================================
  // REGULAR WIN CARD (Cosmic + warm orange tint)
  // ============================================

  async generateRegularWinPNG(winData) {
    const { username, city, amount, questionsAnswered, totalQuestions } = winData;

    const width = 1080;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    await this.drawCosmicBackground(ctx, width, height, '#FF6420', 0.25);

    this.drawConfetti(ctx, width, height, [
      '#FF6B6B', '#4ECDC4', '#FFD93D', '#95E1D3', '#F38181', '#AA96DA', '#FFFFFF'
    ], 50);

    await this.drawQRCode(ctx, width, '#FF8C00', 'Scan to Play!');
    await this.drawTrophyImage(ctx, width, 80, 200, false);

    // WINNER badge
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 15;
    this.roundRect(ctx, width/2 - 160, 300, 320, 60, 30);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#FF6B35';
    ctx.font = 'bold 36px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('WINNER!', width / 2, 343);

    // Victory text
    let y = 430;
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 10;

    ctx.font = 'bold 60px Arial';
    ctx.fillText('@' + username, width / 2, y); y += 55;
    if (city) { ctx.font = 'bold 40px Arial'; ctx.fillText('from ' + city, width / 2, y); y += 75; } else { y += 30; }
    ctx.font = 'bold 52px Arial'; ctx.fillText('WON', width / 2, y); y += 85;
    ctx.shadowColor = 'rgba(255, 215, 0, 0.5)'; ctx.shadowBlur = 20;
    ctx.font = 'bold 100px Arial'; ctx.fillText('N' + amount.toLocaleString(), width / 2, y); y += 85;
    ctx.shadowBlur = 10;
    ctx.font = 'bold 52px Arial'; ctx.fillText('ON', width / 2, y); y += 70;
    ctx.font = 'bold 56px Arial'; ctx.fillText("WHAT'S UP TRIVIA", width / 2, y);
    ctx.shadowBlur = 0; y += 55;

    ctx.font = 'bold 34px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillText(questionsAnswered + '/' + totalQuestions + ' Questions Correct', width / 2, y);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '20px Arial';
    ctx.fillText('SummerIsland Systems', width / 2, height - 145);

    const filename = 'win_' + Date.now() + '.png';
    const filepath = path.join(this.tempDir, filename);
    fs.writeFileSync(filepath, canvas.toBuffer('image/png', { compressionLevel: 6 }));
    logger.info('Victory PNG generated: ' + filename);
    return filepath;
  }

  // ============================================
  // GRAND PRIZE CARD (Cosmic + dark overlay + gold)
  // ============================================

  async generateGrandPrizePNG(winData) {
    const { username, city, amount } = winData;

    const width = 1080;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    await this.drawCosmicBackground(ctx, width, height, '#0a0520', 0.35);
    this.drawConfetti(ctx, width, height, ['#FFD700', '#FFA500', '#FFFF00', '#FFE066'], 50, true);
    await this.drawQRCode(ctx, width, '#FFD700', 'Scan & Win!');

    // Grand prize banner
    const bGrad = ctx.createLinearGradient(width/2 - 380, 70, width/2 + 380, 70);
    bGrad.addColorStop(0, '#FFD700'); bGrad.addColorStop(0.5, '#FFA500'); bGrad.addColorStop(1, '#FFD700');
    ctx.fillStyle = bGrad;
    ctx.shadowColor = 'rgba(255, 215, 0, 0.7)'; ctx.shadowBlur = 25;
    this.roundRect(ctx, width/2 - 380, 70, 760, 70, 35); ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#1a1a2e';
    ctx.font = 'bold 34px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('GRAND PRIZE WINNER!', width / 2, 118);

    await this.drawTrophyImage(ctx, width, 165, 230, true);

    let y = 450;
    ctx.shadowColor = 'rgba(255, 215, 0, 0.6)'; ctx.shadowBlur = 15;
    ctx.fillStyle = '#FFD700'; ctx.font = 'bold 60px Arial'; ctx.textAlign = 'center';
    ctx.fillText('@' + username, width / 2, y); y += 55;
    if (city) { ctx.font = 'bold 40px Arial'; ctx.fillText('from ' + city, width / 2, y); y += 75; } else { y += 30; }
    ctx.font = 'bold 52px Arial'; ctx.fillText('WON', width / 2, y); y += 85;
    ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 100px Arial';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.4)'; ctx.shadowBlur = 25;
    ctx.fillText('N' + amount.toLocaleString(), width / 2, y); y += 85;
    ctx.fillStyle = '#FFD700'; ctx.shadowBlur = 15; ctx.font = 'bold 52px Arial';
    ctx.fillText('ON', width / 2, y); y += 70;
    ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 56px Arial';
    ctx.fillText("WHAT'S UP TRIVIA", width / 2, y); ctx.shadowBlur = 0; y += 55;
    ctx.fillStyle = '#FFD700'; ctx.font = 'bold 34px Arial';
    ctx.fillText('15/15 PERFECT!', width / 2, y);

    ctx.globalAlpha = 0.6; ctx.fillStyle = '#FFD700'; ctx.font = '20px Arial';
    ctx.fillText('SummerIsland Systems', width / 2, height - 145);
    ctx.globalAlpha = 1;

    const filename = 'grand_' + Date.now() + '.png';
    const filepath = path.join(this.tempDir, filename);
    fs.writeFileSync(filepath, canvas.toBuffer('image/png', { compressionLevel: 6 }));
    logger.info('Grand Prize PNG generated: ' + filename);
    return filepath;
  }

  // ============================================
  // PODIUM ICON (replaces broken emoji rendering)
  // ============================================

  drawPodiumIcon(ctx, cx, cy, isPerfect) {
    const barW = 55;
    const gap = 12;

    ctx.fillStyle = '#FFD700';
    ctx.shadowColor = 'rgba(255, 215, 0, 0.6)'; ctx.shadowBlur = 20;
    this.roundRect(ctx, cx - barW/2, cy - 60, barW, 140, 8); ctx.fill();

    ctx.fillStyle = '#C0C0C0';
    ctx.shadowColor = 'rgba(192, 192, 192, 0.4)'; ctx.shadowBlur = 12;
    this.roundRect(ctx, cx - barW*1.5 - gap, cy - 20, barW, 100, 8); ctx.fill();

    ctx.fillStyle = '#CD7F32';
    ctx.shadowColor = 'rgba(205, 127, 50, 0.4)'; ctx.shadowBlur = 12;
    this.roundRect(ctx, cx + barW/2 + gap, cy, barW, 80, 8); ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#1a1a2e';
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('1', cx, cy - 30);
    ctx.fillText('2', cx - barW - gap, cy + 10);
    ctx.fillText('3', cx + barW + gap, cy + 30);
  }

  // ============================================
  // QR CODE
  // ============================================

  async drawQRCode(ctx, width, color, labelText) {
    const qrSize = 160;
    const pad = 30;
    const link = 'https://wa.me/' + (process.env.WHATSAPP_PHONE_NUMBER || '2348030890744');

    try {
      const isDark = (color === '#FFD700');
      const qrDataUrl = await QRCode.toDataURL(link, {
        width: qrSize, margin: 1,
        color: { dark: isDark ? '#1a1a2e' : color, light: isDark ? '#FFD700' : '#FFFFFF' }
      });

      const qrImg = await loadImage(qrDataUrl);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      this.roundRect(ctx, width - qrSize - pad - 12, pad - 12, qrSize + 24, qrSize + 60, 12);
      ctx.fill();
      ctx.drawImage(qrImg, width - qrSize - pad, pad, qrSize, qrSize);

      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 18px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(labelText, width - pad - qrSize/2, pad + qrSize + 28);
    } catch (err) {
      logger.error('QR code generation failed:', err);
    }
  }

  // ============================================
  // TROPHY IMAGE
  // ============================================

  async drawTrophyImage(ctx, width, trophyY, size, isGold) {
    try {
      const img = await loadImage(this.trophyPath);
      ctx.shadowColor = isGold ? 'rgba(255, 215, 0, 0.8)' : 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = isGold ? 40 : 20;
      ctx.shadowOffsetY = 10;
      ctx.drawImage(img, width / 2 - size / 2, trophyY, size, size);
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    } catch (error) {
      this.drawTrophy(ctx, width / 2, trophyY + size/2, size * 0.7, '#FFD700', isGold);
    }
  }

  // ============================================
  // CONFETTI
  // ============================================

  drawConfetti(ctx, width, height, colors, count, isGold) {
    for (let i = 0; i < count; i++) {
      ctx.save();
      const x = Math.random() * width;
      const y = Math.random() * height * 0.85;
      const size = isGold ? (Math.random() * 12 + 8) : (Math.random() * 14 + 6);
      ctx.translate(x, y);
      ctx.rotate(Math.random() * Math.PI * 2);
      ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
      ctx.globalAlpha = 0.7 + Math.random() * 0.3;
      if (isGold) { ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 10; }

      const s = Math.random();
      if (s > 0.66) { ctx.beginPath(); ctx.arc(0, 0, size/2, 0, Math.PI*2); ctx.fill(); }
      else if (s > 0.33) { ctx.fillRect(-size/2, -size/2, size, size*1.5); }
      else { ctx.beginPath(); ctx.moveTo(0, -size/2); ctx.lineTo(size/2, size/2); ctx.lineTo(-size/2, size/2); ctx.closePath(); ctx.fill(); }
      ctx.restore();
    }
  }

  // ============================================
  // TELEGRAM ANIMATED GIF
  // ============================================

  async generateTelegramAnimatedGif(winData, isGrandPrize) {
    if (!GIFEncoder) throw new Error('GIFEncoder not available');
    const { username, city, amount, questionsAnswered, totalQuestions } = winData;
    const width = 1080, height = 1080, totalFrames = 60, fps = 30;
    const filename = 'win_tg_' + Date.now() + '.gif';
    const filepath = path.join(this.tempDir, filename);

    const encoder = new GIFEncoder(width, height);
    encoder.createReadStream().pipe(fs.createWriteStream(filepath));
    encoder.start(); encoder.setRepeat(0); encoder.setDelay(1000 / fps); encoder.setQuality(10);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    for (let frame = 0; frame < totalFrames; frame++) {
      const p = frame / totalFrames;
      ctx.clearRect(0, 0, width, height);
      if (isGrandPrize) { await this.drawGrandPrizeFrame(ctx, width, height, p, { username, city, amount }); }
      else { await this.drawRegularWinFrame(ctx, width, height, p, { username, city, amount, questionsAnswered, totalQuestions }); }
      encoder.addFrame(ctx);
    }
    encoder.finish();
    logger.info('Telegram GIF generated: ' + filename);
    return filepath;
  }

  async drawRegularWinFrame(ctx, w, h, p, data) {
    const { username, city, amount, questionsAnswered, totalQuestions } = data;
    const a = this.easeInOut(Math.min(p * 2, 1));
    await this.drawCosmicBackground(ctx, w, h, '#FF6420', a * 0.25);
    if (p > 0.2) this.drawAnimatedConfetti(ctx, w, h, p, ['#FF6B6B', '#4ECDC4', '#FFD93D', '#95E1D3'], false);
    if (p > 0.1) { ctx.globalAlpha = this.easeInOut((p - 0.1) / 0.2); await this.drawQRCode(ctx, w, '#FF6B35', 'Scan to Play!'); ctx.globalAlpha = 1; }
    if (p > 0.2) { const tp = (p - 0.2) / 0.3; ctx.globalAlpha = Math.min(tp * 2, 1); await this.drawTrophyImage(ctx, w, 80 + (1 - this.bounceEffect(tp)) * 200, 200, false); ctx.globalAlpha = 1; }
    if (p > 0.4) { ctx.globalAlpha = this.easeInOut((p - 0.4) / 0.2); ctx.fillStyle = 'rgba(255,255,255,0.95)'; this.roundRect(ctx, w/2-160, 300, 320, 60, 30); ctx.fill(); ctx.fillStyle = '#FF6B35'; ctx.font = 'bold 36px Arial'; ctx.textAlign = 'center'; ctx.fillText('WINNER!', w/2, 343); ctx.globalAlpha = 1; }
    if (p > 0.5) {
      ctx.globalAlpha = this.easeInOut((p - 0.5) / 0.5);
      let y = 430; ctx.fillStyle = '#FFF'; ctx.textAlign = 'center'; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 10;
      ctx.font = 'bold 60px Arial'; ctx.fillText('@' + username, w/2, y); y += 55;
      if (city) { ctx.font = 'bold 40px Arial'; ctx.fillText('from ' + city, w/2, y); y += 75; } else y += 30;
      ctx.font = 'bold 52px Arial'; ctx.fillText('WON', w/2, y); y += 85;
      ctx.font = 'bold 100px Arial'; ctx.fillText('N' + amount.toLocaleString(), w/2, y); y += 85;
      ctx.font = 'bold 52px Arial'; ctx.fillText('ON', w/2, y); y += 70;
      ctx.font = 'bold 56px Arial'; ctx.fillText("WHAT'S UP TRIVIA", w/2, y); ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  async drawGrandPrizeFrame(ctx, w, h, p, data) {
    const { username, city, amount } = data;
    const a = this.easeInOut(Math.min(p * 2, 1));
    await this.drawCosmicBackground(ctx, w, h, '#0a0520', a * 0.35);
    if (p > 0.15) this.drawAnimatedConfetti(ctx, w, h, p, ['#FFD700', '#FFA500', '#FFFF00'], true);
    if (p > 0.1) { ctx.globalAlpha = this.easeInOut((p - 0.1) / 0.2); await this.drawQRCode(ctx, w, '#FFD700', 'Scan & Win!'); ctx.globalAlpha = 1; }
    if (p > 0.2) {
      ctx.globalAlpha = this.easeInOut((p - 0.2) / 0.2);
      const bg = ctx.createLinearGradient(w/2-380, 70, w/2+380, 70); bg.addColorStop(0, '#FFD700'); bg.addColorStop(1, '#FFA500');
      ctx.fillStyle = bg; this.roundRect(ctx, w/2-380, 70, 760, 70, 35); ctx.fill();
      ctx.fillStyle = '#1a1a2e'; ctx.font = 'bold 34px Arial'; ctx.textAlign = 'center'; ctx.fillText('GRAND PRIZE WINNER!', w/2, 118);
      ctx.globalAlpha = 1;
    }
    if (p > 0.3) { const tp = (p - 0.3) / 0.3; ctx.globalAlpha = Math.min(tp * 2, 1); await this.drawTrophyImage(ctx, w, 165 + (1 - this.bounceEffect(tp)) * 150, 230, true); ctx.globalAlpha = 1; }
    if (p > 0.5) {
      ctx.globalAlpha = this.easeInOut((p - 0.5) / 0.5);
      let y = 450; ctx.textAlign = 'center'; ctx.shadowColor = 'rgba(255,215,0,0.6)'; ctx.shadowBlur = 15;
      ctx.fillStyle = '#FFD700'; ctx.font = 'bold 60px Arial'; ctx.fillText('@' + username, w/2, y); y += 55;
      if (city) { ctx.font = 'bold 40px Arial'; ctx.fillText('from ' + city, w/2, y); y += 75; } else y += 30;
      ctx.font = 'bold 52px Arial'; ctx.fillText('WON', w/2, y); y += 85;
      ctx.fillStyle = '#FFF'; ctx.font = 'bold 100px Arial'; ctx.fillText('N' + amount.toLocaleString(), w/2, y); y += 85;
      ctx.fillStyle = '#FFD700'; ctx.font = 'bold 52px Arial'; ctx.fillText('ON', w/2, y); y += 70;
      ctx.fillStyle = '#FFF'; ctx.font = 'bold 56px Arial'; ctx.fillText("WHAT'S UP TRIVIA", w/2, y); ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  drawAnimatedConfetti(ctx, w, h, progress, colors, isGold) {
    const count = isGold ? 50 : 60;
    for (let i = 0; i < count; i++) {
      ctx.save();
      const x = (i / count) * w + Math.sin(progress * Math.PI * 4 + i) * 50;
      const y = ((i % 10) * (h / 10) + progress * h * 0.3) % (h * 0.85);
      const size = isGold ? (Math.random() * 12 + 8) : (Math.random() * 14 + 6);
      ctx.translate(x, y); ctx.rotate(progress * Math.PI * 4 + i);
      ctx.fillStyle = colors[i % colors.length]; ctx.globalAlpha = 0.7;
      if (isGold) { ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 12; }
      const s = i % 3;
      if (s === 0) { ctx.beginPath(); ctx.arc(0, 0, size/2, 0, Math.PI*2); ctx.fill(); }
      else if (s === 1) ctx.fillRect(-size/2, -size/2, size, size*1.5);
      else { ctx.beginPath(); ctx.moveTo(0, -size/2); ctx.lineTo(size/2, size/2); ctx.lineTo(-size/2, size/2); ctx.closePath(); ctx.fill(); }
      ctx.restore();
    }
  }

  // ============================================
  // FALLBACK TROPHY (drawn shape)
  // ============================================

  drawTrophy(ctx, x, y, size, color, hasGlow) {
    ctx.save();
    ctx.shadowColor = hasGlow ? color : 'rgba(0,0,0,0.3)'; ctx.shadowBlur = hasGlow ? 40 : 15; ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, size * 0.45, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(x - size*0.12, y + size*0.35, size*0.24, size*0.25);
    ctx.fillRect(x - size*0.35, y + size*0.55, size*0.7, size*0.15);
    ctx.beginPath(); ctx.arc(x - size*0.55, y - size*0.05, size*0.22, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + size*0.55, y - size*0.05, size*0.22, 0, Math.PI*2); ctx.fill();
    ctx.fillRect(x - size*0.5, y - size*0.5, size, size*0.12);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath(); ctx.arc(x - size*0.2, y - size*0.15, size*0.25, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // ============================================
  // HELPERS
  // ============================================

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

  bounceEffect(t) {
    if (t >= 1) return 1;
    const n = 7.5625, d = 2.75;
    if (t < 1/d) return n*t*t;
    if (t < 2/d) return n*(t -= 1.5/d)*t + 0.75;
    if (t < 2.5/d) return n*(t -= 2.25/d)*t + 0.9375;
    return n*(t -= 2.625/d)*t + 0.984375;
  }

  generateTelegramCaption(winData, isGrandPrize) {
    const { username, city, amount, questionsAnswered, totalQuestions } = winData;
    if (isGrandPrize) {
      return '🏆 *GRAND PRIZE WINNER!* 🏆\n\n🎉 Congratulations *@' + username + '* from *' + city + '*!\n\n💰 You\'ve won *₦' + amount.toLocaleString() + '*!\n⭐ Perfect score: *15/15 questions*!\n\n🎮 Play now on *What\'s Up Trivia*!\n\n_Powered by SummerIsland Systems_';
    }
    return '🎊 *WINNER!* 🎊\n\n🎉 *@' + username + '* from *' + city + '* just won!\n\n💰 Prize: *₦' + amount.toLocaleString() + '*\n📊 Score: *' + questionsAnswered + '/' + totalQuestions + ' correct*\n\n🎮 Your turn to win! Play What\'s Up Trivia now!\n\n_Powered by SummerIsland Systems_';
  }

  cleanupTempFiles() {
    try {
      const files = fs.readdirSync(this.tempDir);
      const now = Date.now();
      files.forEach(file => {
        const fp = path.join(this.tempDir, file);
        if (now - fs.statSync(fp).mtimeMs > 3600000) { fs.unlinkSync(fp); logger.info('Cleaned up: ' + file); }
      });
    } catch (error) { logger.error('Error cleaning up temp files:', error); }
  }
}

module.exports = ImageService;