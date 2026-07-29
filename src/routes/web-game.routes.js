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
const webhookController = require('../controllers/webhook.controller');
const GameService = require('../services/game.service');
const gameService = new GameService();
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
            .catch(err => {
                logger.error(`Web input failed for user ${req.webUser.id}: ${err.message}`);
                gameEvents.emit(req.webUser.id, 'error', {
                    message: 'Something went wrong handling that. Type MENU to start again.'
                });
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

        // startNewGame() creates the session, sends the rules and then waits
        // for the player to send START — it parks that intent in Redis. On
        // chat you just type it; the web UI needs to know so it can show a
        // button instead of an empty board.
        let awaitingStart = false;
        try {
            awaitingStart = !!(await redis.get(`game_ready:${user.id}`));
        } catch (e) { /* non-fatal */ }

        res.json({
            success: true,
            user: webAuthService.publicUser({ ...user, ...stats }),
            streaming: gameEvents.isConnected(user.id),
            awaitingStart,
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

module.exports = router;