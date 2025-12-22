const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// GET for webhook verification
router.get('/', webhookController.verify.bind(webhookController));

// POST for receiving messages
router.post('/', webhookController.handleMessage.bind(webhookController));

// Initialize service once at module level
const TelegramService = require('../services/telegram.service');
let telegramServiceInstance = null;

// Telegram webhook endpoint
router.post('/telegram', async (req, res) => {
  try {
    // Use singleton instance
    if (!telegramServiceInstance) {
      telegramServiceInstance = new TelegramService();
    }
    
    // Process the update
    if (telegramServiceInstance.bot) {
      await telegramServiceInstance.processUpdate(req.body);
    }
    
    // Always respond 200 to Telegram
    res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('Telegram webhook error:', error);
    // Still respond 200 to prevent Telegram retries
    res.status(200).json({ ok: false });
  }
});

module.exports = router;