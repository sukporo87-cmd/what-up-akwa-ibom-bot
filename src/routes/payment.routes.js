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
    
    // Redirect to WhatsApp after 3 seconds
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
            padding: 50px 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            margin: 0;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .container {
            background: white;
            max-width: 500px;
            width: 100%;
            padding: 40px 30px;
            border-radius: 20px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
          }
          .emoji { 
            font-size: 5rem; 
            margin-bottom: 20px;
            animation: bounce 1s ease infinite;
          }
          @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-20px); }
          }
          h1 { 
            color: #4CAF50; 
            margin: 20px 0;
            font-size: 2rem;
          }
          p { 
            color: #666; 
            line-height: 1.8;
            font-size: 1.1rem;
            margin: 15px 0;
          }
          .btn {
            display: inline-block;
            margin-top: 20px;
            padding: 15px 40px;
            background: #25D366;
            color: white;
            text-decoration: none;
            border-radius: 30px;
            font-weight: bold;
            font-size: 1.1rem;
            transition: all 0.3s;
          }
          .btn:hover {
            background: #128C7E;
            transform: scale(1.05);
          }
          .countdown {
            color: #FF6B35;
            font-weight: bold;
            font-size: 1.2rem;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="emoji">✅</div>
          <h1>Payment Successful!</h1>
          <p>Your games have been credited to your account.</p>
          <p><strong>Redirecting to WhatsApp in <span class="countdown" id="countdown">3</span> seconds...</strong></p>
          <a href="https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}" class="btn">Return to WhatsApp Now</a>
        </div>
        <script>
          let seconds = 3;
          const countdownEl = document.getElementById('countdown');
          const interval = setInterval(() => {
            seconds--;
            countdownEl.textContent = seconds;
            if (seconds === 0) {
              clearInterval(interval);
              window.location.href = 'https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}';
            }
          }, 1000);
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    logger.error('Payment callback error:', error);
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
            padding: 50px 20px;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            min-height: 100vh;
            margin: 0;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .container {
            background: white;
            max-width: 500px;
            width: 100%;
            padding: 40px 30px;
            border-radius: 20px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
          }
          .emoji { 
            font-size: 5rem;
            margin-bottom: 20px;
          }
          h1 { 
            color: #f44336; 
            margin: 20px 0;
            font-size: 2rem;
          }
          p { 
            color: #666; 
            line-height: 1.8;
            font-size: 1.1rem;
            margin: 15px 0;
          }
          .btn {
            display: inline-block;
            margin-top: 20px;
            padding: 15px 40px;
            background: #25D366;
            color: white;
            text-decoration: none;
            border-radius: 30px;
            font-weight: bold;
            font-size: 1.1rem;
            transition: all 0.3s;
          }
          .btn:hover {
            background: #128C7E;
            transform: scale(1.05);
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="emoji">❌</div>
          <h1>Payment Failed</h1>
          <p>Something went wrong with your payment.</p>
          <p>Please try again or contact support.</p>
          <a href="https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}" class="btn">Return to WhatsApp</a>
        </div>
      </body>
      </html>
    `);
  }
});

module.exports = router;