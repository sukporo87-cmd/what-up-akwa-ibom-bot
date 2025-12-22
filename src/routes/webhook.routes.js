// ============================================
// FILE: src/routes/webhook.routes.js
// FIXED: Matches actual controller methods
// ============================================
const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// WhatsApp verification (GET)
router.get('/whatsapp', (req, res) => {
  webhookController.verify(req, res);
});

// WhatsApp messages (POST)
router.post('/whatsapp', (req, res) => {
  webhookController.handleMessage(req, res);
});

// Telegram webhook - uses global singleton
router.post('/telegram', async (req, res) => {
  try {
    // Use global instance created in server.js
    if (global.telegramService && global.telegramService.bot) {
      await global.telegramService.processUpdate(req.body);
    } else {
      console.warn('Telegram service not available');
    }
    
    // Always return 200 to Telegram
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    // Still return 200 to prevent retries
    res.status(200).json({ ok: false });
  }
});

module.exports = router;