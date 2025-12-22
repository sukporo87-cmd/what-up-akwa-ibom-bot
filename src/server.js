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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/webhook', webhookRoutes);
app.use('/payment', paymentRoutes);
app.use('/admin', adminRoutes);

// Initialize Telegram bot if enabled
const TelegramService = require('./services/telegram.service');

if (process.env.TELEGRAM_ENABLED === 'true') {
  try {
    const telegramService = new TelegramService();
    console.log('✅ Telegram bot started');
    console.log(`📱 Telegram Bot: @${process.env.TELEGRAM_BOT_USERNAME || 'your_bot'}`);
  } catch (error) {
    console.error('❌ Failed to start Telegram bot:', error.message);
    console.log('ℹ️  Application will continue without Telegram support');
  }
} else {
  console.log('ℹ️  Telegram bot disabled (set TELEGRAM_ENABLED=true to enable)');
}

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Payment Mode: ${process.env.PAYMENT_MODE || 'free'}`);
  console.log(`💬 WhatsApp Webhook: http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`🔐 Admin Dashboard: http://localhost:${PORT}/admin`);
  
  // Platform status summary
  console.log('\n📊 Platform Status:');
  console.log(`   WhatsApp: ✅ Active`);
  console.log(`   Telegram: ${process.env.TELEGRAM_ENABLED === 'true' ? '✅ Active' : '⏸️  Disabled'}`);
});

module.exports = app;