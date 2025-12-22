const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');
const TelegramService = require('../services/telegram.service');

// WhatsApp routes
router.get('/whatsapp', webhookController.verifyWhatsApp);
router.post('/whatsapp', webhookController.handleWhatsAppWebhook);

// Telegram webhook - passive handler
router.post('/telegram', async (req, res) => {
  try {
    // Get singleton instance (already created in server.js)
    const telegramService = new TelegramService();
    
    if (telegramService.bot) {
      await telegramService.processUpdate(req.body);
    }
    
    // Always return 200
    res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('Telegram webhook error:', error);
    res.status(200).json({ ok: false });
  }
});

module.exports = router;