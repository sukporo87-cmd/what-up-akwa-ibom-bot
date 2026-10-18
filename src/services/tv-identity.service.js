// ============================================
// FILE: src/services/tv-identity.service.js
// WUT TV — which TV is which.
//
// THREE WAYS A TV IS KNOWN:
//   * what it reports about itself when the app starts: maker, brand, model,
//     Android version, the name its owner gave it in the TV's own settings
//     ("Living Room TV"), and the screen. Sent by the app, so only ever as
//     good as the TV's answer; every field is cleaned and capped here.
//   * a name this server gives it, unique, such as "Sunny Iroko 27". The app
//     shows it small on the home screen, so whoever is standing at a TV can
//     tell us which one it is.
//   * a name and notes an admin sets on the TV admin page.
//
// THE PLACE IS APPROXIMATE. It comes from the TV's internet address, looked
// up in src/data/tv-ng-ip-places.json: a Nigeria-only cut of DB-IP's free
// "IP to City Lite" database (CC BY 4.0, https://db-ip.com), built by
// tools/build-ng-places.py. The lookup runs here, on our own server; no
// outside service is asked. A network is placed where its provider registers
// it, so the answer is a town or a state, often only right to the state, and
// a phone's hotspot can be far off. Outside Nigeria it says so and no more.
// ============================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('../config/database');
const { logger } = require('../utils/logger');
const tvAuth = require('./tv-auth.service');

// ---- the names the server gives TVs ----
const NAME_WORDS = Object.freeze([
    'Sunny', 'Bright', 'Golden', 'Lucky', 'Happy', 'Swift', 'Clever', 'Bold', 'Calm', 'Brave',
    'Jolly', 'Merry', 'Royal', 'Mighty', 'Gentle', 'Proud', 'Quick', 'Rapid', 'Smart', 'Cosy',
    'Silver', 'Amber', 'Coral', 'Indigo', 'Emerald', 'Ruby', 'Crimson', 'Velvet', 'Starry', 'Breezy'
]);
const NAME_THINGS = Object.freeze([
    'Iroko', 'Baobab', 'Mango', 'Kola', 'Palm', 'Cowrie', 'Drum', 'Gong', 'Zuma', 'Niger',
    'Benue', 'Obudu', 'Kainji', 'Lekki', 'Jos', 'Ogbunike', 'Olumo', 'Yankari', 'Agbada', 'Adire',
    'Akara', 'Suya', 'Zobo', 'Kunu', 'Egret', 'Hornbill', 'Weaver', 'Kestrel', 'Falcon', 'Antelope'
]);
const NAME_ATTEMPTS = 12;

// ---- what a TV may report about itself ----
// Strings only, each capped; anything not listed is dropped.
const DETAIL_FIELDS = Object.freeze({
    manufacturer: 60, brand: 60, model: 60, device: 60, product: 60,
    androidVersion: 20, sdk: 6, deviceName: 60, screen: 30, appBuild: 20
});

const PLACES_FILE = path.join(__dirname, '..', 'data', 'tv-ng-ip-places.json');

function clean(v, max) {
    if (v == null) return null;
    const s = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
    return s || null;
}

class TvIdentityService {

    constructor() {
        this._places = null;
    }

    // ============================================
    // THE APPROXIMATE PLACE
    // ============================================

    _table() {
        if (this._places) return this._places;
        try {
            const doc = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
            this._places = {
                places: doc.places,
                release: doc.release,
                v4: doc.v4,
                v6: doc.v6.map(([s, e, p]) => [BigInt('0x' + s), BigInt('0x' + e), p])
            };
        } catch (e) {
            logger.error(`TV places file could not be read: ${e.message}`);
            this._places = { places: [], release: null, v4: [], v6: [] };
        }
        return this._places;
    }

    static _v4(ip) {
        const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip);
        if (!m) return null;
        const parts = m.slice(1).map(Number);
        if (parts.some(n => n > 255)) return null;
        return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
    }

    static _v6(ip) {
        if (!ip.includes(':') || /[^0-9a-f:]/i.test(ip)) return null;
        const halves = ip.split('::');
        if (halves.length > 2) return null;
        const head = halves[0] ? halves[0].split(':') : [];
        const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
        const missing = 8 - head.length - tail.length;
        if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
        const groups = [...head, ...Array(missing).fill('0'), ...tail];
        if (groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
        return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n);
    }

    static _private(ip) {
        return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip.replace(/^::ffff:/i, ''));
    }

    static _find(rows, n) {
        let lo = 0, hi = rows.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (n < rows[mid][0]) hi = mid - 1;
            else if (n > rows[mid][1]) lo = mid + 1;
            else return rows[mid][2];
        }
        return -1;
    }

    /** "Ikeja, Lagos", "Outside Nigeria", or null when the address says nothing. */
    locate(ip) {
        const s = String(ip || '').trim();
        if (!s || TvIdentityService._private(s)) return null;
        const t = this._table();
        const v4 = TvIdentityService._v4(s);
        if (v4 != null) {
            const i = TvIdentityService._find(t.v4, v4);
            return i >= 0 ? t.places[i] : 'Outside Nigeria';
        }
        const v6 = TvIdentityService._v6(s);
        if (v6 != null) {
            const i = TvIdentityService._find(t.v6, v6);
            return i >= 0 ? t.places[i] : 'Outside Nigeria';
        }
        return null;
    }

    // ============================================
    // WHAT A TV REPORTS ABOUT ITSELF
    // ============================================

    cleanDetails(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const out = {};
        for (const [k, max] of Object.entries(DETAIL_FIELDS)) {
            const v = clean(raw[k], max);
            if (v) out[k] = v;
        }
        return Object.keys(out).length ? out : null;
    }

    _newName() {
        const pick = list => list[crypto.randomInt(list.length)];
        return `${pick(NAME_WORDS)} ${pick(NAME_THINGS)} ${crypto.randomInt(10, 100)}`;
    }

    /** Gives a TV its server name if it has none yet. Returns the name. */
    async ensureName(deviceId) {
        const cur = await pool.query(`SELECT tv_name FROM tv_devices WHERE id = $1`, [deviceId]);
        if (!cur.rows[0]) return null;
        if (cur.rows[0].tv_name) return cur.rows[0].tv_name;
        for (let i = 0; i < NAME_ATTEMPTS; i++) {
            const name = this._newName();
            try {
                const r = await pool.query(
                    `UPDATE tv_devices SET tv_name = $2 WHERE id = $1 AND tv_name IS NULL RETURNING tv_name`,
                    [deviceId, name]
                );
                if (r.rows[0]) return r.rows[0].tv_name;
                const again = await pool.query(`SELECT tv_name FROM tv_devices WHERE id = $1`, [deviceId]);
                return again.rows[0] ? again.rows[0].tv_name : null;
            } catch (e) {
                if (e.code !== '23505') throw e;   // taken by another TV: try another
            }
        }
        logger.error(`TV ${deviceId}: no free name after ${NAME_ATTEMPTS} tries`);
        return null;
    }

    /**
     * The app reports itself: at registration and each time it starts.
     * Records the details, the app version, the address it came from and
     * the place that address points to, and makes sure the TV has a name.
     */
    async report(deviceId, { details, appVersion, ip } = {}) {
        await tvAuth.ensureSchema();
        const d = this.cleanDetails(details);
        const version = clean(appVersion, 30);
        const addr = tvAuth._inet(ip);
        const place = addr ? this.locate(addr) : null;
        await pool.query(
            `UPDATE tv_devices
                SET details = COALESCE($2::jsonb, details),
                    details_at = CASE WHEN $2::jsonb IS NULL THEN details_at ELSE NOW() END,
                    app_version = COALESCE($3, app_version),
                    last_ip = COALESCE($4::inet, last_ip),
                    approx_location = COALESCE($5, approx_location)
              WHERE id = $1`,
            [deviceId, d ? JSON.stringify(d) : null, version, addr, place]
        );
        const tvName = await this.ensureName(deviceId);
        return { ok: true, tvName };
    }

    /** What the admin page calls a TV: the admin's name, else the server's, else its number. */
    static displayName(row) {
        return (row && (row.admin_name || row.tv_name)) || `TV #${row && row.id}`;
    }

    placesRelease() { return this._table().release; }
}

module.exports = new TvIdentityService();
module.exports.TvIdentityService = TvIdentityService;
module.exports.NAME_WORDS = NAME_WORDS;
module.exports.NAME_THINGS = NAME_THINGS;
module.exports.DETAIL_FIELDS = DETAIL_FIELDS;
module.exports.displayName = TvIdentityService.displayName;
