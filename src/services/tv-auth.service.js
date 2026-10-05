// ============================================
// FILE: src/services/tv-auth.service.js
// WUT TV — schema owner, TV identity and the tokens every TV caller carries.
//
// THREE KINDS OF CALLER, AND NOTHING ELSE:
//   * a TV           — device token   "tvd_…"  in Authorization: Bearer
//   * a phone player — player token   "tvp_…"  in Authorization: Bearer, or
//                      the httpOnly wut_tvp cookie (EventSource cannot set
//                      headers, and a token in the query string would be
//                      written into the access log by morgan)
//   * a signed-in web user — the existing wut_session, read through
//                      web-auth.service exactly as web play reads it
//
// TOKENS ARE STORED HASHED. Only SHA-256 of a token is ever written to the
// database or Redis, so a leaked dump cannot impersonate a TV or a phone. The
// tokens carry 256 bits of randomness, so a fast hash is the right one here;
// bcrypt is for low-entropy passwords.
//
// A PLAYER TOKEN NAMES ITS ROOM. "tvp_<roomId>.<playerId>.<secret>" — so a
// token presented to another room is refused before any lookup, and a token
// can only ever resolve to the one player it was issued to.
//
// The ensureSchema() statements are GENERATED from migrations/018-tv.sql and
// are byte-identical to it; a test checks they have not drifted.
// ============================================

const crypto = require('crypto');
const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

const DEVICE_PREFIX = 'tvd_';
const PLAYER_PREFIX = 'tvp_';
const PLAYER_COOKIE = 'wut_tvp';
const PHONE_COOKIE = 'wut_tvph';
const COOKIE_PATH = '/tv';
const PLAYER_COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const PHONE_COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const IS_PROD = process.env.NODE_ENV === 'production';

const PLATFORMS = ['android_tv', 'webos'];

// last_seen is touched at most once per window per TV, so a TV that polls or
// reconnects is not a database write per request.
const LAST_SEEN_WINDOW_SECONDS = 300;

class TvAuthService {

    constructor() {
        this._schemaReady = false;
    }

    // ============================================
    // ENSURE SCHEMA
    // ============================================
    async ensureSchema() {
        if (this._schemaReady) return;
        for (const sql of TvAuthService.SCHEMA_STATEMENTS) {
            await pool.query(sql);
        }
        this._schemaReady = true;
        logger.info('🗄️  WUT TV schema verified');
    }

    // ============================================
    // HASHING AND TOKENS
    // ============================================
    hash(token) {
        return crypto.createHash('sha256').update(String(token)).digest('hex');
    }

    sameHash(a, b) {
        if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    }

    _secret() {
        return crypto.randomBytes(32).toString('base64url');
    }

    mintDeviceToken() {
        const token = DEVICE_PREFIX + this._secret();
        return { token, hash: this.hash(token) };
    }

    mintPlayerToken(roomId, playerId) {
        const token = `${PLAYER_PREFIX}${roomId}.${playerId}.${this._secret()}`;
        return { token, hash: this.hash(token) };
    }

    mintPhoneRef() {
        const ref = this._secret();
        return { ref, hash: this.hash(ref) };
    }

    /** { roomId, playerId } from a well-formed player token, else null. */
    parsePlayerToken(token) {
        const m = /^tvp_(\d{1,10})\.(\d{1,10})\.[A-Za-z0-9_-]{40,60}$/.exec(String(token || ''));
        if (!m) return null;
        return { roomId: parseInt(m[1], 10), playerId: parseInt(m[2], 10) };
    }

    // ============================================
    // READING CREDENTIALS OFF A REQUEST
    // ============================================
    // Never from the query string: morgan('combined') logs every URL.

    _bearer(req) {
        const header = req.headers && req.headers.authorization;
        if (header && header.startsWith('Bearer ')) return header.substring(7).trim();
        return null;
    }

    _cookie(req, name) {
        const raw = req.headers && req.headers.cookie;
        if (!raw) return null;
        for (const part of raw.split(';')) {
            const [k, ...v] = part.trim().split('=');
            if (k === name) {
                try { return decodeURIComponent(v.join('=')); } catch (e) { return null; }
            }
        }
        return null;
    }

    deviceTokenFrom(req) {
        const t = this._bearer(req);
        return t && t.startsWith(DEVICE_PREFIX) ? t : null;
    }

    playerTokenFrom(req) {
        const t = this._bearer(req);
        if (t && t.startsWith(PLAYER_PREFIX)) return t;
        const c = this._cookie(req, PLAYER_COOKIE);
        return c && c.startsWith(PLAYER_PREFIX) ? c : null;
    }

    phoneRefFrom(req) {
        const c = this._cookie(req, PHONE_COOKIE);
        return c && /^[A-Za-z0-9_-]{40,60}$/.test(c) ? c : null;
    }

    setPlayerCookie(res, token) {
        res.cookie(PLAYER_COOKIE, token, {
            httpOnly: true, secure: IS_PROD, sameSite: 'lax',
            maxAge: PLAYER_COOKIE_MAX_AGE_MS, path: COOKIE_PATH
        });
    }

    setPhoneCookie(res, ref) {
        res.cookie(PHONE_COOKIE, ref, {
            httpOnly: true, secure: IS_PROD, sameSite: 'lax',
            maxAge: PHONE_COOKIE_MAX_AGE_MS, path: COOKIE_PATH
        });
    }

    clearPlayerCookie(res) {
        res.clearCookie(PLAYER_COOKIE, { path: COOKIE_PATH });
    }

    // ============================================
    // TV DEVICES
    // ============================================

    async registerDevice({ platform, label, appVersion, ip } = {}) {
        await this.ensureSchema();
        const p = String(platform || '').toLowerCase();
        if (!PLATFORMS.includes(p)) return { ok: false, reason: 'bad_platform' };

        const cleanLabel = label == null ? null : String(label).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || null;
        const cleanVersion = appVersion == null ? null : String(appVersion).trim().slice(0, 30) || null;

        const { token, hash } = this.mintDeviceToken();
        const result = await pool.query(
            `INSERT INTO tv_devices (device_token_hash, platform, label, app_version, register_ip)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [hash, p, cleanLabel, cleanVersion, this._inet(ip)]
        );
        const deviceId = result.rows[0].id;
        logger.info(`📺 TV registered: device ${deviceId} (${p})`);
        return { ok: true, deviceId, deviceToken: token };
    }

    /** The device row for a token, or { ok: false, reason }. */
    async authenticateDevice(token) {
        if (!token || !token.startsWith(DEVICE_PREFIX)) return { ok: false, reason: 'no_device_token' };
        await this.ensureSchema();
        const result = await pool.query(
            `SELECT id, platform, label, blocked FROM tv_devices WHERE device_token_hash = $1`,
            [this.hash(token)]
        );
        const device = result.rows[0];
        if (!device) return { ok: false, reason: 'unknown_device' };
        if (device.blocked) return { ok: false, reason: 'device_blocked' };

        try {
            const fresh = await redis.set(`tv_seen:${device.id}`, '1', 'EX', LAST_SEEN_WINDOW_SECONDS, 'NX');
            if (fresh === 'OK') {
                await pool.query(`UPDATE tv_devices SET last_seen = NOW() WHERE id = $1`, [device.id]);
            }
        } catch (e) { /* last_seen is housekeeping; never fail a request over it */ }

        return { ok: true, device };
    }

    _inet(ip) {
        const s = String(ip || '').trim();
        if (!s) return null;
        const v4 = s.replace(/^::ffff:/, '');
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4;
        if (/^[0-9a-f:]+$/i.test(s) && s.includes(':')) return s;
        return null;
    }
}

TvAuthService.SCHEMA_STATEMENTS = Object.freeze([
    `CREATE TABLE IF NOT EXISTS tv_devices (
    id                  SERIAL PRIMARY KEY,
    device_token_hash   TEXT NOT NULL UNIQUE,
    platform            TEXT NOT NULL CHECK (platform IN ('android_tv','webos')),
    label               TEXT CHECK (label IS NULL OR char_length(label) <= 60),
    app_version         TEXT CHECK (app_version IS NULL OR char_length(app_version) <= 30),
    register_ip         INET,
    first_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    blocked             BOOLEAN NOT NULL DEFAULT false,
    blocked_reason      TEXT
)`,
    `CREATE TABLE IF NOT EXISTS tv_rooms (
    id                  SERIAL PRIMARY KEY,
    tv_device_id        INTEGER NOT NULL REFERENCES tv_devices(id),
    challenge_id        INTEGER,
    join_code           TEXT NOT NULL CHECK (join_code ~ '^[0-9]{6}$'),
    host_player_id      INTEGER,
    status              TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN (
                            'lobby','playing','finished','closed'
                        )),
    close_reason        TEXT CHECK (close_reason IS NULL OR close_reason IN (
                            'tv','host','expired','replaced','state_lost','no_questions','empty','admin'
                        )),
    categories          TEXT[] CHECK (
                            categories IS NULL OR array_length(categories, 1) BETWEEN 1 AND 3
                        ),
    max_players         SMALLINT NOT NULL DEFAULT 20 CHECK (max_players BETWEEN 2 AND 20),
    result_counted      BOOLEAN,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at          TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ NOT NULL
)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tv_rooms_live_code
    ON tv_rooms (join_code)
    WHERE status IN ('lobby','playing')`,
    `CREATE INDEX IF NOT EXISTS idx_tv_rooms_device
    ON tv_rooms (tv_device_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tv_rooms_live
    ON tv_rooms (status, expires_at)
    WHERE status IN ('lobby','playing')`,
    `CREATE TABLE IF NOT EXISTS tv_players (
    id                  SERIAL PRIMARY KEY,
    tv_room_id          INTEGER NOT NULL REFERENCES tv_rooms(id) ON DELETE CASCADE,
    user_id             INTEGER REFERENCES users(id),
    display_name        TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 24),
    name_key            TEXT NOT NULL,
    avatar              TEXT NOT NULL,
    colour              TEXT NOT NULL CHECK (colour ~ '^#[0-9A-F]{6}$'),
    phone_token_hash    TEXT NOT NULL UNIQUE,
    phone_ref_hash      TEXT,
    join_ip             INET,
    joined_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at             TIMESTAMPTZ,
    removed_at          TIMESTAMPTZ,
    final_correct       SMALLINT CHECK (final_correct IS NULL OR final_correct BETWEEN 0 AND 15),
    final_total_ms      INTEGER,
    final_rank          SMALLINT,
    CONSTRAINT tv_players_name_unique UNIQUE (tv_room_id, name_key)
)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tv_players_account_once
    ON tv_players (tv_room_id, user_id)
    WHERE user_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_tv_players_room
    ON tv_players (tv_room_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tv_players_phone
    ON tv_players (tv_room_id, phone_ref_hash)
    WHERE phone_ref_hash IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS tv_room_questions (
    id                  SERIAL PRIMARY KEY,
    tv_room_id          INTEGER NOT NULL REFERENCES tv_rooms(id) ON DELETE CASCADE,
    position            SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 15),
    question_id         INTEGER NOT NULL REFERENCES questions(id),
    CONSTRAINT tv_room_questions_slot UNIQUE (tv_room_id, position),
    CONSTRAINT tv_room_questions_no_repeat UNIQUE (tv_room_id, question_id)
)`,
    `CREATE TABLE IF NOT EXISTS tv_answers (
    id                  SERIAL PRIMARY KEY,
    tv_room_id          INTEGER NOT NULL REFERENCES tv_rooms(id) ON DELETE CASCADE,
    tv_player_id        INTEGER NOT NULL REFERENCES tv_players(id) ON DELETE CASCADE,
    position            SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 15),
    question_id         INTEGER NOT NULL,
    chosen              TEXT CHECK (chosen IS NULL OR chosen IN ('A','B','C','D')),
    is_correct          BOOLEAN,
    answer_ms           INTEGER NOT NULL CHECK (answer_ms >= 0),
    answered_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT tv_answers_once UNIQUE (tv_player_id, position)
)`,
    `CREATE INDEX IF NOT EXISTS idx_tv_answers_room
    ON tv_answers (tv_room_id, position)`,
    `CREATE TABLE IF NOT EXISTS tv_points (
    id                  SERIAL PRIMARY KEY,
    user_id             INTEGER REFERENCES users(id),
    guest_ref           TEXT,
    mode                TEXT NOT NULL CHECK (mode IN ('solo','party')),
    question_number     SMALLINT NOT NULL CHECK (question_number BETWEEN 1 AND 15),
    points              SMALLINT NOT NULL,
    tv_room_id          INTEGER REFERENCES tv_rooms(id),
    tv_player_id        INTEGER REFERENCES tv_players(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT tv_points_owner CHECK (user_id IS NOT NULL OR guest_ref IS NOT NULL),
    CONSTRAINT tv_points_ladder CHECK (
        points = CASE WHEN question_number <= 5 THEN 10
                      WHEN question_number <= 10 THEN 20
                      ELSE 30 END
    )
)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tv_points_party_once
    ON tv_points (tv_player_id, question_number)
    WHERE tv_player_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_tv_points_user
    ON tv_points (user_id, created_at DESC)
    WHERE user_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_tv_points_week
    ON tv_points (created_at)`
]);

module.exports = new TvAuthService();
module.exports.PLATFORMS = PLATFORMS;
module.exports.PLAYER_COOKIE = PLAYER_COOKIE;
module.exports.PHONE_COOKIE = PHONE_COOKIE;
module.exports.COOKIE_PATH = COOKIE_PATH;
