// ============================================
// FILE: src/services/announcements.service.js
// ANNOUNCEMENTS — the rolling news bar on the marketing site.
//
// WHY THIS IS NOT site-content.service.js
// That file is a flat key→string store for copy that is baked into the
// page and overridden in place. Its own header calls it "deliberately
// narrow… not a page builder". An announcement is a different shape: it
// is a LIST, it is ORDERED, it has a WINDOW (starts_at / ends_at), and it
// is meant to appear and then stop appearing without anyone remembering
// to go and delete it. Forcing that into news.1, news.2, news.3 would
// mean an admin hand-editing key names to reorder items and a stale
// notice sitting on the site until someone noticed.
//
// EXPORT SHAPE: exports an INSTANCE.
//   const announcements = require('./announcements.service');
//
// SAFETY MODEL — the same one site-content uses, for the same reason.
// Bodies are PLAIN TEXT. The ticker sets textContent, never innerHTML,
// so a tag typed into the admin box renders as literal characters rather
// than as markup. Link URLs are the one field that reaches an attribute,
// so they are validated to http/https here and re-checked client-side;
// a javascript: URL is rejected at write time, not merely on display.
//
// SCHEDULING. starts_at and ends_at are both optional:
//   neither  → runs until switched off
//   ends_at  → disappears on its own, which is the common case
//   starts_at→ queue tomorrow's notice today
// Expired rows are NOT deleted. They stay visible in the admin list so
// there is a record of what the site was saying last week.
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

const CACHE_KEY = 'announcements:live';
// 60s, against site-content's 300s. Copy changes are planned; a news bar
// is reached for when something is happening now, and five minutes of
// staleness is the wrong property for the surface you use to say "the
// tournament is live".
const CACHE_TTL = 60;

const MAX_BODY_LENGTH = 280;
const MAX_LABEL_LENGTH = 24;
const MAX_LIVE_ITEMS = 12;

// Tones drive one thing only: the colour of the dot and label in the bar.
// A closed list, because "whatever the admin typed" as a CSS class is how
// an untrusted string ends up in a stylesheet.
const TONES = ['info', 'live', 'alert', 'win'];

class AnnouncementsService {
    constructor() {
        this._schemaReady = false;
    }

    // Idempotent — mirrored in src/migrations/016-announcements.sql
    async ensureSchema() {
        if (this._schemaReady) return;
        await pool.query(`
            CREATE TABLE IF NOT EXISTS site_announcements (
                id SERIAL PRIMARY KEY,
                body TEXT NOT NULL,
                label TEXT,
                link_url TEXT,
                tone TEXT NOT NULL DEFAULT 'info',
                priority INTEGER NOT NULL DEFAULT 0,
                starts_at TIMESTAMPTZ,
                ends_at TIMESTAMPTZ,
                active BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_by TEXT
            )
        `);
        // Partial index: the public query only ever asks for live rows, and
        // the archive is allowed to grow without slowing it down.
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_announcements_live
            ON site_announcements (priority DESC, created_at DESC)
            WHERE active = true
        `);
        this._schemaReady = true;
    }

    // --------------------------------------------
    // PUBLIC READ — what the ticker shows right now
    // --------------------------------------------
    async getLive() {
        await this.ensureSchema();

        try {
            const cached = await redis.get(CACHE_KEY);
            if (cached) return JSON.parse(cached);
        } catch (e) { /* fall through to DB */ }

        const result = await pool.query(`
            SELECT id, body, label, link_url, tone
            FROM site_announcements
            WHERE active = true
              AND (starts_at IS NULL OR starts_at <= NOW())
              AND (ends_at   IS NULL OR ends_at   >  NOW())
            ORDER BY priority DESC, created_at DESC
            LIMIT $1
        `, [MAX_LIVE_ITEMS]);

        const payload = {
            items: result.rows.map(r => ({
                id: r.id,
                body: r.body,
                label: r.label || null,
                url: r.link_url || null,
                tone: TONES.includes(r.tone) ? r.tone : 'info'
            })),
            // Lets the client skip a re-render when nothing has changed.
            version: result.rows.length
                ? result.rows.map(r => r.id).join('-')
                : 'empty'
        };

        await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(payload)).catch(() => {});
        return payload;
    }

    async _bust() {
        await redis.del(CACHE_KEY).catch(() => {});
    }

    // --------------------------------------------
    // VALIDATION
    // --------------------------------------------
    _validate(fields) {
        const { body, label, link_url, tone, priority, starts_at, ends_at } = fields;

        if (typeof body !== 'string' || !body.trim()) {
            return { ok: false, error: 'Write the announcement text' };
        }
        if (body.length > MAX_BODY_LENGTH) {
            return { ok: false, error: `Keep it under ${MAX_BODY_LENGTH} characters — it has to scroll past in a few seconds` };
        }
        if (label != null && String(label).length > MAX_LABEL_LENGTH) {
            return { ok: false, error: `Label must be ${MAX_LABEL_LENGTH} characters or fewer` };
        }
        if (tone != null && !TONES.includes(tone)) {
            return { ok: false, error: `Tone must be one of: ${TONES.join(', ')}` };
        }
        if (priority != null && !Number.isInteger(Number(priority))) {
            return { ok: false, error: 'Priority must be a whole number' };
        }

        // The one field that becomes an attribute. Relative paths are the
        // common case (/leaderboards); absolute must be http(s). Anything
        // else — javascript:, data:, vbscript: — is refused here so it can
        // never reach the DOM at all.
        if (link_url) {
            const u = String(link_url).trim();
            const relative = u.startsWith('/') && !u.startsWith('//');
            let absoluteOk = false;
            if (!relative) {
                try {
                    const parsed = new URL(u);
                    absoluteOk = parsed.protocol === 'http:' || parsed.protocol === 'https:';
                } catch (e) { absoluteOk = false; }
            }
            if (!relative && !absoluteOk) {
                return { ok: false, error: 'Link must start with / or be a full http(s) address' };
            }
        }

        const s = starts_at ? new Date(starts_at) : null;
        const e = ends_at ? new Date(ends_at) : null;
        if (starts_at && isNaN(s)) return { ok: false, error: 'Start time is not a valid date' };
        if (ends_at && isNaN(e))   return { ok: false, error: 'End time is not a valid date' };
        if (s && e && e <= s) {
            return { ok: false, error: 'End time must be after the start time' };
        }

        return { ok: true };
    }

    // --------------------------------------------
    // ADMIN
    // --------------------------------------------
    async adminList() {
        await this.ensureSchema();
        const result = await pool.query(`
            SELECT id, body, label, link_url, tone, priority,
                   starts_at, ends_at, active, created_at, updated_at, updated_by,
                   (
                     active = true
                     AND (starts_at IS NULL OR starts_at <= NOW())
                     AND (ends_at   IS NULL OR ends_at   >  NOW())
                   ) AS is_live,
                   (ends_at IS NOT NULL AND ends_at <= NOW()) AS is_expired,
                   (starts_at IS NOT NULL AND starts_at > NOW()) AS is_scheduled
            FROM site_announcements
            ORDER BY is_live DESC, priority DESC, created_at DESC
        `);
        return result.rows;
    }

    async create(fields, adminUsername) {
        await this.ensureSchema();
        const check = this._validate(fields);
        if (!check.ok) return check;

        const result = await pool.query(`
            INSERT INTO site_announcements
                (body, label, link_url, tone, priority, starts_at, ends_at, active, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `, [
            String(fields.body).trim(),
            fields.label ? String(fields.label).trim() : null,
            fields.link_url ? String(fields.link_url).trim() : null,
            fields.tone || 'info',
            Number(fields.priority) || 0,
            fields.starts_at || null,
            fields.ends_at || null,
            fields.active !== false,
            adminUsername || null
        ]);

        await this._bust();
        logger.info(`Announcement created (#${result.rows[0].id}) by ${adminUsername || 'unknown'}`);
        return { ok: true, id: result.rows[0].id };
    }

    async update(id, fields, adminUsername) {
        await this.ensureSchema();
        const check = this._validate(fields);
        if (!check.ok) return check;

        const result = await pool.query(`
            UPDATE site_announcements SET
                body = $2, label = $3, link_url = $4, tone = $5, priority = $6,
                starts_at = $7, ends_at = $8, active = $9,
                updated_at = NOW(), updated_by = $10
            WHERE id = $1
            RETURNING id
        `, [
            id,
            String(fields.body).trim(),
            fields.label ? String(fields.label).trim() : null,
            fields.link_url ? String(fields.link_url).trim() : null,
            fields.tone || 'info',
            Number(fields.priority) || 0,
            fields.starts_at || null,
            fields.ends_at || null,
            fields.active !== false,
            adminUsername || null
        ]);

        await this._bust();
        if (!result.rows.length) return { ok: false, error: 'Announcement not found' };
        logger.info(`Announcement #${id} updated by ${adminUsername || 'unknown'}`);
        return { ok: true };
    }

    /** The one-click control an admin actually reaches for mid-incident. */
    async setActive(id, active, adminUsername) {
        await this.ensureSchema();
        const result = await pool.query(`
            UPDATE site_announcements
            SET active = $2, updated_at = NOW(), updated_by = $3
            WHERE id = $1 RETURNING id, active
        `, [id, active === true, adminUsername || null]);

        await this._bust();
        if (!result.rows.length) return { ok: false, error: 'Announcement not found' };
        logger.info(`Announcement #${id} ${active ? 'shown' : 'hidden'} by ${adminUsername || 'unknown'}`);
        return { ok: true, active: result.rows[0].active };
    }

    async remove(id, adminUsername) {
        await this.ensureSchema();
        const result = await pool.query(
            'DELETE FROM site_announcements WHERE id = $1 RETURNING id', [id]
        );
        await this._bust();
        if (result.rows.length) {
            logger.info(`Announcement #${id} deleted by ${adminUsername || 'unknown'}`);
        }
        return result.rows.length > 0;
    }
}

module.exports = new AnnouncementsService();
module.exports.TONES = TONES;
module.exports.MAX_BODY_LENGTH = MAX_BODY_LENGTH;
