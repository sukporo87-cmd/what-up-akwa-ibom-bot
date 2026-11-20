// ============================================================
// FILE: src/services/web-notice.service.js
// Web-play, Nov 20, 2026: what the lobby may put in front of a player.
//
// MESSAGES. An admin message to a web player (direct or broadcast) goes out
// by email, as before, and a copy is kept here. The lobby shows a short
// notice of new ones (subject and first lines); "Read" opens the whole
// message full screen. Each is offered once, for 14 days.
//
// REVIEWS. After 3 finished games in any mode (Classic, Practice,
// Tournament, Challenge), the lobby asks for a review, in a form inside
// web-play. "Not now" waits 5 more games. 3 asks at most; never again once
// the player has reviewed.
//
// Neither is ever offered while a game is in progress: the route checks.
// Tables: migrations/033-web-messages-review-asks.sql, mirrored below.
// Every public method swallows its own errors: a notice must never break
// the lobby.
// ============================================================
'use strict';

const pool = require('../config/database');
const { logger } = require('../utils/logger');

const MESSAGE_DAYS = 14;
const PREVIEW_CHARS = 160;
const FIRST_ASK_AT = 3;    // finished games
const ASK_AGAIN_AFTER = 5; // more finished games
const MAX_ASKS = 3;

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS web_messages (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject     TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
        body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
        source      TEXT NOT NULL DEFAULT 'direct' CHECK (source IN ('direct', 'broadcast')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        seen_at     TIMESTAMPTZ,
        read_at     TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_web_messages_user ON web_messages (user_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS web_review_asks (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        asks        SMALLINT NOT NULL DEFAULT 0 CHECK (asks BETWEEN 0 AND 10),
        last_games  INTEGER NOT NULL DEFAULT 0,
        last_at     TIMESTAMPTZ
    )`
];

let ready = null;
function ensureSchema() {
    if (!ready) {
        ready = (async () => {
            for (const sql of SCHEMA_STATEMENTS) await pool.query(sql);
        })().catch(err => { ready = null; throw err; });
    }
    return ready;
}

/** Plain text, without the chat bold markers, cut to a length. */
function clean(text, max) {
    return String(text || '').replace(/\*([^*\n]+)\*/g, '$1').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function preview(body) {
    const flat = body.replace(/\s+/g, ' ').trim();
    if (flat.length <= PREVIEW_CHARS) return flat;
    const cut = flat.slice(0, PREVIEW_CHARS);
    const space = cut.lastIndexOf(' ');
    return (space > PREVIEW_CHARS * 0.6 ? cut.slice(0, space) : cut) + '…';
}

class WebNoticeService {
    // ---------------------------------------------------------- messages

    /** Keep a copy of a message sent to a web player. Never throws. */
    async record(userId, { subject, text, source = 'direct' }) {
        try {
            const body = clean(text, 20000);
            if (!userId || !body) return false;
            await ensureSchema();
            await pool.query(
                `INSERT INTO web_messages (user_id, subject, body, source) VALUES ($1, $2, $3, $4)`,
                [userId, clean(subject, 200) || "A message from What's Up Trivia", body,
                 source === 'broadcast' ? 'broadcast' : 'direct']
            );
            return true;
        } catch (e) {
            logger.warn(`Web message copy not kept for user ${userId}: ${e.message}`);
            return false;
        }
    }

    /** New messages the lobby has not shown yet, newest first (at most 5). */
    async unseen(userId) {
        try {
            await ensureSchema();
            const r = await pool.query(
                `SELECT id, subject, body, created_at FROM web_messages
                 WHERE user_id = $1 AND seen_at IS NULL
                   AND created_at > NOW() - ($2::int * INTERVAL '1 day')
                 ORDER BY created_at DESC LIMIT 5`,
                [userId, MESSAGE_DAYS]
            );
            return r.rows.map(m => ({ id: Number(m.id), subject: m.subject, preview: preview(m.body), sentAt: m.created_at }));
        } catch (e) {
            logger.warn(`Web messages not read for user ${userId}: ${e.message}`);
            return [];
        }
    }

    /** The lobby showed these. Only the player's own are touched. */
    async markSeen(userId, ids) {
        try {
            const list = (Array.isArray(ids) ? ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 20);
            if (!list.length) return 0;
            await ensureSchema();
            const r = await pool.query(
                `UPDATE web_messages SET seen_at = COALESCE(seen_at, NOW())
                 WHERE user_id = $1 AND id = ANY($2::bigint[])`,
                [userId, list]
            );
            return r.rowCount;
        } catch (e) {
            logger.warn(`Web messages not marked seen for user ${userId}: ${e.message}`);
            return 0;
        }
    }

    /** One whole message, the player's own only; marks it read. */
    async open(userId, id) {
        try {
            const n = Number(id);
            if (!Number.isInteger(n) || n <= 0) return null;
            await ensureSchema();
            const r = await pool.query(
                `UPDATE web_messages SET read_at = COALESCE(read_at, NOW()), seen_at = COALESCE(seen_at, NOW())
                 WHERE user_id = $1 AND id = $2
                 RETURNING id, subject, body, created_at`,
                [userId, n]
            );
            if (!r.rows.length) return null;
            const m = r.rows[0];
            return { id: Number(m.id), subject: m.subject, body: m.body, sentAt: m.created_at };
        } catch (e) {
            logger.warn(`Web message ${id} not opened for user ${userId}: ${e.message}`);
            return null;
        }
    }

    // ---------------------------------------------------------- reviews

    /** Finished games in every mode. Challenge tables are only read. */
    async gamesFinished(userId) {
        const r = await pool.query(
            `SELECT
               (SELECT COUNT(*) FROM game_sessions WHERE user_id = $1 AND status = 'completed')
             + (SELECT COUNT(*) FROM challenge_participants WHERE user_id = $1 AND status = 'finished') AS n`,
            [userId]
        );
        return parseInt(r.rows[0].n, 10) || 0;
    }

    /**
     * Whether to ask this player for a review now. When it says yes, the ask
     * is counted at once, so a second tab or a reload does not ask again.
     */
    async reviewAsk(userId, hasReviewed) {
        try {
            await ensureSchema();
            if (await hasReviewed(userId)) return false;
            const games = await this.gamesFinished(userId);
            if (games < FIRST_ASK_AT) return false;
            const row = (await pool.query(`SELECT asks, last_games FROM web_review_asks WHERE user_id = $1`, [userId])).rows[0];
            if (row && row.asks >= MAX_ASKS) return false;
            if (row && row.asks > 0 && games < row.last_games + ASK_AGAIN_AFTER) return false;
            // Counted only if nobody counted it first (two tabs at once).
            const r = await pool.query(
                `INSERT INTO web_review_asks (user_id, asks, last_games, last_at) VALUES ($1, 1, $2, NOW())
                 ON CONFLICT (user_id) DO UPDATE SET asks = web_review_asks.asks + 1, last_games = $2, last_at = NOW()
                 WHERE web_review_asks.asks < $3 AND $2 >= web_review_asks.last_games + $4`,
                [userId, games, MAX_ASKS, ASK_AGAIN_AFTER]
            );
            return r.rowCount === 1;
        } catch (e) {
            logger.warn(`Review ask skipped for user ${userId}: ${e.message}`);
            return false;
        }
    }
}

const service = new WebNoticeService();
service.SCHEMA_STATEMENTS = SCHEMA_STATEMENTS;
service.POLICY = { MESSAGE_DAYS, FIRST_ASK_AT, ASK_AGAIN_AFTER, MAX_ASKS };
module.exports = service;
