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
const CT = require('./card-template.service');

// One call to action on every card, so the wording is changed in one place.
const JOIN_LABEL = 'SIGN UP TO PLAY AT WHATSUPTRIVIA.COM.NG';
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
  // TOURNAMENT CARD
  // ============================================
  async generateTournamentCard(cardData) {
    const { username, city, questionsAnswered, timeTaken, rank, tournamentName, prizeAmount } = cardData;
    const { canvas, ctx, palette, W, H } = await CT.startCard('cosmic');
    await this._tiva(ctx, W, H, 0.30);

    const money = Number(prizeAmount) || 0;
    const place = parseInt(rank, 10);
    const trophyH = await CT.place(ctx, 'card-trophy.png', W * 0.56, 14, money ? 200 : 214);
    CT.drawPill(ctx, place ? `RANK #${place}` : 'TOURNAMENT', W * 0.56, 16 + trophyH + 4, 660, 82);

    // The tournament's own name. It used to be whatever the caller happened to
    // pass, which was 'Tournament' more often than not.
    CT.fitText(ctx, String(tournamentName || 'Tournament').toUpperCase(),
               W * 0.56, money ? 452 : 486, 730, 36, '800', palette.accent);

    // What the rank is worth. A tournament win pays, and a card that showed a
    // placing but no money read as the smaller prize beside a Classic card.
    if (money > 0) CT.drawMoney(ctx, money, W * 0.56, 556, 104, palette);

    CT.fitText(ctx, '@' + username, W * 0.56, money ? 618 : 566, 720, money ? 48 : 58, '800', palette.text);
    if (city) CT.fitText(ctx, 'from ' + city, W * 0.56, money ? 658 : 610, 700, 29, 'normal', palette.dim);
    CT.fitText(ctx, `${questionsAnswered}/15 correct \u00b7 ${timeTaken}s`,
               W * 0.56, money ? 698 : 654, 760, 27, '600', palette.faint);

    this._panel(ctx, W, money ? 738 : 706, [
      place
        ? `@${username} placed ${this._ordinal(place)} in ${tournamentName}`
        : `@${username} played ${tournamentName}`,
      'Think you can top the table?',
      'Play now: whatsuptrivia.com.ng'
    ]);
    CT.drawJoinBar(ctx, W / 2, H - 104, 890, 74, JOIN_LABEL);
    return this.saveCanvas(canvas, 'tournament');
  }

  // ============================================
  // CHALLENGE CARD
  // ============================================
  // Two players get a head-to-head; three or more get standings. Past five,
  // the first five are listed and the remainder counted, because a card with
  // twelve rows on it is a spreadsheet.
  async generateChallengeCard(cardData) {
    const {
      winnerName, winnerScore, winnerTimeMs,
      loserName, loserScore, loserTimeMs,
      categories, isGroup, groupSize, standings
    } = cardData;

    const { canvas, ctx, palette, W, H } = await CT.startCard('gold');
    await this._tiva(ctx, W, H, 0.28);

    // Below the logo, never across it: the badge is wide and the logo owns
    // the top-right corner.
    CT.drawPill(ctx, 'CHALLENGE WINNER!!!', W * 0.55, 148, 700, 82);

    const cats = Array.isArray(categories) ? categories.join(' \u00b7 ') : String(categories || '');
    CT.fitText(ctx, cats.replace(/[_-]+/g, ' ').toUpperCase(), W * 0.55, 292, 720, 40, '800', palette.text);

    const secs = (ms) => (Number(ms) > 0 ? (Number(ms) / 1000).toFixed(1) + 's' : '');
    let rows = Array.isArray(standings) && standings.length
      ? standings.map(p => [String(p.username || '').replace(/^@/, ''),
                            `${p.score}/15`, secs(p.timeMs)])
      : [[String(winnerName || '').replace(/^@/, ''), `${winnerScore}/15`, secs(winnerTimeMs)],
         [String(loserName || '').replace(/^@/, ''), `${loserScore}/15`, secs(loserTimeMs)]];
    rows = rows.filter(r => r[0]);

    const total = (isGroup && Number(groupSize)) ? Number(groupSize) : rows.length;
    const shown = rows.slice(0, 5);
    const head = shown.length === 2;

    const rh = head ? 130 : 66, gap = head ? 20 : 7;
    let y = head ? 346 : 320;
    const rx = Math.round(W * 0.26), rw = Math.round(W * 0.70);
    shown.forEach((p, i) => { this._standingRow(ctx, rx, y, rw, rh, i + 1, '@' + p[0], p[1], p[2], i === 0); y += rh + gap; });
    y -= gap;

    const others = Math.max(0, total - shown.length);
    if (others > 0) {
      CT.fitText(ctx, `and ${others} other player${others === 1 ? '' : 's'}`,
                 W * 0.55, y + 36, 700, 28, '800', palette.text);
      y += 48;
    }

    // The panel starts below whatever the rows needed. A fixed position clips
    // the overflow line the moment a fifth row appears.
    const panelY = Math.max(head ? 706 : 722, y + 26);
    const beaten = Math.max(1, total - 1);
    this._panel(ctx, W, panelY, [
      `@${shown[0][0]} defeated ${beaten} ${beaten === 1 ? 'friend' : 'friends'} in a What's Up Trivia Challenge`,
      'Challenge your friends to a game of Knowledge?',
      'Sign up, create your challenge & invite friends to play'
    ]);
    CT.drawJoinBar(ctx, W / 2, H - 104, 890, 74, JOIN_LABEL);
    return this.saveCanvas(canvas, 'challenge');
  }

  // ============================================
  // CLASSIC WIN
  // ============================================
  async generateRegularWinPNG(winData) {
    return this._classicCard(winData, false);
  }

  async generateGrandPrizePNG(winData) {
    return this._classicCard(winData, true);
  }

  async _classicCard(winData, grand) {
    const { username, city, amount, questionsAnswered } = winData;
    const { canvas, ctx, palette, W, H } = await CT.startCard('cosmic');
    await this._tiva(ctx, W, H, 0.30);

    const trophyH = await CT.place(ctx, 'card-trophy.png', W * 0.56, 14, grand ? 266 : 232);
    CT.drawPill(ctx, grand ? 'GRAND PRIZE WINNER!!!' : 'WINNER!',
                W * 0.56, 18 + trophyH + 6, 680, grand ? 88 : 84);
    CT.drawMoney(ctx, amount, W * 0.56, grand ? 596 : 562, grand ? 128 : 120, palette);
    CT.fitText(ctx, '@' + username, W * 0.56, grand ? 662 : 632, 700, 54, '800', palette.text);
    if (city) CT.fitText(ctx, 'from ' + city, W * 0.56, grand ? 702 : 674, 700, 30, 'normal', palette.dim);
    CT.fitText(ctx, `${questionsAnswered}/15 Questions Correct on What's Up Trivia`,
               W * 0.56, grand ? 740 : 714, 760, 25, '600', palette.faint);

    this._panel(ctx, W, 750, [
      `@${username} won \u20a6${Number(amount || 0).toLocaleString('en-NG')} playing What's Up Trivia!`,
      'Your turn \u2014 can you win bigger?',
      'Play now: whatsuptrivia.com.ng'
    ]);
    CT.drawJoinBar(ctx, W / 2, H - 104, 890, 74, JOIN_LABEL);
    return this.saveCanvas(canvas, grand ? 'grandprize' : 'victory-card');
  }

  // ---- shared bits of the new layout ----

  async _tiva(ctx, W, H, frac) {
    const im = await CT.asset('card-tiva.png');
    if (!im) return;
    const tw = Math.round(W * frac), th = im.height * (tw / im.width);
    ctx.drawImage(im, -Math.round(W * 0.035), H - th, tw, th);
  }

  _panel(ctx, W, y, lines) {
    const w = 886, h = 168;
    CT.drawPanel(ctx, W / 2, y, w, h);
    CT.fitText(ctx, lines[0], W / 2, y + 54, w - 80, lines[0].length > 48 ? 27 : 31, '800', '#ffffff');
    CT.fitText(ctx, lines[1], W / 2, y + 100, w - 80, 30, '800', '#ffc233');
    CT.fitText(ctx, lines[2], W / 2, y + 144, w - 80, 24, 'normal', 'rgba(255,255,255,.78)');
  }

  _standingRow(ctx, x, y, w, h, rank, name, score, time, top) {
    ctx.save();
    const r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
    ctx.fillStyle = top ? 'rgba(26,19,72,.93)' : 'rgba(26,19,72,.72)';
    ctx.fill();
    if (top) { ctx.lineWidth = 3; ctx.strokeStyle = '#ffd257'; ctx.stroke(); }

    ctx.textBaseline = 'middle';
    ctx.fillStyle = top ? '#ffd257' : 'rgba(255,255,255,.55)';
    ctx.font = CT.font(h * 0.36, '800'); ctx.textAlign = 'center';
    ctx.fillText(String(rank), x + 38, y + h / 2);

    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left';
    ctx.font = CT.font(h * 0.34, '800');
    ctx.fillText(name, x + 72, y + h / 2 - (time ? h * 0.13 : 0));
    if (time) {
      ctx.fillStyle = 'rgba(255,255,255,.6)';
      ctx.font = CT.font(h * 0.24, 'normal');
      ctx.fillText(time, x + 72, y + h / 2 + h * 0.24);
    }

    ctx.textAlign = 'right';
    ctx.fillStyle = top ? '#ffd257' : '#ffffff';
    ctx.font = CT.font(h * 0.42, '800');
    ctx.fillText(score, x + w - 34, y + h / 2);
    ctx.restore();
  }

  _ordinal(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return n + 'th';
    return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
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

  // `link` is optional. Every existing caller omits it and gets the wa.me
  // destination it always got; the challenge card passes a rematch URL so the
  // QR is the growth loop rather than a generic "come to the bot" code.
  async drawQRCode(ctx, W, link = null) {
    const sz = 140, pad = 25;
    link = link || ('https://wa.me/' + (process.env.WHATSAPP_PHONE_NUMBER || '2348030890744'));
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