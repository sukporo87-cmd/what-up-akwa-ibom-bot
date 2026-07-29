// ============================================
// FILE: src/routes/web-payment.routes.js
// Credit purchase for web play.
//
// Unlike gameplay, this does NOT route through webhookController. The chat
// buy flow is a text state machine (SELECT_PACKAGE -> SELECT_PACKAGE_GATEWAY)
// which exists only because WhatsApp can't render a button. On web we can, so
// this is a plain REST surface over the same PaymentService and the same
// gateway manager. Crediting, verification and webhooks are untouched.
//
// Mount:  app.use('/web/payment', require('./routes/web-payment.routes'));
// ============================================

const express = require('express');
const router = express.Router();

const webAuthRoutes = require('./web-auth.routes');
const { requireWebAuth, requireCompleteProfile } = webAuthRoutes;

const PaymentService = require('../services/payment.service');
const gatewayManager = require('../services/payment-gateway-manager');
const pool = require('../config/database');
const { logger } = require('../utils/logger');

const paymentService = new PaymentService();

// A transaction older than this is never re-verified against the gateway —
// checkout links expire, and hammering a dead reference just marks it failed.
const VERIFY_WINDOW_MS = 3 * 60 * 60 * 1000;

function clientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress
        || null;
}

/**
 * The origin the browser is actually talking to.
 *
 * This matters more than it looks. The session cookie is host-only and the
 * token in localStorage is per-origin, so if checkout returns the player to a
 * DIFFERENT host than the one they signed in on, they land signed-out. Sending
 * the gateway back to the origin the request came from keeps the whole round
 * trip on one origin, whatever domain they happen to be using.
 */
function originOf(req) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return host ? `${proto}://${host}` : null;
}

// ============================================
// PACKAGES + AVAILABLE PROCESSORS
// One call, because the UI needs both to render the buy screen.
// ============================================

router.get('/packages', requireWebAuth, async (req, res) => {
    try {
        const [packages, gateways] = await Promise.all([
            paymentService.getPackages(),
            gatewayManager.getEnabledGatewaysForPicker()
        ]);

        // "Best value" is derived, not hardcoded to a package name — if the
        // pricing table changes the badge follows it.
        let bestId = null;
        let bestRatio = -1;
        for (const p of packages) {
            const price = Number(p.price_naira);
            const ratio = price > 0 ? Number(p.games_count) / price : 0;
            if (ratio > bestRatio) { bestRatio = ratio; bestId = p.id; }
        }

        const fresh = await pool.query(
            'SELECT games_remaining FROM users WHERE id = $1',
            [req.webUser.id]
        );

        res.json({
            success: true,
            paymentEnabled: paymentService.isEnabled(),
            gamesRemaining: fresh.rows[0]?.games_remaining ?? 0,
            packages: packages.map(p => ({
                id: p.id,
                name: p.name,
                price: Number(p.price_naira),
                games: p.games_count,
                description: p.description,
                bestValue: p.id === bestId && packages.length > 1
            })),
            gateways: gateways.map((g, i) => ({
                name: g.getName(),
                displayName: g.getDisplayName(),
                isDefault: i === 0          // picker is already sorted default-first
            }))
        });
    } catch (error) {
        logger.error('Web packages error:', error);
        res.status(500).json({ success: false, error: 'Could not load packages right now' });
    }
});

// ============================================
// INITIALIZE
// Returns a hosted checkout URL. All four gateways are web-first, so the
// browser just follows authorizationUrl and comes back via /payment/callback.
// ============================================

router.post('/initialize', requireWebAuth, requireCompleteProfile, async (req, res) => {
    try {
        if (!paymentService.isEnabled()) {
            return res.status(400).json({
                success: false,
                paymentDisabled: true,
                error: 'Games are free at the moment — no purchase needed. Just hit Play.'
            });
        }

        const packageId = parseInt(req.body?.packageId, 10);
        if (!Number.isInteger(packageId)) {
            return res.status(400).json({ success: false, error: 'Pick a package first' });
        }

        const enabled = await gatewayManager.getEnabledGatewaysForPicker();
        if (enabled.length === 0) {
            return res.status(503).json({
                success: false,
                error: 'No payment processors are available right now. Please try again shortly.'
            });
        }

        // Never trust the client's gateway string — it has to be one that is
        // actually enabled, or we fall back to the configured default.
        const requested = (req.body?.gateway || '').toString().trim().toLowerCase();
        const match = enabled.find(g => g.getName() === requested);
        if (requested && !match) {
            return res.status(400).json({ success: false, error: 'That payment option is not available' });
        }
        const gatewayName = (match || enabled[0]).getName();

        const origin = originOf(req);

        const payment = await paymentService.initializePayment(
            req.webUser,
            packageId,
            gatewayName,
            {
                email: req.webUser.email,
                callbackUrl: origin ? `${origin}/payment/callback` : undefined
            }
        );

        // Record the IP at intent time as well as at callback — a mismatch
        // between the two is a signal the fraud tooling can use later.
        try {
            const ip = clientIp(req);
            if (ip) {
                const deviceTrackingService = require('../services/device-tracking.service');
                await deviceTrackingService.recordIP(req.webUser.id, ip, 'web_payment_init');
            }
        } catch (ipErr) {
            logger.error('Error recording web payment IP (non-fatal):', ipErr.message);
        }

        logger.info(`💳 Web checkout opened: user ${req.webUser.id} via ${gatewayName} — ${payment.reference}`);

        res.json({
            success: true,
            authorizationUrl: payment.authorization_url,
            reference: payment.reference,
            amount: payment.amount,
            games: payment.games,
            gateway: payment.gateway
        });

    } catch (error) {
        logger.error('Web payment initialize error:', error);
        res.status(500).json({
            success: false,
            error: 'Could not start that payment. Please try again.'
        });
    }
});

// ============================================
// STATUS
// The browser polls this after returning from checkout. Usually it beats the
// webhook, so a pending transaction gets verified inline here.
// ============================================

router.get('/status/:reference', requireWebAuth, async (req, res) => {
    try {
        const reference = String(req.params.reference || '').trim();
        if (!reference) {
            return res.status(400).json({ success: false, error: 'No reference given' });
        }

        const load = async () => {
            const r = await pool.query(
                'SELECT * FROM payment_transactions WHERE reference = $1',
                [reference]
            );
            return r.rows[0] || null;
        };

        let txn = await load();

        // 404 rather than 403 on someone else's reference — no point confirming
        // that it exists.
        if (!txn || txn.user_id !== req.webUser.id) {
            return res.status(404).json({ success: false, error: 'Payment not found' });
        }

        let stillProcessing = false;

        if (txn.status === 'pending') {
            const age = Date.now() - new Date(txn.created_at).getTime();
            if (age < VERIFY_WINDOW_MS) {
                try {
                    await paymentService.verifyPayment(reference);
                } catch (error) {
                    // transient = gateway says "not settled yet"; verifyPayment
                    // deliberately leaves the row pending so the webhook can
                    // finish the job. Anything else is already marked failed.
                    if (error.transient) stillProcessing = true;
                }
                txn = await load();
            }
        }

        const fresh = await pool.query(
            'SELECT games_remaining FROM users WHERE id = $1',
            [req.webUser.id]
        );

        res.json({
            success: true,
            status: stillProcessing ? 'processing' : txn.status,   // pending|processing|success|failed
            reference: txn.reference,
            amount: Number(txn.amount),
            games: txn.games_purchased,
            gateway: txn.gateway_used,
            gamesRemaining: fresh.rows[0]?.games_remaining ?? 0
        });

    } catch (error) {
        logger.error('Web payment status error:', error);
        res.status(500).json({ success: false, error: 'Could not check that payment' });
    }
});

// ============================================
// HISTORY
// ============================================

router.get('/history', requireWebAuth, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT pt.reference, pt.amount, pt.games_purchased, pt.status,
                   pt.gateway_used, pt.paid_at, pt.created_at, gp.name AS package_name
            FROM payment_transactions pt
            LEFT JOIN game_packages gp ON gp.id = pt.package_id
            WHERE pt.user_id = $1
            ORDER BY pt.created_at DESC
            LIMIT 20
        `, [req.webUser.id]);

        res.json({
            success: true,
            transactions: r.rows.map(t => ({
                reference: t.reference,
                packageName: t.package_name,
                amount: Number(t.amount),
                games: t.games_purchased,
                status: t.status,
                gateway: t.gateway_used,
                at: t.paid_at || t.created_at
            }))
        });
    } catch (error) {
        logger.error('Web payment history error:', error);
        res.status(500).json({ success: false, error: 'Could not load your purchases' });
    }
});

module.exports = router;