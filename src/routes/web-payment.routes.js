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
const redis = require('../config/redis');
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

        // probe=1 is the background poll: read the row, touch nothing. The
        // player may still be on the gateway page entering card details, and
        // asking the gateway about a payment that hasn't happened yet returns
        // "not found", which must not be mistaken for "declined".
        const probe = req.query.probe === '1';

        if (!probe && (txn.status === 'pending' || txn.status === 'failed')) {
            const age = Date.now() - new Date(txn.created_at).getTime();
            if (age < VERIFY_WINDOW_MS) {
                try {
                    // markFailed:false — a web verify is never authoritative
                    // enough to condemn a transaction. Only the gateway's own
                    // webhook settles that, and it can still credit later.
                    await paymentService.verifyPayment(reference, { markFailed: false });
                } catch (error) {
                    stillProcessing = true;
                }
                txn = await load();
            }
        }

        const fresh = await pool.query(
            'SELECT games_remaining FROM users WHERE id = $1',
            [req.webUser.id]
        );

        // 'failed' is never reported to the browser as final — a payment can
        // still land afterwards. The UI shows "still checking" and the webhook
        // gets the last word.
        let status = txn.status;
        if (status === 'pending' || (status === 'failed' && stillProcessing)) status = 'processing';
        else if (status === 'failed') status = 'unsettled';

        res.json({
            success: true,
            status,                                  // processing | unsettled | success
            raw: txn.status,
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
// RECOVER
// Re-checks any recent unsettled payment for this user. Called when the buy
// screen opens, so money that arrived after we gave up still turns into
// credits without anyone having to file a support ticket.
// ============================================

router.post('/recover', requireWebAuth, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT reference FROM payment_transactions
            WHERE user_id = $1
              AND status IN ('pending', 'failed')
              AND created_at > NOW() - INTERVAL '24 hours'
            ORDER BY created_at DESC
            LIMIT 5
        `, [req.webUser.id]);

        const recovered = [];
        for (const row of r.rows) {
            // A payment the player abandoned at the gateway never existed as far
            // as the gateway is concerned, and asking about it forever fills the
            // log with "No transaction was found for this id" on every single
            // visit to the top-up screen. Give each reference a few chances —
            // enough for a slow bank transfer — then stop asking.
            const triesKey = `recover_tries:${row.reference}`;
            let tries = 0;
            try {
                tries = parseInt(await redis.get(triesKey), 10) || 0;
            } catch (e) { /* if redis is unavailable, just try */ }
            if (tries >= 5) continue;

            try {
                const v = await paymentService.verifyPayment(row.reference, { markFailed: false });
                if (v.success) {
                    recovered.push({ reference: row.reference, games: v.games, amount: v.amount });
                    try { await redis.del(triesKey); } catch (e) { /* non-fatal */ }
                }
            } catch (e) {
                try {
                    const n = await redis.incr(triesKey);
                    if (n === 1) await redis.expire(triesKey, 172800);   // 48h
                } catch (e2) { /* non-fatal */ }
            }
        }

        const fresh = await pool.query(
            'SELECT games_remaining FROM users WHERE id = $1',
            [req.webUser.id]
        );

        if (recovered.length) {
            logger.info(`♻️ Recovered ${recovered.length} payment(s) for user ${req.webUser.id}`);
        }

        res.json({
            success: true,
            recovered,
            gamesRemaining: fresh.rows[0]?.games_remaining ?? 0
        });
    } catch (error) {
        logger.error('Web payment recover error:', error);
        res.status(500).json({ success: false, error: 'Could not check recent payments' });
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

// ============================================
// TOURNAMENT ENTRY STATUS
// Tournament payments live in tournament_entry_payments keyed by
// payment_reference, not in payment_transactions — so /status/:reference
// cannot see them. Read-only: the tournament webhook is what settles entry,
// and polling must never be able to condemn a payment in flight.
// ============================================

router.get('/tournament-status/:reference', requireWebAuth, async (req, res) => {
    try {
        const reference = String(req.params.reference || '').trim();
        if (!reference) {
            return res.status(400).json({ success: false, error: 'No reference given' });
        }

        const r = await pool.query(
            `SELECT tep.*, t.tournament_name
             FROM tournament_entry_payments tep
             LEFT JOIN tournaments t ON t.id = tep.tournament_id
             WHERE tep.payment_reference = $1`,
            [reference]
        );
        const row = r.rows[0];

        // 404 rather than 403 on someone else's reference.
        if (!row || row.user_id !== req.webUser.id) {
            return res.status(404).json({ success: false, error: 'Entry not found' });
        }

        // Column is payment_status. Reading row.status gave undefined, so this
        // could never report success no matter how the payment went.
        const st = String(row.payment_status || '').toLowerCase();
        const paid = st === 'success' || st === 'paid';

        // Confirm they actually landed in the tournament, not just that money moved.
        let joined = false;
        try {
            const p = await pool.query(
                `SELECT 1 FROM tournament_participants
                 WHERE tournament_id = $1 AND user_id = $2 LIMIT 1`,
                [row.tournament_id, req.webUser.id]
            );
            joined = p.rows.length > 0;
        } catch (e) { /* non-fatal */ }

        // Entry confirmed — clear the recovery record so the checkout screen
        // stops reappearing on refresh.
        if (paid) {
            try { await redis.del(`pending_checkout:${req.webUser.id}`); } catch (e) { /* non-fatal */ }
        }

        res.json({
            success: true,
            status: paid ? 'success' : 'processing',
            raw: row.payment_status || null,
            joined,
            tournamentId: row.tournament_id,
            tournamentName: row.tournament_name || null,
            amount: Number(row.amount || 0),
            reference
        });
    } catch (error) {
        logger.error('Web tournament status error:', error);
        res.status(500).json({ success: false, error: 'Could not check that entry' });
    }
});

// ============================================
// TOURNAMENTS — list and enter
//
// Same money, different thing bought. Sits under the credit packages on the
// top-up screen rather than behind a chat menu, which is where it was
// effectively invisible to web players.
// ============================================

router.get('/tournaments', requireWebAuth, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT
                t.id, t.tournament_name, t.entry_fee, t.prize_pool, t.payment_type,
                t.start_date, t.end_date, t.max_participants,
                COUNT(DISTINCT tp.user_id) AS participant_count,
                BOOL_OR(tp.user_id = $1) AS joined,
                BOOL_OR(tep.user_id = $1 AND tep.payment_status = 'success') AS paid
            FROM tournaments t
            LEFT JOIN tournament_participants tp ON tp.tournament_id = t.id
            LEFT JOIN tournament_entry_payments tep ON tep.tournament_id = t.id
            -- 'upcoming' is included for the same reason it now is in
            -- tournamentService.getActiveTournaments() and the site's
            -- /tournaments/showcase: the admin panel creates tournaments with
            -- status 'upcoming' by default, so filtering on 'active' alone
            -- hid every newly published tournament from web players. status
            -- means published; the dates decide live-versus-upcoming.
            WHERE t.status IN ('active', 'upcoming') AND t.end_date > NOW()
            GROUP BY t.id
            ORDER BY (t.start_date <= NOW()) DESC, t.prize_pool DESC
        `, [req.webUser.id]);

        const gateways = await gatewayManager.getEnabledGatewaysForPicker();

        res.json({
            success: true,
            tournaments: r.rows.map(t => ({
                id: t.id,
                name: t.tournament_name,
                entryFee: Number(t.entry_fee) || 0,
                prizePool: Number(t.prize_pool) || 0,
                isFree: t.payment_type === 'free' || Number(t.entry_fee) === 0,
                participants: parseInt(t.participant_count, 10) || 0,   // COUNT returns a string
                maxParticipants: t.max_participants || null,
                startsAt: t.start_date,
                endsAt: t.end_date,
                started: new Date(t.start_date) <= new Date(),
                joined: t.joined === true,
                paid: t.paid === true
            })),
            gateways: gateways.map((g, i) => ({
                name: g.getName(),
                displayName: g.getDisplayName(),
                isDefault: i === 0
            }))
        });
    } catch (error) {
        logger.error('Web tournaments list error:', error);
        res.status(500).json({ success: false, error: 'Could not load tournaments' });
    }
});

router.post('/tournament/initialize', requireWebAuth, requireCompleteProfile, async (req, res) => {
    try {
        const tournamentId = parseInt(req.body?.tournamentId, 10);
        if (!Number.isInteger(tournamentId)) {
            return res.status(400).json({ success: false, error: 'Pick a tournament first' });
        }

        const tournamentService = require('../services/tournament.service');
        const tournament = await tournamentService.getTournamentById(tournamentId);
        if (!tournament) {
            return res.status(404).json({ success: false, error: 'That tournament is no longer available' });
        }

        // Free tournaments never touch a gateway.
        if (tournament.payment_type !== 'paid' || Number(tournament.entry_fee) === 0) {
            const joined = await tournamentService.joinFreeTournament(req.webUser.id, tournamentId);
            return res.json({
                success: true, free: true, joined: !!joined,
                tournamentName: tournament.tournament_name
            });
        }

        const enabled = await gatewayManager.getEnabledGatewaysForPicker();
        if (enabled.length === 0) {
            return res.status(503).json({ success: false, error: 'No payment processors available right now' });
        }

        const requested = (req.body?.gateway || '').toString().trim().toLowerCase();
        const match = enabled.find(g => g.getName() === requested);
        if (requested && !match) {
            return res.status(400).json({ success: false, error: 'That payment option is not available' });
        }
        const gatewayName = (match || enabled[0]).getName();

        const payment = await tournamentService.initializeTournamentPayment(
            req.webUser.id, tournamentId, gatewayName
        );

        const checkout = {
            kind: 'tournament',
            title: tournament.tournament_name,
            subtitle: 'Tournament entry',
            amount: Number(tournament.entry_fee) || 0,
            gateway: gatewayName,
            gatewayLabel: gatewayName.charAt(0).toUpperCase() + gatewayName.slice(1),
            authorizationUrl: payment.authorization_url,
            reference: payment.reference,
            expiresInMinutes: 30,
            note: "You'll be added to the tournament automatically once payment clears."
        };

        // Same recovery record the chat-initiated flow writes, so a lost tab or
        // a dropped stream doesn't strand a paid entry.
        await redis.setex(`pending_checkout:${req.webUser.id}`, 1800, JSON.stringify(checkout));

        res.json({ success: true, checkout });

    } catch (error) {
        const msg = String(error && error.message || '');
        // These are expected states, not failures — say so plainly.
        if (/already paid/i.test(msg)) {
            return res.status(409).json({ success: false, error: "You've already paid for this tournament" });
        }
        if (/free tournament/i.test(msg)) {
            return res.status(400).json({ success: false, error: 'That tournament is free to enter' });
        }
        logger.error('Web tournament initialize error:', error);
        res.status(500).json({ success: false, error: 'Could not start that entry' });
    }
});

module.exports = router;