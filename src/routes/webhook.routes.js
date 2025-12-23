// ============================================
// FILE: src/routes/webhook.routes.js
// FIXED: Handles BOTH /webhook and /webhook/whatsapp
// ============================================

const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// ============================================
// WHATSAPP ROUTES - Handle both /webhook and /webhook/whatsapp
// ============================================

// Handle /webhook directly (root of this router)
// This catches POST /webhook (WhatsApp default)
router.get('/', (req, res) => {
  console.log('📥 WhatsApp verification request received on /webhook');
  webhookController.verify(req, res);
});

router.post('/', (req, res) => {
  console.log('📥 WhatsApp message received on /webhook');
  webhookController.handleMessage(req, res);
});

// Also handle /webhook/whatsapp (explicit path)
router.get('/whatsapp', (req, res) => {
  console.log('📥 WhatsApp verification request received on /webhook/whatsapp');
  webhookController.verify(req, res);
});

router.post('/whatsapp', (req, res) => {
  console.log('📥 WhatsApp message received on /webhook/whatsapp');
  webhookController.handleMessage(req, res);
});

// ============================================
// TELEGRAM ROUTES
// ============================================

router.post('/telegram', async (req, res) => {
  try {
    console.log('📥 Telegram update received');
    
    // Use global instance created in server.js
    if (global.telegramService && global.telegramService.bot) {
      await global.telegramService.processUpdate(req.body);
      console.log('✅ Telegram update processed');
    } else {
      console.warn('⚠️ Telegram service not available');
    }
    
    // Always return 200 to Telegram
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('❌ Telegram webhook error:', error);
    // Still return 200 to prevent retries
    res.status(200).json({ ok: false });
  }
});

module.exports = router;