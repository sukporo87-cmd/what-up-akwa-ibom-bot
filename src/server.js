// ============================================
// FILE: src/server.js - UPDATED VERSION WITH TELEGRAM INTEGRATION
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
const telegramRoutes = require('./routes/telegram.routes');
const telegramService = require('./services/telegram.service');
const { logger } = require('./utils/logger');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================

app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for admin dashboard
}));

app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from views directory (for admin dashboard)
app.use(express.static(path.join(__dirname, 'views')));

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// ROUTES
// ============================================

app.use('/webhook', webhookRoutes);
app.use('/payment', paymentRoutes);
app.use('/admin', adminRoutes);
app.use('/webhooks', telegramRoutes);

// ============================================
// ERROR HANDLER
// ============================================

app.use((err, req, res, next) => {
  logger.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// TELEGRAM BOT INITIALIZATION
// ============================================

// Initialize Telegram Bot
telegramService.initialize();

// Setup Telegram webhook (production only)
if (process.env.NODE_ENV === 'production' && process.env.TELEGRAM_WEBHOOK_URL) {
  telegramService.setupWebhook(process.env.TELEGRAM_WEBHOOK_URL)
    .then(() => {
      logger.info('✅ Telegram webhook configured successfully');
    })
    .catch((error) => {
      logger.error('❌ Failed to setup Telegram webhook:', error);
    });
}

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  logger.info(`✅ Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Payment Mode: ${process.env.PAYMENT_MODE || 'free'}`);
  logger.info(`🔐 Admin Dashboard: http://localhost:${PORT}/admin`);
  
  if (process.env.TELEGRAM_BOT_TOKEN) {
    logger.info('✅ Telegram bot enabled');
    logger.info(`📱 Telegram Bot Username: @${process.env.TELEGRAM_BOT_USERNAME || 'your_bot'}`);
  } else {
    logger.warn('⚠️ Telegram bot token not configured');
  }
  
  if (process.env.WHATSAPP_PHONE_NUMBER_ID) {
    logger.info('✅ WhatsApp integration enabled');
  }
});

module.exports = app;