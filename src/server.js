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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Start server
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Payment Mode: ${process.env.PAYMENT_MODE || 'free'}`);
  console.log(`💬 WhatsApp Webhook: http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`🔐 Admin Dashboard: http://localhost:${PORT}/admin`);
  
  // Platform status summary
  console.log('\n📊 Platform Status:');
  console.log(`   WhatsApp: ✅ Active`);
  console.log(`   Telegram: ${process.env.TELEGRAM_ENABLED === 'true' ? '⏸️  Configuring...' : '⏸️  Disabled'}`);
  
  // Setup Telegram webhook ONCE, AFTER server is ready
  await setupTelegramWebhook();
  
  if (process.env.TELEGRAM_ENABLED === 'true') {
    console.log(`   Telegram: ✅ Active`);
  }
});

module.exports = app;