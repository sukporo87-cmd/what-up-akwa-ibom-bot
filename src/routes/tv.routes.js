// ============================================
// FILE: src/routes/tv.routes.js
// WUT TV — every TV and Party route. Mounted at /tv.
//
// Each caller is exactly one of:
//   * a TV           (device token, Authorization: Bearer tvd_…)
//   * a phone player (player token, Authorization: Bearer tvp_… or the
//                     wut_tvp cookie, which is what EventSource sends)
//   * a signed-in web user, only when joining a room "as my account" — read
//     from the existing wut_session, so a player who already has a web account
//     uses it here with nothing new to sign up for
//
// Tokens are never read from the query string: morgan logs every URL.
//
// AND, ON TOP OF A TV'S DEVICE TOKEN, a TV sign-in (phase 4): the session
// token in the X-TV-Session header, honoured only with its own TV's device
// token. It credits Solo points to the account and shows its name; nothing
// else.
//
// NO MONEY IN HERE YET. The sponsor and claim routes arrive in phase 5.
// Solo is phase 3; QR sign-in on the TV and the leaderboard are phase 4.
//
// ROUTE ORDER: every path below is either fully literal or ends in a literal
// action, and room ids, join codes and pairing codes are constrained by
// pattern, so no parameter route can shadow a literal one.
// ============================================

const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const tvAuth = require('../services/tv-auth.service');
const store = require('../services/tv-room-store.service');
const party = require('../services/tv-party.service');
const solo = require('../services/tv-solo.service');
const tvSession = require('../services/tv-session.service');
const webAuthService = require('../services/web-auth.service');

const STATUS = {
    no_device_token: 401, unknown_device: 401, no_player_token: 401, bad_player_token: 401,
    not_signed_in: 401, no_session: 401, session_unknown: 401, session_ended: 401,
    device_blocked: 403, removed: 403, not_your_round: 403, not_host: 403, not_your_room: 403, wrong_room: 403,
    account_unavailable: 403, profile_incomplete: 403, scoped_session: 403, not_your_pairing: 403,
    no_room: 404, no_round: 404, no_such_player: 404, not_in_room: 404,
    room_closed: 410, pair_expired: 410,
    too_many_attempts: 429, too_many_rooms: 429, too_many_rounds: 429, too_many_registrations: 429,
    try_again: 503
};

function getIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress
        || null;
}

function reply(res, out, okExtra = {}) {
    if (out && out.ok) {
        const { ok, status, armAt, ...rest } = out;
        return res.json({ success: true, ...rest, ...okExtra });
    }
    const reason = (out && out.reason) || 'failed';
    const code = (out && out.status) || STATUS[reason] || (reason === 'bad_choice' || /^name_|^pick_|^bad_/.test(reason) ? 400 : 409);
    const { ok, status, ...rest } = out || {};
    return res.status(code).json({ success: false, ...rest, reason });
}

function fail(res, label, error) {
    logger.error(`TV route ${label} failed: ${error.message}`);
    return res.status(500).json({ success: false, reason: 'server_error' });
}

// ============================================
// AUTH
// ============================================

async function requireDevice(req, res, next) {
    try {
        const auth = await tvAuth.authenticateDevice(tvAuth.deviceTokenFrom(req));
        if (!auth.ok) return reply(res, auth);
        req.tvDevice = auth.device;
        next();
    } catch (error) { return fail(res, 'device auth', error); }
}

async function requirePlayer(req, res, next) {
    try {
        const auth = await party.authenticatePlayer(tvAuth.playerTokenFrom(req), req.params.id);
        if (!auth.ok) return reply(res, auth);
        req.tvPlayerId = auth.playerId;
        next();
    } catch (error) { return fail(res, 'player auth', error); }
}

/** A TV acting on a room must own it. */
async function deviceOwnsRoom(device, roomId) {
    const state = await store.load(roomId);
    return !!(state && state.deviceId === device.id);
}

/** For the two things either the TV or the host may do. */
async function requireDeviceOrPlayer(req, res, next) {
    if (tvAuth.deviceTokenFrom(req)) {
        return requireDevice(req, res, async () => {
            try {
                if (!(await deviceOwnsRoom(req.tvDevice, req.params.id))) {
                    return reply(res, { ok: false, reason: 'not_your_room' });
                }
                next();
            } catch (error) { return fail(res, 'room ownership', error); }
        });
    }
    return requirePlayer(req, res, next);
}

/** The signed-in web account on this phone, if the player chose to use it. */
async function webAccount(req) {
    let token = null;
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ') && !header.substring(7).startsWith('tv')) {
        token = header.substring(7).trim();
    }
    if (!token) token = tvAuth._cookie(req, 'wut_session');
    if (!token) return { ok: false, reason: 'not_signed_in' };

    const ctx = await webAuthService.getSessionContext(token);
    if (!ctx) return { ok: false, reason: 'not_signed_in' };
    // A challenge-scoped session is not a login (see requireWebAuth).
    if (ctx.scope) return { ok: false, reason: 'scoped_session' };
    if (ctx.user.is_suspended === true) return { ok: false, reason: 'account_unavailable' };
    if (ctx.user.profile_complete === false) return { ok: false, reason: 'profile_incomplete' };
    return { ok: true, user: ctx.user };
}

/**
 * The person signed in on this TV, if the TV says someone is. Runs after
 * requireDevice. Never refuses on its own: a route that needs the session
 * checks req.tvSession, and one that only counts activity ignores it. A
 * session that has ended is reported as req.tvSessionRefused, so a route can
 * tell the TV to forget it.
 */
async function readSession(req, res, next) {
    try {
        const token = tvAuth.sessionTokenFrom(req);
        if (token) {
            const out = await tvSession.authenticate(req.tvDevice, token);
            if (out.ok) req.tvSession = out.session;
            else req.tvSessionRefused = out;
        }
        next();
    } catch (error) {
        // A sign-in that cannot be read is treated as absent: a Solo answer
        // must never fail because the session check did.
        logger.error(`TV session check failed: ${error.message}`);
        next();
    }
}

function requireSession(req, res, next) {
    if (req.tvSession) return next();
    return reply(res, req.tvSessionRefused || { ok: false, reason: 'no_session' });
}

/** A TV, if the caller is one. For the one route anybody may call. */
async function optionalDevice(req, res, next) {
    if (!tvAuth.deviceTokenFrom(req)) return next();
    try {
        const auth = await tvAuth.authenticateDevice(tvAuth.deviceTokenFrom(req));
        if (auth.ok) req.tvDevice = auth.device;
        next();
    } catch (error) { return fail(res, 'device auth', error); }
}

// ============================================
// TV
// ============================================

router.post('/devices/register', async (req, res) => {
    try {
        const ip = getIp(req);
        if (!(await party.registrationAllowed(ip))) {
            return reply(res, { ok: false, reason: 'too_many_registrations' });
        }
        const body = req.body || {};
        const out = await tvAuth.registerDevice({
            platform: body.platform, label: body.label, appVersion: body.appVersion, ip
        });
        return reply(res, out);
    } catch (error) { return fail(res, 'register', error); }
});

router.get('/categories', requireDevice, async (req, res) => {
    try {
        return res.json({ success: true, categories: await party.getCategories() });
    } catch (error) { return fail(res, 'categories', error); }
});

router.post('/rooms', requireDevice, async (req, res) => {
    try {
        const out = await party.openRoom(req.tvDevice, { fresh: !!(req.body && req.body.fresh) });
        return reply(res, out);
    } catch (error) { return fail(res, 'open room', error); }
});

/** Server-sent events for the room, to the TV that owns it. */
router.get('/rooms/:id(\\d+)/stream', requireDevice, async (req, res) => {
    try {
        const roomId = Number(req.params.id);
        const since = req.headers['last-event-id'] ?? req.query.since;
        const outcome = await store.withRoom(roomId, async (state, tx) => {
            if (!state) return 'no_room';
            if (state.deviceId !== req.tvDevice.id) return 'not_your_room';
            const missed = since != null ? await store.eventsSince(state, 'tv', since) : null;
            tx.attach = async () => {
                store.openStream(res);
                if (missed) {
                    for (const e of missed) store.writeEvent(res, roomId, { type: e.type, rev: e.rev, data: e.data });
                } else {
                    store.writeEvent(res, roomId, { type: 'room.snapshot', rev: state.rev, data: party.tvSnapshot(state) });
                }
                // A closed room has nothing more to say; the snapshot tells
                // the TV why, and the stream ends rather than idling forever.
                if (state.status === 'closed') { res.end(); return; }
                store.addTv(roomId, res);
            };
            return 'ok';
        });
        if (outcome !== 'ok') return reply(res, { ok: false, reason: outcome });
        req.on('close', () => {
            store.removeTv(roomId, res);
            try { res.end(); } catch (e) { /* already closed */ }
        });
    } catch (error) {
        if (!res.headersSent) return fail(res, 'tv stream', error);
        logger.error(`TV stream failed after open: ${error.message}`);
    }
});

/** Categories are picked on the TV — by the remote, or by the host. */
router.post('/rooms/:id(\\d+)/categories', requireDeviceOrPlayer, async (req, res) => {
    try {
        const actor = req.tvPlayerId ? { playerId: req.tvPlayerId } : { deviceId: req.tvDevice.id };
        const out = await party.setCategories(Number(req.params.id), actor, (req.body || {}).categories);
        return reply(res, out);
    } catch (error) { return fail(res, 'categories', error); }
});

/** Standard or Race. Chosen in the lobby, on the TV (or by the host), like the categories. */
router.post('/rooms/:id(\\d+)/style', requireDeviceOrPlayer, async (req, res) => {
    try {
        const actor = req.tvPlayerId ? { playerId: req.tvPlayerId } : { deviceId: req.tvDevice.id };
        return reply(res, await party.setStyle(Number(req.params.id), actor, (req.body || {}).style));
    } catch (error) { return fail(res, 'style', error); }
});

router.post('/rooms/:id(\\d+)/close', requireDeviceOrPlayer, async (req, res) => {
    try {
        const roomId = Number(req.params.id);
        if (req.tvPlayerId) {
            const state = await store.load(roomId);
            if (!state || state.hostPlayerId !== req.tvPlayerId) return reply(res, { ok: false, reason: 'not_host' });
        }
        const out = await party.closeRoom(roomId, req.tvPlayerId ? 'host' : 'tv');
        return reply(res, out);
    } catch (error) { return fail(res, 'close', error); }
});

// ============================================
// SOLO (phase 3) — the TV and its remote, nobody else
// ============================================
// Every Solo route is the TV's own: the device token decides, and a round
// another TV started is refused.

// Signed in (phase 4): the round is the account's. A sign-in that has ended
// is refused here, so the TV says so rather than quietly playing as a guest.
router.post('/solo', requireDevice, readSession, async (req, res) => {
    try {
        if (req.tvSessionRefused) return reply(res, req.tvSessionRefused);
        return reply(res, await solo.start(req.tvDevice, {
            category: (req.body || {}).category,
            userId: req.tvSession ? req.tvSession.userId : null
        }));
    }
    catch (error) { return fail(res, 'solo start', error); }
});

router.get('/solo/:id(\\d+)', requireDevice, readSession, async (req, res) => {
    try { return reply(res, await solo.get(req.tvDevice, Number(req.params.id))); }
    catch (error) { return fail(res, 'solo get', error); }
});

router.post('/solo/:id(\\d+)/answer', requireDevice, readSession, async (req, res) => {
    try {
        const body = req.body || {};
        return reply(res, await solo.answer(req.tvDevice, Number(req.params.id),
                                            parseInt(body.position, 10), body.choice == null ? null : body.choice));
    } catch (error) { return fail(res, 'solo answer', error); }
});

router.post('/solo/:id(\\d+)/next', requireDevice, readSession, async (req, res) => {
    try { return reply(res, await solo.next(req.tvDevice, Number(req.params.id))); }
    catch (error) { return fail(res, 'solo next', error); }
});

router.post('/solo/:id(\\d+)/fifty', requireDevice, readSession, async (req, res) => {
    try { return reply(res, await solo.fiftyFifty(req.tvDevice, Number(req.params.id), parseInt((req.body || {}).position, 10))); }
    catch (error) { return fail(res, 'solo fifty', error); }
});

router.post('/solo/:id(\\d+)/skip', requireDevice, readSession, async (req, res) => {
    try { return reply(res, await solo.skip(req.tvDevice, Number(req.params.id), parseInt((req.body || {}).position, 10))); }
    catch (error) { return fail(res, 'solo skip', error); }
});

router.post('/solo/:id(\\d+)/quit', requireDevice, readSession, async (req, res) => {
    try { return reply(res, await solo.quit(req.tvDevice, Number(req.params.id))); }
    catch (error) { return fail(res, 'solo quit', error); }
});

// ============================================
// SIGNING IN ON THE TV, AND THE LEADERBOARD (phase 4)
// ============================================
// The TV shows a QR code; a phone signed in to its web account approves;
// the TV is signed in until sign-out, 15 minutes idle, or the app closing.

const PAIR = ':code([A-Za-z0-9]{8})';

router.post('/pair', requireDevice, async (req, res) => {
    try { return reply(res, await tvSession.startPairing(req.tvDevice, { carry: (req.body || {}).carry })); }
    catch (error) { return fail(res, 'pair start', error); }
});

router.get(`/pair/${PAIR}/status`, requireDevice, async (req, res) => {
    try { return reply(res, await tvSession.pairingStatus(req.tvDevice, req.params.code)); }
    catch (error) { return fail(res, 'pair status', error); }
});

/** What the phone shows before approving: the TV's name and any guest points. */
router.get(`/pair/${PAIR}`, async (req, res) => {
    try { return reply(res, await tvSession.pairingForPhone(req.params.code, getIp(req))); }
    catch (error) { return fail(res, 'pair look', error); }
});

router.post(`/pair/${PAIR}/approve`, async (req, res) => {
    try {
        const acct = await webAccount(req);
        if (!acct.ok) return reply(res, acct);
        return reply(res, await tvSession.approve(req.params.code, acct.user, getIp(req)));
    } catch (error) { return fail(res, 'pair approve', error); }
});

router.post(`/pair/${PAIR}/deny`, async (req, res) => {
    try { return reply(res, await tvSession.deny(req.params.code, getIp(req))); }
    catch (error) { return fail(res, 'pair deny', error); }
});

router.get('/session', requireDevice, readSession, requireSession, async (req, res) => {
    try { return reply(res, await tvSession.summary(req.tvSession)); }
    catch (error) { return fail(res, 'session', error); }
});

/** The remote is being used. Keeps the session from going idle. */
router.post('/session/touch', requireDevice, readSession, requireSession, (req, res) =>
    reply(res, { ok: true }));

router.post('/session/signout', requireDevice, async (req, res) => {
    try {
        return reply(res, await tvSession.signOut(req.tvDevice, tvAuth.sessionTokenFrom(req), (req.body || {}).reason));
    } catch (error) { return fail(res, 'sign out', error); }
});

/** Anyone may look. A signed-in TV also gets its own place. */
router.get('/leaderboard', optionalDevice, async (req, res, next) => {
    if (req.tvDevice) return readSession(req, res, next);
    next();
}, async (req, res) => {
    try {
        return reply(res, await tvSession.leaderboard(req.query.period, {
            limit: req.query.limit,
            userId: req.tvSession ? req.tvSession.userId : null
        }));
    } catch (error) { return fail(res, 'leaderboard', error); }
});

// ============================================
// PHONE
// ============================================

router.post('/rooms/:code(\\d{6})/join', async (req, res) => {
    try {
        const body = req.body || {};
        let account = null;
        if (body.asAccount === true) {
            const acct = await webAccount(req);
            if (!acct.ok) return reply(res, acct);
            account = acct.user;
        }

        let phoneRef = tvAuth.phoneRefFrom(req);
        let newPhoneRef = null;
        if (!phoneRef) {
            newPhoneRef = tvAuth.mintPhoneRef().ref;
            phoneRef = newPhoneRef;
        }

        const out = await party.join(req.params.code, {
            name: body.name, allowNumber: body.allowNumber === true
        }, {
            ip: getIp(req),
            playerToken: tvAuth.playerTokenFrom(req),
            phoneRef,
            account
        });

        if (newPhoneRef) tvAuth.setPhoneCookie(res, newPhoneRef);
        if (out && out.ok) tvAuth.setPlayerCookie(res, out.token);
        return reply(res, out);
    } catch (error) { return fail(res, 'join', error); }
});

/** One player's own events. The token decides whose; there is no player id to ask for. */
router.get('/rooms/:id(\\d+)/player-stream', requirePlayer, async (req, res) => {
    try {
        const roomId = Number(req.params.id);
        const pid = req.tvPlayerId;
        const since = req.headers['last-event-id'] ?? req.query.since;
        const outcome = await store.withRoom(roomId, async (state, tx) => {
            if (!state) return 'no_room';
            const missed = since != null ? await store.eventsSince(state, 'player', since, pid) : null;
            tx.attach = async () => {
                store.openStream(res);
                if (missed) {
                    for (const e of missed) store.writeEvent(res, roomId, { type: e.type, rev: e.rev, data: e.data });
                } else {
                    store.writeEvent(res, roomId, { type: 'player.snapshot', rev: state.rev, data: party.playerSnapshot(state, pid) });
                }
                store.addPlayer(roomId, pid, res);
            };
            return 'ok';
        });
        if (outcome !== 'ok') return reply(res, { ok: false, reason: outcome });
        req.on('close', () => {
            store.removePlayer(roomId, pid, res);
            try { res.end(); } catch (e) { /* already closed */ }
        });
    } catch (error) {
        if (!res.headersSent) return fail(res, 'player stream', error);
        logger.error(`Player stream failed after open: ${error.message}`);
    }
});

router.post('/rooms/:id(\\d+)/host', requirePlayer, async (req, res) => {
    try { return reply(res, await party.takeHost(Number(req.params.id), req.tvPlayerId)); }
    catch (error) { return fail(res, 'host', error); }
});

router.post('/rooms/:id(\\d+)/avatar', requirePlayer, async (req, res) => {
    try { return reply(res, await party.setAvatar(Number(req.params.id), req.tvPlayerId, (req.body || {}).avatar)); }
    catch (error) { return fail(res, 'avatar', error); }
});

router.post('/rooms/:id(\\d+)/start', requirePlayer, async (req, res) => {
    try { return reply(res, await party.start(Number(req.params.id), req.tvPlayerId)); }
    catch (error) { return fail(res, 'start', error); }
});

router.post('/rooms/:id(\\d+)/answer', requirePlayer, async (req, res) => {
    try {
        const body = req.body || {};
        return reply(res, await party.answer(Number(req.params.id), req.tvPlayerId,
                                             parseInt(body.position, 10), body.choice));
    } catch (error) { return fail(res, 'answer', error); }
});

/** Race: the phone says a question has just arrived, so its delay can be measured. */
router.post('/rooms/:id(\\d+)/seen', requirePlayer, async (req, res) => {
    try { return reply(res, await party.seen(Number(req.params.id), req.tvPlayerId, parseInt((req.body || {}).position, 10))); }
    catch (error) { return fail(res, 'seen', error); }
});

router.post('/rooms/:id(\\d+)/fifty', requirePlayer, async (req, res) => {
    try {
        return reply(res, await party.fiftyFifty(Number(req.params.id), req.tvPlayerId,
                                                 parseInt((req.body || {}).position, 10)));
    } catch (error) { return fail(res, 'fifty', error); }
});

router.post('/rooms/:id(\\d+)/leave', requirePlayer, async (req, res) => {
    try {
        const out = await party.leave(Number(req.params.id), req.tvPlayerId);
        if (out && out.ok) tvAuth.clearPlayerCookie(res);
        return reply(res, out);
    } catch (error) { return fail(res, 'leave', error); }
});

router.post('/rooms/:id(\\d+)/players/:playerId(\\d+)/remove', requirePlayer, async (req, res) => {
    try {
        return reply(res, await party.removePlayer(Number(req.params.id), req.tvPlayerId,
                                                   Number(req.params.playerId)));
    } catch (error) { return fail(res, 'remove', error); }
});

/**
 * A guest keeps their points after the game by signing in on this phone.
 * The player token proves which player; the web session, whose account.
 */
router.post('/rooms/:id(\\d+)/keep-points', async (req, res) => {
    try {
        const token = tvAuth.playerTokenFrom(req);
        if (!token) return reply(res, { ok: false, reason: 'no_player_token' });
        const acct = await webAccount(req);
        if (!acct.ok) return reply(res, acct);
        return reply(res, await tvSession.keepPartyPoints(Number(req.params.id), token, acct.user));
    } catch (error) { return fail(res, 'keep points', error); }
});

module.exports = router;
