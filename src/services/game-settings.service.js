// ============================================
// FILE: src/services/game-settings.service.js
// NUMERIC GAME SETTINGS — the values an admin needs to change during a
// live event, without a deploy.
//
// WHY THIS EXISTS (and why it is not toggles.service.js)
// toggles.service.js answers one question: is this thing on? Its column
// is a BOOLEAN and its whole resolution chain returns true/false. The
// answer clock is a number with a floor, a ceiling and a fallback, so it
// gets its own table rather than a bolted-on `value` column that means
// nothing for every existing row.
//
// EXPORT SHAPE: exports an INSTANCE (like toggles.service.js).
//   const gameSettings = require('./game-settings.service');
//
// THE ONLY SETTING TODAY
//   answer_seconds.<mode>.<platform>   e.g. answer_seconds.classic.web
//
// A value here is FLAT: it replaces the progressive ladder (Q1-5 12s,
// Q6-10 11s, Q11-15 10s) with one number for every question in the
// round. Stepped would have preserved the difficulty curve, but "your
// clock is 8 seconds" is a thing a player can be told, and "your clock
// starts at 8 and tightens on a schedule you cannot see" is not.
//
// WHERE IT SITS IN THE PRIORITY ORDER — this is the important part.
// game.service.getSessionTimeout() consults, in order:
//
//   1. challenge bypass      both duellists on one clock
//   2. watchlist timers      shortened clocks for flagged players
//   3. turbo mode            anti-cheat response to suspicious pacing
//   4. penalty mode          enforcement after a violation
//   5. THIS OVERRIDE         <-- admin-set base clock
//   6. progressive ladder    the 12/11/10 default
//
// It is deliberately BELOW every anti-cheat layer. An admin loosening
// the clock to 20 seconds must not thereby hand a flagged account its
// full time back, and must not be able to switch turbo off by accident
// from a settings page. Loosening the base clock and disarming fraud
// detection are different decisions and stay different controls.
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

const REFRESH_MS = 15000;

const MODES = ['practice', 'classic', 'tournament'];
const PLATFORMS = ['whatsapp', 'telegram', 'web'];

// 5 is not an arbitrary floor. TURBO_MODE_CONFIG.CLUSTERING.MINIMUM_TIMEOUT_MS
// is 5000: five seconds is the tightest clock the anti-cheat system will
// impose on anyone. Letting an admin set a base clock below the punishment
// clock would mean every honest player was already playing under conditions
// the fraud model reads as adversarial.
const MIN_SECONDS = 5;

// 30 is where the chat surfaces break down. "⏱️ 45 seconds..." on WhatsApp
// invites a player to walk away mid-question, and the Redis timeout buffer
// and zombie-session sweeper are both sized for a round that moves.
const MAX_SECONDS = 30;

class GameSettingsService {
    constructor() {
        this._cache = new Map();    // key -> { seconds, updated_by, updated_at }
        this._loaded = false;
        this._timer = null;
    }

    // Idempotent — mirrored in src/migrations/015-game-settings.sql
    async ensureSchema() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS game_settings (
                key TEXT PRIMARY KEY,
                int_value INTEGER NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_by TEXT
            )
        `);
    }

    async refresh() {
        try {
            await this.ensureSchema();
            const result = await pool.query(
                'SELECT key, int_value, updated_at, updated_by FROM game_settings'
            );
            const next = new Map();
            for (const row of result.rows) {
                next.set(row.key, {
                    seconds: row.int_value,
                    updated_at: row.updated_at,
                    updated_by: row.updated_by
                });
            }
            this._cache = next;
            this._loaded = true;
        } catch (error) {
            // A failed refresh keeps the last snapshot. With no snapshot at
            // all every lookup returns null and the game falls back to the
            // built-in ladder — which is the safe direction to fail in, but
            // it means an admin's setting is silently not applying, so say so.
            if (this._loaded) {
                logger.warn(`Game settings refresh failed, using last snapshot: ${error.message}`);
            } else {
                logger.error(`Game settings cache EMPTY — admin answer-time overrides are NOT being applied: ${error.message}`);
            }
        }
    }

    /** Called once at boot from server.js. Await it before serving traffic. */
    async start() {
        if (this._timer) return;
        const first = this.refresh();
        this._timer = setInterval(() => this.refresh(), REFRESH_MS);
        this._timer.unref?.();
        await first;
        logger.info(`⏱️  Game settings active (${this._cache.size} override(s) loaded, refresh every ${REFRESH_MS / 1000}s)`);
    }

    _key(mode, platform) {
        return `answer_seconds.${mode}.${platform}`;
    }

    // --------------------------------------------
    // THE ONE QUESTION THE GAME ASKS
    // --------------------------------------------
    /**
     * The admin-set answer clock for this mode on this platform, in seconds,
     * or null when no override is set (caller keeps its own default).
     *
     * Synchronous on purpose: getSessionTimeout() is already doing several
     * awaits per question and this is read on every single question served.
     * Same trade-off, and same reasoning, as togglesService.isModeEnabled().
     */
    answerSeconds(mode, platform) {
        // Defence in depth — if start() was never called, begin loading now
        // rather than reporting "no override" for the life of the process.
        if (!this._loaded && !this._timer) this.start();

        if (!MODES.includes(mode) || !PLATFORMS.includes(platform)) return null;
        const row = this._cache.get(this._key(mode, platform));
        if (!row) return null;

        // Clamp on read as well as on write. A row edited directly in psql,
        // or written before the bounds tightened, cannot produce a two-second
        // clock in production.
        return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, row.seconds));
    }

    // --------------------------------------------
    // ADMIN SURFACE
    // --------------------------------------------
    async setAnswerSeconds(mode, platform, seconds, adminUsername) {
        if (!MODES.includes(mode)) {
            return { ok: false, error: `Unknown mode "${mode}"` };
        }
        if (!PLATFORMS.includes(platform)) {
            return { ok: false, error: `Unknown platform "${platform}"` };
        }

        const n = Number(seconds);
        if (!Number.isInteger(n)) {
            return { ok: false, error: 'Answer time must be a whole number of seconds' };
        }
        if (n < MIN_SECONDS || n > MAX_SECONDS) {
            return { ok: false, error: `Answer time must be between ${MIN_SECONDS} and ${MAX_SECONDS} seconds` };
        }

        await this.ensureSchema();
        await pool.query(
            `INSERT INTO game_settings (key, int_value, updated_at, updated_by)
             VALUES ($1, $2, NOW(), $3)
             ON CONFLICT (key) DO UPDATE
               SET int_value = $2, updated_at = NOW(), updated_by = $3`,
            [this._key(mode, platform), n, adminUsername || null]
        );
        await this.refresh();      // take effect on this node immediately
        logger.info(`Answer time for ${mode}/${platform} set to ${n}s by ${adminUsername || 'unknown'}`);
        return { ok: true, seconds: n };
    }

    /** Removing the row hands the clock back to the progressive ladder. */
    async clearAnswerSeconds(mode, platform, adminUsername) {
        await this.ensureSchema();
        const r = await pool.query(
            'DELETE FROM game_settings WHERE key = $1 RETURNING key',
            [this._key(mode, platform)]
        );
        await this.refresh();
        if (r.rows.length) {
            logger.info(`Answer time for ${mode}/${platform} cleared by ${adminUsername || 'unknown'} (back to progressive ladder)`);
        }
        return r.rows.length > 0;
    }

    /**
     * The full grid for the dashboard, including what the game would
     * actually do where no override is set — so the page shows the real
     * behaviour rather than an empty box that means "something, probably".
     */
    async getGrid() {
        await this.refresh();
        const grid = { bounds: { min: MIN_SECONDS, max: MAX_SECONDS }, matrix: {} };

        for (const m of MODES) {
            grid.matrix[m] = {};
            for (const p of PLATFORMS) {
                const row = this._cache.get(this._key(m, p));
                grid.matrix[m][p] = row
                    ? {
                        seconds: row.seconds,
                        source: 'override',
                        updated_by: row.updated_by,
                        updated_at: row.updated_at
                    }
                    : { seconds: null, source: 'ladder', updated_by: null, updated_at: null };
            }
        }
        return grid;
    }
}

module.exports = new GameSettingsService();
module.exports.MODES = MODES;
module.exports.PLATFORMS = PLATFORMS;
module.exports.MIN_SECONDS = MIN_SECONDS;
module.exports.MAX_SECONDS = MAX_SECONDS;
