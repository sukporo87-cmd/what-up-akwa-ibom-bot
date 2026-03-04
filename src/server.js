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

// Serve static files from views directory (for admin dashboard)
app.use(express.static(path.join(__dirname, 'views')));

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

// Start server
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
});

module.exports = app;