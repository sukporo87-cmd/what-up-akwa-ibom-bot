// ============================================
// FILE: src/services/card-template.service.js
// The shared look for every result card.
// ============================================
//
// WHY THIS EXISTS. Classic, tournament and challenge cards were three separate
// pieces of drawing code that had drifted into three different designs. This
// holds the parts they share — background, logo, trophy, the WINNER pill, the
// message panel, the join button, and the way money is written — so a change
// to the brand is one change, not three.
//
// TWO BACKGROUNDS, ON PURPOSE:
//   cosmic  Classic and tournament. A win against the house, on the deep blue
//           confetti field the brand mock uses.
//   gold    Challenges. A head-to-head reads differently from a solo win, and
//           the gold field separates the two at a glance in a chat list.
// Each carries its own text palette, because white text that sings on the
// cosmic field is illegible on gold.
//
// NO QR CODE. Removed by founder decision, 17 Sep; the logo takes its corner.
// The join link stays as text.

const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');
const { logger } = require('../utils/logger');

const ASSETS = path.join(__dirname, '..', 'assets');
const FONTS = path.join(ASSETS, 'fonts');

// ============================================
// FONTS
// ============================================
// The old cards asked for 'Arial', which does not exist on a Linux server, so
// fontconfig substituted whatever it had and every card rendered in a face
// nobody chose. The display font now ships WITH the app, so a card looks the
// same on a laptop, on Render, and after any base-image change.
//
// Poppins, SIL Open Font License 1.1 — redistributable, including bundled in
// an application. Latin subset only; see drawNaira for what that costs.
let fontsReady = false;

function ensureFonts() {
    if (fontsReady) return;
    const faces = [
        ['Poppins-ExtraBold.ttf', { family: 'WUT', weight: '800' }],
        ['Poppins-Bold.ttf', { family: 'WUT', weight: 'bold' }],
        ['Poppins-SemiBold.ttf', { family: 'WUT', weight: '600' }],
        ['Poppins-Medium.ttf', { family: 'WUT', weight: 'normal' }]
    ];
    for (const [file, spec] of faces) {
        const fp = path.join(FONTS, file);
        try {
            if (fs.existsSync(fp)) registerFont(fp, spec);
            else logger.warn(`Card font missing: ${file}`);
        } catch (e) {
            logger.warn(`Could not register ${file}: ${e.message}`);
        }
    }
    fontsReady = true;
}

// Every size goes through here so no drawing code hardcodes a family name.
const font = (size, weight = '800') => `${weight} ${size}px WUT, sans-serif`;

// ============================================
// PALETTES
// ============================================
const PALETTES = {
    cosmic: {
        background: 'card-bg-cosmic.jpg',
        text: '#ffffff',
        dim: 'rgba(255,255,255,.78)',
        faint: 'rgba(255,255,255,.6)',
        accent: '#ffc233',
        money: '#ffffff',
        moneyGlow: 'rgba(255,196,60,.55)',
        panelText: '#ffffff',
        panelDim: 'rgba(255,255,255,.72)',
        shadow: 'rgba(0,0,0,.55)'
    },
    gold: {
        background: 'card-bg-gold.jpg',
        // Deep navy on gold. White on this field is unreadable, and a result
        // card nobody can read is worse than no card.
        text: '#1a1348',
        dim: 'rgba(26,19,72,.82)',
        faint: 'rgba(26,19,72,.62)',
        accent: '#7a3bd6',
        money: '#1a1348',
        moneyGlow: 'rgba(255,255,255,.75)',
        panelText: '#ffffff',
        panelDim: 'rgba(255,255,255,.75)',
        shadow: 'rgba(120,80,0,.35)'
    }
};

const assetCache = new Map();

async function asset(name) {
    if (assetCache.has(name)) return assetCache.get(name);
    const fp = path.join(ASSETS, name);
    if (!fs.existsSync(fp)) {
        logger.warn(`Card asset missing: ${name}`);
        assetCache.set(name, null);
        return null;
    }
    const img = await loadImage(fp);
    assetCache.set(name, img);
    return img;
}

// ============================================
// DRAWING KIT
// ============================================

// Draw an image centred on cx, scaled to a target width.
async function place(ctx, name, cx, y, width) {
    const img = await asset(name);
    if (!img) return 0;
    const h = img.height * (width / img.width);
    ctx.drawImage(img, Math.round(cx - width / 2), Math.round(y), Math.round(width), Math.round(h));
    return h;
}

// THE NAIRA SIGN.
//
// Poppins' latin subset has no ₦ (U+20A6), and neither does the default font
// on the server — which is exactly why the old cards read "N1,000". Rather
// than mixing in a second typeface for one glyph at 150px, the sign is drawn:
// the font's own N, plus the two bars. It keeps the weight and the shape of
// whatever size it is asked for.
function drawNaira(ctx, x, y, size, fill) {
    ctx.save();
    ctx.font = font(size, '800');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = fill;
    const w = ctx.measureText('N').width;
    ctx.fillText('N', x, y);

    // Two bars across the stem. Positioned from the CAP HEIGHT rather than
    // the em box, or they sit low enough to read as a strikethrough, and kept
    // tight to the letter so the sign does not look crossed out.
    const cap = size * 0.70;
    const capTop = y - cap;
    const barH = Math.max(2, size * 0.062);
    const overhang = size * 0.022;
    for (const frac of [0.40, 0.62]) {
        ctx.fillRect(x - overhang, capTop + cap * frac, w + overhang * 2, barH);
    }
    ctx.restore();
    return w;
}

// Money, centred, with the glow the brand mock uses.
function drawMoney(ctx, amount, cx, baseline, size, palette) {
    const digits = Number(amount || 0).toLocaleString('en-NG');
    ctx.save();
    ctx.font = font(size, '800');
    const digitsW = ctx.measureText(digits).width;

    ctx.font = font(size, '800');
    const signW = ctx.measureText('N').width;
    const gap = size * 0.06;
    const totalW = signW + gap + digitsW;
    const left = cx - totalW / 2;

    // Glow first, so the fill sits crisply on top of it.
    ctx.shadowColor = palette.moneyGlow;
    ctx.shadowBlur = size * 0.32;
    drawNaira(ctx, left, baseline, size, palette.money);
    ctx.font = font(size, '800');
    ctx.textAlign = 'left';
    ctx.fillStyle = palette.money;
    ctx.fillText(digits, left + signW + gap, baseline);
    ctx.restore();
    return totalW;
}

// The join bar. DRAWN, not placed: the supplied artwork arrived with its
// transparency flattened onto a checkerboard, and its neon halo could not be
// recovered. Drawing it also keeps it sharp at any size and lets the words
// change without new artwork.
function drawJoinBar(ctx, cx, y, w, h, label) {
    const r = h / 2;
    ctx.save();

    const grad = ctx.createLinearGradient(cx - w / 2, y, cx + w / 2, y + h);
    grad.addColorStop(0, '#1e7bff');
    grad.addColorStop(0.5, '#5b3ff0');
    grad.addColorStop(1, '#a13cf0');

    const rounded = () => {
        ctx.beginPath();
        ctx.moveTo(cx - w / 2 + r, y);
        ctx.lineTo(cx + w / 2 - r, y);
        ctx.arc(cx + w / 2 - r, y + r, r, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(cx - w / 2 + r, y + h);
        ctx.arc(cx - w / 2 + r, y + r, r, Math.PI / 2, -Math.PI / 2);
        ctx.closePath();
    };

    ctx.shadowColor = 'rgba(120,80,255,.7)';
    ctx.shadowBlur = 34;
    rounded();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Gold rim.
    const rim = ctx.createLinearGradient(cx - w / 2, y, cx + w / 2, y + h);
    rim.addColorStop(0, '#f7dd8a');
    rim.addColorStop(0.5, '#c9962f');
    rim.addColorStop(1, '#f7dd8a');
    rounded();
    ctx.lineWidth = Math.max(3, h * 0.07);
    ctx.strokeStyle = rim;
    ctx.stroke();

    // Gloss along the top half.
    const gloss = ctx.createLinearGradient(0, y, 0, y + h * 0.55);
    gloss.addColorStop(0, 'rgba(255,255,255,.34)');
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    rounded();
    ctx.fillStyle = gloss;
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = h * 0.30;
    ctx.font = font(size, '800');
    while (ctx.measureText(label).width > w - h * 0.9 && size > 10) {
        size -= 1;
        ctx.font = font(size, '800');
    }
    ctx.fillText(label, cx, y + h / 2 + 1);
    ctx.restore();
}

// The badge pill. The supplied artwork has "WINNER!" baked into it, so a
// challenge card could only ever say the same word as a Classic one. Drawn,
// the wording follows the card: "WINNER!" on a Classic or tournament win,
// "CHALLENGE WINNER!!!" on a challenge, all on one badge rather than a label
// stacked above it.
//
// Poppins ships no italic in the bundled subset, so the slant is applied as a
// transform. It is the asset's own look: white lozenge, warm outer glow,
// orange caps leaning forward.
function drawPill(ctx, label, cx, y, maxW, h) {
    ctx.save();
    const padX = h * 0.62;
    let size = h * 0.46;
    ctx.font = font(size, '800');
    let textW = ctx.measureText(label).width;
    let w = textW + padX * 2;
    if (w > maxW) {
        size = Math.max(14, size * ((maxW - padX * 2) / textW));
        ctx.font = font(size, '800');
        textW = ctx.measureText(label).width;
        w = Math.min(maxW, textW + padX * 2);
    }
    const r = h / 2;
    const rounded = () => {
        ctx.beginPath();
        ctx.moveTo(cx - w / 2 + r, y);
        ctx.lineTo(cx + w / 2 - r, y);
        ctx.arc(cx + w / 2 - r, y + r, r, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(cx - w / 2 + r, y + h);
        ctx.arc(cx - w / 2 + r, y + r, r, Math.PI / 2, -Math.PI / 2);
        ctx.closePath();
    };

    ctx.shadowColor = 'rgba(255,186,80,.85)';
    ctx.shadowBlur = h * 0.42;
    rounded();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.shadowBlur = 0;

    // The asset's body is not flat white; it lifts at the top.
    const body = ctx.createLinearGradient(0, y, 0, y + h);
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.62, '#fdfbf7');
    body.addColorStop(1, '#efe7da');
    rounded();
    ctx.fillStyle = body;
    ctx.fill();

    rounded();
    ctx.lineWidth = Math.max(1.5, h * 0.022);
    ctx.strokeStyle = 'rgba(255,205,120,.9)';
    ctx.stroke();

    // Leaning caps, like the artwork.
    ctx.translate(cx, y + h / 2);
    ctx.transform(1, 0, -0.16, 1, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(size, '800');
    ctx.fillStyle = '#f2791a';
    ctx.fillText(label, 0, size * 0.04);
    ctx.restore();
    return { width: w, height: h };
}

// The message panel. DRAWN for the same reason as the join bar, plus one of
// its own: the supplied artwork is nearly square (900x535) while the panel in
// the brand mock is a wide, shallow band. Scaling the artwork to the width the
// layout needs makes it four times too tall; stretching it instead would pull
// its rounded corners into ovals. Drawn, it takes whatever shape the content
// needs and keeps an even radius.
function drawPanel(ctx, cx, y, w, h) {
    const r = Math.min(h / 2, 54);
    ctx.save();
    const rounded = () => {
        ctx.beginPath();
        ctx.moveTo(cx - w / 2 + r, y);
        ctx.lineTo(cx + w / 2 - r, y);
        ctx.quadraticCurveTo(cx + w / 2, y, cx + w / 2, y + r);
        ctx.lineTo(cx + w / 2, y + h - r);
        ctx.quadraticCurveTo(cx + w / 2, y + h, cx + w / 2 - r, y + h);
        ctx.lineTo(cx - w / 2 + r, y + h);
        ctx.quadraticCurveTo(cx - w / 2, y + h, cx - w / 2, y + h - r);
        ctx.lineTo(cx - w / 2, y + r);
        ctx.quadraticCurveTo(cx - w / 2, y, cx - w / 2 + r, y);
        ctx.closePath();
    };

    const body = ctx.createLinearGradient(0, y, 0, y + h);
    body.addColorStop(0, 'rgba(28,24,68,.92)');
    body.addColorStop(1, 'rgba(18,15,46,.94)');
    rounded();
    ctx.fillStyle = body;
    ctx.fill();

    const rim = ctx.createLinearGradient(cx - w / 2, y, cx + w / 2, y + h);
    rim.addColorStop(0, 'rgba(150,130,255,.75)');
    rim.addColorStop(0.5, 'rgba(120,100,230,.35)');
    rim.addColorStop(1, 'rgba(180,120,255,.75)');
    rounded();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = rim;
    ctx.stroke();
    ctx.restore();
}

// One line of text, centred, shrinking until it fits.
function fitText(ctx, text, cx, y, maxW, size, weight, fill, minSize = 12) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = fill;
    let s = size;
    ctx.font = font(s, weight);
    while (ctx.measureText(text).width > maxW && s > minSize) {
        s -= 2;
        ctx.font = font(s, weight);
    }
    ctx.fillText(text, cx, y);
    ctx.restore();
    return s;
}

// Start a card: background, logo in the corner.
async function startCard(variant, W = 1080, H = 1080) {
    ensureFonts();
    const palette = PALETTES[variant] || PALETTES.cosmic;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    const bg = await asset(palette.background);
    if (bg) ctx.drawImage(bg, 0, 0, W, H);
    else { ctx.fillStyle = '#1a1348'; ctx.fillRect(0, 0, W, H); }

    // Logo, top right, where the QR used to be.
    const logo = await asset('card-logo.png');
    if (logo) {
        const lw = Math.round(W * 0.21);
        const lh = logo.height * (lw / logo.width);
        ctx.drawImage(logo, W - lw - Math.round(W * 0.045), Math.round(H * 0.035), lw, lh);
    }

    return { canvas, ctx, palette, W, H };
}

module.exports = {
    ensureFonts, font, PALETTES, asset, place,
    drawNaira, drawMoney, drawJoinBar, drawPanel, drawPill, fitText, startCard
};