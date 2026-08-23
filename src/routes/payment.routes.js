// ============================================
// FILE: src/routes/payment.routes.js
// UPDATED: Add multi-platform support
// ============================================

const express = require('express');
const router = express.Router();
const PaymentService = require('../services/payment.service');
const TournamentService = require('../services/tournament.service');
const MessagingService = require('../services/messaging.service');
const gatewayManager = require('../services/payment-gateway-manager');
const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

const paymentService = new PaymentService();
const tournamentService = new TournamentService();
const messagingService = new MessagingService();

// ============================================
// SHARED WEBHOOK HANDLER
// Processes verified webhook payload regardless of gateway
// ============================================

async function processWebhookEvent(reference, metadata, gatewayName) {
    try {
        // Check if this is a tournament payment
        if (reference.startsWith('TRN-') || reference.startsWith('TRNR-')) {
            await handleTournamentPaymentWebhook(reference, metadata);
        } else if (reference.startsWith('CHS-')) {
            // A sponsored challenge prize. THIS is the only thing that opens
            // the challenge to participants — settled, not initiated. The
            // browser callback sets nothing, exactly like credit tokens.
            await handleChallengeSponsorshipWebhook(reference);
        } else {
            // Handle regular game payment
            const verification = await paymentService.verifyPayment(reference);
            
            const userResult = await pool.query(
                'SELECT * FROM users WHERE id = $1',
                [verification.userId]
            );
            
            if (userResult.rows.length === 0) {
                throw new Error('User not found');
            }
            
            const user = userResult.rows[0];
            logger.info(`User ${user.id} now has ${user.games_remaining} games remaining`);

            const web = isWeb(user.phone_number);

            const body =
                `✅ PAYMENT SUCCESSFUL! ✅\n\n` +
                `${verification.games} games have been credited to your account!\n\n` +
                `Amount: ₦${verification.amount.toLocaleString()}\n` +
                `Games Remaining: ${user.games_remaining}\n\n` +
                (web ? `Head back to the game and pick Play Classic. 🎮`
                     : `Type PLAY to start a game! 🎮`);

            if (web) {
                // Two channels on purpose. The SSE nudge only lands if the tab
                // is still open — and it usually isn't, because the player was
                // just redirected off to a gateway. Email is the durable copy.
                messagingService.sendMessage(user.phone_number, body).catch(() => {});

                const contactService = require('../services/contact.service');
                await contactService.send(user, {
                    text: body,
                    subject: `Your ${verification.games} game credits are ready`,
                    kind: 'transactional'
                });
            } else {
                await messagingService.sendMessage(user.phone_number, body);
            }
        }
        
        logger.info(`Payment webhook (${gatewayName}) processed: ${reference}`);
    } catch (error) {
        logger.error(`Error processing ${gatewayName} webhook event:`, error);
    }
}

// ============================================
// CHALLENGE SPONSORSHIP WEBHOOK
// ============================================
async function handleChallengeSponsorshipWebhook(reference) {
    const challengeSponsorshipService = require('../services/challenge-sponsorship.service');
    const deepLinkService = require('../services/deeplink.service');

    const result = await challengeSponsorshipService.settle(reference);
    if (!result.ok || result.alreadySettled) return;

    try {
        const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [result.userId]);
        const user = userResult.rows[0];
        if (!user || !result.code) return;

        const links = deepLinkService.buildLinks(result.code);

        // No "confirming" message was ever sent, so this is the first thing
        // the initiator hears — and it is the thing they actually want, which
        // is the link.
        const body =
            `\u2705 Prize confirmed \u2014 \u20a6${Number(result.amount).toLocaleString()} is held.\n\n` +
            `Your challenge is live. Send this to whoever you want to beat:\n` +
            `${links.web}\n\n` +
            `At least two people have to finish for the prize to be won.`;

        await messagingService.sendMessage(user.phone_number, body);
    } catch (error) {
        // The money is settled and the challenge is open. A failed message is
        // not a failed payment, and must not look like one.
        logger.error('Sponsorship settled but notification failed:', error.message);
    }
}

// ============================================
// PAYSTACK WEBHOOK
// ============================================

router.post('/webhook', async (req, res) => {
    try {
        const gateway = gatewayManager.getGateway('paystack');
        const signature = req.headers['x-paystack-signature'];
        const rawBody = JSON.stringify(req.body);
        
        if (!gateway.verifyWebhookSignature(rawBody, signature)) {
            logger.warn('Invalid Paystack signature');
            return res.status(400).send('Invalid signature');
        }
        
        const event = req.body;
        
        if (event.event === 'charge.success') {
            const { reference, metadata } = event.data;
            await processWebhookEvent(reference, metadata, 'paystack');
        }
        
        res.status(200).send('Webhook received');
        
    } catch (error) {
        logger.error('Webhook error:', error);
        res.status(500).send('Webhook error');
    }
});

// ============================================
// KORAPAY WEBHOOK
// ============================================

router.post('/korapay-webhook', async (req, res) => {
    try {
        const gateway = gatewayManager.getGateway('korapay');
        const signature = req.headers['x-korapay-signature'];
        const rawBody = JSON.stringify(req.body);
        
        if (!gateway.verifyWebhookSignature(rawBody, signature)) {
            logger.warn('Invalid Korapay signature');
            return res.status(400).send('Invalid signature');
        }
        
        const event = req.body;
        
        if (event.event === 'charge.success' && event.data?.status === 'success') {
            const { reference, metadata } = event.data;
            await processWebhookEvent(reference, metadata || {}, 'korapay');
        }
        
        res.status(200).send('Webhook received');
        
    } catch (error) {
        logger.error('Korapay webhook error:', error);
        res.status(500).send('Webhook error');
    }
});

// ============================================
// MONNIFY WEBHOOK
// ============================================

router.post('/monnify-webhook', express.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}), async (req, res) => {
    try {
        const gateway = gatewayManager.getGateway('monnify');
        const signature = req.headers['monnify-signature'];
        // Monnify hashes the RAW body — use the captured rawBody, falling back to stringified body
        const rawBody = req.rawBody || JSON.stringify(req.body);
        
        if (!gateway.verifyWebhookSignature(rawBody, signature)) {
            logger.warn('Invalid Monnify signature');
            return res.status(400).send('Invalid signature');
        }
        
        const event = req.body;
        const status = event?.eventData?.paymentStatus;
        
        if (event.eventType === 'SUCCESSFUL_TRANSACTION' && (status === 'PAID' || status === 'OVERPAID')) {
            const reference = event.eventData.paymentReference;
            const metadata = event.eventData.metadata || {};
            await processWebhookEvent(reference, metadata, 'monnify');
        }
        
        res.status(200).send('Webhook received');
        
    } catch (error) {
        logger.error('Monnify webhook error:', error);
        res.status(500).send('Webhook error');
    }
});

// ============================================
// FLUTTERWAVE WEBHOOK
// ============================================

router.post('/flutterwave-webhook', async (req, res) => {
    try {
        const gateway = gatewayManager.getGateway('flutterwave');
        // Flutterwave sends the hash in `verif-hash` header
        const signature = req.headers['verif-hash'];
        
        if (!gateway.verifyWebhookSignature(null, signature)) {
            logger.warn('Invalid Flutterwave signature');
            return res.status(400).send('Invalid signature');
        }
        
        const event = req.body;
        const status = event?.data?.status;
        
        if (event.event === 'charge.completed' && status === 'successful') {
            const reference = event.data.tx_ref;
            const metadata = event.data.meta || {};
            await processWebhookEvent(reference, metadata, 'flutterwave');
        }
        
        res.status(200).send('Webhook received');
        
    } catch (error) {
        logger.error('Flutterwave webhook error:', error);
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
        
        let message;
        
        if (verification.isRebuy) {
            // REBUY confirmation
            message = `✅ TOKEN REBUY SUCCESSFUL! ✅\n\n`;
            message += `Tournament: ${tournament.tournament_name}\n\n`;
            message += `Amount Paid: ₦${verification.payment.amount.toLocaleString()}\n`;
            message += `🎟️ Tokens Added: +${verification.tokensAdded}\n`;
            message += `🎟️ Total Tokens Now: ${verification.tokensRemaining}\n\n`;
            message += `Ready for another attempt? Type PLAY to start! 🏆`;
        } else {
            // Initial entry confirmation
            message = `✅ TOURNAMENT PAYMENT SUCCESSFUL! ✅\n\n`;
            message += `You've joined: ${tournament.tournament_name}\n\n`;
            message += `Amount Paid: ₦${verification.payment.amount.toLocaleString()}\n`;
            
            if (tournament.uses_tokens && verification.tokensRemaining) {
                message += `🎟️ Tournament Tokens: ${verification.tokensRemaining}\n\n`;
            } else {
                message += `♾️ Unlimited plays during tournament!\n\n`;
            }
            
            message += `Ready to compete? Type PLAY to start! 🏆`;
        }
        
        // CHANGED: Use messagingService instead of whatsappService
        await messagingService.sendMessage(user.phone_number, message);
        
        logger.info(`Tournament payment successful${verification.isRebuy ? ' (rebuy)' : ''}: User ${user.id} tournament ${tournament.id}`);
        
    } catch (error) {
        logger.error('Error handling tournament payment webhook:', error);
        throw error;
    }
}

// ============================================
// HELPER: Get redirect URL based on platform
// ============================================
function isWeb(phoneNumber) {
    return String(phoneNumber || '').startsWith('web_');
}

/**
 * Where to send the player after checkout.
 *
 * Chat platforms get a deeplink back into the conversation. Web players go
 * back into the app carrying the reference, so play.html can poll
 * /web/payment/status and show the outcome itself — no interstitial.
 */
function getRedirectUrl(phoneNumber, reference = '', outcome = 'success', req = null, knownOrigin = null) {
    const id = String(phoneNumber || '');

    if (isWeb(id)) {
        // knownOrigin is the origin the player was recorded on. It beats the
        // request host, because a gateway callback arrives at APP_URL — not at
        // whatever domain the player is using.
        if (knownOrigin) {
            const base = String(knownOrigin).replace(/\/$/, '');
            return `${base}/play.html?paid=${encodeURIComponent(reference)}&status=${outcome}`;
        }
        // Return them to the origin they came in on, not a hardcoded one. The
        // session cookie is host-only and the localStorage token is per-origin,
        // so bouncing a player to a different host lands them signed-out.
        let base = null;
        if (req) {
            const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
            const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
            if (host) base = `${proto}://${host}`;
        }
        base = (base || process.env.WEB_APP_URL || 'https://play.whatsuptrivia.com.ng').replace(/\/$/, '');
        return `${base}/play.html?paid=${encodeURIComponent(reference)}&status=${outcome}`;
    }
    if (id.startsWith('tg_')) {
        return `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}`;
    }
    return `https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER}`;
}

function getPlatformName(phoneNumber) {
    const id = String(phoneNumber || '');
    if (isWeb(id)) return 'the game';
    if (id.startsWith('tg_')) return 'Telegram';
    return 'WhatsApp';
}

// ============================================
// REGULAR GAME PAYMENT CALLBACK
// ============================================

router.get('/callback', async (req, res) => {
    // Paystack sends 'reference', Korapay sends 'reference', Monnify sends 'paymentReference', Flutterwave sends 'tx_ref'
    const reference = req.query.reference || req.query.paymentReference || req.query.tx_ref;
    
    if (!reference) {
        return res.status(400).send('No reference provided');
    }
    
    // Resolve the player BEFORE verifying. Every exit path — success, still
    // processing, outright failure — needs to know where to send them, and on
    // the failure paths verifyPayment has already thrown.
    // Reference format: {WUAIB|KOR}-{user_id}-{timestamp}-{random}
    const userId = reference.split('-')[1];
    let phoneNumber = '';

    try {
        const userResult = await pool.query(
            'SELECT phone_number FROM users WHERE id = $1',
            [userId]
        );
        phoneNumber = userResult.rows[0]?.phone_number || '';
    } catch (lookupErr) {
        logger.error('Could not resolve user for payment callback:', lookupErr.message);
    }

    // Capture user's real IP for device tracking
    try {
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress;
        if (clientIp && userId) {
            const deviceTrackingService = require('../services/device-tracking.service');
            await deviceTrackingService.recordIP(parseInt(userId), clientIp, 'payment_callback');
        }
    } catch (ipErr) {
        logger.error('Error recording payment IP (non-fatal):', ipErr.message);
    }

    try {
        const verification = await paymentService.verifyPayment(reference);

        // Web players go straight back into the app — it polls the status
        // endpoint and renders the result in its own UI.
        if (isWeb(phoneNumber)) {
            let knownOrigin = null;
            try { knownOrigin = await redis.get(`web_origin:${userId}`); } catch (e) { /* fall back */ }
            return res.redirect(302, getRedirectUrl(phoneNumber, reference, 'success', req, knownOrigin));
        }

        const redirectUrl = getRedirectUrl(phoneNumber, reference, 'success', req);
        const platformName = getPlatformName(phoneNumber);
        
        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="4;url=${redirectUrl}">
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
            background: ${platformName === 'Telegram' ? '#0088cc' : '#25D366'};
            color: white;
            text-decoration: none;
            border-radius: 50px;
            font-weight: bold;
            font-size: 1.2rem;
            transition: all 0.3s;
            box-shadow: 0 4px 15px rgba(37, 211, 102, 0.4);
        }
        .btn:hover {
            background: ${platformName === 'Telegram' ? '#006699' : '#128C7E'};
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
        <p><strong>Redirecting to ${platformName}...</strong></p>
        <a href="${redirectUrl}" class="btn">Go to ${platformName} Now</a>
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
                    window.location.href = '${redirectUrl}';
                }
            }, 1000);
        })();
    </script>
</body>
</html>
        `);
        
    } catch (error) {
        logger.error('Payment callback error:', error);

        // transient = the bank hasn't settled yet. The row stays pending and
        // the webhook will finish it, so this is not a failure.
        const outcome = error.transient ? 'pending' : 'failed';

        if (isWeb(phoneNumber)) {
            return res.redirect(302, getRedirectUrl(phoneNumber, reference, outcome, req));
        }

        if (error.transient) {
            return res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payment Processing</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
        .container { background: white; max-width: 500px; margin: 0 auto; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #f59e0b; }
        a { display: inline-block; margin-top: 20px; padding: 15px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>⏳ Payment Still Processing</h1>
        <p>Your bank is still confirming this payment. It usually takes a minute or two.</p>
        <p>Your games will be credited automatically once it clears.</p>
        <a href="javascript:location.reload()">Retry Check</a>
    </div>
</body>
</html>
            `);
        }

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
            background: #667eea;
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
        <a href="javascript:history.back()">Go Back</a>
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
    // Paystack/Korapay send 'reference', Monnify sends 'paymentReference', Flutterwave sends 'tx_ref'
    const reference = req.query.reference || req.query.paymentReference || req.query.tx_ref;
    
    if (!reference) {
        return res.status(400).send('No reference provided');
    }
    
    try {
        const verification = await tournamentService.verifyTournamentPayment(reference);
const tournament = await tournamentService.getTournamentById(verification.payment.tournament_id);

// Extract user_id from reference (format: TRN-{tournamentId}-{userId}-{timestamp} or TRNR-{tournamentId}-{userId}-{timestamp})
const refParts = reference.split('-');
const userId = refParts[2]; // userId is always the 3rd part

// Capture user's real IP for device tracking
try {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress;
    if (clientIp && userId) {
        const deviceTrackingService = require('../services/device-tracking.service');
        await deviceTrackingService.recordIP(parseInt(userId), clientIp, 'tournament_payment_callback');
    }
} catch (ipErr) {
    logger.error('Error recording tournament payment IP (non-fatal):', ipErr.message);
}

// Get user to determine platform
const userResult = await pool.query(
    'SELECT phone_number FROM users WHERE id = $1',
    [userId]  // ✅ FIXED
);
        
        const phoneNumber = userResult.rows[0]?.phone_number || '';

        let knownOrigin = null;
        if (isWeb(phoneNumber)) {
            try { knownOrigin = await redis.get(`web_origin:${userId}`); } catch (e) { /* fall back */ }
        }

        const redirectUrl = getRedirectUrl(phoneNumber, reference, 'success', req, knownOrigin);
        const platformName = getPlatformName(phoneNumber);

        // Web players go straight back into the app, same as the credit
        // purchase callback — no interstitial page they have to read.
        if (isWeb(phoneNumber)) {
            try { await redis.del(`pending_checkout:${userId}`); } catch (e) { /* non-fatal */ }
            return res.redirect(302, redirectUrl);
        }
        
        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="5;url=${redirectUrl}">
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
            background: ${platformName === 'Telegram' ? '#0088cc' : '#25D366'};
            color: white;
            text-decoration: none;
            border-radius: 50px;
            font-weight: bold;
            font-size: 1.2rem;
            transition: all 0.3s;
            box-shadow: 0 4px 15px rgba(37, 211, 102, 0.4);
        }
        .btn:hover {
            background: ${platformName === 'Telegram' ? '#006699' : '#128C7E'};
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
        <p><strong>Redirecting to ${platformName}...</strong></p>
        <a href="${redirectUrl}" class="btn">Start Playing Now!</a>
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
                    window.location.href = '${redirectUrl}';
                }
            }, 1000);
        })();
    </script>
</body>
</html>
        `);
        
    } catch (error) {
        logger.error('Tournament payment callback error:', error);
        
        // Friendly UI for "still processing" — user can retry
        if (error.transient) {
            return res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Payment Processing</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
        .container { background: white; max-width: 500px; margin: 0 auto; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #f59e0b; }
        a { display: inline-block; margin-top: 20px; padding: 15px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>⏳ Payment Still Processing</h1>
        <p>Your payment is being confirmed by your bank. This usually takes a minute or two.</p>
        <p>You'll be auto-registered once it completes. You can also tap below to retry checking.</p>
        <a href="javascript:location.reload()">Retry Check</a>
    </div>
</body>
</html>
            `);
        }
        
        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Payment Failed</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
        .container { background: white; max-width: 500px; margin: 0 auto; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #f44336; }
        a { display: inline-block; margin-top: 20px; padding: 15px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>❌ Tournament Payment Failed</h1>
        <p>Something went wrong. Please try again.</p>
        <a href="javascript:history.back()">Go Back</a>
    </div>
</body>
</html>
        `);
    }
});

module.exports = router;