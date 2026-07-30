// ============================================
// FILE: src/routes/web-game.routes.js
// Web play game surface.
//
// Deliberately tiny: every input is routed through the SAME controller that
// handles WhatsApp and Telegram, so web gets menus, answers, lifelines,
// tournaments, CAPTCHA and promo codes with no duplicated logic.
//
// Mount:  app.use('/web/game', require('./routes/web-game.routes'));
// ============================================

const express = require('express');
const router = express.Router();

const webAuthRoutes = require('./web-auth.routes');
const { requireWebAuth, requireCompleteProfile, getToken } = webAuthRoutes;

const webAuthService = require('../services/web-auth.service');
const gameEvents = require('../services/game-events.service');
const gameState = require('../services/game-state.service');
const webhookController = require('../controllers/webhook.controller');
const GameService = require('../services/game.service');
const gameService = GameService.shared;
const redis = require('../config/redis');
const pool = require('../config/database');
const { logger } = require('../utils/logger');

// ============================================
// SSE STREAM
// ============================================

router.get('/stream', async (req, res) => {
    // EventSource can't set headers, so auth rides on the cookie.
    // ?token= is accepted as a fallback for curl testing.
    const token = getToken(req) || req.query.token;
    const user = await webAuthService.getSessionUser(token);

    if (!user) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Not signed in' }));
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'      // stops proxies buffering the stream
    });
    res.write('retry: 3000\n\n');

    gameEvents.subscribe(user.id, res);
    gameEvents.emit(user.id, 'connected', { username: user.username });

    // Restore an in-flight question if they refreshed mid-game
    const snapshot = await gameEvents.getSnapshot(user.id);
    if (snapshot && !snapshot.stale) {
        gameEvents.emit(user.id, 'question.asked', { ...snapshot, restored: true });
    }

    // Then the authoritative state, so a reconnecting client knows what the
    // engine wants without having to guess from whatever text arrives next.
    gameState.emit(user).catch(() => {});

    req.on('close', () => {
        gameEvents.unsubscribe(user.id, res);
        try { res.end(); } catch (e) { /* already closed */ }
    });
});

// ============================================
// INPUT
// Everything the player does arrives here as text and goes through the
// shared router: "PLAY", "A", "50:50", "TOURNAMENTS", "MENU", a promo code…
// ============================================

router.post('/input', requireWebAuth, requireCompleteProfile, async (req, res) => {
    try {
        const text = (req.body?.text ?? '').toString().trim();
        if (!text) {
            return res.status(400).json({ success: false, error: 'Nothing was sent' });
        }
        if (text.length > 500) {
            return res.status(400).json({ success: false, error: 'That input is too long' });
        }

        // Fire and forget — the engine's replies arrive over the SSE stream,
        // so this response only confirms the input was accepted.
        webhookController.routeMessage(req.webUser.phone_number, text)
            .then(() => {
                // messaging.service already schedules this after any reply, but
                // a turn can change state without the engine saying a word.
                gameState.schedule(req.webUser.phone_number, 200);
            })
            .catch(err => {
                logger.error(`Web input failed for user ${req.webUser.id}: ${err.message}`);
                gameEvents.emit(req.webUser.id, 'error', {
                    message: 'Something went wrong handling that. Type MENU to start again.'
                });
                gameState.schedule(req.webUser.phone_number, 200);
            });

        res.json({ success: true, accepted: text });
    } catch (error) {
        logger.error('Web game input error:', error);
        res.status(500).json({ success: false, error: 'Something went wrong' });
    }
});

// ============================================
// STATE  (for first load and reconnects)
// ============================================

router.get('/state', requireWebAuth, async (req, res) => {
    try {
        const user = req.webUser;

        const fresh = await pool.query(
            'SELECT games_remaining, current_streak, longest_streak FROM users WHERE id = $1',
            [user.id]
        );
        const stats = fresh.rows[0] || {};

        const session = await gameService.getActiveSession(user.id);
        let question = null;

        if (session) {
            const snapshot = await gameEvents.getSnapshot(user.id);
            if (snapshot && !snapshot.stale) question = snapshot;
        }

        // Same derivation the SSE event uses, so a cold page load and a live
        // stream can never disagree about what the engine wants.
        const state = await gameState.derive(user);

        // An unclaimed prize is the single most important thing the lobby can
        // tell someone, and there was no way to reach it from web at all.
        let pendingWin = null;
        try {
            const payoutService = require('../services/payout.service');
            const txn = await payoutService.getPendingTransaction(user.id);
            if (txn && Number(txn.amount) > 0) {
                const details = await payoutService.getPayoutDetails(txn.id);
                pendingWin = {
                    amount: Number(txn.amount),
                    reference: `WUA-${String(txn.id).padStart(4, '0')}`,
                    detailsGiven: !!details,
                    status: txn.payout_status || 'pending'
                };
            }
        } catch (e) {
            logger.error(`Could not read pending payout: ${e && e.message}`);
        }

        res.json({
            success: true,
            user: webAuthService.publicUser({ ...user, ...stats }),
            streaming: gameEvents.isConnected(user.id),
            pendingWin,
            state,
            awaitingStart: state.phase === 'awaiting_start',   // kept for compatibility
            game: session ? {
                sessionId: session.id,
                mode: session.game_mode,
                tournamentId: session.tournament_id,
                questionNumber: session.current_question,
                currentScore: session.current_score,
                lifelines: {
                    fiftyFifty: !session.lifeline_5050_used,
                    skip: !session.lifeline_skip_used
                }
            } : null,
            question
        });
    } catch (error) {
        logger.error('Web game state error:', error);
        res.status(500).json({ success: false, error: 'Could not load your game state' });
    }
});

// ============================================
// ABANDON  (explicit quit — clears a stuck session)
// ============================================

router.post('/abandon', requireWebAuth, async (req, res) => {
    try {
        const user = req.webUser;
        const session = await gameService.getActiveSession(user.id);
        if (!session) return res.json({ success: true, message: 'No game in progress' });

        await gameService.completeGame(session, user, false, 'abandoned');
        await gameEvents.clearSnapshot(user.id);
        await redis.del(`user_state:${user.phone_number}`).catch(() => {});

        res.json({ success: true, message: 'Game ended' });
    } catch (error) {
        logger.error('Web game abandon error:', error);
        res.status(500).json({ success: false, error: 'Could not end the game' });
    }
});

// ============================================
// PHOTO VERIFICATION
// Anti-fraud can demand a selfie mid-game. Chat platforms just send an image;
// web had no way to comply at all, so a flagged web player was dead in the
// water. The body is the raw image — no base64 padding, no multipart
// dependency — and it goes through the same processPhotoVerification the
// other platforms use, so validation and scoring stay identical.
// ============================================

router.post('/photo',
    requireWebAuth,
    express.raw({ type: ['image/*', 'application/octet-stream'], limit: '10mb' }),
    async (req, res) => {
        try {
            const buf = req.body;
            if (!Buffer.isBuffer(buf) || buf.length === 0) {
                return res.status(400).json({ success: false, error: 'No image received' });
            }
            if (buf.length < 1024) {
                return res.status(400).json({ success: false, error: 'That image looks empty — try again' });
            }

            const session = await gameService.getActiveSession(req.webUser.id);
            if (!session) {
                return res.status(409).json({ success: false, error: 'No game in progress' });
            }

            const pending = await gameService.hasPendingPhotoVerification(session.session_key);
            if (!pending) {
                // The window is short and expiring mid-upload is a real outcome.
                // Resolve the game rather than leaving them on a dead screen —
                // this also covers a timeout whose in-process timer was lost.
                await gameService.reconcilePhotoTimeout(session, req.webUser);
                return res.status(409).json({
                    success: false, expired: true,
                    error: 'The verification window closed before that arrived'
                });
            }

            const handled = await gameService.processPhotoVerification(
                session, req.webUser, { photoBuffer: buf }
            );

            // processPhotoVerification emits its own result messages and, on
            // failure, ends the game — so the client just needs to know it landed.
            res.json({ success: true, handled: !!handled });

        } catch (error) {
            logger.error('Web photo verification error:', error);
            res.status(500).json({ success: false, error: 'Could not process that photo' });
        }
    }
);

// The client calls this the moment its countdown reaches zero. The server's
// own timer should already have ended the game — this exists because that
// timer is in-process, and a restart during the 20-second window would
// otherwise strand the session active forever.
router.post('/photo/expired', requireWebAuth, async (req, res) => {
    try {
        const session = await gameService.getActiveSession(req.webUser.id);
        if (!session) return res.json({ success: true, resolved: false, reason: 'no_session' });

        const resolved = await gameService.reconcilePhotoTimeout(session, req.webUser);
        res.json({ success: true, resolved });
    } catch (error) {
        logger.error('Web photo expiry error:', error);
        res.status(500).json({ success: false, error: 'Could not resolve that' });
    }
});

// ============================================
// VICTORY CARD
// The engine generates the card as a temp file and unlinks it straight after
// sending, which works for WhatsApp and is useless to a browser. handleWinShare
// caches the PNG for web; this serves it so the player can view, save and
// share it — the gate that stands between them and claiming their prize.
// ============================================

router.get('/victory-card', requireWebAuth, async (req, res) => {
    try {
        const raw = await redis.get(`victory_card:${req.webUser.id}`);
        if (!raw) {
            return res.status(404).json({
                success: false,
                error: 'That card is no longer available — reopen it from the menu'
            });
        }

        const data = JSON.parse(raw);
        const buf = Buffer.from(data.png, 'base64');

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Length', buf.length);
        res.setHeader('Cache-Control', 'private, max-age=1800');
        res.setHeader('Content-Disposition', 'inline; filename="whatsup-trivia-win.png"');
        res.end(buf);
    } catch (error) {
        logger.error('Web victory card error:', error);
        res.status(500).json({ success: false, error: 'Could not load that card' });
    }
});

// ============================================
// STATS
// Web players had no way to see anything about their own play. Uses the same
// userService.getUserStats the chat STATS command uses, so the numbers can't
// disagree between platforms.
// ============================================

router.get('/stats', requireWebAuth, async (req, res) => {
    try {
        const UserService = require('../services/user.service');
        const userService = new UserService();
        const raw = await userService.getUserStats(req.webUser.id);

        // Winnings live in transactions, not on the users row.
        let won = { total: 0, paid: 0, pending: 0, wins: 0 };
        try {
            const w = await pool.query(`
                SELECT
                  COALESCE(SUM(amount), 0) AS total,
                  COALESCE(SUM(CASE WHEN payout_status = 'paid' THEN amount ELSE 0 END), 0) AS paid,
                  COALESCE(SUM(CASE WHEN payout_status IS NULL
                                     OR payout_status IN ('pending','details_collected','approved')
                                    THEN amount ELSE 0 END), 0) AS pending,
                  COUNT(*) AS wins
                FROM transactions
                WHERE user_id = $1
                  AND transaction_type IN ('prize', 'tournament_prize')
                  AND amount > 0
            `, [req.webUser.id]);
            const r = w.rows[0] || {};
            // Postgres returns these as strings — Number() or the UI shows "0"
            // concatenated onto things.
            won = {
                total: Number(r.total || 0),
                paid: Number(r.paid || 0),
                pending: Number(r.pending || 0),
                wins: parseInt(r.wins || 0, 10)
            };
        } catch (e) {
            logger.error(`Could not total winnings: ${e && e.message}`);
        }

        res.json({
            success: true,
            stats: {
                gamesPlayed: raw?.totalGamesPlayed ?? 0,
                gamesWon: raw?.gamesWon ?? 0,
                winRate: raw?.winRate ?? 0,
                highestWin: raw?.highestWin ?? 0,
                highestQuestion: raw?.highestQuestionReached ?? 0,
                rank: raw?.rank ?? null,
                currentStreak: req.webUser.current_streak ?? 0,
                longestStreak: req.webUser.longest_streak ?? 0,
                gamesRemaining: req.webUser.games_remaining ?? 0,
                joined: raw?.joinedDate ?? req.webUser.created_at,
                winnings: won
            }
        });
    } catch (error) {
        logger.error('Web stats error:', error);
        res.status(500).json({ success: false, error: 'Could not load your stats' });
    }
});

module.exports = router;