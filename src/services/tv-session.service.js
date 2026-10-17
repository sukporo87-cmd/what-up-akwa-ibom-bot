// ============================================
// FILE: src/services/tv-session.service.js
// WUT TV, phase 4 — signing in on a TV, the 15-minute rule, guest points
// moving to an account, and the leaderboard.
//
// SIGNING IN IS A QR CODE. Nobody types on a remote. The TV asks for a
// pairing and shows a QR code; the phone opens it, the player (signed in to
// their existing web account on the phone) approves, and the TV is signed in.
// The TV is handed its session token when it asks for the pairing, but the
// token means nothing until the phone approves: only then is its hash written
// to tv_sessions. Nothing is ever stored in plain text, here or in Redis.
//
// WHAT A TV SIGN-IN CAN DO: credit Solo points to the account and show the
// account's username. Nothing else. It is not a web login and opens no money,
// profile or private data.
//
// IT ENDS WITH THE SESSION — a hard rule, not a setting:
//   * sign-out                 the TV says so
//   * 15 minutes idle          checked here on every use, from the database's
//                              own clock; the TV also signs out by itself
//   * the app closing          the TV app keeps the token in memory only, and
//                              says so on its way out; if that message is
//                              lost, the token died with the app anyway and
//                              the idle rule ends the row
//   * someone else signing in  one live session per TV, a unique index
//   (and a row whose app closed without a word is closed as idle by a light
//   sweep, so the records say what happened)
//   * the account suspended    ended on its next use
//
// GUEST POINTS MOVE ACROSS WITHIN 24 HOURS. A Solo guest's rounds are carried
// by the pairing itself (the TV lists the rounds it played as a guest since
// it was switched on; only rounds that TV played, still unclaimed and under
// 24 hours old, are moved). A Party guest keeps their points from their phone
// after the game, by signing in there. Rows are moved, never copied, and keep
// their guest_ref; claimed_at says when.
//
// THE LEADERBOARD IS A SUM OF THE LEDGER. All-time, and this week from Monday
// 00:00 Lagos time. Signed-in accounts only; suspended accounts are left off.
// ============================================

const crypto = require('crypto');
const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const tvAuth = require('./tv-auth.service');

// ---- the rules ----
const IDLE_MINUTES = 15;
const TOUCH_SECONDS = 30;
const CARRY_HOURS = 24;
const KEEP_HOURS = 24;

// ---- pairing ----
const PAIR_TTL_SECONDS = 5 * 60;
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_CODE_LENGTH = 8;
const PAIR_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const CARRY_MAX_ROUNDS = 20;

// ---- limits ----
const PAIRINGS_PER_DEVICE = 10;      // per 10 minutes
const PHONE_CALLS_PER_IP = 60;       // per 10 minutes: looks, approvals, denials
const LIMIT_WINDOW_SECONDS = 600;

// ---- leaderboard ----
const BOARD_DEFAULT = 20;
const BOARD_MAX = 50;
const BOARD_CACHE_SECONDS = 60;
const WEEK_START_SQL = `(date_trunc('week', NOW() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')`;

const END_REASONS_FROM_TV = ['signout', 'idle', 'app_closed'];

const pairKey = code => `tv_pair:${code}`;
const devicePairKey = id => `tv_pair_dev:${id}`;

function playBase() {
    return (process.env.WEB_PLAY_URL || 'https://play.whatsuptrivia.com.ng').replace(/\/+$/, '');
}

const SWEEP_EVERY_MS = 10 * 60 * 1000;

class TvSessionService {

    constructor() {
        this._lastSweep = 0;
    }

    /**
     * A session whose app closed without saying so (the sign-out message was
     * lost as the TV went to sleep) can no longer be used: its token died with
     * the app. Its row is closed here as idle, at most every ten minutes, when
     * anyone uses sign-in — so no timer or boot step is needed in server.js.
     */
    _maybeSweep() {
        if (Date.now() - this._lastSweep < SWEEP_EVERY_MS) return;
        this._lastSweep = Date.now();
        pool.query(
            `UPDATE tv_sessions SET ended_at = NOW(), end_reason = 'idle'
             WHERE ended_at IS NULL AND last_active_at < NOW() - INTERVAL '${IDLE_MINUTES} minutes'`
        ).catch(e => logger.error('TV session sweep failed:', e.message));
    }

    // ============================================
    // SMALL HELPERS
    // ============================================

    normaliseCode(code) {
        const c = String(code || '').trim().toUpperCase();
        return PAIR_CODE_RE.test(c) ? c : null;
    }

    _newCode() {
        let s = '';
        for (let i = 0; i < PAIR_CODE_LENGTH; i++) s += PAIR_ALPHABET[crypto.randomInt(0, PAIR_ALPHABET.length)];
        return s;
    }

    /** True while under the limit. Redis down: allowed. */
    async _allow(key, max) {
        try {
            const n = await redis.incr(key);
            if (n === 1) await redis.expire(key, LIMIT_WINDOW_SECONDS);
            return n <= max;
        } catch (e) { return true; }
    }

    async _loadPairing(code) {
        const raw = await redis.get(pairKey(code));
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    async _savePairing(code, rec) {
        await redis.set(pairKey(code), JSON.stringify(rec), 'EX', PAIR_TTL_SECONDS);
    }

    /** One change at a time to a pairing, across instances. */
    async _lock(key) {
        try { return (await redis.set(key, '1', 'EX', 10, 'NX')) === 'OK'; }
        catch (e) { return false; }
    }

    async _unlock(key) {
        try { await redis.del(key); } catch (e) { /* it expires */ }
    }

    // ============================================
    // PAIRING — the TV
    // ============================================

    /**
     * The TV asks to sign someone in. `carry` is the Solo rounds it played as
     * a guest since it was switched on; their points move to the account that
     * approves, if they qualify.
     */
    async startPairing(device, { carry } = {}) {
        await tvAuth.ensureSchema();
        this._maybeSweep();
        if (!(await this._allow(`tv_rate:pair:${device.id}`, PAIRINGS_PER_DEVICE))) {
            return { ok: false, reason: 'too_many_attempts' };
        }

        const asked = [...new Set((Array.isArray(carry) ? carry : [])
            .map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x > 0))].slice(0, CARRY_MAX_ROUNDS);
        let carryIds = [];
        let carryPoints = 0;
        if (asked.length) {
            const r = await pool.query(
                `SELECT r.id, COALESCE(SUM(p.points), 0)::int AS points
                 FROM tv_solo_rounds r
                 LEFT JOIN tv_points p ON p.tv_solo_round_id = r.id AND p.user_id IS NULL
                 WHERE r.id = ANY($1::int[]) AND r.tv_device_id = $2 AND r.user_id IS NULL
                   AND r.started_at > NOW() - INTERVAL '${CARRY_HOURS} hours'
                 GROUP BY r.id`,
                [asked, device.id]
            );
            for (const row of r.rows) {
                if (Number(row.points) > 0) { carryIds.push(Number(row.id)); carryPoints += Number(row.points); }
            }
        }

        // A TV has one pairing at a time: asking again retires the last code.
        try {
            const prev = await redis.get(devicePairKey(device.id));
            if (prev) await redis.del(pairKey(prev));
        } catch (e) { /* it expires */ }

        const { token, hash } = tvAuth.mintSessionToken();
        const expiresAt = Date.now() + PAIR_TTL_SECONDS * 1000;
        const rec = {
            deviceId: device.id, tokenHash: hash, label: device.label || null,
            carry: carryIds, carryPoints, status: 'pending', createdAt: Date.now(), expiresAt
        };
        let code = null;
        for (let i = 0; i < 5 && !code; i++) {
            const c = this._newCode();
            const set = await redis.set(pairKey(c), JSON.stringify(rec), 'EX', PAIR_TTL_SECONDS, 'NX');
            if (set === 'OK') code = c;
        }
        if (!code) return { ok: false, reason: 'try_again' };
        try { await redis.set(devicePairKey(device.id), code, 'EX', PAIR_TTL_SECONDS); } catch (e) { /* best effort */ }

        return {
            ok: true, code, url: `${playBase()}/t/${code}`, expiresAt, carryPoints,
            sessionToken: token, serverNow: Date.now()
        };
    }

    /** The TV polls this until the phone answers. */
    async pairingStatus(device, rawCode) {
        const code = this.normaliseCode(rawCode);
        if (!code) return { ok: false, reason: 'bad_code' };
        const rec = await this._loadPairing(code);
        // NB "state", not "status": reply() treats status as the HTTP code.
        if (!rec) return { ok: true, state: 'expired' };
        if (rec.deviceId !== device.id) return { ok: false, reason: 'not_your_pairing' };
        if (rec.status === 'approved') {
            return { ok: true, state: 'approved', user: { username: rec.username }, carried: rec.carried || 0 };
        }
        return { ok: true, state: rec.status, expiresAt: rec.expiresAt, serverNow: Date.now() };
    }

    // ============================================
    // PAIRING — the phone
    // ============================================

    /** What the phone shows before approving. Nothing about the person. */
    async pairingForPhone(rawCode, ip) {
        if (!(await this._allow(`tv_rate:pairphone:${ip || 'none'}`, PHONE_CALLS_PER_IP))) {
            return { ok: false, reason: 'too_many_attempts' };
        }
        const code = this.normaliseCode(rawCode);
        if (!code) return { ok: false, reason: 'pair_expired' };
        const rec = await this._loadPairing(code);
        if (!rec) return { ok: false, reason: 'pair_expired' };
        return {
            ok: true, state: rec.status, tvLabel: rec.label,
            carryPoints: rec.status === 'pending' ? rec.carryPoints : 0,
            expiresAt: rec.expiresAt, serverNow: Date.now()
        };
    }

    async approve(rawCode, user, ip) {
        if (!(await this._allow(`tv_rate:pairphone:${ip || 'none'}`, PHONE_CALLS_PER_IP))) {
            return { ok: false, reason: 'too_many_attempts' };
        }
        const code = this.normaliseCode(rawCode);
        if (!code) return { ok: false, reason: 'pair_expired' };
        await tvAuth.ensureSchema();

        const lock = `tv_pair_lock:${code}`;
        if (!(await this._lock(lock))) return { ok: false, reason: 'busy' };
        try {
            const rec = await this._loadPairing(code);
            if (!rec) return { ok: false, reason: 'pair_expired' };
            if (rec.status !== 'pending') return { ok: false, reason: 'pair_used' };

            const dev = await pool.query(`SELECT blocked FROM tv_devices WHERE id = $1`, [rec.deviceId]);
            if (!dev.rows[0] || dev.rows[0].blocked) return { ok: false, reason: 'device_blocked' };

            // One live session per TV: whoever was signed in is signed out.
            await pool.query(
                `UPDATE tv_sessions SET ended_at = NOW(), end_reason = 'replaced'
                 WHERE tv_device_id = $1 AND ended_at IS NULL`,
                [rec.deviceId]
            );
            await pool.query(
                `INSERT INTO tv_sessions (tv_device_id, user_id, token_hash) VALUES ($1, $2, $3)`,
                [rec.deviceId, user.id, rec.tokenHash]
            );

            let carried = 0;
            if (rec.carry && rec.carry.length) {
                try {
                    const moved = await pool.query(
                        `UPDATE tv_points p SET user_id = $1, claimed_at = NOW()
                         FROM tv_solo_rounds r
                         WHERE p.tv_solo_round_id = r.id AND r.id = ANY($2::int[]) AND r.tv_device_id = $3
                           AND r.user_id IS NULL AND p.user_id IS NULL
                           AND r.started_at > NOW() - INTERVAL '${CARRY_HOURS} hours'
                         RETURNING p.points`,
                        [user.id, rec.carry, rec.deviceId]
                    );
                    carried = moved.rows.reduce((a, x) => a + Number(x.points), 0);
                    await pool.query(
                        `UPDATE tv_solo_rounds SET user_id = $1
                         WHERE id = ANY($2::int[]) AND tv_device_id = $3 AND user_id IS NULL`,
                        [user.id, rec.carry, rec.deviceId]
                    );
                } catch (e) {
                    // The sign-in stands; the points stay with the guest rounds.
                    logger.error(`TV pairing ${code}: moving guest points failed: ${e.message}`);
                }
            }

            rec.status = 'approved';
            rec.userId = user.id;
            rec.username = user.username;
            rec.carried = carried;
            await this._savePairing(code, rec);
            logger.info(`📺 TV ${rec.deviceId} signed in as user ${user.id}${carried ? ` (+${carried} guest points)` : ''}`);
            return { ok: true, username: user.username, carried };
        } finally {
            await this._unlock(lock);
        }
    }

    /** "Not me" on the phone. The TV shows a fresh code. */
    async deny(rawCode, ip) {
        if (!(await this._allow(`tv_rate:pairphone:${ip || 'none'}`, PHONE_CALLS_PER_IP))) {
            return { ok: false, reason: 'too_many_attempts' };
        }
        const code = this.normaliseCode(rawCode);
        if (!code) return { ok: false, reason: 'pair_expired' };
        const lock = `tv_pair_lock:${code}`;
        if (!(await this._lock(lock))) return { ok: false, reason: 'busy' };
        try {
            const rec = await this._loadPairing(code);
            if (!rec) return { ok: false, reason: 'pair_expired' };
            if (rec.status !== 'pending') return { ok: false, reason: 'pair_used' };
            rec.status = 'denied';
            await this._savePairing(code, rec);
            return { ok: true };
        } finally {
            await this._unlock(lock);
        }
    }

    // ============================================
    // THE SESSION
    // ============================================

    /**
     * The person signed in on this TV, or why not. Every use counts as
     * activity; a session idle for 15 minutes by the database's clock is
     * ended here and refused.
     */
    async authenticate(device, token) {
        if (!token) return { ok: false, reason: 'no_session' };
        await tvAuth.ensureSchema();
        this._maybeSweep();
        const r = await pool.query(
            `SELECT s.id, s.user_id, s.tv_device_id, s.ended_at, s.end_reason,
                    (s.last_active_at < NOW() - INTERVAL '${IDLE_MINUTES} minutes') AS idle,
                    (s.last_active_at < NOW() - INTERVAL '${TOUCH_SECONDS} seconds') AS stale,
                    u.username, u.is_suspended
             FROM tv_sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = $1`,
            [tvAuth.hash(token)]
        );
        const s = r.rows[0];
        // A session token only works with the device token of its own TV.
        if (!s || s.tv_device_id !== device.id) return { ok: false, reason: 'session_unknown' };
        if (s.ended_at) return { ok: false, reason: 'session_ended', ended: s.end_reason };
        if (s.is_suspended === true) {
            await this._end(s.id, 'account');
            return { ok: false, reason: 'session_ended', ended: 'account' };
        }
        if (s.idle) {
            await this._end(s.id, 'idle');
            return { ok: false, reason: 'session_ended', ended: 'idle' };
        }
        if (s.stale) {
            await pool.query(`UPDATE tv_sessions SET last_active_at = NOW() WHERE id = $1 AND ended_at IS NULL`, [s.id]);
        }
        return { ok: true, session: { id: s.id, userId: s.user_id, username: s.username } };
    }

    async _end(id, reason) {
        await pool.query(
            `UPDATE tv_sessions SET ended_at = NOW(), end_reason = $2 WHERE id = $1 AND ended_at IS NULL`,
            [id, reason]
        );
    }

    /** Sign-out, the TV's own idle timer, or the app closing. Always succeeds. */
    async signOut(device, token, reason) {
        const why = END_REASONS_FROM_TV.includes(reason) ? reason : 'signout';
        if (!token) return { ok: true, ended: false };
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `UPDATE tv_sessions SET ended_at = NOW(), end_reason = $3
             WHERE token_hash = $1 AND tv_device_id = $2 AND ended_at IS NULL
             RETURNING id`,
            [tvAuth.hash(token), device.id, why]
        );
        if (r.rows[0]) logger.info(`📺 TV ${device.id} signed out (${why})`);
        return { ok: true, ended: !!r.rows[0] };
    }

    /** The signed-in person's points and places, for the TV. */
    async summary(session) {
        const week = await this._standing('week', session.userId);
        const all = await this._standing('all', session.userId);
        return {
            ok: true,
            user: { username: session.username },
            idleMinutes: IDLE_MINUTES,
            week, allTime: all
        };
    }

    // ============================================
    // PARTY GUESTS KEEP THEIR POINTS
    // ============================================

    /**
     * A guest, after a Party game, signs in on their phone and keeps what they
     * earned. Checked against the database, not the live room, so it still
     * works once the room has gone from Redis.
     */
    async keepPartyPoints(roomId, playerToken, user) {
        const parsed = tvAuth.parsePlayerToken(playerToken);
        if (!parsed || parsed.roomId !== roomId) return { ok: false, reason: 'bad_player_token' };
        await tvAuth.ensureSchema();

        const pr = await pool.query(
            `SELECT p.id, p.user_id, p.phone_token_hash, p.removed_at, r.status
             FROM tv_players p JOIN tv_rooms r ON r.id = p.tv_room_id
             WHERE p.id = $1 AND p.tv_room_id = $2`,
            [parsed.playerId, roomId]
        );
        const p = pr.rows[0];
        if (!p || !tvAuth.sameHash(p.phone_token_hash, tvAuth.hash(playerToken))) return { ok: false, reason: 'bad_player_token' };
        if (p.removed_at) return { ok: false, reason: 'removed' };
        if (p.user_id) return { ok: false, reason: 'already_signed_in' };
        if (p.status === 'lobby' || p.status === 'playing') return { ok: false, reason: 'not_finished' };

        const lock = `tv_keep_lock:${roomId}:${user.id}`;
        if (!(await this._lock(lock))) return { ok: false, reason: 'busy' };
        try {
            // One person, one share of a room: not on top of playing it as
            // their account, and not from two guest phones.
            const inRoom = await pool.query(
                `SELECT 1 FROM tv_players WHERE tv_room_id = $1 AND user_id = $2 LIMIT 1`,
                [roomId, user.id]
            );
            if (inRoom.rows[0]) return { ok: false, reason: 'account_in_room' };
            const other = await pool.query(
                `SELECT 1 FROM tv_points WHERE tv_room_id = $1 AND user_id = $2 AND tv_player_id <> $3 LIMIT 1`,
                [roomId, user.id, p.id]
            );
            if (other.rows[0]) return { ok: false, reason: 'already_kept' };

            const moved = await pool.query(
                `UPDATE tv_points SET user_id = $1, claimed_at = NOW()
                 WHERE tv_player_id = $2 AND user_id IS NULL
                   AND created_at > NOW() - INTERVAL '${KEEP_HOURS} hours'
                 RETURNING points`,
                [user.id, p.id]
            );
            const kept = moved.rows.reduce((a, x) => a + Number(x.points), 0);
            if (kept) logger.info(`📺 Party guest ${p.id} kept ${kept} points on user ${user.id}`);
            return { ok: true, kept, username: user.username };
        } finally {
            await this._unlock(lock);
        }
    }

    // ============================================
    // THE LEADERBOARD
    // ============================================

    _totalsSql(period) {
        return `SELECT user_id, SUM(points)::int AS points FROM tv_points
                WHERE user_id IS NOT NULL${period === 'week' ? ` AND created_at >= ${WEEK_START_SQL}` : ''}
                GROUP BY user_id`;
    }

    async leaderboard(rawPeriod, { limit, userId } = {}) {
        await tvAuth.ensureSchema();
        const period = rawPeriod === 'all' ? 'all' : 'week';
        const n = Math.min(BOARD_MAX, Math.max(1, parseInt(limit, 10) || BOARD_DEFAULT));

        const cacheKey = `tv_board:${period}:${n}`;
        let entries = null;
        try {
            const hit = await redis.get(cacheKey);
            if (hit) entries = JSON.parse(hit);
        } catch (e) { /* read it fresh */ }

        if (!entries) {
            const r = await pool.query(
                `SELECT u.username, t.points, RANK() OVER (ORDER BY t.points DESC)::int AS rank
                 FROM (${this._totalsSql(period)}) t
                 JOIN users u ON u.id = t.user_id
                 WHERE u.is_suspended IS NOT TRUE
                 ORDER BY t.points DESC, u.username ASC
                 LIMIT $1`,
                [n]
            );
            entries = r.rows.map(x => ({ rank: Number(x.rank), username: x.username, points: Number(x.points) }));
            try { await redis.set(cacheKey, JSON.stringify(entries), 'EX', BOARD_CACHE_SECONDS); } catch (e) { /* uncached */ }
        }

        const me = userId ? await this._standing(period, userId) : null;
        return { ok: true, period, entries, me };
    }

    /** One account's points and place for the period. */
    async _standing(period, userId) {
        const r = await pool.query(
            `SELECT points, rank FROM (
                 SELECT t.user_id, t.points, RANK() OVER (ORDER BY t.points DESC)::int AS rank
                 FROM (${this._totalsSql(period)}) t
                 JOIN users u ON u.id = t.user_id
                 WHERE u.is_suspended IS NOT TRUE
             ) ranked
             WHERE user_id = $1`,
            [userId]
        );
        const row = r.rows[0];
        return row ? { points: Number(row.points), rank: Number(row.rank) } : { points: 0, rank: null };
    }
}

module.exports = new TvSessionService();
module.exports.IDLE_MINUTES = IDLE_MINUTES;
module.exports.PAIR_TTL_SECONDS = PAIR_TTL_SECONDS;
module.exports.PAIR_ALPHABET = PAIR_ALPHABET;
module.exports.END_REASONS_FROM_TV = END_REASONS_FROM_TV;
