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
// CHALLENGE PAYMENT CALLBACK
// ============================================
// The browser landing back after checkout. The WEBHOOK is what settles a
// challenge, so this page decides nothing \u2014 it reports where the sponsorship
// has got to and sends the player somewhere useful.
async function handleChallengeCallback(reference, req, res) {
    const page = (title, colour, heading, body, link) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
<style>body{font-family:system-ui,Arial,sans-serif;text-align:center;padding:44px 20px;background:#14101f;color:#e9e4f5}
.card{background:#1d1730;max-width:460px;margin:0 auto;padding:34px 26px;border-radius:16px;border:1px solid #2e2545}
h1{color:${colour};font-size:22px;margin:0 0 10px}p{color:#b3a9c9;line-height:1.55}
a{display:inline-block;margin-top:20px;padding:13px 26px;background:#f0b429;color:#1a1226;
text-decoration:none;border-radius:10px;font-weight:600}</style></head>
<body><div class="card"><h1>${heading}</h1><p>${body}</p>${link}</div></body></html>`;

    const playUrl = process.env.PLAY_URL || 'https://play.whatsuptrivia.com.ng';

    try {
        const found = await pool.query(
            `SELECT s.payment_status, c.code
             FROM challenge_sponsorships s
             JOIN challenges c ON c.id = s.challenge_id
             WHERE s.payment_reference = $1`,
            [reference]
        );

        const row = found.rows[0];
        if (!row) {
            return res.send(page('Payment', '#f0b429', '\u23f3 Checking\u2026',
                'We have not matched this payment yet. If it went through, your challenge ' +
                'will open on its own within a minute.',
                `<a href="${playUrl}">Back to the game</a>`));
        }

        if (row.payment_status === 'settled' || row.payment_status === 'awarded') {
            return res.send(page('Payment received', '#3ddc97', '\u2705 Payment received',
                'Your challenge is live. Your invite is waiting \u2014 send it to whoever ' +
                'you want to beat.',
                `<a href="${playUrl}/c/${row.code}">Open my challenge</a>`));
        }

        // Still pending: the gateway redirected before the webhook landed,
        // which is normal and is NOT a failure.
        return res.send(page('Payment processing', '#f0b429', '\u23f3 Almost there',
            'Your bank is still confirming. This usually takes under a minute, and your ' +
            'challenge opens by itself when it clears.',
            `<a href="${playUrl}/c/${row.code}">Open my challenge</a>`));

    } catch (error) {
        logger.error('Challenge payment callback error:', error.message);
        return res.send(page('Payment', '#f0b429', '\u23f3 Checking\u2026',
            'We could not confirm this right away. If the payment went through, your ' +
            'challenge will open on its own.',
            `<a href="${playUrl}">Back to the game</a>`));
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

        // TWO MESSAGES, matching creation in free mode.
        //
        // The confirmation was carrying the bare link, so a paid challenge
        // produced no forwardable invite at all \u2014 and no entry code for the
        // creator, who cannot play their own challenge without one. Whoever
        // paid ended up with a URL and nothing to send.
        const challengeChatService = require('../services/challenge-chat.service');
        const challengeService = require('../services/challenge.service');

        const challenge = await challengeService.getByCode(result.code);
        if (!challenge) {
            logger.error(`Sponsorship settled for ${result.code} but the challenge is gone`);
            return;
        }

        // Declared once and used by both the messages and the web push. It was
        // missing from the push, which threw a ReferenceError that the catch
        // swallowed as "Could not push the share screen after payment" \u2014 so the
        // web creator's screen never updated and the log said only that
        // something had failed.
        const links = deepLinkService.buildLinks(result.code);

        const prize = Number(challenge && challenge.prize_amount) || 0;
        const setup = Number(challenge && challenge.setup_charge) || 0;
        const fee = Number(challenge && challenge.prize_fee) || 0;

        // The code is issued first so it can be printed in the confirmation
        // rather than arriving separately.
        let entryCode = null;
        try {
            const challengeAuthService = require('../services/challenge-auth.service');
            const issued = await challengeAuthService.issueCode(challenge, user, { deliver: false });
            if (issued.ok) entryCode = issued.code;
        } catch (e) {
            logger.error('Could not issue an entry code after payment:', e.message);
        }

        await messagingService.sendMessage(user.phone_number,
            challengeChatService.STRINGS.paymentConfirmed(
                { setup, prize, fee }, result.code, entryCode
            ));

        // The forwardable invite, on its own so the entry code never travels
        // inside a message built to be passed on.
        await messagingService.sendMessage(user.phone_number,
            challengeChatService.STRINGS.invite(
                challengeChatService.displayName(user),
                deepLinkService.buildLinks(result.code),
                challengeChatService._categoryBlock(challenge.categories),
                challenge.mode === 'live' && challenge.scheduled_start_at
                    ? challengeChatService.watLabel(challenge.scheduled_start_at) : null,
                challenge.max_participants,
                prize
            ));

        // A WEB CREATOR IS STARING AT A CHECKOUT SCREEN.
        //
        // The messages above go to their chat identifier, which for a web user
        // renders as a transient prompt \u2014 so the payment cleared and the
        // screen still said "Waiting for payment\u2026" with no way forward. The
        // share screen is what they actually need: the invite, ready to copy.
        if (String(user.phone_number || '').startsWith('web_')) {
            try {
                const gameEvents = require('../services/game-events.service');
                gameEvents.emit(user.id, 'challenge.created', {
                    code: result.code,
                    links,
                    categories: challengeChatService._categoryBlock(challenge.categories),
                    startLabel: challenge.mode === 'live' && challenge.scheduled_start_at
                        ? challengeChatService.watLabel(challenge.scheduled_start_at) : null,
                    inviteText: challengeChatService.STRINGS.invite(
                        challengeChatService.displayName(user),
                        links,
                        challengeChatService._categoryBlock(challenge.categories),
                        challenge.mode === 'live' && challenge.scheduled_start_at
                            ? challengeChatService.watLabel(challenge.scheduled_start_at) : null,
                        challenge.max_participants,
                        prize
                    )
                });
            } catch (error) {
                logger.error('Could not push the share screen after payment:', error.message);
            }
        }

        // They are no longer waiting on money, so PAY should stop responding.
        try {
            const redisClient = require('../config/redis');
            await redisClient.del(`challenge_awaiting_payment:${user.phone_number}`);
        } catch (e) { /* a missing key is the desired state */ }
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
    
    // A CHALLENGE PAYMENT IS NOT A TOKEN PAYMENT.
    //
    // Two things below assume the token reference format
    // {WUAIB|KOR}-{user_id}-{timestamp}-{random}: the user id is read from
    // position 1, and verifyPayment() looks the reference up in `transactions`.
    // A challenge reference is CHS-{challengeId}-{userId}-{timestamp} and its
    // record lives in challenge_sponsorships \u2014 so position 1 returned the
    // CHALLENGE id, the lookup found nothing, and a payment that had genuinely
    // succeeded rendered "Payment Failed".
    if (reference.startsWith('CHS-')) {
        return handleChallengeCallback(reference, req, res);
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