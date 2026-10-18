// ============================================
// FILE: src/services/tv-settings.service.js
// WUT TV — the values an admin can change on the TV admin page, without a
// deploy.
//
// WHAT CAN BE CHANGED, AND WITHIN WHAT LIMITS. Every setting has a built-in
// default (today's value) and a floor and a ceiling. A value outside them is
// refused here, not clamped quietly, so the admin sees why.
//
// NEW GAMES ONLY. The engines read these when a game or round STARTS and keep
// them for that game (tv-party.service start(), tv-solo.service start()). A
// change never moves the clock under a game already running.
//
// WITHIN 15 SECONDS. Values are cached for REFRESH_MS, the same as the main
// game settings, so a change reaches new games within that, with no deploy.
//
// TWO SETTINGS ARE LISTS, NOT NUMBERS:
//   * party.categories_off — Party categories the TV does NOT offer. Stored
//     as the ones switched off, so a category that becomes ready later is on
//     by default, as categories are today. The Categories tile uses the same
//     list.
//   * solo.play_now_source — where Solo Mode's questions come from (Solo Mode was
//     called Play Now before app 0.8.0): the
//     Practice bank (the default), the Classic or Tournament bank, or a mix
//     of Party categories. Classic and Tournament questions are also used in
//     games played for cash, so the admin page warns before choosing them.
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');
const tvAuth = require('./tv-auth.service');

const REFRESH_MS = 15000;

/**
 * Every setting the TV admin page can change. min/max are inclusive; step
 * is what the page offers. The defaults are the values the TV used before
 * this page existed.
 */
const NUMBERS = Object.freeze({
    'party.question_seconds': {
        group: 'Party clock', label: 'Seconds per question', min: 5, max: 30, step: 1, def: 10, unit: 's',
        help: 'How long everyone has to answer each Party question (Standard and Race).'
    },
    'party.fifty_bonus_seconds': {
        group: 'Party clock', label: 'Seconds a 50:50 adds', min: 0, max: 15, step: 1, def: 5, unit: 's',
        help: 'Added to the shared clock, once per question, when someone uses 50:50. Standard style only.'
    },
    'solo.seconds_q1_5': {
        group: 'Solo clock', label: 'Questions 1 to 5', min: 5, max: 30, step: 1, def: 12, unit: 's',
        help: 'Solo Mode and Categories rounds on the TV.'
    },
    'solo.seconds_q6_10': {
        group: 'Solo clock', label: 'Questions 6 to 10', min: 5, max: 30, step: 1, def: 11, unit: 's'
    },
    'solo.seconds_q11_15': {
        group: 'Solo clock', label: 'Questions 11 to 15', min: 5, max: 30, step: 1, def: 10, unit: 's'
    },
    'race.lock_ms': {
        group: 'Race', label: 'Buttons shut while the question is read', min: 1000, max: 6000, step: 500, def: 2500, unit: 'ms',
        help: 'Everyone starts together, and nobody can tap before the question can be read.'
    },
    'race.wrong_penalty': {
        group: 'Race', label: 'Points lost for a wrong answer', min: 1, max: 3, step: 1, def: 1, unit: '',
        help: 'At least 1: with no penalty, tapping blindly the instant a question appears pays off.'
    },
    'rooms.max_players': {
        group: 'Room limits', label: 'Players per Party room', min: 2, max: 20, step: 1, def: 20, unit: '',
        help: 'For rooms opened after the change.'
    },
    'rooms.per_tv_per_hour': {
        group: 'Room limits', label: 'Party rooms a TV can open per hour', min: 5, max: 100, step: 1, def: 30, unit: ''
    },
    'solo.rounds_per_tv_per_hour': {
        group: 'Room limits', label: 'Solo rounds a TV can start per hour', min: 10, max: 200, step: 1, def: 60, unit: ''
    }
});

const BANKS = Object.freeze({
    practice: 'Practice questions',
    classic: 'Classic questions',
    tournament: 'Tournament questions',
    categories: 'Party categories'
});
// Also used in games played for cash. Fine for testing; the page says so.
const CASH_BANKS = ['classic', 'tournament'];

const LISTS = Object.freeze({
    'party.categories_off': { def: [] },
    'solo.play_now_source': { def: { bank: 'practice', categories: [] } }
});

class TvSettingsService {

    constructor() {
        this._cache = null;
        this._at = 0;
    }

    /** Every stored value, refreshed at most every 15 seconds. Never throws. */
    async _stored() {
        if (this._cache && Date.now() - this._at < REFRESH_MS) return this._cache;
        try {
            await tvAuth.ensureSchema();
            const r = await pool.query(`SELECT key, value, updated_at, updated_by FROM tv_settings`);
            const map = new Map();
            for (const row of r.rows) map.set(row.key, row);
            this._cache = map;
            this._at = Date.now();
        } catch (e) {
            // The database is down: keep the last known values, or the defaults.
            logger.error(`TV settings could not be read: ${e.message}`);
            if (!this._cache) this._cache = new Map();
        }
        return this._cache;
    }

    _number(key, row) {
        const d = NUMBERS[key];
        const v = row ? Number(row.value) : NaN;
        return Number.isFinite(v) && v >= d.min && v <= d.max ? v : d.def;
    }

    /** All values, with defaults where nothing is stored. What the engines use. */
    async values() {
        const stored = await this._stored();
        const out = {};
        for (const key of Object.keys(NUMBERS)) out[key] = this._number(key, stored.get(key));
        out['party.categories_off'] = this._categoriesOff(stored.get('party.categories_off'));
        out['solo.play_now_source'] = this._source(stored.get('solo.play_now_source'));
        return out;
    }

    _categoriesOff(row) {
        const v = row && row.value;
        return Array.isArray(v) ? v.map(c => String(c).toLowerCase()) : [];
    }

    _source(row) {
        const v = row && row.value;
        if (!v || !BANKS[v.bank]) return { bank: 'practice', categories: [] };
        return { bank: v.bank, categories: Array.isArray(v.categories) ? v.categories.map(c => String(c).toLowerCase()) : [] };
    }

    // ============================================
    // CHANGING THEM (the admin page)
    // ============================================

    async _write(key, value, admin) {
        await tvAuth.ensureSchema();
        await pool.query(
            `INSERT INTO tv_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, NOW(), $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
            [key, JSON.stringify(value), admin || null]
        );
        this._cache = null; // this process sees it at once; others within 15 seconds
    }

    /** One number. Refused, with the reason, if it is outside its limits. */
    async setNumber(key, raw, admin) {
        const d = NUMBERS[key];
        if (!d) return { ok: false, error: 'Unknown setting' };
        const v = Number(raw);
        if (!Number.isFinite(v)) return { ok: false, error: 'Enter a number' };
        if (v < d.min || v > d.max) return { ok: false, error: `Must be between ${d.min} and ${d.max}` };
        if (Math.round((v - d.min) / d.step) * d.step + d.min !== v) return { ok: false, error: `Use steps of ${d.step}` };
        await this._write(key, v, admin);
        return { ok: true, key, value: v };
    }

    /** Back to the built-in default: the row goes. */
    async reset(key, admin) {
        if (!NUMBERS[key] && !LISTS[key]) return { ok: false, error: 'Unknown setting' };
        await tvAuth.ensureSchema();
        await pool.query(`DELETE FROM tv_settings WHERE key = $1`, [key]);
        this._cache = null;
        logger.info(`TV setting ${key} reset to default by ${admin || 'admin'}`);
        return { ok: true, key };
    }

    /** Switches one Party category on or off. `known` is every category the bank has. */
    async setCategory(category, on, known, admin) {
        const c = String(category || '').trim().toLowerCase();
        if (!c || !known.includes(c)) return { ok: false, error: 'Unknown category' };
        const off = new Set((await this.values())['party.categories_off']);
        if (on) off.delete(c); else off.add(c);
        await this._write('party.categories_off', [...off].sort(), admin);
        return { ok: true, category: c, on: !!on };
    }

    /** Where Solo Mode's (Play Now's) questions come from. `ready` is the categories that can fill a round. */
    async setSource(bank, categories, ready, admin) {
        if (!BANKS[bank]) return { ok: false, error: 'Unknown question source' };
        let cats = [];
        if (bank === 'categories') {
            cats = [...new Set((Array.isArray(categories) ? categories : []).map(c => String(c).trim().toLowerCase()).filter(Boolean))];
            if (!cats.length) return { ok: false, error: 'Pick at least one category' };
            if (!cats.every(c => ready.includes(c))) return { ok: false, error: 'Every category must be one the bank can fill' };
        }
        await this._write('solo.play_now_source', { bank, categories: cats }, admin);
        return { ok: true, bank, categories: cats };
    }

    /** Everything the admin page shows: each setting, its limits, its value and who last changed it. */
    async describe() {
        const stored = await this._stored();
        const values = await this.values();
        const numbers = Object.entries(NUMBERS).map(([key, d]) => {
            const row = stored.get(key);
            return {
                key, ...d, value: values[key], isDefault: !row,
                updatedAt: row ? row.updated_at : null, updatedBy: row ? row.updated_by : null
            };
        });
        const src = stored.get('solo.play_now_source');
        return {
            numbers,
            categoriesOff: values['party.categories_off'],
            playNow: {
                ...values['solo.play_now_source'],
                banks: Object.entries(BANKS).map(([id, label]) => ({ id, label, cash: CASH_BANKS.includes(id) })),
                updatedAt: src ? src.updated_at : null, updatedBy: src ? src.updated_by : null
            },
            refreshSeconds: REFRESH_MS / 1000
        };
    }

    /** For tests and after a write elsewhere. */
    forget() { this._cache = null; }
}

module.exports = new TvSettingsService();
module.exports.NUMBERS = NUMBERS;
module.exports.BANKS = BANKS;
module.exports.CASH_BANKS = CASH_BANKS;
module.exports.REFRESH_MS = REFRESH_MS;
