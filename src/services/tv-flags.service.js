// ============================================
// FILE: src/services/tv-flags.service.js
// WUT TV — the pictures for flag questions (Oct 24, 2026).
//
// A flag question keeps its picture apart from its text: questions.image_type
// is 'flag' and questions.image_data is the country code, and the picture is
// FLAG_BASE_URL + code + '.png' (as chat play and web play build it). Until
// now WUT TV sent only a question's text and answers, so a flag question
// reached the TV as "What country's flag is this?" with nothing to see.
//
// The TV fetches the picture from THIS server, at /tv/flags/<code>.png, not
// from FLAG_BASE_URL itself. The webOS app is a web page, and a web page can
// draw a picture from another site only if that site allows it (CORS);
// served from here (whose CORS allows any origin) it always can, and both
// TVs use one path. Each flag is fetched from FLAG_BASE_URL once and kept in
// memory. Only codes that some flag question actually uses are fetched, so
// the route cannot be used to make this server fetch arbitrary files.
//
// The flags are for the TV screens only: the phones in a Party game are not
// sent them (decided Oct 24).
// ============================================

const pool = require('../config/database');

const CODE = /^[A-Za-z0-9-]{2,12}$/;
const MAX_CACHED = 400;            // there are about 250 flags
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;

class TvFlagsService {
    constructor() {
        this.cache = new Map();    // code -> { body: Buffer, type }
        this.used = new Set();     // codes known to belong to a flag question
        this.http = null;          // axios, loaded on first use (tests set a double)
    }

    _http() {
        if (!this.http) this.http = require('axios');
        return this.http;
    }

    /**
     * What a question carries for its picture, or null for a question with
     * none: { kind: 'flag', code, url }. url is the path on this server, or
     * null when FLAG_BASE_URL is not set or the code is not a code, in which
     * case the TV says the flag is not available.
     */
    imageFor(q) {
        if (!q || q.image_type !== 'flag' || !q.image_data) return null;
        const code = String(q.image_data).trim();
        if (!CODE.test(code)) return { kind: 'flag', code: null, url: null };
        return {
            kind: 'flag',
            code,
            url: process.env.FLAG_BASE_URL ? `/tv/flags/${code}.png` : null
        };
    }

    async _isUsed(code) {
        if (this.used.has(code)) return true;
        const r = await pool.query(
            `SELECT 1 FROM questions WHERE image_type = 'flag' AND image_data = $1 LIMIT 1`,
            [code]
        );
        if (r.rows.length) this.used.add(code);
        return r.rows.length > 0;
    }

    /** The picture for one flag: { ok, body, type } or { ok: false, status }. */
    async get(code) {
        code = String(code || '');
        const base = process.env.FLAG_BASE_URL;
        if (!CODE.test(code) || !base) return { ok: false, status: 404 };
        const hit = this.cache.get(code);
        if (hit) return { ok: true, ...hit };
        if (!(await this._isUsed(code))) return { ok: false, status: 404 };

        let res;
        try {
            res = await this._http().get(`${base}${code}.png`, {
                responseType: 'arraybuffer',
                timeout: FETCH_TIMEOUT_MS,
                maxContentLength: MAX_BYTES,
                validateStatus: s => s === 200
            });
        } catch (_) {
            return { ok: false, status: 502 };
        }
        const body = Buffer.from(res.data);
        if (!body.length) return { ok: false, status: 502 };
        const declared = String((res.headers && res.headers['content-type']) || '');
        const type = /^image\//.test(declared) ? declared : 'image/png';

        if (this.cache.size >= MAX_CACHED) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(code, { body, type });
        return { ok: true, body, type };
    }
}

module.exports = new TvFlagsService();
module.exports.TvFlagsService = TvFlagsService;
