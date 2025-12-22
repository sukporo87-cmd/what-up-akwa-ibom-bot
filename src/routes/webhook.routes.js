const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// GET for webhook verification
router.get('/', webhookController.verify.bind(webhookController));

// POST for receiving messages
router.post('/', webhookController.handleMessage.bind(webhookController));

router.post('/telegram', async (req, res) => {
  try {
    const TelegramService = require('../services/telegram.service');
    const telegramService = new TelegramService();
    
    await telegramService.processUpdate(req.body);
    res.sendStatus(200);
    
  } catch (error) {
    console.error('Telegram webhook error:', error);
    res.sendStatus(500);
  }
});

module.exports = router;