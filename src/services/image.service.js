// ============================================
// FILE: src/services/image.service.js
// V5: Victory cards as marketing assets
// - Cosmic banner backgrounds (crop B: coins visible, CTA bar removed)
// - Challenge/conversion text baked into card
// - Proper typography hierarchy
// - Self-contained: no caption needed
// ============================================

const { createCanvas, loadImage } = require('canvas');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { logger } = require('../utils/logger');

let GIFEncoder;
try { GIFEncoder = require('gifencoder'); } catch (e) {}

class ImageService {
  constructor() {
    this.tempDir = path.join(__dirname, '../temp');
    this.ensureTempDir();
    this.assetsDir = path.join(__dirname, '../assets');
    this._cache = {};
  }

  ensureTempDir() {
    if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true });
  }

  async loadAsset(name) {
    if (this._cache[name]) return this._cache[name];
    const fp = path.join(this.assetsDir, name);
    if (!fs.existsSync(fp)) { logger.warn(`Asset missing: ${fp}`); return null; }
    try {
      const img = await loadImage(fp);
      this._cache[name] = img;
      logger.info(`Loaded: ${name} (${img.width}x${img.height})`);
      return img;
    } catch (e) { logger.error(`Failed to load ${name}: ${e.message}`); return null; }
  }

  async drawBackground(ctx, w, h, variant) {
    // Filenames match what's on Render (lowercase)
    const map = { tournament: 'cosmic-bg.jpg', warm: 'cosmic-bg-warm.jpg', dark: 'cosmic-bg-dark.jpg' };
    const bg = await this.loadAsset(map[variant] || map.tournament);
    if (bg) { ctx.drawImage(bg, 0, 0, w, h); return true; }
    // Fallback
    const g = ctx.createLinearGradient(0, 0, w, h);
    if (variant === 'warm') { g.addColorStop(0,'#6b2fa0'); g.addColorStop(1,'#c44b24'); }
    else if (variant === 'dark') { g.addColorStop(0,'#0d0520'); g.addColorStop(1,'#2d1854'); }
    else { g.addColorStop(0,'#1e1b4b'); g.addColorStop(0.5,'#3b1f7a'); g.addColorStop(1,'#5b2d8e'); }
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    return false;
  }

  // ============================================
  // MAIN ENTRY
  // ============================================

  async generateWinImage(winData) {
    const platform = winData.platform || 'whatsapp';
    const isGP = winData.questionsAnswered === winData.totalQuestions && winData.totalQuestions === 15;
    if (platform === 'telegram' && GIFEncoder) {
      try {
        const fp = await this.generateTelegramAnimatedGif(winData, isGP);
        return { filepath: fp, type: 'gif', caption: this.genCaption(winData, isGP), platform: 'telegram' };
      } catch (e) { logger.error('GIF failed:', e); }
    }
    return isGP ? this.generateGrandPrizePNG(winData) : this.generateRegularWinPNG(winData);
  }

  // ============================================
  // TOURNAMENT CARD — The flagship card
  // Layout: Badge → Score (hero) → Stats → Username → Challenge CTA
  // ============================================

  async generateTournamentCard(cardData) {
    const { username, city, questionsAnswered, timeTaken, rank, tournamentName } = cardData;
    const isPerfect = questionsAnswered === 15;
    const W = 1080, H = 1080;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    await this.drawBackground(ctx, W, H, isPerfect ? 'dark' : 'tournament');
    if (isPerfect) this.drawConfetti(ctx, W, H, ['#FFD700','#FFA500','#FFFF00'], 40, true);

    const ac = isPerfect ? '#FFD700' : '#00BFFF';  // accent
    const tx = isPerfect ? '#FFD700' : '#FFFFFF';   // text

    // ─── QR CODE (top-right, compact) ───
    await this.drawQRCode(ctx, W);

    // ─── TOURNAMENT NAME BADGE (top-left area, not full width) ───
    const bY = 35;
    ctx.fillStyle = ac;
    ctx.globalAlpha = 0.9;
    this.roundRect(ctx, 30, bY, 680, 55, 28);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = isPerfect ? '#1a0a2e' : '#FFFFFF';
    ctx.font = 'bold 26px Arial';
    ctx.textAlign = 'center';
    ctx.fillText((tournamentName || 'TOURNAMENT').toUpperCase(), 370, bY + 37);

    // ─── SCORE — THE HERO ELEMENT ───
    // This is what grabs attention when scrolling
    ctx.textAlign = 'center';
    ctx.fillStyle = tx;
    ctx.font = 'bold 120px Arial';
    ctx.shadowColor = isPerfect ? 'rgba(255,215,0,0.6)' : 'rgba(0,200,255,0.4)';
    ctx.shadowBlur = 25;
    ctx.fillText('Q' + questionsAnswered + '/15', W / 2, 210);
    ctx.shadowBlur = 0;

    // Small "reached" label above
    ctx.fillStyle = ac;
    ctx.font = 'bold 22px Arial';
    ctx.globalAlpha = 0.8;
    ctx.fillText(isPerfect ? 'PERFECT SCORE' : 'QUESTIONS REACHED', W / 2, 115);
    ctx.globalAlpha = 1;

    // ─── USERNAME (prominent, right below score) ───
    ctx.fillStyle = tx;
    ctx.font = 'bold 48px Arial';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 12;
    ctx.fillText('@' + (username || 'player'), W / 2, 290);
    ctx.shadowBlur = 0;

    if (city) {
      ctx.fillStyle = ac;
      ctx.font = '24px Arial';
      ctx.globalAlpha = 0.85;
      ctx.fillText(city, W / 2, 325);
      ctx.globalAlpha = 1;
    }

    // ─── STATS ROW (Time + Rank side by side in glass pills) ───
    const statY = 365;
    const timeStr = typeof timeTaken === 'number' ? timeTaken.toFixed(1) + 's' : timeTaken + 's';

    // Time pill
    ctx.fillStyle = 'rgba(10,5,35,0.55)';
    ctx.strokeStyle = isPerfect ? 'rgba(255,215,0,0.3)' : 'rgba(100,180,255,0.25)';
    ctx.lineWidth = 1.5;
    this.roundRect(ctx, W/2 - 280, statY, 250, 85, 16);
    ctx.fill(); ctx.stroke();

    ctx.fillStyle = ac; ctx.font = 'bold 18px Arial';
    ctx.fillText('TIME', W/2 - 155, statY + 30);
    ctx.fillStyle = tx; ctx.font = 'bold 36px Arial';
    ctx.fillText(timeStr, W/2 - 155, statY + 68);

    // Rank pill
    if (rank) {
      ctx.fillStyle = 'rgba(10,5,35,0.55)';
      this.roundRect(ctx, W/2 + 30, statY, 250, 85, 16);
      ctx.fill(); ctx.stroke();

      ctx.fillStyle = ac; ctx.font = 'bold 18px Arial';
      ctx.fillText('RANK', W/2 + 155, statY + 30);
      ctx.fillStyle = tx; ctx.font = 'bold 36px Arial';
      ctx.fillText('#' + rank, W/2 + 155, statY + 68);
    }

    // ─── CHALLENGE CTA — The conversion zone ───
    // This is what makes someone want to tap/join
    const ctaY = 500;

    // Dark glass panel behind CTA text
    ctx.fillStyle = 'rgba(10, 5, 35, 0.65)';
    this.roundRect(ctx, 40, ctaY, W - 80, 140, 20);
    ctx.fill();
    // Subtle border
    ctx.strokeStyle = isPerfect ? 'rgba(255,215,0,0.2)' : 'rgba(100,180,255,0.15)';
    ctx.lineWidth = 1;
    this.roundRect(ctx, 40, ctaY, W - 80, 140, 20);
    ctx.stroke();

    // Challenge text line 1
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 26px Arial';
    ctx.textAlign = 'center';
    const challengeLine1 = '@' + (username || 'player') + ' reached Q' + questionsAnswered + ' in ' + timeStr;
    ctx.fillText(challengeLine1, W / 2, ctaY + 40);

    // Challenge text line 2
    ctx.fillStyle = ac;
    ctx.font = 'bold 30px Arial';
    ctx.fillText('Think you can beat that?', W / 2, ctaY + 80);

    // URL line
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 24px Arial';
    ctx.globalAlpha = 0.9;
    ctx.fillText('Join: whatsuptrivia.com.ng', W / 2, ctaY + 118);
    ctx.globalAlpha = 1;

    // ─── BRANDING (small, bottom-right of the coin area) ───
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '16px Arial';
    ctx.textAlign = 'right';
    ctx.fillText("What's Up Trivia", W - 40, H - 30);
    ctx.textAlign = 'center';

    return this.saveCanvas(canvas, 'tournament');
  }

  // ============================================
  // REGULAR WIN CARD
  // Layout: Trophy → Amount (hero) → Username → Score → Challenge CTA
  // ============================================

  async generateRegularWinPNG(winData) {
    const { username, city, amount, questionsAnswered, totalQuestions } = winData;
    const W = 1080, H = 1080;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    await this.drawBackground(ctx, W, H, 'warm');
    this.drawConfetti(ctx, W, H, ['#FF6B6B','#4ECDC4','#FFD93D','#95E1D3','#FCBAD3','#FFF'], 50);
    await this.drawQRCode(ctx, W);

    // Trophy
    await this.drawTrophyImage(ctx, W, 30, 170, false);

    // "WINNER" badge
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 18;
    this.roundRect(ctx, W/2 - 120, 215, 240, 48, 24); ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#FF6B35'; ctx.font = 'bold 30px Arial'; ctx.textAlign = 'center';
    ctx.fillText('WINNER!', W/2, 248);

    // ─── AMOUNT — THE HERO ───
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 110px Arial';
    ctx.shadowColor = 'rgba(255,215,0,0.6)'; ctx.shadowBlur = 30;
    ctx.textAlign = 'center';
    ctx.fillText('N' + amount.toLocaleString(), W/2, 380);
    ctx.shadowBlur = 0;

    // Username
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 46px Arial';
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 10;
    ctx.fillText('@' + username, W/2, 450);
    ctx.shadowBlur = 0;

    if (city) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '24px Arial';
      ctx.fillText('from ' + city, W/2, 485);
    }

    // Score line
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 28px Arial';
    ctx.globalAlpha = 0.85;
    ctx.fillText(questionsAnswered + '/' + totalQuestions + ' Questions Correct on What\'s Up Trivia', W/2, 530);
    ctx.globalAlpha = 1;

    // ─── CHALLENGE CTA ───
    const ctaY = 570;
    ctx.fillStyle = 'rgba(10,5,35,0.6)';
    this.roundRect(ctx, 40, ctaY, W-80, 115, 20); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    this.roundRect(ctx, 40, ctaY, W-80, 115, 20); ctx.stroke();

    ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 24px Arial'; ctx.textAlign = 'center';
    ctx.fillText('@' + username + ' won N' + amount.toLocaleString() + ' playing trivia!', W/2, ctaY + 38);
    ctx.fillStyle = '#FFD93D'; ctx.font = 'bold 28px Arial';
    ctx.fillText('Your turn — can you win bigger?', W/2, ctaY + 74);
    ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 22px Arial'; ctx.globalAlpha = 0.9;
    ctx.fillText('Play now: whatsuptrivia.com.ng', W/2, ctaY + 105);
    ctx.globalAlpha = 1;

    // Branding
    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '16px Arial'; ctx.textAlign = 'right';
    ctx.fillText('SummerIsland Systems', W-40, H-30); ctx.textAlign = 'center';

    return this.saveCanvas(canvas, 'win');
  }

  // ============================================
  // GRAND PRIZE CARD
  // Layout: Banner → Trophy → Amount (hero) → Username → Perfect badge → CTA
  // ============================================

  async generateGrandPrizePNG(winData) {
    const { username, city, amount } = winData;
    const W = 1080, H = 1080;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    await this.drawBackground(ctx, W, H, 'dark');
    this.drawConfetti(ctx, W, H, ['#FFD700','#FFA500','#FFFF00','#FFE066'], 50, true);
    await this.drawQRCode(ctx, W);

    // Gold banner
    const bG = ctx.createLinearGradient(W/2-340, 35, W/2+340, 35);
    bG.addColorStop(0,'#FFD700'); bG.addColorStop(0.5,'#FFB000'); bG.addColorStop(1,'#FFD700');
    ctx.fillStyle = bG; ctx.shadowColor = 'rgba(255,215,0,0.7)'; ctx.shadowBlur = 25;
    this.roundRect(ctx, W/2-340, 35, 680, 55, 28); ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#1a0a2e'; ctx.font = 'bold 28px Arial'; ctx.textAlign = 'center';
    ctx.fillText('GRAND PRIZE WINNER!', W/2, 72);

    // Trophy
    await this.drawTrophyImage(ctx, W, 110, 200, true);

    // ─── AMOUNT — THE HERO ───
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 115px Arial';
    ctx.shadowColor = 'rgba(255,255,255,0.5)'; ctx.shadowBlur = 35;
    ctx.textAlign = 'center';
    ctx.fillText('N' + amount.toLocaleString(), W/2, 410);
    ctx.shadowBlur = 0;

    // Username
    ctx.fillStyle = '#FFD700';
    ctx.font = 'bold 48px Arial';
    ctx.shadowColor = 'rgba(255,215,0,0.5)'; ctx.shadowBlur = 15;
    ctx.fillText('@' + username, W/2, 480);
    ctx.shadowBlur = 0;

    if (city) {
      ctx.fillStyle = '#FFD700'; ctx.font = '24px Arial'; ctx.globalAlpha = 0.8;
      ctx.fillText('from ' + city, W/2, 515); ctx.globalAlpha = 1;
    }

    // Perfect score badge
    ctx.fillStyle = 'rgba(255,215,0,0.15)';
    this.roundRect(ctx, W/2-140, 535, 280, 42, 21); ctx.fill();
    ctx.strokeStyle = 'rgba(255,215,0,0.4)'; ctx.lineWidth = 1.5;
    this.roundRect(ctx, W/2-140, 535, 280, 42, 21); ctx.stroke();
    ctx.fillStyle = '#FFD700'; ctx.font = 'bold 22px Arial';
    ctx.fillText('15/15 PERFECT SCORE', W/2, 563);

    // ─── CHALLENGE CTA ───
    const ctaY = 610;
    ctx.fillStyle = 'rgba(10,5,35,0.65)';
    this.roundRect(ctx, 40, ctaY, W-80, 115, 20); ctx.fill();
    ctx.strokeStyle = 'rgba(255,215,0,0.2)'; ctx.lineWidth = 1;
    this.roundRect(ctx, 40, ctaY, W-80, 115, 20); ctx.stroke();

    ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 24px Arial'; ctx.textAlign = 'center';
    ctx.fillText('@' + username + ' answered all 15 questions and won N' + amount.toLocaleString() + '!', W/2, ctaY + 38);
    ctx.fillStyle = '#FFD700'; ctx.font = 'bold 28px Arial';
    ctx.fillText('Can you go all the way?', W/2, ctaY + 74);
    ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 22px Arial'; ctx.globalAlpha = 0.9;
    ctx.fillText('Play now: whatsuptrivia.com.ng', W/2, ctaY + 105);
    ctx.globalAlpha = 1;

    ctx.fillStyle = 'rgba(255,215,0,0.3)'; ctx.font = '16px Arial'; ctx.textAlign = 'right';
    ctx.fillText('SummerIsland Systems', W-40, H-30); ctx.textAlign = 'center';

    return this.saveCanvas(canvas, 'grand');
  }

  // ============================================
  // HELPERS
  // ============================================

  saveCanvas(canvas, prefix) {
    const f = prefix + '_' + Date.now() + '.png';
    const fp = path.join(this.tempDir, f);
    fs.writeFileSync(fp, canvas.toBuffer('image/png', { compressionLevel: 6 }));
    logger.info('Card: ' + f);
    return fp;
  }

  async drawQRCode(ctx, W) {
    const sz = 140, pad = 25;
    const link = 'https://wa.me/' + (process.env.WHATSAPP_PHONE_NUMBER || '2348030890744');
    try {
      const url = await QRCode.toDataURL(link, { width: sz, margin: 1, color: { dark: '#1a0a2e', light: '#FFFFFF' } });
      const img = await loadImage(url);
      ctx.fillStyle = 'rgba(10,5,35,0.5)';
      this.roundRect(ctx, W-sz-pad-8, pad-8, sz+16, sz+16, 12); ctx.fill();
      ctx.drawImage(img, W-sz-pad, pad, sz, sz);
    } catch (e) { logger.error('QR:', e); }
  }

  async drawTrophyImage(ctx, W, y, size, isGold) {
    const trophy = await this.loadAsset('trophy.png');
    if (trophy) {
      ctx.shadowColor = isGold ? 'rgba(255,215,0,0.8)' : 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = isGold ? 30 : 15; ctx.shadowOffsetY = 6;
      ctx.drawImage(trophy, W/2-size/2, y, size, size);
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    } else {
      const cx = W/2, cy = y+size/2, s = size*0.6;
      ctx.save(); ctx.fillStyle = '#FFD700';
      ctx.shadowColor = isGold ? '#FFD700' : 'rgba(0,0,0,0.3)'; ctx.shadowBlur = isGold ? 30 : 10;
      ctx.beginPath(); ctx.arc(cx, cy, s*0.38, 0, Math.PI*2); ctx.fill();
      ctx.fillRect(cx-s*0.1, cy+s*0.28, s*0.2, s*0.18);
      ctx.fillRect(cx-s*0.28, cy+s*0.45, s*0.56, s*0.1);
      ctx.restore();
    }
  }

  drawConfetti(ctx, W, H, colors, count, isGold) {
    for (let i = 0; i < count; i++) {
      ctx.save();
      const x = Math.random()*W, y = Math.random()*H*0.72;
      const sz = (isGold ? 8 : 6) + Math.random()*8;
      ctx.translate(x, y); ctx.rotate(Math.random()*Math.PI*2);
      ctx.fillStyle = colors[Math.floor(Math.random()*colors.length)];
      ctx.globalAlpha = 0.6 + Math.random()*0.4;
      if (isGold) { ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 7; }
      const s = Math.random();
      if (s > 0.6) { ctx.beginPath(); ctx.arc(0,0,sz/2,0,Math.PI*2); ctx.fill(); }
      else if (s > 0.3) ctx.fillRect(-sz/2,-sz/3,sz,sz*1.4);
      else { ctx.beginPath(); ctx.moveTo(0,-sz/2); ctx.lineTo(sz/2,sz/2); ctx.lineTo(-sz/2,sz/2); ctx.closePath(); ctx.fill(); }
      ctx.restore();
    }
  }

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
    ctx.quadraticCurveTo(x+w,y,x+w,y+r); ctx.lineTo(x+w,y+h-r);
    ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
    ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r);
    ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
  }

  // ============================================
  // TELEGRAM GIF
  // ============================================

  async generateTelegramAnimatedGif(winData, isGP) {
    if (!GIFEncoder) throw new Error('No GIFEncoder');
    const { username, city, amount, questionsAnswered, totalQuestions } = winData;
    const W = 1080, H = 1080;
    const f = 'tg_' + Date.now() + '.gif';
    const fp = path.join(this.tempDir, f);
    const enc = new GIFEncoder(W, H);
    enc.createReadStream().pipe(fs.createWriteStream(fp));
    enc.start(); enc.setRepeat(0); enc.setDelay(33); enc.setQuality(10);
    const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');

    for (let frame = 0; frame < 60; frame++) {
      const p = frame / 60;
      ctx.clearRect(0, 0, W, H);
      await this.drawBackground(ctx, W, H, isGP ? 'dark' : 'warm');

      // Animated confetti
      if (p > 0.1) {
        const cols = isGP ? ['#FFD700','#FFA500','#FFFF00'] : ['#FF6B6B','#4ECDC4','#FFD93D'];
        for (let i = 0; i < 45; i++) {
          ctx.save();
          ctx.translate((i/45)*W + Math.sin(p*12+i)*40, ((i%10)*(H/10)+p*H*0.25)%(H*0.72));
          ctx.rotate(p*12+i); ctx.fillStyle = cols[i%cols.length]; ctx.globalAlpha = 0.55;
          const sz = 6+Math.random()*7;
          if (i%3===0) { ctx.beginPath(); ctx.arc(0,0,sz/2,0,Math.PI*2); ctx.fill(); }
          else ctx.fillRect(-sz/2,-sz/3,sz,sz*1.3);
          ctx.restore();
        }
      }

      const ease = t => t<0.5?2*t*t:-1+(4-2*t)*t;
      const bounce = t => { if(t>=1)return 1;const n=7.5625,d=2.75;if(t<1/d)return n*t*t;if(t<2/d)return n*(t-=1.5/d)*t+0.75;if(t<2.5/d)return n*(t-=2.25/d)*t+0.9375;return n*(t-=2.625/d)*t+0.984375; };

      // QR
      if (p > 0.05) { ctx.globalAlpha = ease(Math.min((p-0.05)/0.1,1)); await this.drawQRCode(ctx, W); ctx.globalAlpha = 1; }

      // Trophy (bounce in)
      if (p > 0.1) {
        const tp = Math.min((p-0.1)/0.25,1);
        ctx.globalAlpha = Math.min(tp*2,1);
        if (isGP) {
          const bg = ctx.createLinearGradient(W/2-340,35,W/2+340,35); bg.addColorStop(0,'#FFD700'); bg.addColorStop(1,'#FFB000');
          ctx.fillStyle = bg; this.roundRect(ctx,W/2-340,35,680,55,28); ctx.fill();
          ctx.fillStyle = '#1a0a2e'; ctx.font = 'bold 28px Arial'; ctx.textAlign = 'center'; ctx.fillText('GRAND PRIZE WINNER!',W/2,72);
          await this.drawTrophyImage(ctx, W, 110+(1-bounce(tp))*150, 200, true);
        } else {
          await this.drawTrophyImage(ctx, W, 30+(1-bounce(tp))*150, 170, false);
        }
        ctx.globalAlpha = 1;
      }

      // Badge
      if (!isGP && p > 0.3) {
        ctx.globalAlpha = ease(Math.min((p-0.3)/0.12,1));
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        this.roundRect(ctx,W/2-120,215,240,48,24); ctx.fill();
        ctx.fillStyle = '#FF6B35'; ctx.font = 'bold 30px Arial'; ctx.textAlign = 'center';
        ctx.fillText('WINNER!',W/2,248);
        ctx.globalAlpha = 1;
      }

      // Main text
      if (p > 0.35) {
        ctx.globalAlpha = ease(Math.min((p-0.35)/0.35,1));
        ctx.textAlign = 'center';
        ctx.shadowColor = isGP ? 'rgba(255,215,0,0.5)' : 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 12;

        if (isGP) {
          ctx.fillStyle = '#FFF'; ctx.font = 'bold 115px Arial'; ctx.fillText('N'+amount.toLocaleString(), W/2, 410);
          ctx.fillStyle = '#FFD700'; ctx.font = 'bold 48px Arial'; ctx.fillText('@'+username, W/2, 480);
        } else {
          ctx.fillStyle = '#FFF'; ctx.font = 'bold 110px Arial'; ctx.fillText('N'+amount.toLocaleString(), W/2, 380);
          ctx.fillStyle = '#FFF'; ctx.font = 'bold 46px Arial'; ctx.fillText('@'+username, W/2, 450);
          ctx.font = 'bold 28px Arial'; ctx.globalAlpha *= 0.85;
          ctx.fillText(questionsAnswered+'/'+totalQuestions+' Correct on What\'s Up Trivia', W/2, 500);
        }
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }

      // CTA
      if (p > 0.6) {
        ctx.globalAlpha = ease(Math.min((p-0.6)/0.25,1));
        const cy = isGP ? 610 : 570;
        ctx.fillStyle = 'rgba(10,5,35,0.6)';
        this.roundRect(ctx, 40, cy, W-80, 100, 20); ctx.fill();
        ctx.fillStyle = '#FFF'; ctx.font = 'bold 24px Arial'; ctx.textAlign = 'center';
        ctx.fillText(isGP ? '@'+username+' answered all 15 and won N'+amount.toLocaleString()+'!' : '@'+username+' won N'+amount.toLocaleString()+' playing trivia!', W/2, cy+35);
        ctx.fillStyle = isGP ? '#FFD700' : '#FFD93D'; ctx.font = 'bold 26px Arial';
        ctx.fillText(isGP ? 'Can you go all the way?' : 'Your turn — can you win bigger?', W/2, cy+68);
        ctx.fillStyle = '#FFF'; ctx.font = 'bold 20px Arial'; ctx.globalAlpha *= 0.9;
        ctx.fillText('Play: whatsuptrivia.com.ng', W/2, cy+95);
        ctx.globalAlpha = 1;
      }

      enc.addFrame(ctx);
    }
    enc.finish();
    logger.info('GIF: ' + f);
    return fp;
  }

  genCaption(wd, isGP) {
    const { username, city, amount, questionsAnswered, totalQuestions } = wd;
    if (isGP) return '🏆 *GRAND PRIZE!* @'+username+' from '+city+' won ₦'+amount.toLocaleString()+'! 15/15 Perfect!\n\n🎮 Play: whatsuptrivia.com.ng';
    return '🎊 @'+username+' from '+city+' won ₦'+amount.toLocaleString()+'! ('+questionsAnswered+'/'+totalQuestions+')\n\n🎮 Play: whatsuptrivia.com.ng';
  }

  cleanupTempFiles() {
    try { fs.readdirSync(this.tempDir).forEach(f => { const fp = path.join(this.tempDir,f); if(Date.now()-fs.statSync(fp).mtimeMs>3600000) fs.unlinkSync(fp); }); } catch(e){} }
}

module.exports = ImageService;