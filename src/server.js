// ============================================
// FILE: src/server.js - UPDATED VERSION
// Multi-platform support (WhatsApp + Telegram)
// ============================================
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const webhookRoutes = require('./routes/webhook.routes');
const paymentRoutes = require('./routes/payment.routes');
const adminRoutes = require('./routes/admin.routes');
const publicRoutes = require('./routes/public.routes');
const webAuthRoutes = require('./routes/web-auth.routes');
const newsletterRoutes = require('./routes/newsletter.routes');
const webGameRoutes = require('./routes/web-game.routes');
const webPaymentRoutes = require('./routes/web-payment.routes');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,  // Allow inline scripts for admin dashboard
}));
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// play.<domain> should serve the game at the bare root, not require /play.html.
// Must sit ABOVE express.static so it wins the '/' match.
app.get('/', (req, res, next) => {
  if (req.hostname.startsWith('play.')) {
    return res.sendFile('play.html', { root: path.join(__dirname, 'views') });
  }
  next();
});

// A challenge invite link: play.<domain>/c/K7P2M4RN
// Serves the same single-page app; the client reads the code off the path,
// stashes it, and resumes after login. Without this the path falls through to
// the static handler and 404s, which is what every first-time invitee would
// have seen.
app.get(/^\/c\/[A-Z0-9]{8}$/, (req, res, next) => {
  if (!req.hostname.startsWith('play.')) return next();
  return res.sendFile('play.html', { root: path.join(__dirname, 'views') });
});

// ============================================
// The marketing site (views/site) is served on the APEX domain and on
// demo.<domain>, with clean URLs. play.<domain> keeps the game and every
// API/webhook/admin path keeps working on all hosts, because this
// middleware only serves files that actually exist in views/site and
// otherwise falls through.
// ============================================
// Only the APEX needs a paid custom-domain slot on Render. www is handled
// as a redirect at the DNS layer (see APEX-GO-LIVE.md) and never reaches
// this app — but the redirect below stays as a safety net in case www is
// ever pointed here directly.
const SITE_HOSTS = new Set([
  'whatsuptrivia.com.ng',
  'www.whatsuptrivia.com.ng'
]);
// Paths no legitimate visitor to a Node app ever requests. Kept deliberately
// narrow: real 404s (a mistyped /leaderbords) still get the themed page.
const SCANNER_PROBE = /\.(php|asp|aspx|jsp|cgi|sql|bak|old|env|ini|sh|exe|dll)($|\?)|^\/(wp-|wordpress|xmlrpc|vendor\/|cgi-bin\/|phpmyadmin|\.git|\.env|\.aws|autodiscover|owa\/|boaform|hudson|jenkins|solr\/|struts)/i;

const isSiteHost = (hostname) => {
  const h = String(hostname || '').toLowerCase();
  return SITE_HOSTS.has(h)
      || h.startsWith('demo.');   // harmless if demo. is retired; costs nothing
};

// Any preview host must never compete with the apex in search results.
const isPreviewHost = (hostname) =>
  String(hostname || '').toLowerCase().startsWith('demo.');

// Canonical host: send www → apex with a permanent redirect so search
// engines and shared links settle on one address.
app.use((req, res, next) => {
  if (String(req.hostname || '').toLowerCase() === 'www.whatsuptrivia.com.ng') {
    return res.redirect(301, 'https://whatsuptrivia.com.ng' + req.originalUrl);
  }
  next();
});

// ============================================
// SEO MIGRATION — the WordPress site that lived on this domain used
// trailing-slash URLs (/faq/, /terms/) and a singular /leaderboard/.
// Google has those indexed. Every one gets a permanent redirect to its
// new address so no ranking or backlink is lost on launch day.
// ============================================
const LEGACY_PATHS = {
  '/leaderboard': '/leaderboards',       // slug changed: singular -> plural
  '/home': '/',
  '/index.php': '/',
  '/index.html': '/'
};

app.use((req, res, next) => {
  if (!isSiteHost(req.hostname) || req.method !== 'GET') return next();

  const [rawPath] = req.originalUrl.split('?');
  const query = req.originalUrl.slice(rawPath.length);   // '' or '?...'

  // 1. Old WordPress URLs carried a trailing slash; the new site does not.
  //    /faq/ -> /faq   (never touch the root itself)
  let clean = rawPath;
  if (clean.length > 1 && clean.endsWith('/')) {
    clean = clean.replace(/\/+$/, '') || '/';
  }

  // 2. Renamed pages.
  if (LEGACY_PATHS[clean]) clean = LEGACY_PATHS[clean];

  if (clean !== rawPath) {
    return res.redirect(301, clean + query);
  }
  next();
});

const siteStatic = express.static(path.join(__dirname, 'views', 'site'), {
  extensions: ['html'],            // /how-to-play  ->  how-to-play.html
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
});

app.use((req, res, next) => {
  if (!isSiteHost(req.hostname)) return next();
  // Preview hosts stay live but must never compete with the apex in search
  if (isPreviewHost(req.hostname)) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  siteStatic(req, res, next);
});

// Serve static files from views directory (for admin dashboard)
// HTML is never cached: the game UI ships as one file, and a browser holding
// yesterday's copy looks exactly like a bug in today's code.
app.use(express.static(path.join(__dirname, 'views'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    telegram: process.env.TELEGRAM_ENABLED === 'true' ? 'enabled' : 'disabled',
    whatsapp: 'enabled'
  });
});

// Routes
app.use('/api/public', publicRoutes);  // Public leaderboard API (no auth)
app.use('/webhook', webhookRoutes);
app.use('/payment', paymentRoutes);
app.use('/admin', adminRoutes);
app.use('/web/auth', webAuthRoutes);
app.use('/newsletter', newsletterRoutes);
app.use('/web/game', webGameRoutes);
app.use('/challenge', require('./routes/challenge.routes'));
app.use('/web/payment', webPaymentRoutes);

// Anything unmatched on the demo host gets the site's own 404 page.
// Sits after the API routes so /api/public/* still works on that hostname.
app.use((req, res, next) => {
  // ============================================
  // SCANNER PROBES — cheap 404, no page render
  // Automated bots sweep every public IP looking for PHP/WordPress
  // backdoors. They cannot hurt a Node app, but each probe was being
  // answered with the full themed 404 page: 73 KB a time, ~2.8 MB per
  // scan burst, for requests that will never be a real visitor.
  // These get an empty 404 instead — 0 bytes of body.
  // ============================================
  if (req.method === 'GET' && SCANNER_PROBE.test(req.path)) {
    return res.status(404).type('txt').send('');
  }

  if (isSiteHost(req.hostname) && req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.status(404).sendFile('404.html', {
      root: path.join(__dirname, 'views', 'site')
    });
  }
  next();
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// TELEGRAM WEBHOOK SETUP - ONLY PLACE THIS HAPPENS
// ============================================
async function setupTelegramWebhook() {
  if (process.env.TELEGRAM_ENABLED !== 'true') {
    console.log('ℹ️  Telegram bot disabled');
    return;
  }

  try {
    const TelegramService = require('./services/telegram.service');
    const telegramService = new TelegramService();
    
    if (!telegramService.bot) {
      console.log('⚠️  Telegram bot not initialized (missing token)');
      return;
    }

    const webhookUrl = `${process.env.APP_URL}/webhook/telegram`;
    
    // Use the service's setupWebhook method
    await telegramService.setupWebhook(webhookUrl);
    
    // Store as global instance
    global.telegramService = telegramService;
    
    console.log('✅ Telegram webhook configured successfully');
    
  } catch (error) {
    console.error('❌ Error setting Telegram webhook:', error.message);
  }
}

// ============================================
// LOVE QUEST SCHEDULED SEND PROCESSOR
// Checks every 60 seconds for bookings due to send
// ============================================
async function startScheduledSendProcessor() {
  const MessagingService = require('./services/messaging.service');
  const loveQuestService = require('./services/love-quest.service');
  const pool = require('./config/database');

  const messagingService = new MessagingService();

  setInterval(async () => {
    try {
      const result = await pool.query(`
        SELECT id FROM love_quest_bookings 
        WHERE status = 'scheduled' 
        AND scheduled_send_at <= NOW()
        AND scheduled_send_at > NOW() - INTERVAL '1 hour'
      `);

      if (result.rows.length === 0) return;

      console.log(`💘 Processing ${result.rows.length} scheduled Love Quest invitation(s)...`);

      for (const row of result.rows) {
        try {
          await loveQuestService.sendInvitation(row.id, messagingService);
          console.log(`✅ Scheduled invitation sent: booking ${row.id}`);
        } catch (err) {
          console.error(`❌ Failed to send scheduled invitation ${row.id}:`, err.message);
        }
      }
    } catch (error) {
      console.error('❌ Error in scheduled send processor:', error.message);
    }
  }, 60000); // Check every 60 seconds

  console.log('✅ Love Quest scheduled send processor started (60s interval)');
}

// ============================================
// FEATURE TOGGLES — loaded BEFORE the first request
// This must complete before app.listen(). An unloaded cache makes every
// _db() lookup return null, so resolveMode() falls through to the env vars
// and then to "enabled" — a mode switched off in the admin grid stays
// silently playable. Awaiting the first load removes that window entirely
// rather than narrowing it.
// ============================================
const togglesService = require('./services/toggles.service');
const gameSettingsService = require('./services/game-settings.service');

async function bootstrap() {
  try {
    await togglesService.start();
  } catch (e) {
    console.error('⚠️  Toggle cache failed to load at boot:', e.message);
  }
  // Same reasoning as the toggle cache, one step milder: an unloaded cache
  // here means answerSeconds() returns null and the game uses its built-in
  // 12/11/10 ladder. That is a safe clock rather than a wrong one, so this
  // does not block the boot — but an admin's setting silently not applying
  // is still worth a line in the log.
  try {
    await gameSettingsService.start();
  } catch (e) {
    console.error('⚠️  Game settings cache failed to load at boot:', e.message);
  }
  startServer();
}

// Start server
function startServer() {
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Payment Mode: ${process.env.PAYMENT_MODE || 'free'}`);
  console.log(`💬 WhatsApp Webhook: http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`🔐 Admin Dashboard: http://localhost:${PORT}/admin`);
  console.log(`🏆 Public Leaderboard API: http://localhost:${PORT}/api/public/tournaments`);
  
  // Platform status summary
  console.log('\n📊 Platform Status:');
  console.log(`   WhatsApp: ✅ Active`);
  console.log(`   Telegram: ${process.env.TELEGRAM_ENABLED === 'true' ? '⏸️  Configuring...' : '⏸️  Disabled'}`);
  
  // Setup Telegram webhook ONCE, AFTER server is ready
  await setupTelegramWebhook();
  
  if (process.env.TELEGRAM_ENABLED === 'true') {
    console.log(`   Telegram: ✅ Active`);
  }

  // Initialize error monitoring (must be first to catch startup errors)
  const errorMonitor = require('./services/error-monitor.service');
  errorMonitor.init();

  // Initialize message queue
  const messageQueue = require('./services/message-queue.service');
  const WhatsAppService = require('./services/whatsapp.service');
  const whatsappInstance = new WhatsAppService();
  messageQueue.start(whatsappInstance, global.telegramService);

  // Schedule Redis key cleanup (every 2 hours)
  const { cleanupOrphanedKeys } = require('./config/redis-keys');
  const redis = require('./config/redis');
  setInterval(async () => {
    try {
      const cleaned = await cleanupOrphanedKeys(redis);
      if (cleaned > 0) console.log(`🧹 Redis cleanup: fixed TTL on ${cleaned} orphaned keys`);
    } catch (e) {
      console.error('Redis cleanup error:', e.message);
    }
  }, 7200000); // Every 2 hours

  // Start Love Quest scheduled send processor
  startScheduledSendProcessor();
  
  // Start Welcome Message processor — sends one-time welcome to new users
  // who've been inactive for 20+ hours
  startWelcomeMessageProcessor();
});
}

bootstrap();


function startWelcomeMessageProcessor() {
  const welcomeService = require('./services/welcome-message.service');
  
  // Check every 5 minutes
  setInterval(async () => {
    try {
      const sent = await welcomeService.processBatch();
      if (sent > 0) console.log(`👋 Welcome processor: sent ${sent} message(s)`);
    } catch (error) {
      console.error('❌ Error in welcome message processor:', error.message);
    }
  }, 5 * 60 * 1000);
  
  console.log('✅ Welcome message processor started (5min interval, 20hr threshold)');
}

module.exports = app;