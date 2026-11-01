// ============================================================
// FILE: src/services/location.service.js
// Where players are, from the city they typed at sign-up.
//
// NOTHING A PLAYER TYPED IS CHANGED. users.city stays exactly as entered.
// The tidy version lives beside it in user_locations, one row per player:
// country, state (or region abroad), city, and how sure we are.
//
//   matched       placed by the rules in utils/ng-places.js
//   manual        placed by an admin decision (location_aliases)
//   country_only  "Nigeria" and nothing more
//   ambiguous     a name that belongs to more than one place ("Karu")
//   unmatched     nothing recognisable ("my house", "123")
//   empty         no city given (e.g. a Google sign-up not finished)
//
// An admin decision is stored against the squashed text ("karu"), so it
// applies at once to every player who typed it, and to every future player
// who types it. Both tables are created on first use.
// ============================================================
'use strict';

const pool = require('../config/database');
const { logger } = require('../utils/logger');
const places = require('../utils/ng-places');

let ready = null;
function ensureSchema() {
    if (!ready) {
        ready = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS user_locations (
                    user_id      INTEGER PRIMARY KEY,
                    raw_city     TEXT,
                    raw_key      TEXT,
                    country      TEXT,
                    state        TEXT,
                    city         TEXT,
                    status       TEXT NOT NULL,
                    method       TEXT,
                    resolved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_locations_key ON user_locations (raw_key)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_locations_place ON user_locations (country, state)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_locations_status ON user_locations (status)`);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS location_aliases (
                    raw_key      TEXT PRIMARY KEY,
                    raw_example  TEXT,
                    country      TEXT,
                    state        TEXT,
                    city         TEXT,
                    is_unknown   BOOLEAN NOT NULL DEFAULT false,
                    decided_by   TEXT,
                    decided_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`);
        })().catch(err => { ready = null; throw err; });
    }
    return ready;
}

async function loadAliases() {
    const r = await pool.query(`SELECT raw_key, country, state, city, is_unknown FROM location_aliases`);
    return new Map(r.rows.map(a => [a.raw_key, a]));
}

/** The tidy place for one piece of text. An admin decision beats the rules. */
function resolveText(raw, aliases) {
    const text = raw == null ? '' : String(raw).trim();
    if (!text) return { raw_key: '', country: null, state: null, city: null, status: 'empty', method: 'empty' };
    const key = places.squash(text);
    const alias = aliases && aliases.get(key);
    if (alias) {
        return alias.is_unknown
            ? { raw_key: key, country: null, state: null, city: null, status: 'manual', method: 'admin_unknown' }
            : { raw_key: key, country: alias.country, state: alias.state, city: alias.city, status: 'manual', method: 'admin' };
    }
    const r = places.resolvePlace(text);
    return { raw_key: key, country: r.country, state: r.state, city: r.city, status: r.status, method: r.method };
}

async function upsertMany(rows) {
    if (!rows.length) return;
    const col = (k) => rows.map(r => (r[k] === undefined ? null : r[k]));
    await pool.query(`
        INSERT INTO user_locations (user_id, raw_city, raw_key, country, state, city, status, method, resolved_at)
        SELECT * , NOW() FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
        ON CONFLICT (user_id) DO UPDATE SET
            raw_city = EXCLUDED.raw_city, raw_key = EXCLUDED.raw_key, country = EXCLUDED.country,
            state = EXCLUDED.state, city = EXCLUDED.city, status = EXCLUDED.status,
            method = EXCLUDED.method, resolved_at = NOW()
    `, [col('user_id'), col('raw_city'), col('raw_key'), col('country'), col('state'), col('city'), col('status'), col('method')]);
}

/**
 * Places one player. Called after sign-up and after a profile is finished;
 * never throws, never delays the sign-up.
 */
async function resolveUser(userId, rawCity) {
    try {
        if (!userId) return;
        await ensureSchema();
        const aliases = await loadAliases();
        const r = resolveText(rawCity, aliases);
        await upsertMany([{ user_id: userId, raw_city: rawCity == null ? null : String(rawCity), ...r }]);
    } catch (error) {
        logger.warn(`Could not place user ${userId}: ${error.message}`);
    }
}

/**
 * Brings user_locations up to date: every player without a row, and every
 * player whose city has changed since they were placed. The first call after
 * deploy is the clean-up of every existing player. Cheap when nothing changed.
 */
async function syncMissing({ batch = 2000, maxBatches = 50 } = {}) {
    await ensureSchema();
    const aliases = await loadAliases();
    let done = 0;
    for (let i = 0; i < maxBatches; i++) {
        const r = await pool.query(`
            SELECT u.id, u.city FROM users u
            LEFT JOIN user_locations l ON l.user_id = u.id
            WHERE l.user_id IS NULL OR l.raw_city IS DISTINCT FROM u.city
            ORDER BY u.id LIMIT $1`, [batch]);
        if (!r.rows.length) break;
        await upsertMany(r.rows.map(u => ({ user_id: u.id, raw_city: u.city, ...resolveText(u.city, aliases) })));
        done += r.rows.length;
        if (r.rows.length < batch) break;
    }
    if (done) logger.info(`📍 Placed ${done} player(s) by location`);
    return done;
}

/** Places everyone again from scratch (after the rules improve). Admin decisions still win. */
async function rerunAll() {
    await ensureSchema();
    await pool.query(`UPDATE user_locations SET raw_city = NULL WHERE raw_city IS NOT NULL`);
    return syncMissing({ maxBatches: 500 });
}

/** An admin decides what one piece of text means. Applies to everyone who typed it. */
async function decide(rawKey, { country, state, city, unknown }, decidedBy) {
    await ensureSchema();
    const key = places.squash(rawKey);
    if (!key) throw new Error('Nothing to decide');
    const isUnknown = !!unknown;
    let c = isUnknown ? null : (country || 'Nigeria').trim();
    let s = isUnknown ? null : (state ? String(state).trim() : null);
    const t = isUnknown ? null : (city ? String(city).trim().slice(0, 80) : null);
    if (!isUnknown) {
        if (c === 'Nigeria') {
            if (!s || !places.NIGERIAN_STATES.includes(s)) throw new Error('Choose a Nigerian state');
        } else if (!c) throw new Error('Choose a state, or enter a country');
        if (s) s = s.slice(0, 80);
        c = c.slice(0, 80);
    }
    const ex = await pool.query(`SELECT raw_city FROM user_locations WHERE raw_key = $1 LIMIT 1`, [key]);
    await pool.query(`
        INSERT INTO location_aliases (raw_key, raw_example, country, state, city, is_unknown, decided_by, decided_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (raw_key) DO UPDATE SET country = EXCLUDED.country, state = EXCLUDED.state, city = EXCLUDED.city,
            is_unknown = EXCLUDED.is_unknown, decided_by = EXCLUDED.decided_by, decided_at = NOW()
    `, [key, ex.rows[0] ? ex.rows[0].raw_city : rawKey, c, s, t, isUnknown, decidedBy || 'admin']);
    const upd = await pool.query(`
        UPDATE user_locations SET country = $2, state = $3, city = $4, status = 'manual',
            method = $5, resolved_at = NOW()
        WHERE raw_key = $1
    `, [key, c, s, t, isUnknown ? 'admin_unknown' : 'admin']);
    return { players: upd.rowCount };
}

/** Takes back an admin decision; those players go back to the rules. */
async function undoDecision(rawKey) {
    await ensureSchema();
    const key = places.squash(rawKey);
    await pool.query(`DELETE FROM location_aliases WHERE raw_key = $1`, [key]);
    await pool.query(`UPDATE user_locations SET raw_city = NULL WHERE raw_key = $1`, [key]);
    await syncMissing();
}

// Beside a town name, FCT needs no "(Abuja)": "Gwarinpa, FCT", not "Gwarinpa, FCT (Abuja)".
const withTownLabel = (state) => (state === 'FCT' ? 'FCT' : places.stateLabel(state));

const topN = (rows, groupKey, n = 3) => {
    const out = {};
    for (const r of rows) {
        const g = r[groupKey];
        (out[g] = out[g] || []);
        if (out[g].length < n) out[g].push(r);
    }
    return out;
};

/** Everything the "Where players are" card shows. */
async function summary() {
    await syncMissing();

    const totals = await pool.query(`
        SELECT
            COUNT(*)::int                                                                    AS players,
            COUNT(*) FILTER (WHERE country = 'Nigeria' AND state IS NOT NULL)::int           AS nigeria_placed,
            COUNT(*) FILTER (WHERE country = 'Nigeria' AND state IS NULL)::int               AS nigeria_no_state,
            COUNT(*) FILTER (WHERE country IS NOT NULL AND country <> 'Nigeria')::int        AS abroad,
            COUNT(*) FILTER (WHERE status IN ('ambiguous', 'unmatched'))::int                AS needs_review,
            COUNT(*) FILTER (WHERE status = 'manual' AND country IS NULL)::int               AS marked_unknown,
            COUNT(*) FILTER (WHERE status = 'empty')::int                                    AS not_given
        FROM user_locations`);

    const states = await pool.query(`
        SELECT l.state,
               COUNT(*)::int                                                         AS players,
               COALESCE(SUM(u.total_games_played), 0)::int                           AS games,
               COALESCE(SUM(u.total_winnings), 0)::numeric                           AS winnings,
               COUNT(*) FILTER (WHERE u.last_active > NOW() - INTERVAL '30 days')::int AS active_30d,
               COUNT(*) FILTER (WHERE u.created_at > NOW() - INTERVAL '30 days')::int  AS joined_30d
        FROM user_locations l JOIN users u ON u.id = l.user_id
        WHERE l.country = 'Nigeria' AND l.state IS NOT NULL
        GROUP BY l.state ORDER BY players DESC, l.state`);

    const ngCities = await pool.query(`
        SELECT state, city, COUNT(*)::int AS players FROM user_locations
        WHERE country = 'Nigeria' AND state IS NOT NULL AND city IS NOT NULL
        GROUP BY state, city ORDER BY state, players DESC, city`);

    const countries = await pool.query(`
        SELECT l.country,
               COUNT(*)::int                                                         AS players,
               COALESCE(SUM(u.total_games_played), 0)::int                           AS games,
               COUNT(*) FILTER (WHERE u.last_active > NOW() - INTERVAL '30 days')::int AS active_30d
        FROM user_locations l JOIN users u ON u.id = l.user_id
        WHERE l.country IS NOT NULL AND l.country <> 'Nigeria'
        GROUP BY l.country ORDER BY players DESC, l.country`);

    const abroadCities = await pool.query(`
        SELECT country, city, state, COUNT(*)::int AS players FROM user_locations
        WHERE country IS NOT NULL AND country <> 'Nigeria' AND (city IS NOT NULL OR state IS NOT NULL)
        GROUP BY country, city, state ORDER BY country, players DESC`);

    // Every city, at home and abroad, most players first: the city donut.
    const allCities = await pool.query(`
        SELECT city, state, country, COUNT(*)::int AS players FROM user_locations
        WHERE city IS NOT NULL
        GROUP BY city, state, country ORDER BY players DESC, city LIMIT 60`);
    const citiesTotal = await pool.query(`SELECT COUNT(*)::int AS n FROM user_locations WHERE city IS NOT NULL`);

    const cityTop = topN(ngCities.rows, 'state');
    const abroadTop = topN(abroadCities.rows, 'country');
    return {
        totals: totals.rows[0],
        states: states.rows.map(s => ({
            state: s.state, label: places.stateLabel(s.state), players: s.players, games: s.games,
            winnings: Number(s.winnings), active30d: s.active_30d, joined30d: s.joined_30d,
            topCities: (cityTop[s.state] || []).map(c => ({ city: c.city, players: c.players }))
        })),
        cities: allCities.rows.map(c => ({
            city: c.city, players: c.players,
            where: c.country === 'Nigeria' ? withTownLabel(c.state) : c.country
        })),
        citiesTotal: citiesTotal.rows[0].n,
        countries: countries.rows.map(c => ({
            country: c.country, players: c.players, games: c.games, active30d: c.active_30d,
            topCities: (abroadTop[c.country] || []).map(x => ({ city: [x.city, x.state].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '), players: x.players }))
        }))
    };
}

/** Texts the rules could not place, most players first, with suggestions. */
async function reviewList(limit = 150) {
    await ensureSchema();
    const r = await pool.query(`
        SELECT raw_key, MIN(raw_city) AS example, COUNT(*)::int AS players, MIN(status) AS status
        FROM user_locations
        WHERE status IN ('ambiguous', 'unmatched') AND raw_key <> ''
        GROUP BY raw_key ORDER BY players DESC, raw_key LIMIT $1`, [limit]);
    return r.rows.map(row => {
        const res = places.resolvePlace(row.example);
        const fromRules = (res.candidates || []).map(c => ({
            country: c.country || 'Nigeria', state: c.state || null,
            city: c.name && c.name.includes('(') ? c.name.replace(/\s*\(.*$/, '') : null
        }));
        const near = places.suggestPlaces(row.example, 3).map(s => ({ country: s.country, state: s.state, city: s.city }));
        // One button per distinct place, labelled the same way every time.
        const seen = new Set();
        const suggestions = [...fromRules, ...near]
            .filter(s => { const k = `${s.country}|${s.state}|${s.city}`; return !seen.has(k) && seen.add(k); })
            .slice(0, 4)
            .map(s => ({ ...s, label: s.country !== 'Nigeria'
                ? [s.city, s.state, s.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ')
                : [s.city, places.stateLabel(s.state)].filter(Boolean).join(', ') }));
        return { key: row.raw_key, example: row.example, players: row.players, status: row.status, suggestions };
    });
}

// Country from the start of a WhatsApp number (Telegram and web players have
// no number). Longest code first, so 234 is Nigeria, not "2".
const DIAL = { '234': 'Nigeria', '233': 'Ghana', '229': 'Benin', '228': 'Togo', '237': 'Cameroon', '227': 'Niger',
    '235': 'Chad', '221': 'Senegal', '225': "Côte d'Ivoire", '231': 'Liberia', '232': 'Sierra Leone', '220': 'Gambia',
    '254': 'Kenya', '256': 'Uganda', '255': 'Tanzania', '250': 'Rwanda', '251': 'Ethiopia', '27': 'South Africa',
    '260': 'Zambia', '263': 'Zimbabwe', '20': 'Egypt', '212': 'Morocco', '44': 'United Kingdom', '353': 'Ireland',
    '1': 'United States / Canada', '971': 'United Arab Emirates', '974': 'Qatar', '966': 'Saudi Arabia', '965': 'Kuwait',
    '968': 'Oman', '973': 'Bahrain', '90': 'Turkey', '49': 'Germany', '33': 'France', '31': 'Netherlands', '32': 'Belgium',
    '39': 'Italy', '34': 'Spain', '351': 'Portugal', '41': 'Switzerland', '43': 'Austria', '46': 'Sweden', '47': 'Norway',
    '45': 'Denmark', '358': 'Finland', '48': 'Poland', '7': 'Russia', '380': 'Ukraine', '357': 'Cyprus', '30': 'Greece',
    '86': 'China', '81': 'Japan', '82': 'South Korea', '91': 'India', '92': 'Pakistan', '60': 'Malaysia', '65': 'Singapore',
    '61': 'Australia', '64': 'New Zealand', '55': 'Brazil' };
function phoneCountry(phone) {
    const d = String(phone || '');
    if (!/^\d{8,15}$/.test(d)) return null;
    for (const len of [3, 2, 1]) if (DIAL[d.slice(0, len)]) return DIAL[d.slice(0, len)];
    return null;
}

/**
 * The players behind one review entry, with what can hint at where they are:
 * full name, phone country code, email, who referred them (and where that
 * player is), how they found us. Up to 50, most recently active first.
 */
async function playersForKey(rawKey) {
    await ensureSchema();
    const key = places.squash(rawKey);
    if (!key) return [];
    const r = await pool.query(`
        SELECT u.id, u.username, u.full_name, u.phone_number, u.email, u.age, u.city,
               u.created_at, u.last_active, u.total_games_played, u.total_winnings, u.acquisition_source,
               r.username AS referrer_username,
               rl.city AS referrer_city, rl.state AS referrer_state, rl.country AS referrer_country
        FROM user_locations l
        JOIN users u ON u.id = l.user_id
        LEFT JOIN users r ON r.id = u.referred_by
        LEFT JOIN user_locations rl ON rl.user_id = r.id
        WHERE l.raw_key = $1
        ORDER BY u.last_active DESC NULLS LAST, u.id DESC
        LIMIT 50`, [key]);
    return r.rows.map(u => {
        const id = String(u.phone_number || '');
        const platform = id.startsWith('tg_') ? 'telegram' : id.startsWith('web_') ? 'web' : 'whatsapp';
        const refWhere = u.referrer_username
            ? [u.referrer_city, u.referrer_country === 'Nigeria' ? (u.referrer_city ? withTownLabel(u.referrer_state) : places.stateLabel(u.referrer_state)) : (u.referrer_state || null), u.referrer_country !== 'Nigeria' ? u.referrer_country : null]
                .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ') || null
            : null;
        return {
            id: u.id, username: u.username, fullName: u.full_name, platform,
            playerId: id, phoneCountry: platform === 'whatsapp' ? phoneCountry(id) : null,
            email: u.email || null, age: u.age || null, typed: u.city,
            joined: u.created_at, lastActive: u.last_active,
            games: Number(u.total_games_played || 0), winnings: Number(u.total_winnings || 0),
            foundUsVia: u.acquisition_source || null,
            referrer: u.referrer_username ? { username: u.referrer_username, where: refWhere } : null
        };
    });
}

/** Admin decisions so far, so any can be checked or taken back. */
async function decisions() {
    await ensureSchema();
    const r = await pool.query(`
        SELECT a.raw_key, a.raw_example, a.country, a.state, a.city, a.is_unknown, a.decided_by, a.decided_at,
               (SELECT COUNT(*)::int FROM user_locations l WHERE l.raw_key = a.raw_key) AS players
        FROM location_aliases a ORDER BY a.decided_at DESC LIMIT 300`);
    return r.rows;
}

module.exports = {
    ensureSchema, resolveText, resolveUser, syncMissing, rerunAll, decide, undoDecision,
    summary, reviewList, decisions, playersForKey, phoneCountry, NIGERIAN_STATES: places.NIGERIAN_STATES, stateLabel: places.stateLabel
};
