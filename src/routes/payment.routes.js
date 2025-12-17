// ============================================
// FILE: src/routes/payment.routes.js
// UPDATED: Add tournament payment callback
// Batch 6: Payment Routes
// ============================================

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const PaymentService = require('../services/payment.service');
const TournamentService = require('../services/tournament.service');
const WhatsAppService = require('../services/whatsapp.service');
const pool = require('../config/database');
const { logger } = require('../utils/logger');

const paymentService = new PaymentService();
const tournamentService = new TournamentService();
const whatsappService = new WhatsAppService();

// ============================================
// EXISTING REGULAR PAYMENT WEBHOOK
// ============================================

router.post('/webhook', async (req, res) => {
    try {
        const hash = crypto
            .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');
        
        if (hash !== req.headers['x-paystack-signature']) {
            logger.warn('Invalid Paystack signature');
            return res.status(400).send('Invalid signature');
        }
        
        const event = req.body;
        
        if (event.event === 'charge.success') {
            const { reference, metadata } = event.data;
            
            try {
                // Check if this is a tournament payment
                if (reference.startsWith('TRN-')) {
                    // Handle tournament payment
                    await handleTournamentPaymentWebhook(reference, metadata);
                } else {
                    // Handle regular game payment
                    const verification = await paymentService.verifyPayment(reference);
                    
                    const userResult = await pool.query(
                        'SELECT * FROM users WHERE id = $1',
                        [metadata.user_id]
                    );
                    
                    if (userResult.rows.length === 0) {
                        throw new Error('User not found');
                    }
                    
                    const user = userResult.rows[0];
                    
                    logger.info(`User ${user.id} now has ${user.games_remaining} games remaining`);
                    
                    await whatsappService.sendMessage(
                        user.phone_number,
                        `✅ PAYMENT SUCCESSFUL! ✅\n\n` +
                        `${verification.games} games have been credited to your account!\n\n` +
                        `Amount: ₦${verification.amount.toLocaleString()}\n` +
                        `Games Remaining: ${user.games_remaining}\n\n` +
                        `Type PLAY to start a game! 🎮`
                    );
                }
                
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

// ============================================
// TOURNAMENT PAYMENT WEBHOOK HANDLER
// ============================================

async function handleTournamentPaymentWebhook(reference, metadata) {
    try {
        const verification = await tournamentService.verifyTournamentPayment(reference);
        
        if (!verification.success) {
            throw new Error('Tournament payment verification failed');
        }
        
        const userResult = await pool.query(
            'SELECT * FROM users WHERE id = $1',
            [verification.payment.user_id]
        );
        
        if (userResult.rows.length === 0) {
            throw new Error('User not found');
        }
        
        const user = userResult.rows[0];
        const tournament = await tournamentService.getTournamentById(verification.payment.tournament_id);
        
        let message = `✅ TOURNAMENT PAYMENT SUCCESSFUL! ✅\n\n`;
        message += `You've joined: ${tournament.tournament_name}\n\n`;
        message += `Amount Paid: ₦${verification.payment.amount.toLocaleString()}\n`;
        
        if (tournament.uses_tokens && verification.tokensRemaining) {
            message += `🎟️ Tournament Tokens: ${verification.tokensRemaining}\n\n`;
        } else {
            message += `♾️ Unlimited plays during tournament!\n\n`;
        }
        
        message += `Ready to compete? Type PLAY to start! 🏆`;
        
        await whatsappService.sendMessage(user.phone_number, message);
        
        logger.info(`Tournament payment successful: User ${user.id} joined tournament ${tournament.id}`);
        
    } catch (error) {
        logger.error('Error handling tournament payment webhook:', error);
        throw error;
    }
}

// ============================================
// REGULAR GAME PAYMENT CALLBACK
// ============================================

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
    <meta http-equiv="refresh" content="4;url=https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}">
    <title>Payment Successful</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            max-width: 500px;
            width: 100%;
            padding: 50px 30px;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
        }
        .emoji {
            font-size: 80px;
            margin-bottom: 20px;
            animation: bounce 1s ease infinite;
        }
        @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-20px); }
        }
        h1 { color: #4CAF50; margin: 20px 0; font-size: 2rem; }
        p { color: #666; line-height: 1.8; font-size: 1.1rem; margin: 15px 0; }
        .countdown { color: #FF6B35; font-weight: bold; font-size: 3rem; margin: 30px 0; }
        .btn {
            display: inline-block;
            margin-top: 30px;
            padding: 18px 50px;
            background: #25D366;
            color: white;
            text-decoration: none;
            border-radius: 50px;
            font-weight: bold;
            font-size: 1.2rem;
            transition: all 0.3s;
            box-shadow: 0 4px 15px rgba(37, 211, 102, 0.4);
        }
        .btn:hover {
            background: #128C7E;
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(37, 211, 102, 0.6);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="emoji">✅</div>
        <h1>Payment Successful!</h1>
        <p>Your games have been credited.</p>
        <div class="countdown" id="countdown">3</div>
        <p><strong>Redirecting to WhatsApp...</strong></p>
        <a href="https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}" class="btn">Go to WhatsApp Now</a>
    </div>
    <script>
        (function() {
            let seconds = 3;
            const countdownEl = document.getElementById('countdown');
            const interval = setInterval(function() {
                seconds--;
                if (countdownEl) {
                    countdownEl.textContent = seconds;
                }
                if (seconds <= 0) {
                    clearInterval(interval);
                    window.location.href = 'https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}';
                }
            }, 1000);
        })();
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
    <title>Payment Failed</title>
    <style>
        body {
            font-family: Arial, sans-serif;
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
        a {
            display: inline-block;
            margin-top: 20px;
            padding: 15px 30px;
            background: #25D366;
            color: white;
            text-decoration: none;
            border-radius: 5px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>❌ Payment Failed</h1>
        <p>Something went wrong. Please try again.</p>
        <a href="https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}">Return to WhatsApp</a>
    </div>
</body>
</html>
        `);
    }
});

// ============================================
// TOURNAMENT PAYMENT CALLBACK
// ============================================

router.get('/tournament-callback', async (req, res) => {
    const { reference } = req.query;
    
    if (!reference) {
        return res.status(400).send('No reference provided');
    }
    
    try {
        const verification = await tournamentService.verifyTournamentPayment(reference);
        const tournament = await tournamentService.getTournamentById(verification.payment.tournament_id);
        
        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="5;url=https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}">
    <title>Tournament Payment Successful</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            max-width: 500px;
            width: 100%;
            padding: 50px 30px;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
        }
        .emoji {
            font-size: 80px;
            margin-bottom: 20px;
            animation: bounce 1s ease infinite;
        }
        @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-20px); }
        }
        h1 { color: #4CAF50; margin: 20px 0; font-size: 1.8rem; }
        .tournament-name {
            color: #f5576c;
            font-weight: bold;
            font-size: 1.3rem;
            margin: 15px 0;
        }
        p { color: #666; line-height: 1.8; font-size: 1.1rem; margin: 15px 0; }
        .countdown { color: #f5576c; font-weight: bold; font-size: 3rem; margin: 30px 0; }
        .btn {
            display: inline-block;
            margin-top: 30px;
            padding: 18px 50px;
            background: #25D366;
            color: white;
            text-decoration: none;
            border-radius: 50px;
            font-weight: bold;
            font-size: 1.2rem;
            transition: all 0.3s;
            box-shadow: 0 4px 15px rgba(37, 211, 102, 0.4);
        }
        .btn:hover {
            background: #128C7E;
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(37, 211, 102, 0.6);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="emoji">🏆</div>
        <h1>Tournament Entry Confirmed!</h1>
        <div class="tournament-name">${tournament.tournament_name}</div>
        <p>You're now registered to compete!</p>
        <div class="countdown" id="countdown">5</div>
        <p><strong>Redirecting to WhatsApp...</strong></p>
        <a href="https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}" class="btn">Start Playing Now!</a>
    </div>
    <script>
        (function() {
            let seconds = 5;
            const countdownEl = document.getElementById('countdown');
            const interval = setInterval(function() {
                seconds--;
                if (countdownEl) {
                    countdownEl.textContent = seconds;
                }
                if (seconds <= 0) {
                    clearInterval(interval);
                    window.location.href = 'https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}';
                }
            }, 1000);
        })();
    </script>
</body>
</html>
        `);
        
    } catch (error) {
        logger.error('Tournament payment callback error:', error);
        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Payment Failed</title>
    <style>
        body {
            font-family: Arial, sans-serif;
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
        a {
            display: inline-block;
            margin-top: 20px;
            padding: 15px 30px;
            background: #25D366;
            color: white;
            text-decoration: none;
            border-radius: 5px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>❌ Tournament Payment Failed</h1>
        <p>Something went wrong. Please try again.</p>
        <a href="https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}">Return to WhatsApp</a>
    </div>
</body>
</html>
        `);
    }
});

module.exports = router;