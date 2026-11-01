// ============================================================
// FILE: src/services/app-install.service.js
// How many people have put the web app on their home screen.
//
// Browsers do not tell a website it has been installed, except one event on
// Android/desktop Chrome, and nothing at all on iPhones. So installs are
// counted from what the page CAN see, per device (a random id the page keeps
// in its own storage, no personal data):
//
//   prompt_shown      the Install card was shown with an Install button
//   ios_hint_shown    the "Share -> Add to Home Screen" card was shown (iPhone)
//   install_click     the Install button was tapped
//   install_choice    the browser's own dialog: outcome 'accepted' / 'dismissed'
//   installed         the browser confirmed the install (Android/desktop)
//   opened_installed  the page was opened FROM the home-screen icon
//
// "opened_installed" is the one that works everywhere, iPhones included, and
// it also catches everyone who installed before this was deployed, the first
// time they open the app. Uninstalls are invisible to any website.
//
// One row per device, per event, per day: repeats the same day are ignored,
// so a refresh loop cannot inflate the numbers.
// ============================================================
'use strict';

const pool = require('../config/database');
const { logger } = require('../utils/logger');

const EVENTS = new Set(['prompt_shown', 'ios_hint_shown', 'install_click', 'install_choice', 'installed', 'opened_installed']);
const OUTCOMES = new Set(['accepted', 'dismissed']);

let ready = null;
function ensureSchema() {
    if (!ready) {
        ready = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS app_install_events (
                    id          SERIAL PRIMARY KEY,
                    device_id   TEXT NOT NULL,
                    user_id     INTEGER,
                    event       TEXT NOT NULL,
                    outcome     TEXT,
                    platform    TEXT,
                    day         DATE NOT NULL DEFAULT CURRENT_DATE,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (device_id, event, day)
                )`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_app_install_event_day ON app_install_events (event, day)`);
        })().catch(err => { ready = null; throw err; });
    }
    return ready;
}

/** Android, iPhone/iPad, desktop or other, from the browser's user agent. */
function platformOf(ua) {
    const s = String(ua || '');
    if (/iPad|iPhone|iPod/i.test(s)) return 'ios';
    if (/Android/i.test(s)) return 'android';
    if (/Windows|Macintosh|Linux|CrOS/i.test(s)) return 'desktop';
    return 'other';
}

async function record({ deviceId, event, outcome, userId, userAgent }) {
    if (!/^[a-z0-9]{12,40}$/.test(String(deviceId || ''))) return { ok: false, reason: 'bad device' };
    if (!EVENTS.has(event)) return { ok: false, reason: 'bad event' };
    const out = event === 'install_choice' && OUTCOMES.has(outcome) ? outcome : null;
    if (event === 'install_choice' && !out) return { ok: false, reason: 'bad outcome' };
    try {
        await ensureSchema();
        await pool.query(`
            INSERT INTO app_install_events (device_id, user_id, event, outcome, platform)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (device_id, event, day) DO UPDATE
                SET user_id = COALESCE(app_install_events.user_id, EXCLUDED.user_id),
                    outcome = COALESCE(EXCLUDED.outcome, app_install_events.outcome)
        `, [deviceId, userId || null, event, out, platformOf(userAgent)]);
        return { ok: true };
    } catch (error) {
        logger.warn(`Install event not recorded: ${error.message}`);
        return { ok: false, reason: 'not recorded' };
    }
}

/** Everything the "Web app installs" card shows. */
async function stats() {
    await ensureSchema();
    // A device counts as installed once any of these has happened to it.
    const INSTALLED = `(event IN ('installed', 'opened_installed') OR (event = 'install_choice' AND outcome = 'accepted'))`;

    const head = await pool.query(`
        WITH first_install AS (
            SELECT device_id, MIN(day) AS first_day,
                   (ARRAY_AGG(platform ORDER BY created_at))[1] AS platform
            FROM app_install_events WHERE ${INSTALLED} GROUP BY device_id
        )
        SELECT
            (SELECT COUNT(*) FROM first_install)::int                                                   AS installed_devices,
            (SELECT COUNT(*) FROM first_install WHERE first_day > CURRENT_DATE - 7)::int                AS new_7d,
            (SELECT COUNT(*) FROM first_install WHERE first_day > CURRENT_DATE - 30)::int               AS new_30d,
            (SELECT COUNT(DISTINCT device_id) FROM app_install_events
              WHERE event = 'opened_installed' AND day > CURRENT_DATE - 7)::int                        AS opened_7d,
            (SELECT COUNT(DISTINCT device_id) FROM app_install_events
              WHERE event = 'opened_installed' AND day > CURRENT_DATE - 30)::int                       AS opened_30d,
            (SELECT COUNT(DISTINCT user_id) FROM app_install_events
              WHERE ${INSTALLED} AND user_id IS NOT NULL)::int                                          AS installed_players
    `);

    const byPlatform = await pool.query(`
        WITH first_install AS (
            SELECT device_id, (ARRAY_AGG(platform ORDER BY created_at))[1] AS platform
            FROM app_install_events WHERE ${INSTALLED} GROUP BY device_id
        )
        SELECT COALESCE(platform, 'other') AS platform, COUNT(*)::int AS devices
        FROM first_install GROUP BY 1 ORDER BY devices DESC`);

    // The Install button's own funnel (Android/desktop), last 30 days.
    const funnel = await pool.query(`
        SELECT
            COUNT(DISTINCT device_id) FILTER (WHERE event = 'prompt_shown')::int                         AS shown,
            COUNT(DISTINCT device_id) FILTER (WHERE event = 'install_click')::int                        AS clicked,
            COUNT(DISTINCT device_id) FILTER (WHERE event = 'install_choice' AND outcome = 'accepted')::int  AS accepted,
            COUNT(DISTINCT device_id) FILTER (WHERE event = 'install_choice' AND outcome = 'dismissed')::int AS dismissed,
            COUNT(DISTINCT device_id) FILTER (WHERE event = 'ios_hint_shown')::int                       AS ios_hint
        FROM app_install_events WHERE day > CURRENT_DATE - 30`);

    const daily = await pool.query(`
        WITH first_install AS (
            SELECT device_id, MIN(day) AS first_day FROM app_install_events WHERE ${INSTALLED} GROUP BY device_id
        ),
        days AS (SELECT generate_series(CURRENT_DATE - 29, CURRENT_DATE, INTERVAL '1 day')::date AS day)
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COUNT(f.device_id)::int AS installs
        FROM days d LEFT JOIN first_install f ON f.first_day = d.day
        GROUP BY d.day ORDER BY d.day`);

    const since = await pool.query(`SELECT to_char(MIN(day), 'YYYY-MM-DD') AS since FROM app_install_events`);

    return {
        ...head.rows[0],
        byPlatform: byPlatform.rows,
        funnel30d: funnel.rows[0],
        daily: daily.rows,
        countingSince: since.rows[0].since
    };
}

module.exports = { ensureSchema, record, stats, platformOf, EVENTS };
