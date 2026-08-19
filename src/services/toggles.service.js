// ============================================
// FILE: src/services/toggles.service.js
// FEATURE TOGGLES — per mode, per platform, flipped from the admin
// dashboard without a deploy.
//
// WHY THIS EXISTS
// The mode switches lived in Render environment variables, which means
// a redeploy — and a few minutes of downtime — every time one is
// flipped. That is exactly the wrong property for a control you reach
// for *during* an incident. These now live in Postgres and can be
// changed instantly.
//
// EXPORT SHAPE: exports an INSTANCE (like activity.service.js).
//   const toggles = require('./toggles.service');
//
// WHY THE CACHE IS SYNCHRONOUS
// `restrictionsService.isModeEnabled()` is called from six places that
// are not async-friendly, including inside message composition. Rather
// than make those async and risk a missed `await` silently returning a
// Promise (which is truthy, so every mode would read as "enabled"),
// this keeps a small in-memory snapshot refreshed on a timer and after
// every write. Worst case a toggle takes REFRESH_MS to reach a node.
//
// RESOLUTION ORDER — most specific wins:
//   1. DB   mode.<mode>.<platform>      e.g. mode.classic.whatsapp
//   2. DB   platform.<platform>         whole platform off
//   3. DB   mode.<mode>                 mode off everywhere
//   4. ENV  <MODE>_MODE_ENABLED_<PLATFORM>
//   5. ENV  <MODE>_MODE_ENABLED         the original variable
//   6. default: enabled
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

const REFRESH_MS = 15000;
const MODES = ['practice', 'classic', 'tournament'];
const PLATFORMS = ['whatsapp', 'telegram', 'web'];

class TogglesService {
    constructor() {
        this._cache = new Map();   // key -> { enabled, message }
        this._loaded = false;
        this._timer = null;
    }

    // Idempotent — mirrored in src/migrations/008-system-toggles.sql
    async ensureSchema() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS system_toggles (
                key TEXT PRIMARY KEY,
                enabled BOOLEAN NOT NULL DEFAULT true,
                message TEXT,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_by TEXT
            )
        `);
    }

    async refresh() {
        try {
            await this.ensureSchema();
            const result = await pool.query('SELECT key, enabled, message FROM system_toggles');
            const next = new Map();
            for (const row of result.rows) {
                next.set(row.key, { enabled: row.enabled, message: row.message || null });
            }
            this._cache = next;
            this._loaded = true;
        } catch (error) {
            // Never let a toggle lookup failure take the game down: keep the
            // last known snapshot, or fall through to env vars if we have none.
            // Log loudly when we have NO snapshot at all, because in that state
            // every mode reads as enabled and a switched-off mode is playable.
            if (this._loaded) {
                logger.warn(`Toggle refresh failed, using last snapshot: ${error.message}`);
            } else {
                logger.error(`Toggle cache EMPTY — all modes will read as enabled until this recovers: ${error.message}`);
            }
        }
    }

    // Called once at boot from server.js
    start() {
        if (this._timer) return;
        this.refresh();
        this._timer = setInterval(() => this.refresh(), REFRESH_MS);
        this._timer.unref?.();
        logger.info(`🎚️  Feature toggles active (refresh every ${REFRESH_MS / 1000}s)`);
    }

    _db(key) {
        // Defence in depth: if start() was never called — the exact bug that
        // let Classic stay playable after being switched off — begin loading
        // now rather than reporting "no override set" forever. The first few
        // lookups still fall through to env/default, but the window is
        // seconds instead of permanent.
        if (!this._loaded && !this._timer) {
            this.start();
        }
        return this._cache.get(key) || null;
    }

    _env(name) {
        const v = process.env[name];
        if (v === undefined || v === null || v === '') return null;
        return v === 'true';
    }

    // --------------------------------------------
    // The one question everything else asks.
    // Returns { enabled, reason, message }
    // --------------------------------------------
    resolveMode(mode, platform) {
        mode = String(mode || '').toLowerCase();
        platform = PLATFORMS.includes(platform) ? platform : null;

        if (platform) {
            const specific = this._db(`mode.${mode}.${platform}`);
            if (specific) {
                return { enabled: specific.enabled, reason: 'mode+platform', message: specific.message };
            }
            const plat = this._db(`platform.${platform}`);
            if (plat && plat.enabled === false) {
                return { enabled: false, reason: 'platform', message: plat.message };
            }
        }

        const global = this._db(`mode.${mode}`);
        if (global) {
            return { enabled: global.enabled, reason: 'mode', message: global.message };
        }

        if (platform) {
            const envPlat = this._env(`${mode.toUpperCase()}_MODE_ENABLED_${platform.toUpperCase()}`);
            if (envPlat !== null) return { enabled: envPlat, reason: 'env+platform', message: null };
        }
        const envGlobal = this._env(`${mode.toUpperCase()}_MODE_ENABLED`);
        if (envGlobal !== null) return { enabled: envGlobal, reason: 'env', message: null };

        return { enabled: true, reason: 'default', message: null };
    }

    isModeEnabled(mode, platform = null) {
        return this.resolveMode(mode, platform).enabled;
    }

    // Whole-platform kill switch, independent of mode.
    isPlatformEnabled(platform) {
        const row = this._db(`platform.${platform}`);
        if (row) return row.enabled;
        const env = this._env(`PLATFORM_ENABLED_${String(platform).toUpperCase()}`);
        return env === null ? true : env;
    }

    // Which other platforms can still play this mode — so the "unavailable"
    // message can redirect rather than just apologise.
    alternativePlatforms(mode, exceptPlatform) {
        return PLATFORMS.filter(p =>
            p !== exceptPlatform &&
            this.isPlatformEnabled(p) &&
            this.isModeEnabled(mode, p)
        );
    }

    // --------------------------------------------
    // Admin surface
    // --------------------------------------------
    async setToggle(key, enabled, message, adminUsername) {
        if (!this.isValidKey(key)) return { ok: false, error: 'Unknown toggle key' };
        await this.ensureSchema();
        await pool.query(
            `INSERT INTO system_toggles (key, enabled, message, updated_at, updated_by)
             VALUES ($1, $2, $3, NOW(), $4)
             ON CONFLICT (key) DO UPDATE
               SET enabled = $2, message = $3, updated_at = NOW(), updated_by = $4`,
            [key, enabled === true, message || null, adminUsername || null]
        );
        await this.refresh();          // take effect immediately on this node
        logger.info(`Toggle ${key} set to ${enabled} by ${adminUsername || 'unknown'}`);
        return { ok: true };
    }

    // Deleting a row hands control back to the env var / default, which is
    // how an admin "unsets" an override rather than pinning it to true.
    async clearToggle(key, adminUsername) {
        await this.ensureSchema();
        const r = await pool.query('DELETE FROM system_toggles WHERE key = $1 RETURNING key', [key]);
        await this.refresh();
        if (r.rows.length) logger.info(`Toggle ${key} cleared by ${adminUsername || 'unknown'}`);
        return r.rows.length > 0;
    }

    isValidKey(key) {
        if (typeof key !== 'string') return false;
        if (/^platform\.(whatsapp|telegram|web)$/.test(key)) return true;
        if (new RegExp(`^mode\\.(${MODES.join('|')})$`).test(key)) return true;
        if (new RegExp(`^mode\\.(${MODES.join('|')})\\.(${PLATFORMS.join('|')})$`).test(key)) return true;
        return false;
    }

    // The full grid, with where each value came from — so the dashboard can
    // show "inherited from env" versus "set here", which is the difference
    // between understanding the system and guessing at it.
    async getGrid() {
        await this.refresh();
        const grid = { platforms: {}, modes: {}, matrix: {} };

        for (const p of PLATFORMS) {
            const row = this._db(`platform.${p}`);
            grid.platforms[p] = {
                enabled: this.isPlatformEnabled(p),
                source: row ? 'database' : (this._env(`PLATFORM_ENABLED_${p.toUpperCase()}`) !== null ? 'env' : 'default'),
                message: row ? row.message : null
            };
        }

        for (const m of MODES) {
            const row = this._db(`mode.${m}`);
            grid.modes[m] = {
                enabled: row ? row.enabled : this.resolveMode(m, null).enabled,
                source: row ? 'database' : this.resolveMode(m, null).reason,
                message: row ? row.message : null
            };
            grid.matrix[m] = {};
            for (const p of PLATFORMS) {
                const specific = this._db(`mode.${m}.${p}`);
                const resolved = this.resolveMode(m, p);
                grid.matrix[m][p] = {
                    enabled: resolved.enabled && this.isPlatformEnabled(p),
                    override: !!specific,
                    source: resolved.reason,
                    message: specific ? specific.message : null
                };
            }
        }
        return grid;
    }
}

module.exports = new TogglesService();
