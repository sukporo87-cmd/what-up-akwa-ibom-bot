const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// GET for webhook verification
router.get('/', webhookController.verify.bind(webhookController));

// POST for receiving messages
router.post('/', webhookController.handleMessage.bind(webhookController));

module.exports = router;