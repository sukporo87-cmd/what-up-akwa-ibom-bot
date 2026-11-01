// ============================================================
// FILE: src/utils/lagos-time.js
// Tournament times are typed, shown and enforced in LAGOS time (WAT).
//
// The database keeps them in UTC, like every other time it stores: the
// start_date / end_date columns hold no time zone, and the database clock
// is UTC, so a stored 07:00 means 7am UTC = 8am in Lagos. The admin forms
// used to save what was typed as if it were UTC, which is why typing 7am
// gave an 8am start. Now:
//
//   typed in the dashboard   8:00   (Lagos)
//   stored                   07:00  (UTC)          toDbUtc()
//   shown everywhere         8:00am (Lagos)        formatLagos(), toLagosInput()
//
// Nigeria is UTC+1 all year round (no daylight saving), so the offset is a
// constant. Existing tournaments need no change: they were already stored
// in UTC, by typing the hour before.
// ============================================================
'use strict';

const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/**
 * What an admin typed -> the moment it means.
 *   "2026-11-06T08:00"           Lagos wall time (what a datetime-local box sends)
 *   "2026-11-06T07:00:00.000Z"   an exact moment (kept as is)
 * Returns a Date, or null if it is not a date at all.
 */
function parseAdminTime(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return isNaN(value) ? null : value;
    const s = String(value).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
        const [, y, mo, d, h, mi, se] = m.map(Number);
        if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
        const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se || 0) - LAGOS_OFFSET_MS);
        return isNaN(t) ? null : t;
    }
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
        const t = new Date(s);
        return isNaN(t) ? null : t;
    }
    return null;
}

/** A moment -> "YYYY-MM-DD HH:MM:SS" in UTC, for the zone-less timestamp columns. */
function toDbUtc(value) {
    const t = parseAdminTime(value);
    if (!t) return null;
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
           `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

/** A moment -> "YYYY-MM-DDTHH:MM" Lagos wall time, for a datetime-local box. */
function toLagosInput(date) {
    const t = new Date(new Date(date).getTime() + LAGOS_OFFSET_MS);
    if (isNaN(t)) return '';
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

/**
 * A moment -> how players read it, in Lagos time.
 *   formatLagos(d)                    "Fri 6 Nov, 8:00am"
 *   formatLagos(d, { year: true })    "Fri 6 Nov 2026, 8:00am"
 *   formatLagos(d, { time: false })   "Fri 6 Nov"
 *   formatLagos(d, { date: false })   "8:00am"
 */
function formatLagos(date, { time = true, date: withDate = true, year = false } = {}) {
    const t = new Date(new Date(date).getTime() + LAGOS_OFFSET_MS);
    if (isNaN(t)) return '';
    const h = t.getUTCHours();
    const clock = `${h % 12 || 12}:${pad(t.getUTCMinutes())}${h < 12 ? 'am' : 'pm'}`;
    const day = `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}${year ? ' ' + t.getUTCFullYear() : ''}`;
    if (!withDate) return clock;
    return time ? `${day}, ${clock}` : day;
}

module.exports = { parseAdminTime, toDbUtc, toLagosInput, formatLagos, LAGOS_OFFSET_MS };
