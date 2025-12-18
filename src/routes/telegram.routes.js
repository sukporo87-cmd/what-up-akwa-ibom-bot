// src/routes/telegram.routes.js

const express = require('express');
const router = express.Router();
const telegramService = require('../services/telegram.service');
const logger = require('../utils/logger');

/**
 * Telegram Webhook Endpoint
 * POST /webhooks/telegram
 */
router.post('/telegram', async (req, res) => {
  try {
    const update = req.body;
    
    logger.info('Received Telegram webhook update:', {
      updateId: update.update_id,
      messageId: update.message?.message_id,
      chatId: update.message?.chat?.id,
      from: update.message?.from?.username
    });

    // Process the update
    telegramService.processWebhookUpdate(update);

    // Telegram expects a 200 OK response
    res.sendStatus(200);

  } catch (error) {
    logger.error('Error processing Telegram webhook:', error);
    res.sendStatus(200); // Still return 200 to avoid Telegram retries
  }
});

/**
 * Webhook health check
 * GET /webhooks/telegram
 */
router.get('/telegram', (req, res) => {
  res.json({
    status: 'ok',
    service: 'telegram-webhook',
    message: 'Telegram webhook is active'
  });
});

module.exports = router;