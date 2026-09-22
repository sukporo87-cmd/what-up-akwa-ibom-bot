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
                   media_public_id, media_resource
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
                kind, title, body, mediaUrl, mediaPublicId, mediaResource,
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
                 priority, starts_at, ends_at, active, updated_by, media_public_id, media_resource)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING id
        `, [v.kind, v.title, v.body, v.mediaUrl, v.linkUrl, v.cta, v.duration,
            v.priority, v.startsAt, v.endsAt, v.active, adminUsername || null,
            v.mediaPublicId, v.mediaResource]);

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
                media_public_id = $14, media_resource = $15
            WHERE id = $13
            RETURNING id
        `, [v.kind, v.title, v.body, v.mediaUrl, v.linkUrl, v.cta, v.duration,
            v.priority, v.startsAt, v.endsAt, v.active, adminUsername || null, id,
            v.mediaPublicId, v.mediaResource]);

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
}

module.exports = LobbyContentService;
module.exports.KINDS = KINDS;
module.exports.MIN_SECONDS = MIN_SECONDS;
module.exports.MAX_SECONDS = MAX_SECONDS;
module.exports.DEFAULT_SECONDS = DEFAULT_SECONDS;
module.exports.deliveryUrl = deliveryUrl;
module.exports.posterUrl = posterUrl;
module.exports.isOurHostedFile = isOurHostedFile;