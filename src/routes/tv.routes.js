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
// PHASE 1 HAS NO MONEY IN IT. The sponsor and claim routes arrive in phase 5;
// QR sign-in on the TV and the leaderboard in phase 4; Solo in phase 3; the
// /p/:code controller page in phase 2.
//
// ROUTE ORDER: every path below is either fully literal or ends in a literal
// action, and room ids and join codes are constrained by pattern, so no
// parameter route can shadow a literal one.
// ============================================

const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const tvAuth = require('../services/tv-auth.service');
const store = require('../services/tv-room-store.service');
const party = require('../services/tv-party.service');
const webAuthService = require('../services/web-auth.service');

const STATUS = {
    no_device_token: 401, unknown_device: 401, no_player_token: 401, bad_player_token: 401,
    not_signed_in: 401,
    device_blocked: 403, removed: 403, not_host: 403, not_your_room: 403, wrong_room: 403,
    account_unavailable: 403, profile_incomplete: 403, scoped_session: 403,
    no_room: 404, no_such_player: 404, not_in_room: 404,
    room_closed: 410,
    too_many_attempts: 429, too_many_rooms: 429, too_many_registrations: 429
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

module.exports = router;
