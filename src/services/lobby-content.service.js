// ============================================
// FILE: src/services/lobby-content.service.js
// The board in the live challenge lobby.
// ============================================
//
// The lobby is the screen players stare at for up to five minutes before a
// live challenge. It showed a countdown and a list of names. This is the
// content that fills the board beside Tiva: whatever marketing wants running
// that week, in the order they want it.
//
// SCOPE. This service knows nothing about challenges. It stores slides and
// hands back the live ones. No challenge service, route or state machine is
// involved, which is deliberate — the lobby board can be changed, broken or
// switched off without any of the challenge machinery noticing.
//
// THREE KINDS OF SLIDE
//   text   a headline and some words, drawn on WHITE — the board reads as a
//          real whiteboard, which is the whole idea
//   image  a picture filling the board
//   video  a muted clip filling the board
//
// Every slide carries its own seconds on screen, so a 6-second promo and a
// 25-second explainer can share a rotation.

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

const CACHE_KEY = 'lobby:content:live';
// Short, like the news bar: an admin who publishes a slide wants to see it in
// the lobby within a minute, not next deploy.
const CACHE_TTL = 60;

const KINDS = ['text', 'image', 'video'];
const MAX_LIVE_ITEMS = 12;
const MAX_TITLE = 60;
const MAX_ADVERTISER = 80;

// ---- Advertising measurement ----
// A view is a slide that stayed on a visible screen for LOBBY_VIEW_MIN_MS (the
// browser enforces that; see play.html). Repeats are collapsed here: one
// person's views of one slide within these windows count once, so a slide
// that loops twice in ten seconds is not billed twice.
const VIEW_DEDUPE_SECONDS = 10;
const TAP_DEDUPE_SECONDS = 3;
// A browser sends its views in batches. More than this in one batch is not a
// lobby, it is something misbehaving.
const MAX_EVENTS_PER_BATCH = 30;
const MAX_REPORT_DAYS = 366;
const MAX_BODY = 320;
const MAX_URL = 500;
const MAX_CTA = 28;

// Seconds a slide holds the board. The floor stops a slide flashing past
// unread; the ceiling stops one slide owning a five-minute lobby.
const MIN_SECONDS = 4;
const MAX_SECONDS = 60;
const DEFAULT_SECONDS = 9;

// Media must be a full https address. http is refused rather than upgraded:
// play.html is served over https, so an http image is blocked by the browser
// as mixed content and the admin sees an empty board with no explanation.
// ============================================
// HOSTED MEDIA
// ============================================
// Board images and videos are uploaded from the admin page into our own
// Cloudinary account (see cloudinary.service). A slide then records both the
// file's URL and its public id, so replacing or deleting the slide can delete
// the file too — nothing is left behind costing storage.
//
// A pasted https link still works, so existing slides keep running, but an
// uploaded file is the supported path: it is the only one we control.
function cloudinaryService() {
    try { return require('./cloudinary.service'); } catch (e) { return null; }
}

// Is this URL a file in OUR account's board folder, with this public id?
// A public id cannot be attached to any other URL: otherwise saving a slide
// could point its "hosted" record at someone else's file, and deleting the
// slide would then try to delete ours.
function isOurHostedFile(url, publicId) {
    const cs = cloudinaryService();
    const cloud = cs && cs.cloudName && cs.cloudName();
    if (!cloud || !publicId) return false;
    let parsed;
    try { parsed = new URL(String(url)); } catch (e) { return false; }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com') return false;
    if (!parsed.pathname.startsWith(`/${cloud}/`)) return false;
    if (!String(publicId).startsWith(cs.lobbyFolder() + '/')) return false;
    return parsed.pathname.includes('/' + publicId);
}

// What players are actually sent. An uploaded original can be tens of
// megabytes; the lobby gets a version sized for a phone, in whatever format
// the player's browser handles best, at a quality Cloudinary picks per file.
// Players pay for their own data, so this is not optional polish.
function deliveryUrl(url, kind) {
    if (!url || !/^https:\/\/res\.cloudinary\.com\//.test(url)) return url;
    const t = kind === 'video' ? 'f_auto,q_auto,w_720,c_limit' : 'f_auto,q_auto,w_900,c_limit';
    return url.replace(/\/(image|video)\/upload\//, (m, type) => `/${type}/upload/${t}/`);
}

// A still frame for a video slide: shown before the video starts, and all a
// player on Data Saver ever loads.
function posterUrl(url, kind) {
    if (kind !== 'video' || !url || !/^https:\/\/res\.cloudinary\.com\/[^/]+\/video\/upload\//.test(url)) return null;
    return url.replace(/\/video\/upload\//, '/video/upload/so_0,f_auto,q_auto,w_720,c_limit/')
              .replace(/\.[a-z0-9]+(\?.*)?$/i, '.jpg');
}

function checkMediaUrl(value) {
    const url = String(value || '').trim();
    if (!url) return { ok: false, error: 'A media address is required for image and video slides' };
    if (url.length > MAX_URL) return { ok: false, error: 'That media address is too long' };
    let parsed;
    try { parsed = new URL(url); } catch (e) { return { ok: false, error: 'That media address is not a valid link' }; }
    if (parsed.protocol !== 'https:') return { ok: false, error: 'Media must be served over https' };
    return { ok: true, value: url };
}

// A link a player can follow. Site-relative is the common case; absolute must
// be http(s). Same rule as the news bar, for the same reason.
function checkLinkUrl(value) {
    const url = String(value || '').trim();
    if (!url) return { ok: true, value: null };
    if (url.length > MAX_URL) return { ok: false, error: 'That link is too long' };
    if (url.startsWith('/')) return { ok: true, value: url };
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return { ok: true, value: url };
    } catch (e) { /* falls through */ }
    return { ok: false, error: 'Link must start with / or be a full http(s) address' };
}

class LobbyContentService {
    constructor() {
        this._schemaReady = false;
    }

    // Idempotent — mirrored in migrations/017-lobby-content.sql
    async ensureSchema() {
        if (this._schemaReady) return;
        await pool.query(`
            CREATE TABLE IF NOT EXISTS lobby_content (
                id SERIAL PRIMARY KEY,
                kind TEXT NOT NULL DEFAULT 'text',
                title TEXT,
                body TEXT,
                media_url TEXT,
                link_url TEXT,
                cta_label TEXT,
                duration_seconds INTEGER NOT NULL DEFAULT 9,
                priority INTEGER NOT NULL DEFAULT 0,
                starts_at TIMESTAMPTZ,
                ends_at TIMESTAMPTZ,
                active BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_by TEXT
            )
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_lobby_content_live
            ON lobby_content (priority DESC, created_at DESC)
            WHERE active = true
        `);
        // Which uploaded file a slide uses, so replacing or deleting the slide
        // can delete the file. Null for a pasted link.
        await pool.query('ALTER TABLE lobby_content ADD COLUMN IF NOT EXISTS media_public_id TEXT');
        await pool.query('ALTER TABLE lobby_content ADD COLUMN IF NOT EXISTS media_resource TEXT');

        // ADVERTISING. Who a slide is sold to, so several slides can be
        // reported together as one client's campaign.
        await pool.query('ALTER TABLE lobby_content ADD COLUMN IF NOT EXISTS advertiser TEXT');

        // One row per counted view or tap. A ledger, not running totals: an
        // advertiser's figures are always recomputed from what happened, never
        // from a counter that could drift. The advertiser is copied onto each
        // row, so a campaign's report survives the slide being renamed,
        // reassigned or deleted after it ran. No foreign key for the same reason.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS lobby_ad_events (
                id          BIGSERIAL PRIMARY KEY,
                content_id  INTEGER NOT NULL,
                advertiser  TEXT,
                kind        TEXT NOT NULL CHECK (kind IN ('view', 'tap')),
                user_id     INTEGER NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_lobby_ad_events_time ON lobby_ad_events (created_at)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_lobby_ad_events_adv ON lobby_ad_events (advertiser, created_at)');
        this._schemaReady = true;
    }

    // --------------------------------------------
    // PUBLIC READ — what the board is showing now
    // --------------------------------------------
    async getLive() {
        await this.ensureSchema();

        try {
            const cached = await redis.get(CACHE_KEY);
            if (cached) return JSON.parse(cached);
        } catch (e) { /* fall through to the database */ }

        const result = await pool.query(`
            SELECT id, kind, title, body, media_url, link_url, cta_label, duration_seconds
            FROM lobby_content
            WHERE active = true
              AND (starts_at IS NULL OR starts_at <= NOW())
              AND (ends_at   IS NULL OR ends_at   >  NOW())
            ORDER BY priority DESC, created_at DESC
            LIMIT $1
        `, [MAX_LIVE_ITEMS]);

        const payload = {
            slides: result.rows.map(r => ({
                id: r.id,
                kind: KINDS.includes(r.kind) ? r.kind : 'text',
                title: r.title || null,
                body: r.body || null,
                mediaUrl: deliveryUrl(r.media_url, r.kind) || null,
                poster: posterUrl(r.media_url, r.kind),
                url: r.link_url || null,
                cta: r.cta_label || null,
                seconds: Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, r.duration_seconds || DEFAULT_SECONDS))
            })),
            // Lets the client skip a re-render when nothing has changed.
            version: result.rows.length ? result.rows.map(r => `${r.id}.${r.duration_seconds}`).join('-') : 'empty'
        };

        try { await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(payload)); } catch (e) { /* cache is optional */ }
        return payload;
    }

    async clearCache() {
        try { await redis.del(CACHE_KEY); } catch (e) { /* cache is optional */ }
    }

    // --------------------------------------------
    // ADMIN
    // --------------------------------------------
    async adminList() {
        await this.ensureSchema();
        const result = await pool.query(`
            SELECT id, kind, title, body, media_url, link_url, cta_label, duration_seconds,
                   priority, starts_at, ends_at, active, created_at, updated_at, updated_by,
                   media_public_id, media_resource, advertiser
            FROM lobby_content
            ORDER BY active DESC, priority DESC, created_at DESC
        `);
        return result.rows;
    }

    // Returns { ok: true, values } or { ok: false, error }.
    validate(fields) {
        const kind = String(fields.kind || 'text').trim();
        if (!KINDS.includes(kind)) return { ok: false, error: 'Kind must be text, image or video' };

        const title = String(fields.title || '').trim().slice(0, MAX_TITLE) || null;
        // Free text, trimmed. Two spellings of one client would split their
        // report, so the admin page offers existing names as suggestions.
        const advertiser = String(fields.advertiser || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ADVERTISER) || null;
        const body = String(fields.body || '').trim().slice(0, MAX_BODY) || null;

        if (kind === 'text' && !title && !body) {
            return { ok: false, error: 'A text slide needs a headline or some words' };
        }

        let mediaUrl = null, mediaPublicId = null, mediaResource = null;
        if (kind === 'image' || kind === 'video') {
            const media = checkMediaUrl(fields.media_url);
            if (!media.ok) return media;
            mediaUrl = media.value;
            if (fields.media_public_id) {
                if (!isOurHostedFile(mediaUrl, fields.media_public_id)) {
                    return { ok: false, error: 'That upload does not match a file in our board storage. Upload it again.' };
                }
                mediaPublicId = String(fields.media_public_id);
                mediaResource = kind === 'video' ? 'video' : 'image';
            }
        }

        const link = checkLinkUrl(fields.link_url);
        if (!link.ok) return link;

        const cta = String(fields.cta_label || '').trim().slice(0, MAX_CTA) || null;

        const seconds = parseInt(fields.duration_seconds, 10);
        const duration = Number.isFinite(seconds)
            ? Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, seconds))
            : DEFAULT_SECONDS;

        const priority = parseInt(fields.priority, 10) || 0;

        const when = (value) => {
            if (!value) return null;
            const d = new Date(value);
            return isNaN(d.getTime()) ? null : d.toISOString();
        };

        return {
            ok: true,
            values: {
                kind, title, body, mediaUrl, mediaPublicId, mediaResource, advertiser,
                linkUrl: link.value,
                cta, duration, priority,
                startsAt: when(fields.starts_at),
                endsAt: when(fields.ends_at),
                active: fields.active !== false
            }
        };
    }

    async create(fields, adminUsername) {
        await this.ensureSchema();
        const checked = this.validate(fields);
        if (!checked.ok) return checked;
        const v = checked.values;

        const result = await pool.query(`
            INSERT INTO lobby_content
                (kind, title, body, media_url, link_url, cta_label, duration_seconds,
                 priority, starts_at, ends_at, active, updated_by, media_public_id, media_resource,
                 advertiser)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING id
        `, [v.kind, v.title, v.body, v.mediaUrl, v.linkUrl, v.cta, v.duration,
            v.priority, v.startsAt, v.endsAt, v.active, adminUsername || null,
            v.mediaPublicId, v.mediaResource, v.advertiser]);

        await this.clearCache();
        logger.info(`Lobby slide ${result.rows[0].id} created by ${adminUsername || 'admin'}`);
        return { ok: true, id: result.rows[0].id };
    }

    async update(id, fields, adminUsername) {
        await this.ensureSchema();
        const checked = this.validate(fields);
        if (!checked.ok) return checked;
        const v = checked.values;

        const before = await pool.query(
            'SELECT media_public_id, media_resource FROM lobby_content WHERE id = $1', [id]);

        const result = await pool.query(`
            UPDATE lobby_content
            SET kind = $1, title = $2, body = $3, media_url = $4, link_url = $5,
                cta_label = $6, duration_seconds = $7, priority = $8,
                starts_at = $9, ends_at = $10, active = $11,
                updated_at = NOW(), updated_by = $12,
                media_public_id = $14, media_resource = $15, advertiser = $16
            WHERE id = $13
            RETURNING id
        `, [v.kind, v.title, v.body, v.mediaUrl, v.linkUrl, v.cta, v.duration,
            v.priority, v.startsAt, v.endsAt, v.active, adminUsername || null, id,
            v.mediaPublicId, v.mediaResource, v.advertiser]);

        if (!result.rowCount) return { ok: false, error: 'Slide not found' };

        // The slide no longer uses its old upload: delete it. Only AFTER the
        // row is saved, so a failed save never loses the file it still needs.
        const old = before.rows[0];
        if (old && old.media_public_id && old.media_public_id !== v.mediaPublicId) {
            const cs = cloudinaryService();
            if (cs) await cs.deleteLobbyMedia(old.media_public_id, old.media_resource);
        }
        await this.clearCache();
        return { ok: true };
    }

    // Take a slide off the board now, keep what it said. Separate from delete
    // on purpose: pulling something in a hurry should not destroy it.
    async setActive(id, active, adminUsername) {
        await this.ensureSchema();
        const result = await pool.query(`
            UPDATE lobby_content
            SET active = $1, updated_at = NOW(), updated_by = $2
            WHERE id = $3
            RETURNING active
        `, [active === true, adminUsername || null, id]);

        if (!result.rowCount) return { ok: false, error: 'Slide not found' };
        await this.clearCache();
        return { ok: true, active: result.rows[0].active };
    }

    async remove(id, adminUsername) {
        await this.ensureSchema();
        const result = await pool.query(
            'DELETE FROM lobby_content WHERE id = $1 RETURNING media_public_id, media_resource', [id]);
        if (!result.rowCount) return false;
        const gone = result.rows[0] || {};
        if (gone.media_public_id) {
            const cs = cloudinaryService();
            if (cs) await cs.deleteLobbyMedia(gone.media_public_id, gone.media_resource);
        }
        await this.clearCache();
        logger.info(`Lobby slide ${id} deleted by ${adminUsername || 'admin'}`);
        return true;
    }

    // ============================================
    // ADVERTISING: COUNTING
    // ============================================
    // Called with a signed-in player's batch of views and taps. Returns how
    // many were counted. Never throws: a failed count must not disturb a lobby.
    async recordEvents(userId, events) {
        try {
            if (!Number.isInteger(userId) || !Array.isArray(events) || !events.length) return 0;
            await this.ensureSchema();

            const batch = events.slice(0, MAX_EVENTS_PER_BATCH)
                .map(e => ({ id: parseInt(e && e.id, 10), kind: e && e.kind }))
                .filter(e => Number.isInteger(e.id) && (e.kind === 'view' || e.kind === 'tap'));
            if (!batch.length) return 0;

            // Only slides that exist. A made-up id must not create a line in
            // somebody's report.
            const ids = [...new Set(batch.map(e => e.id))];
            const known = await pool.query(
                'SELECT id, advertiser FROM lobby_content WHERE id = ANY($1::int[])', [ids]);
            const advertiserOf = new Map(known.rows.map(r => [r.id, r.advertiser]));

            const counted = [];
            for (const e of batch) {
                if (!advertiserOf.has(e.id)) continue;
                const ttl = e.kind === 'tap' ? TAP_DEDUPE_SECONDS : VIEW_DEDUPE_SECONDS;
                let fresh = true;
                try {
                    fresh = (await redis.set(`lbe:${e.kind}:${userId}:${e.id}`, '1', 'EX', ttl, 'NX')) === 'OK';
                } catch (err) { fresh = true; }   // without Redis, count rather than lose it
                if (fresh) counted.push(e);
            }
            if (!counted.length) return 0;

            const values = [], params = [];
            counted.forEach((e, n) => {
                const o = n * 4;
                values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`);
                params.push(e.id, advertiserOf.get(e.id) || null, e.kind, userId);
            });
            await pool.query(
                `INSERT INTO lobby_ad_events (content_id, advertiser, kind, user_id) VALUES ${values.join(', ')}`,
                params);
            return counted.length;
        } catch (error) {
            logger.error(`Could not record lobby ad events: ${error.message}`);
            return 0;
        }
    }

    // ============================================
    // ADVERTISING: THE REPORT
    // ============================================
    // Days are Nigerian days (WAT, UTC+1, no daylight saving), inclusive of
    // both ends, because that is what an advertiser means by "1 to 7 October".
    static reportWindow(from, to) {
        const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
        const today = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
        const toDay = ok(to) ? to : today;
        const fromDay = ok(from) ? from
            : new Date(new Date(toDay + 'T00:00:00Z').getTime() - 6 * 86400000).toISOString().slice(0, 10);
        const start = new Date(fromDay + 'T00:00:00+01:00');
        const end = new Date(new Date(toDay + 'T00:00:00+01:00').getTime() + 86400000);
        if (isNaN(start) || isNaN(end) || end <= start) return null;
        if ((end - start) / 86400000 > MAX_REPORT_DAYS) return null;
        return { fromDay, toDay, start, end };
    }

    async report({ from, to, advertiser } = {}) {
        await this.ensureSchema();
        const win = LobbyContentService.reportWindow(from, to);
        if (!win) return { ok: false, error: 'Choose a date range of up to a year.' };

        const params = [win.start, win.end];
        let filter = '';
        if (advertiser) { params.push(String(advertiser)); filter = 'AND e.advertiser = $3'; }

        // PER ADVERTISER, COUNTED ACROSS THEIR SLIDES TOGETHER.
        // Viewers are counted distinct over the whole campaign, not summed
        // slide by slide: one person who saw three slides is one viewer, and
        // adding per-slide counts would report them as three.
        const totals = await pool.query(`
            SELECT e.advertiser,
                   COUNT(*) FILTER (WHERE e.kind = 'view')                  AS views,
                   COUNT(DISTINCT e.user_id) FILTER (WHERE e.kind = 'view') AS viewers,
                   COUNT(*) FILTER (WHERE e.kind = 'tap')                   AS taps,
                   COUNT(DISTINCT e.content_id)                             AS slides
            FROM lobby_ad_events e
            WHERE e.created_at >= $1 AND e.created_at < $2 ${filter}
            GROUP BY e.advertiser
            ORDER BY views DESC
        `, params);

        const bySlide = await pool.query(`
            SELECT e.advertiser, e.content_id, c.title, c.kind,
                   COUNT(*) FILTER (WHERE e.kind = 'view')                  AS views,
                   COUNT(DISTINCT e.user_id) FILTER (WHERE e.kind = 'view') AS viewers,
                   COUNT(*) FILTER (WHERE e.kind = 'tap')                   AS taps
            FROM lobby_ad_events e
            LEFT JOIN lobby_content c ON c.id = e.content_id
            WHERE e.created_at >= $1 AND e.created_at < $2 ${filter}
            GROUP BY e.advertiser, e.content_id, c.title, c.kind
            ORDER BY e.advertiser NULLS LAST, views DESC
        `, params);

        const n = (v) => Number(v) || 0;
        const rate = (taps, views) => (views > 0 ? Math.round((taps / views) * 1000) / 10 : 0);
        return {
            ok: true,
            from: win.fromDay,
            to: win.toDay,
            advertisers: totals.rows.map(r => ({
                advertiser: r.advertiser || null,
                slides: n(r.slides), views: n(r.views), viewers: n(r.viewers), taps: n(r.taps),
                tapRate: rate(n(r.taps), n(r.views)),
                bySlide: bySlide.rows
                    .filter(s => (s.advertiser || null) === (r.advertiser || null))
                    .map(s => ({
                        id: s.content_id,
                        // A slide deleted after its campaign still reports.
                        title: s.title || `(deleted slide ${s.content_id})`,
                        kind: s.kind || null,
                        views: n(s.views), viewers: n(s.viewers), taps: n(s.taps),
                        tapRate: rate(n(s.taps), n(s.views))
                    }))
            }))
        };
    }

    // Names already in use, offered as suggestions so one client is not split
    // across two spellings.
    async advertisers() {
        await this.ensureSchema();
        const r = await pool.query(`
            SELECT DISTINCT advertiser FROM lobby_content WHERE advertiser IS NOT NULL
            UNION
            SELECT DISTINCT advertiser FROM lobby_ad_events WHERE advertiser IS NOT NULL
            ORDER BY 1`);
        return r.rows.map(x => x.advertiser);
    }
}


module.exports = LobbyContentService;
module.exports.KINDS = KINDS;
module.exports.MIN_SECONDS = MIN_SECONDS;
module.exports.MAX_SECONDS = MAX_SECONDS;
module.exports.DEFAULT_SECONDS = DEFAULT_SECONDS;
module.exports.VIEW_DEDUPE_SECONDS = VIEW_DEDUPE_SECONDS;
module.exports.MAX_EVENTS_PER_BATCH = MAX_EVENTS_PER_BATCH;
module.exports.deliveryUrl = deliveryUrl;
module.exports.posterUrl = posterUrl;
module.exports.isOurHostedFile = isOurHostedFile;