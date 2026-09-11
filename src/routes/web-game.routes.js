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
const auditService = require('../services/audit.service');
const restrictionsService = require('../services/restrictions.service');
const reviewInvites = require('../services/review-invite.service');

// Runs fn with this request's IP, user agent and open-stream count attached to
// any answer it produces (see audit.service, WEB INPUT ATTRIBUTION). If the
// deployed audit.service predates that, fn simply runs — so this file can go
// out before or after it without breaking input.
function withWebInput(req, userId, fn) {
    if (typeof auditService.runWithWebInput !== 'function') return fn();
    return auditService.runWithWebInput(req, userId, fn);
}

/**
 * Record the origin this player is actually on.
 *
 * Payment callbacks are hit by the gateway at APP_URL, not by the player, so a
 * callback has no way to know where to send them back to. Credit purchase gets
 * around this by passing the origin at initialize time; the tournament flow is
 * driven from a chat state machine with no request available, so it needs this.
 */
function rememberOrigin(req, userId) {
    try {
        const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        if (!host || !userId) return;
        redis.setex(`web_origin:${userId}`, 86400, `${proto}://${host}`).catch(() => {});
    } catch (e) { /* never worth failing a request over */ }
}
const { logger } = require('../utils/logger');

// The live Classic, tournament or practice session a client-side event belongs
// to, or null. CLASSIC ONLY, by design: getActiveSession filters out challenge
// rounds, and nothing here looks a challenge up. Challenge mode is outside the
// anti-cheat work while it is still being built, so a signal from a challenge
// screen is never recorded against anything.
async function resolveLiveSession(userId) {
    try {
        const session = await gameService.getActiveSession(userId);
        if (session) {
            return { sessionId: session.id, questionNumber: session.current_question, kind: 'classic' };
        }
    } catch (e) { /* not in a game */ }
    return null;
}

// Who single-stream may act on. Everything here answers "hands off" unless it
// is sure: a web-play account (web_ phone), not mid-way through a challenge
// chat flow, not in a challenge round. Arena rooms are checked in game-events
// itself. challengeChatService is only ASKED; nothing in challenge mode is
// changed or called with side effects.
let challengeChatService = null;
async function mayClaimForClassic(userId, phone) {
    if (!phone || !String(phone).startsWith('web_')) return false;
    try {
        if (!challengeChatService) challengeChatService = require('../services/challenge-chat.service');
        if (await challengeChatService.isInFlow(phone)) return false;
        if (await challengeChatService.isPlaying(phone)) return false;
    } catch (e) {
        return false;
    }
    return true;
}
if (typeof gameEvents.setClaimGuard === 'function') gameEvents.setClaimGuard(mayClaimForClassic);

// Request facts for the audit row. audit.service owns the shape; if an older
// audit.service is deployed without it, log the essentials inline.
function requestFacts(req, userId) {
    const describe = auditService.constructor && auditService.constructor.describeWebRequest;
    if (typeof describe === 'function') {
        const { userId: _u, receivedAt, ...facts } = describe(req, userId);
        return facts;
    }
    return {
        ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
        user_agent: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 300) : null
    };
}

// A phone, by the user agent the SERVER received — not by anything the page
// claims. Tablets are left out on purpose: iPadOS reports itself as a Mac and
// many Android tablets drop "Mobile", so they are neither caught nor falsely
// accused by the phone-only checks below.
const PHONE_UA = /iPhone|iPod|Android.*Mobile|Windows Phone/i;

// When a game is live and an older stream is closed, write it down. Two
// devices on one live game is worth seeing in review. It is NOT a user flag:
// a second tab left open is common and innocent.
// Guarded: if this file is deployed before game-events.service, the listener
// is simply not registered, rather than a TypeError at load taking the app down.
if (typeof gameEvents.onStreamReplaced === 'function') gameEvents.onStreamReplaced(async ({ userId, closed, reason, type, payload }) => {
    try {
        const live = await resolveLiveSession(userId);
        if (!live) return;
        await auditService.logEvent(live.sessionId, userId, 'STREAM_REPLACED', {
            closed_streams: closed,
            reason,
            trigger_event: type,
            question_number: live.questionNumber,
            context: live.kind
        });
    } catch (e) {
        logger.error('Could not audit a replaced stream:', e.message);
    }
});

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

    // Connection id, generated by the page each time it deliberately opens a
    // stream. EventSource's own automatic reconnects reuse the URL, so they
    // reuse the id — which is how a replaced stream is recognised coming back.
    const cid = /^[A-Za-z0-9_-]{8,64}$/.test(String(req.query.cid || '')) ? String(req.query.cid) : null;

    // Replaced by a newer stream on a live game. 204 is the one response that
    // makes EventSource stop reconnecting; anything else and the two devices
    // would take the game from each other every few seconds.
    if (cid && typeof gameEvents.isDisplaced === 'function' && gameEvents.isDisplaced(user.id, cid)) {
        res.writeHead(204);
        return res.end();
    }

    // PASSIVE: a page that was closed while sitting on a challenge screen,
    // quietly trying to get its stream back. It must never take a live Classic
    // game from the other device, so while one is live it is refused — unless
    // this account is in an arena room, where single-stream never acts and
    // the page needs its stream for the match.
    const passive = req.query.passive === '1';
    if (passive && typeof gameEvents.isInArenaRoom === 'function' && !gameEvents.isInArenaRoom(user.id)) {
        let classicLive = false;
        try { classicLive = !!(await gameService.getActiveSession(user.id)); } catch (e) { classicLive = false; }
        if (classicLive) {
            res.writeHead(204);
            return res.end();
        }
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'      // stops proxies buffering the stream
    });
    res.write('retry: 3000\n\n');

    gameEvents.subscribe(user.id, res, { cid, phone: user.phone_number });
    gameEvents.emit(user.id, 'connected', { username: user.username });

    // Connecting DURING a live Classic game claims it now, not at the next
    // question — between questions, on a CAPTCHA or at turbo's GO prompt a
    // second device would otherwise keep both streams for several seconds.
    // claimForClassic does nothing for anyone involved in challenge mode.
    if (!passive && typeof gameEvents.claimForClassic === 'function' && gameEvents.connectionCount(user.id) > 1) {
        try {
            const liveSession = await gameService.getActiveSession(user.id);
            if (liveSession) await gameEvents.claimForClassic(user.id, 'connected_during_game');
        } catch (e) { /* never fail a stream over this */ }
    }

    // Restore an in-flight question if they refreshed mid-game
    const snapshot = await gameEvents.getSnapshot(user.id);
    if (snapshot && !snapshot.stale) {
        gameEvents.emit(user.id, 'question.asked', { ...snapshot, restored: true });
    }

    // Then the authoritative state, so a reconnecting client knows what the
    // engine wants without having to guess from whatever text arrives next.
    gameState.emit(user).catch(() => {});

    rememberOrigin(req, user.id);

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
        withWebInput(req, req.webUser.id, () => webhookController.routeMessage(req.webUser.phone_number, text))
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
// SIGNAL  (what the page noticed during a question)
// ============================================
// Two families, one door:
//
//   COPY ATTEMPTS — copy, cut, long_press. Selection and the long-press menu
//   are blocked on the question, options and flag, so on a phone these are
//   mostly attempts that did nothing. Logged to the audit trail. NOT a user
//   flag: a long press is also what an idle thumb does.
//
//   AUTOMATION — webdriver, phone_ua_no_touch, mouse_on_phone. Logged AND
//   raised as a suspicious-user flag. That flag has teeth: a suspicious user is
//   asked for a selfie at Q13-15 in every later game (shouldRequestPhotoVerification).
//
// Everything here is reported by the page, so it can be faked or suppressed by
// someone technical. It exists to catch the crude setups, and nothing in it
// changes a game outcome by itself.
const SIGNAL_KINDS = {
    copy:              { family: 'copy_attempt' },
    cut:               { family: 'copy_attempt' },
    long_press:        { family: 'copy_attempt' },
    webdriver:         { family: 'automation', flag: true },
    phone_ua_no_touch: { family: 'automation', flag: true, phoneOnly: true },
    // A phone with a Bluetooth mouse, or Samsung DeX, is real. One mouse press
    // is not raised; the second in the same game is.
    mouse_on_phone:    { family: 'automation', flag: true, phoneOnly: true, flagAt: 2 }
};

router.post('/signal', requireWebAuth, async (req, res) => {
    try {
        const user = req.webUser;
        const kind = String((req.body && req.body.kind) || '');
        const spec = SIGNAL_KINDS[kind];
        if (!spec) return res.status(400).json({ success: false, error: 'Unknown signal' });

        // A page stuck in a loop must not fill the audit table.
        const rateKey = `signal_rate:${user.id}`;
        const count = await redis.incr(rateKey);
        if (count === 1) await redis.expire(rateKey, 60);
        if (count > 30) return res.json({ success: true, recorded: false });

        // The phone checks are judged on the user agent the server received,
        // so a page cannot accuse a desktop browser of being a phone.
        const ua = String(req.headers['user-agent'] || '');
        if (spec.phoneOnly && !PHONE_UA.test(ua)) {
            return res.json({ success: true, recorded: false });
        }

        const body = req.body || {};
        const live = await resolveLiveSession(user.id);
        if (!live) return res.json({ success: true, recorded: false });

        const detail = {
            kind,
            family: spec.family,
            context: live.kind,
            question_number: live.questionNumber,
            touch_points: Number.isFinite(body.touchPoints) ? body.touchPoints : null,
            has_touch_events: typeof body.touchEvents === 'boolean' ? body.touchEvents : null,
            pointer_type: typeof body.pointerType === 'string' ? body.pointerType.slice(0, 16) : null,
            ...requestFacts(req, user.id)
        };

        await auditService.logEvent(live.sessionId, user.id, 'CLIENT_SIGNAL', detail);

        let flagged = false;
        if (spec.flag) {
            // Once per kind per game, so one session cannot write a hundred
            // entries into users.suspicious_flags.
            const seen = await redis.incr(`signal_seen:${live.sessionId}:${kind}`);
            if (seen === 1) await redis.expire(`signal_seen:${live.sessionId}:${kind}`, 86400);
            if (seen === (spec.flagAt || 1)) {
                await restrictionsService.flagUserSuspicious(user.id, `automation_${kind}`, {
                    session_id: live.sessionId,
                    question_number: live.questionNumber,
                    context: live.kind,
                    user_agent: detail.user_agent,
                    ip: detail.ip
                });
                flagged = true;
            }
        }

        res.json({ success: true, recorded: true, flagged });
    } catch (error) {
        logger.error('Web signal error:', error);
        res.status(500).json({ success: false, error: 'Could not record that' });
    }
});

// ============================================
// REVIEW LINK  (the lobby's "Leave a review" button)
// ============================================
// The web twin of typing REVIEW on WhatsApp or Telegram: a single-use link
// tied to this signed-in account, so the review it produces is verified.
// The page, the moderation queue and the badge are the existing ones.
router.post('/review-link', requireWebAuth, async (req, res) => {
    try {
        const user = req.webUser;

        const active = await gameService.getActiveSession(user.id);
        if (active) {
            return res.status(409).json({
                success: false,
                error: 'Finish your game first, then leave a review.'
            });
        }

        const result = await reviewInvites.linkOnRequest(user, 'web');
        if (!result.ok && result.reason === 'already_reviewed') {
            return res.json({ success: true, alreadyReviewed: true });
        }
        if (!result.ok) {
            return res.status(500).json({
                success: false,
                error: "We couldn't create your review link just now. Please try again in a few minutes."
            });
        }
        res.json({ success: true, url: result.url });
    } catch (error) {
        logger.error('Web review link error:', error);
        res.status(500).json({
            success: false,
            error: "We couldn't create your review link just now. Please try again in a few minutes."
        });
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
        rememberOrigin(req, user.id);

        // Anything about the player's money that still needs them.
        //
        // Deliberately NOT payoutService.getPendingTransaction: that excludes
        // 'paid', because for the claim flow a paid prize is finished. Here it
        // isn't — a paid prize still needs the player to confirm it arrived,
        // which is the step WhatsApp does with "reply RECEIVED". Using the
        // claim query meant the tile vanished the moment you were paid.
        let pendingWin = null;
        try {
            const r = await pool.query(`
                SELECT t.id, t.amount, t.payout_status, t.paid_at, t.confirmed_at,
                       (pd.id IS NOT NULL) AS details_given
                FROM transactions t
                LEFT JOIN payout_details pd ON pd.transaction_id = t.id
                WHERE t.user_id = $1
                  AND t.transaction_type IN ('prize', 'tournament_prize')
                  AND t.amount > 0
                  AND t.confirmed_at IS NULL
                  AND (t.payout_status IS NULL
                       OR t.payout_status IN ('pending', 'details_collected', 'approved', 'paid'))
                ORDER BY t.created_at DESC
                LIMIT 1
            `, [user.id]);

            const txn = r.rows[0];
            if (txn && Number(txn.amount) > 0) {
                const status = txn.payout_status || 'pending';
                pendingWin = {
                    amount: Number(txn.amount),
                    reference: `WUA-${String(txn.id).padStart(4, '0')}`,
                    detailsGiven: txn.details_given === true,
                    status,
                    awaitingReceipt: status === 'paid',
                    paidAt: txn.paid_at || null
                };
            }
        } catch (e) {
            logger.error(`Could not read pending payout: ${e && e.message}`);
        }

        // checkout.required is a one-shot event, and the chat text that used to
        // carry the link is now suppressed for web. If the stream blinks at the
        // wrong moment the player gets nothing at all — which is exactly what
        // happened. Persisted alongside so a refresh recovers it.
        let pendingCheckout = null;
        try {
            const raw = await redis.get(`pending_checkout:${user.id}`);
            if (raw) pendingCheckout = JSON.parse(raw);
        } catch (e) {
            logger.error(`Could not read pending checkout: ${e && e.message}`);
        }

        res.json({
            success: true,
            user: webAuthService.publicUser({ ...user, ...stats }),
            streaming: gameEvents.isConnected(user.id),
            pendingWin,
            pendingCheckout,
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
// ABANDON  (explicit quit — forfeits all winnings from the game)
// ============================================

router.post('/abandon', requireWebAuth, async (req, res) => {
    try {
        const user = req.webUser;
        const session = await gameService.getActiveSession(user.id);
        if (!session) return res.json({ success: true, message: 'No game in progress' });

        // QUITTING FORFEITS EVERYTHING — safe-point winnings included.
        // completeGame settles session.current_score, which is the full ladder
        // amount after every correct answer. Settling that here paid a player
        // who quit at Q8 ₦3,000, more than timing out would have. It is set to
        // zero first, so the ✕ button pays nothing on web, in Classic and in
        // tournaments alike.
        //
        // What was given up, and whether a security check was waiting, is
        // recorded first: quitting the moment a CAPTCHA or selfie appears is
        // worth seeing in review.
        const forfeited = Number(session.current_score) || 0;
        let pendingCheck = null;
        try {
            if (await gameService.hasPendingCaptcha(session.session_key)) pendingCheck = 'captcha';
            else if (await gameService.hasPendingPhotoVerification(session.session_key)) pendingCheck = 'photo';
            else if (await gameService.isWaitingForTurboGo(session.session_key)) pendingCheck = 'turbo_go';
        } catch (e) { /* the forfeit does not depend on this */ }

        await auditService.logEvent(session.id, user.id, 'GAME_FORFEITED', {
            reason: 'player_quit',
            forfeited_amount: forfeited,
            question_number: session.current_question,
            pending_check: pendingCheck
        });

        session.current_score = 0;
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
        const u = req.webUser;

        // Bucketed explicitly rather than reusing userService.getUserStats,
        // which counts practice games as wins and takes "furthest reached"
        // from a denormalised column that practice also writes to. Practice
        // awards a notional score and no money, so counting it as a win
        // overstates everything that matters.
        //
        // NOTE: the same flaw affects the chat STATS command. Left alone here
        // rather than silently changing numbers players already know.
        const rows = await pool.query(`
            SELECT
              -- challenge_id FIRST. A challenge round writes a real
              -- game_sessions row, and without this branch it falls through
              -- ELSE and is counted as a Classic game in every player's stats
              -- — the exact opposite of "challenge scores stay off Classic".
              -- Bucketed rather than excluded so the profile can show
              -- "214 games played · 38 challenges": two numbers, each meaning
              -- one thing.
              CASE WHEN challenge_id IS NOT NULL     THEN 'challenge'
                   WHEN game_type = 'practice'      THEN 'practice'
                   WHEN is_tournament_game IS TRUE  THEN 'tournament'
                   ELSE 'classic' END                AS bucket,
              COUNT(*)                                                  AS played,
              COUNT(CASE WHEN final_score > 0 THEN 1 END)               AS won,
              COALESCE(MAX(final_score), 0)                             AS best,
              COALESCE(MAX(current_question), 0)                        AS furthest
            FROM game_sessions
            WHERE user_id = $1 AND status = 'completed'
            GROUP BY 1
        `, [u.id]);

        const empty = { played: 0, won: 0, best: 0, furthest: 0 };
        const by = { practice: { ...empty }, classic: { ...empty }, tournament: { ...empty } };
        for (const r of rows.rows) {
            by[r.bucket] = {
                // Postgres hands COUNT and MAX back as strings.
                played: parseInt(r.played, 10) || 0,
                won: parseInt(r.won, 10) || 0,
                best: Number(r.best) || 0,
                furthest: parseInt(r.furthest, 10) || 0
            };
        }

        // "Real" play is anything that could pay out.
        const real = {
            played: by.classic.played + by.tournament.played,
            won: by.classic.won + by.tournament.won,
            best: Math.max(by.classic.best, by.tournament.best),
            furthest: Math.max(by.classic.furthest, by.tournament.furthest)
        };
        const totalPlayed = real.played + by.practice.played;

        // Winnings come from transactions, which is the only place payout
        // status lives.
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
            `, [u.id]);
            const r = w.rows[0] || {};
            won = {
                total: Number(r.total || 0),
                paid: Number(r.paid || 0),
                pending: Number(r.pending || 0),
                wins: parseInt(r.wins || 0, 10)
            };
        } catch (e) {
            logger.error(`Could not total winnings: ${e && e.message}`);
        }

        let rank = null;
        try {
            const rk = await pool.query(
                `SELECT COUNT(*) + 1 AS rank FROM users
                 WHERE COALESCE(total_winnings, 0) > COALESCE((SELECT total_winnings FROM users WHERE id = $1), 0)`,
                [u.id]
            );
            rank = parseInt(rk.rows[0]?.rank, 10) || null;
        } catch (e) { /* non-fatal */ }

        res.json({
            success: true,
            profile: {
                fullName: u.full_name,
                username: u.username,
                city: u.city,
                email: u.email,
                referralCode: u.referral_code,
                joined: u.created_at
            },
            stats: {
                gamesPlayed: totalPlayed,
                breakdown: {
                    classic: by.classic.played,
                    tournament: by.tournament.played,
                    practice: by.practice.played
                },
                gamesWon: real.won,                 // classic + tournament only
                winRate: real.played ? Math.round((real.won / real.played) * 100) : 0,
                highestWin: real.best,              // never a practice score
                highestQuestion: real.furthest,     // never a practice run
                practiceBest: by.practice.furthest,
                currentStreak: u.current_streak ?? 0,
                longestStreak: u.longest_streak ?? 0,
                gamesRemaining: u.games_remaining ?? 0,
                rank,
                winnings: won
            }
        });
    } catch (error) {
        logger.error('Web stats error:', error);
        res.status(500).json({ success: false, error: 'Could not load your stats' });
    }
});

// The checkout recovery record is deliberately sticky so a lost event can be
// recovered. That also means an abandoned one traps the player on the payment
// screen, so they need a way out.
router.post('/checkout/dismiss', requireWebAuth, async (req, res) => {
    try {
        await redis.del(`pending_checkout:${req.webUser.id}`);
        res.json({ success: true });
    } catch (error) {
        logger.error(`Could not dismiss checkout: ${error && error.message}`);
        res.status(500).json({ success: false, error: 'Could not dismiss that' });
    }
});

module.exports = router;