const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const PaymentService = require('../services/payment.service');
const WhatsAppService = require('../services/whatsapp.service');
const pool = require('../config/database');
const { logger } = require('../utils/logger');

const paymentService = new PaymentService();
const whatsappService = new WhatsAppService();

// Paystack webhook endpoint
router.post('/webhook', async (req, res) => {
  try {
    // Verify Paystack signature
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      logger.warn('Invalid Paystack signature');
      return res.status(400).send('Invalid signature');
    }

    const event = req.body;

    // Handle successful payment
    if (event.event === 'charge.success') {
      const { reference, metadata } = event.data;

      try {
        const verification = await paymentService.verifyPayment(reference);
        
        // Get updated user data
        const userResult = await pool.query(
          'SELECT * FROM users WHERE id = $1',
          [metadata.user_id]
        );
        
        const user = userResult.rows[0];

        // Notify user via WhatsApp
        await whatsappService.sendMessage(
          user.phone_number,
          `✅ PAYMENT SUCCESSFUL! ✅\n\n` +
          `${verification.games} games have been credited to your account!\n\n` +
          `Amount: ₦${verification.amount.toLocaleString()}\n` +
          `Games Remaining: ${user.games_remaining}\n\n` +
          `Type PLAY to start a game! 🎮`
        );

        logger.info(`Payment webhook processed: ${reference}`);
      } catch (error) {
        logger.error('Error processing webhook:', error);
      }
    }

    res.status(200).send('Webhook received');
  } catch (error) {
    logger.error('Webhook error:', error);
    res.status(500).send('Webhook error');
  }
});

// Callback URL (for web payment redirects)
router.get('/callback', async (req, res) => {
  const { reference } = req.query;

  if (!reference) {
    return res.status(400).send('No reference provided');
  }

  try {
    await paymentService.verifyPayment(reference);
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Successful</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            text-align: center;
            padding: 50px;
            background: #f5f5f5;
          }
          .container {
            background: white;
            max-width: 500px;
            margin: 0 auto;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          h1 { color: #4CAF50; }
          p { color: #666; line-height: 1.6; }
          .emoji { font-size: 4rem; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="emoji">✅</div>
          <h1>Payment Successful!</h1>
          <p>Your games have been credited to your account.</p>
          <p><strong>Return to WhatsApp to start playing!</strong></p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Failed</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            text-align: center;
            padding: 50px;
            background: #f5f5f5;
          }
          .container {
            background: white;
            max-width: 500px;
            margin: 0 auto;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          h1 { color: #f44336; }
          p { color: #666; line-height: 1.6; }
          .emoji { font-size: 4rem; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="emoji">❌</div>
          <h1>Payment Failed</h1>
          <p>Something went wrong with your payment.</p>
          <p>Please contact support or try again.</p>
        </div>
      </body>
      </html>
    `);
  }
});

module.exports = router;