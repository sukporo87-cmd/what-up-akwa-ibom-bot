// ============================================
// FILE: src/services/tv-live-round.service.js
// WUT TV, phase 7 — Live Rounds and the Brand Cup (decided Nov 18, 2026).
//
// A LIVE ROUND is one ranked round at a set time, played on every TV in a
// campaign's area at once. Each TV is its own Party room, as today, but every
// room gets the same questions, in the same order, on the same clock, and the
// players are ranked across all the rooms together. A BRAND CUP is a set of
// Live Rounds in stages: qualifiers, then each stage takes the ones who went
// through from the stage before, down to the final.
//
// THE ROUND, IN TIME (Lagos time, as typed on the admin page):
//   * 15 minutes before: the lobby opens. The question set is chosen now, so
//     nobody has seen it in the brand's everyday party beforehand. Any TV
//     that can show the campaign can open a room for the round.
//   * 1 minute before: entry closes. Who is ranked is decided here, for every
//     room at once (decide, below), and every room is started with the same
//     plan: the moment question 1 appears, the clock, the questions.
//   * The round. tv-party.service plays each room in step: no question ends
//     early because everyone has answered, there is no 50:50, and each room
//     shows the answers in its own order, so a letter shouted from one house
//     to the next is no help.
//   * The number question. If the round has one, every ranked player types a
//     number at the end. It only ever separates players with exactly the same
//     right answers and time.
//   * Ranking. Once the last room has finished (or a few minutes after the
//     round should have ended), every ranked player gets a place across the
//     area. In a cup, the top ones go through and the next few are reserves.
//   * The dispute window (the campaign's, 24 to 72 hours): results show on a
//     public page and any player who played can question them. Results become
//     final once the window has closed and every question has an answer. Only
//     then are prizes made, through tv-campaign-prize (029), from the money
//     the brand paid in.
//
// WHO IS RANKED. Everyone in a lobby when entry closes plays. A player is
// ranked unless one of these says not, in this order (the reason is kept and
// shown on their phone):
//   1. where they are: the TV's place (from its internet address) and the
//      place they typed must agree, and be in the campaign's area
//   2. the cup: in a qualifier, not already through from an earlier one; in a
//      later stage, through from the stage before (or a reserve needed in
//      place of someone who did not come)
//   3. a venue final: only the venue's TVs
//   4. one per TV, when the round says so: the best-placed from the stage
//      before keeps it
// Everyone else plays for fun, unranked: same questions, same TV.
//
// FAIRNESS IS ON THE SERVER. Who is ranked, the clock, every answer and its
// time, the order of the places: all decided here and in tv-party.service.
// A phone only ever says which letter and which number.
//
// MORE THAN ONE SERVER. Room timers live in the server that runs them (as
// all of WUT TV does today), so this runs on one server. The start and the
// ranking of a round also take a Redis lock, so a second server could never
// start or rank the same round twice.
// ============================================

const crypto = require('crypto');
const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const tvAuth = require('./tv-auth.service');
const store = require('./tv-room-store.service');
const tvSettings = require('./tv-settings.service');
const { NIGERIAN_STATES } = require('../utils/ng-places');
const { parseAdminTime } = require('../utils/lagos-time');
const QuestionService = require('./question.service');

// Loaded when first used: these files load this one.
const party = () => require('./tv-party.service');
const campaigns = () => require('./tv-campaign.service');
const prizes = () => require('./tv-campaign-prize.service');

const questionService = new QuestionService();

const MIN = 60 * 1000;
const LOBBY_OPENS_MS = 15 * MIN;            // the lobby opens this long before the start
const ENTRY_CLOSES_MS = 60 * 1000;          // entry closes this long before the start
const MIN_LEAD_MS = 20 * MIN;               // a new round starts at least this far ahead
const MIN_GAP_MS = 60 * MIN;                // rounds of one campaign at least this far apart
const LATE_LIMIT_MS = 10 * MIN;             // a round the server missed by more than this fails
const TIEBREAK_MS = 20 * 1000;              // time to type the number
const RANK_AFTER_MS = 3 * MIN;              // rank this long after the round should have ended, whatever
const TICK_MS = 15 * 1000;
const BOARD_SHOWN = 100;
const DISPUTES_PER_PLAYER = 2;
const SET_SIZE = 15;                        // what the Challenge bank builds at once
const PUBLIC_CACHE_MS = 5000;               // the results page's shared part, kept this long

const KINDS = ['party', 'live', 'cup'];
const UNITS = ['none', 'city', 'state', 'country'];
const WHERE_FINAL = ['home', 'venue'];
const STATE_SET = new Map(NIGERIAN_STATES.map(s => [s.toLowerCase(), s]));

// Why a player is unranked, as their phone and the admin page say it.
const WHY = Object.freeze({
    outside_area: 'This TV, or the place you typed, is outside the area for this round',
    no_location: 'You did not say where you are',
    tv_unknown: 'We could not tell where this TV is',
    already_through: 'You are already through to the next stage',
    not_through: 'This stage is for the players who went through from the last one',
    not_venue: 'This round is ranked at the venue only',
    one_per_tv: 'One ranked player per TV in this round, and another player here was placed higher',
    reserve_not_needed: 'You are a reserve, and everyone who went through came to play',
    disqualified: 'Taken off the results by an admin'
});

const naira = n => '₦' + Number(n || 0).toLocaleString('en-NG');
const clean = (v, max) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, max) : null;
};
const intOrNull = v => (v === null || v === '' || v === undefined) ? null : Number(v);
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const isNigeria = c => /^(nigeria|ng|naija)$/i.test(String(c || '').trim());
const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
};

/**
 * fn over every item, at most `limit` at a time. Thousands of rooms start
 * in the same minute, and one after another would take too long.
 */
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}
const PARALLEL = 16;                        // rooms read or started at once (the database pool is 20)

/** "Lagos", "Lagos, Oyo", "Nigeria", "Ikeja, Lekki", "anywhere": the area in words. */
function areaLabel(c) {
    if (!c) return '';
    const unit = c.area_unit || 'state';
    if (unit === 'city' && (c.area_cities || []).length) return c.area_cities.join(', ');
    if (unit === 'country') return (c.area_countries || []).length ? c.area_countries.join(', ') : 'any country';
    if ((c.regions || []).length && c.audience === 'chosen') return c.regions.join(', ');
    if (c.audience === 'all') return unit === 'none' ? 'everywhere' : 'anywhere';
    return 'Nigeria';
}

class TvLiveRoundService {

    constructor() {
        /** @type {Map<number, NodeJS.Timeout>} the exact start of each round about to begin */
        this.timers = new Map();
        this._clock = null;
        this._ticks = 0;
    }

    // ============================================
    // READING
    // ============================================

    async _round(id) {
        const n = Number(id);
        if (!Number.isInteger(n) || n <= 0) return null;
        const r = await pool.query(`SELECT * FROM tv_live_rounds WHERE id = $1`, [n]);
        return r.rows[0] || null;
    }

    async _campaign(id) {
        const r = await pool.query(`SELECT * FROM tv_campaigns WHERE id = $1`, [Number(id)]);
        return r.rows[0] || null;
    }

    /** When the lobby opens and entry closes, in ms. */
    times(round) {
        const start = new Date(round.starts_at).getTime();
        return { start, lobbyOpens: start - LOBBY_OPENS_MS, entryCloses: start - ENTRY_CLOSES_MS };
    }

    /** How long a round runs from its first question to the end of the number question, in ms. */
    lengthMs(round, questionMs) {
        const P = party();
        const n = Number(round.questions) || SET_SIZE;
        const step = questionMs + P.ANSWER_GRACE_MS + P.REVEAL_PAUSE_MS;
        const cards = Math.floor((n - 1) / P.SPONSOR_EVERY) * P.SPONSOR_CARD_MS;
        return n * step + cards + (round.tiebreak_text ? TIEBREAK_MS + P.ANSWER_GRACE_MS : 0);
    }

    /** One round as the admin page shows it. */
    view(r, now = Date.now()) {
        const t = this.times(r);
        return {
            id: r.id, campaignId: r.campaign_id, name: r.name, stage: r.stage, startsAt: r.starts_at,
            lobbyOpensAt: new Date(t.lobbyOpens), entryClosesAt: new Date(t.entryCloses),
            questions: r.questions, tiebreakText: r.tiebreak_text,
            tiebreakAnswer: r.tiebreak_answer == null ? null : Number(r.tiebreak_answer),
            throughCount: r.through_count, stateQuota: r.state_quota, reserves: r.reserves,
            rankedPerTv: r.ranked_per_tv, venueTvs: r.venue_tvs || [],
            prizeRanks: Array.isArray(r.prize_ranks) ? r.prize_ranks : [],
            status: r.status, failReason: r.fail_reason,
            lobbyOpen: ['scheduled', 'open'].includes(r.status) && now >= t.lobbyOpens && now < t.entryCloses,
            startedAt: r.started_at, rankedAt: r.ranked_at, finalAt: r.final_at,
            resultsUrl: this.resultsUrl(r.id),
            createdBy: r.created_by, updatedBy: r.updated_by, updatedAt: r.updated_at
        };
    }

    resultsUrl(id) {
        return `${process.env.WEB_PLAY_URL || 'https://play.whatsuptrivia.com.ng'}/tv/live/${Number(id)}`;
    }

    // ============================================
    // THE ADMIN PAGE
    // ============================================

    async list(campaignId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `SELECT r.*,
                    (SELECT COUNT(*)::int FROM tv_live_entries e WHERE e.round_id = r.id) AS players,
                    (SELECT COUNT(*)::int FROM tv_live_entries e WHERE e.round_id = r.id AND e.ranked) AS ranked_players,
                    (SELECT COUNT(*)::int FROM tv_rooms m WHERE m.live_round_id = r.id) AS rooms,
                    (SELECT COUNT(*)::int FROM tv_live_disputes d WHERE d.round_id = r.id AND d.status = 'open') AS open_disputes
             FROM tv_live_rounds r WHERE r.campaign_id = $1 ORDER BY r.starts_at, r.id`,
            [Number(campaignId)]
        );
        const now = Date.now();
        return {
            ok: true,
            rounds: r.rows.map(x => ({ ...this.view(x, now), players: x.players, rankedPlayers: x.ranked_players, rooms: x.rooms, openDisputes: x.open_disputes }))
        };
    }

    /** Checks a round's fields; returns { set } of columns, or { error }. */
    async _fields(c, body, existing) {
        const set = {};
        const err = e => ({ error: e });
        const now = Date.now();

        if (body.name !== undefined || !existing) {
            const v = clean(body.name, 60);
            if (!v || v.length < 2) return err('Give the round a name, like "Qualifier 1" or "Sunday round"');
            set.name = v;
        }
        if (body.startsAt !== undefined || !existing) {
            const t = parseAdminTime(body.startsAt);
            if (!t) return err('The start is not a date and time');
            if (t.getTime() < now + MIN_LEAD_MS) return err('A round must start at least 20 minutes from now, so its lobby can open on time');
            if (c.starts_at && t < new Date(c.starts_at)) return err('The round must start after the campaign starts');
            if (c.ends_at && t.getTime() + 60 * MIN > new Date(c.ends_at).getTime()) return err('The round must end before the campaign ends (allow an hour)');
            const near = await pool.query(
                `SELECT name FROM tv_live_rounds WHERE campaign_id = $1 AND status NOT IN ('cancelled','failed')
                   AND id <> $2 AND ABS(EXTRACT(EPOCH FROM (starts_at - $3::timestamptz))) < $4 LIMIT 1`,
                [c.id, existing ? existing.id : 0, t, MIN_GAP_MS / 1000]
            );
            if (near.rows[0]) return err(`Too close to "${near.rows[0].name}": rounds of one campaign need at least an hour between their starts`);
            set.starts_at = t;
        }
        if (body.questions !== undefined) {
            const v = intOrNull(body.questions);
            if (!Number.isInteger(v) || v < 10 || v > 30) return err('A round has between 10 and 30 questions');
            set.questions = v;
        }
        if (body.tiebreakText !== undefined || !existing) {
            const v = clean(body.tiebreakText, 200);
            if (!v || v.length < 10) return err('Write the number question that settles exact ties (for example, "How many goals were scored in the 2026 World Cup final?")');
            set.tiebreak_text = v;
        }
        if (body.tiebreakAnswer !== undefined || !existing) {
            const s = String(body.tiebreakAnswer == null ? '' : body.tiebreakAnswer).replace(/,/g, '').trim();
            const v = Number(s);
            if (s === '' || !Number.isFinite(v) || Math.abs(v) >= 1e12) return err('Give the answer to the number question, as a number');
            set.tiebreak_answer = v;
        }
        const cup = c.kind === 'cup';
        if (body.stage !== undefined || (!existing && cup)) {
            const v = intOrNull(body.stage);
            if (cup) {
                if (!Number.isInteger(v) || v < 1 || v > 8) return err('Choose the stage: 1 for the qualifiers, 2 for the next, and so on');
                set.stage = v;
            } else set.stage = null;
        }
        if (body.throughCount !== undefined) {
            const v = intOrNull(body.throughCount);
            if (v !== null && (!Number.isInteger(v) || v < 1 || v > 10000)) return err('How many go through is a number from 1 to 10,000, or blank for the final');
            set.through_count = cup ? v : null;
        }
        if (body.stateQuota !== undefined) {
            const v = intOrNull(body.stateQuota);
            if (v !== null && (!Number.isInteger(v) || v < 1 || v > 1000)) return err('The quota per state is a number from 1 to 1,000, or blank for none');
            set.state_quota = cup ? v : null;
        }
        if (body.reserves !== undefined) {
            const v = intOrNull(body.reserves);
            if (!Number.isInteger(v) || v < 0 || v > 20) return err('Reserves is a number from 0 to 20');
            set.reserves = v;
        }
        if (body.rankedPerTv !== undefined) {
            const v = intOrNull(body.rankedPerTv);
            if (v !== null && (!Number.isInteger(v) || v < 1 || v > 20)) return err('Ranked players per TV is a number from 1 to 20, or blank for no limit');
            set.ranked_per_tv = v;
        } else if (!existing && cup && Number(set.stage) >= 2) {
            set.ranked_per_tv = 1;              // from the second stage on, one ranked player per TV unless the admin says otherwise
        }
        if (body.venueTvs !== undefined) {
            if (!Array.isArray(body.venueTvs)) return err('Venue TVs must be a list');
            const ids = [...new Set(body.venueTvs.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 200);
            if (ids.length) {
                const r = await pool.query(`SELECT id FROM tv_devices WHERE id = ANY($1::int[])`, [ids]);
                if (r.rows.length !== ids.length) return err('One of the venue TVs is not registered');
            }
            set.venue_tvs = ids;
        }
        if (body.prizeRanks !== undefined) {
            const v = campaigns()._ranks(Array.isArray(body.prizeRanks) ? body.prizeRanks : []);
            if (v.error) return err(v.error);
            set.prize_ranks = JSON.stringify(v.ranks);
        }
        if (set.state_quota && !(set.through_count || (existing && existing.through_count))) {
            // A quota on its own is fine: it decides who goes through.
        }
        return { set };
    }

    async create(campaignId, body = {}, admin) {
        await tvAuth.ensureSchema();
        const c = await this._campaign(campaignId);
        if (!c) return { ok: false, error: 'No such campaign' };
        if (c.kind === 'party') return { ok: false, error: 'Set the campaign type to Live Round or Brand Cup first' };
        if (c.status === 'ended') return { ok: false, error: 'This campaign has ended' };
        const f = await this._fields(c, body, null);
        if (f.error) return { ok: false, error: f.error };
        const cols = Object.keys(f.set);
        const params = [c.id, admin || 'admin', ...cols.map(k => f.set[k])];
        const r = await pool.query(
            `INSERT INTO tv_live_rounds (campaign_id, created_by, updated_by, ${cols.join(', ')})
             VALUES ($1, $2, $2, ${cols.map((k, i) => `$${i + 3}${k === 'prize_ranks' ? '::jsonb' : ''}`).join(', ')})
             RETURNING id`,
            params
        );
        this.tick().catch(() => {});
        return { ok: true, id: r.rows[0].id };
    }

    async update(id, body = {}, admin) {
        await tvAuth.ensureSchema();
        const r = await this._round(id);
        if (!r) return { ok: false, error: 'No such round' };
        if (r.status !== 'scheduled') return { ok: false, error: 'A round can only be changed before its lobby opens' };
        if (Date.now() >= this.times(r).lobbyOpens) return { ok: false, error: 'The lobby is open: the round can no longer be changed' };
        const c = await this._campaign(r.campaign_id);
        const f = await this._fields(c, body, r);
        if (f.error) return { ok: false, error: f.error };
        const cols = Object.keys(f.set);
        if (!cols.length) return { ok: true, changed: [] };
        const params = [r.id, admin || 'admin', ...cols.map(k => f.set[k])];
        await pool.query(
            `UPDATE tv_live_rounds SET updated_by = $2, updated_at = NOW(),
                    ${cols.map((k, i) => `${k} = $${i + 3}${k === 'prize_ranks' ? '::jsonb' : ''}`).join(', ')}
             WHERE id = $1 AND status = 'scheduled'`,
            params
        );
        this._unarm(r.id);
        this.tick().catch(() => {});
        return { ok: true, changed: cols };
    }

    /** Cancelled before it starts: any lobby open for it is closed. */
    async cancel(id, admin) {
        await tvAuth.ensureSchema();
        const r = await this._round(id);
        if (!r) return { ok: false, error: 'No such round' };
        if (!['scheduled', 'open'].includes(r.status)) return { ok: false, error: 'Only a round that has not started can be cancelled' };
        const upd = await pool.query(
            `UPDATE tv_live_rounds SET status = 'cancelled', updated_by = $2, updated_at = NOW()
             WHERE id = $1 AND status IN ('scheduled','open') RETURNING id`, [r.id, admin || 'admin']);
        if (!upd.rows[0]) return { ok: false, error: 'The round has just started' };
        this._unarm(r.id);
        await this._closeLobbies(r.id, 'round_cancelled');
        return { ok: true };
    }

    async _closeLobbies(roundId, reason) {
        const rooms = await pool.query(
            `SELECT id FROM tv_rooms WHERE live_round_id = $1 AND status IN ('lobby','playing')`, [roundId]);
        for (const x of rooms.rows) {
            await party().closeRoom(x.id, reason).catch(e => logger.error(`Live round ${roundId}: room ${x.id} not closed — ${e.message}`));
        }
        return rooms.rows.length;
    }

    /** Everything the admin page shows about one round. */
    async detail(id) {
        await tvAuth.ensureSchema();
        const r = await this._round(id);
        if (!r) return { ok: false, error: 'No such round' };
        const [entries, why, disputes, rooms] = await Promise.all([
            pool.query(
                `SELECT e.*, u.username, d.approx_location
                 FROM tv_live_entries e JOIN users u ON u.id = e.user_id JOIN tv_devices d ON d.id = e.tv_device_id
                 WHERE e.round_id = $1
                 ORDER BY e.place NULLS LAST, e.created_at LIMIT 300`, [r.id]),
            pool.query(
                `SELECT COALESCE(why_unranked, 'ranked') AS why, COUNT(*)::int AS n
                 FROM tv_live_entries WHERE round_id = $1 GROUP BY 1`, [r.id]),
            pool.query(
                `SELECT d.*, u.username FROM tv_live_disputes d JOIN users u ON u.id = d.user_id
                 WHERE d.round_id = $1 ORDER BY d.status = 'open' DESC, d.created_at`, [r.id]),
            pool.query(
                `SELECT status, COUNT(*)::int AS n FROM tv_rooms WHERE live_round_id = $1 GROUP BY status`, [r.id])
        ]);
        const c = await this._campaign(r.campaign_id);
        return {
            ok: true,
            round: this.view(r),
            area: areaLabel(c),
            closesAt: r.ranked_at ? new Date(new Date(r.ranked_at).getTime() + (Number(c.dispute_hours) || 48) * 3600e3) : null,
            counts: Object.fromEntries(why.rows.map(x => [x.why, x.n])),
            rooms: Object.fromEntries(rooms.rows.map(x => [x.status, x.n])),
            why: WHY,
            entries: entries.rows.map(e => ({
                userId: e.user_id, username: e.username, roomId: e.tv_room_id, tvId: e.tv_device_id, tvPlace: e.approx_location || null,
                ranked: e.ranked, whyUnranked: e.why_unranked, city: e.city, state: e.state, country: e.country,
                correct: e.correct, totalMs: e.total_ms, tiebreak: e.tiebreak_value == null ? null : Number(e.tiebreak_value),
                place: e.place, outcome: e.outcome, reserveOrder: e.reserve_order, steppedIn: e.stepped_in,
                disqualifiedBy: e.disqualified_by, disqualifiedReason: e.disqualified_reason
            })),
            disputes: disputes.rows.map(d => ({
                id: d.id, userId: d.user_id, username: d.username, text: d.text, status: d.status,
                answer: d.answer, answeredBy: d.answered_by, createdAt: d.created_at, answeredAt: d.answered_at
            }))
        };
    }

    /** An admin takes a player off a round's results, with the reason. The places are worked out again. */
    async disqualify(roundId, userId, reason, admin) {
        const r = await this._round(roundId);
        if (!r) return { ok: false, error: 'No such round' };
        if (!['playing', 'ranked'].includes(r.status)) return { ok: false, error: 'Players can be taken off only before the results are final' };
        const why = clean(reason, 200);
        if (!why || why.length < 5) return { ok: false, error: 'Say why, in a few words: the player can ask' };
        const u = await pool.query(
            `UPDATE tv_live_entries SET ranked = false, why_unranked = 'disqualified', disqualified_by = $3,
                    disqualified_reason = $4, place = NULL, outcome = NULL, reserve_order = NULL
             WHERE round_id = $1 AND user_id = $2 AND ranked = true RETURNING user_id`,
            [r.id, Number(userId), admin || 'admin', why]);
        if (!u.rows[0]) return { ok: false, error: 'That player is not ranked in this round' };
        if (r.status === 'ranked') await this.rank(r.id, { again: true });
        return { ok: true };
    }

    /** Puts a player taken off by mistake back. */
    async restore(roundId, userId, admin) {
        const r = await this._round(roundId);
        if (!r) return { ok: false, error: 'No such round' };
        if (!['playing', 'ranked'].includes(r.status)) return { ok: false, error: 'The results are final' };
        const u = await pool.query(
            `UPDATE tv_live_entries SET ranked = true, why_unranked = NULL, disqualified_by = NULL, disqualified_reason = NULL
             WHERE round_id = $1 AND user_id = $2 AND why_unranked = 'disqualified' RETURNING user_id`,
            [r.id, Number(userId)]);
        if (!u.rows[0]) return { ok: false, error: 'That player was not taken off' };
        logger.info(`Live round ${r.id}: user ${userId} put back by ${admin || 'admin'}`);
        if (r.status === 'ranked') await this.rank(r.id, { again: true });
        return { ok: true };
    }

    async answerDispute(disputeId, answer, admin) {
        const text = clean(answer, 1000);
        if (!text || text.length < 2) return { ok: false, error: 'Write the answer the player will see' };
        const u = await pool.query(
            `UPDATE tv_live_disputes SET status = 'answered', answer = $2, answered_by = $3, answered_at = NOW()
             WHERE id = $1 RETURNING round_id`, [Number(disputeId), text, admin || 'admin']);
        if (!u.rows[0]) return { ok: false, error: 'No such dispute' };
        return { ok: true, roundId: u.rows[0].round_id };
    }

    /**
     * The audit file: every entry with its room, TV and each answer and time.
     * Usernames and the place typed, nothing else about a player. CSV.
     */
    async auditCsv(roundId) {
        const r = await this._round(roundId);
        if (!r) return null;
        const n = Number(r.questions) || SET_SIZE;
        const rows = await pool.query(
            `SELECT e.*, u.username, d.approx_location, d.venue
             FROM tv_live_entries e JOIN users u ON u.id = e.user_id JOIN tv_devices d ON d.id = e.tv_device_id
             WHERE e.round_id = $1 ORDER BY e.place NULLS LAST, u.username`, [r.id]);
        const ans = await pool.query(
            `SELECT a.tv_player_id, a.position, a.chosen, a.is_correct, a.answer_ms
             FROM tv_answers a JOIN tv_live_entries e ON e.tv_player_id = a.tv_player_id
             WHERE e.round_id = $1 AND a.position <= $2`, [r.id, n]);
        const by = new Map();
        for (const a of ans.rows) {
            if (!by.has(a.tv_player_id)) by.set(a.tv_player_id, {});
            by.get(a.tv_player_id)[a.position] = a;
        }
        const q = s => {
            const v = s == null ? '' : String(s);
            const safe = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;          // never a formula in a spreadsheet
            return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
        };
        const head = ['place', 'username', 'ranked', 'why_unranked', 'outcome', 'reserve_order', 'stepped_in', 'correct', 'total_ms',
                      'tiebreak', 'tiebreak_ms', 'room', 'tv', 'tv_place', 'venue', 'typed_city', 'typed_state', 'typed_country', 'tv_state'];
        for (let i = 1; i <= n; i++) head.push(`q${i}_answer`, `q${i}_right`, `q${i}_ms`);
        const lines = [head.join(',')];
        for (const e of rows.rows) {
            const mine = by.get(e.tv_player_id) || {};
            const cells = [e.place, e.username, e.ranked ? 'yes' : 'no', e.why_unranked, e.outcome, e.reserve_order, e.stepped_in ? 'yes' : '',
                           e.correct, e.total_ms, e.tiebreak_value, e.tiebreak_ms, e.tv_room_id, e.tv_device_id, e.approx_location,
                           e.venue ? 'yes' : '', e.city, e.state, e.country, e.tv_state];
            for (let i = 1; i <= n; i++) {
                const a = mine[i];
                // The letter is the bank's (A to D as stored), not the shuffled one the room showed.
                cells.push(a ? (a.chosen || '') : '', a ? (a.is_correct ? 'yes' : 'no') : '', a ? a.answer_ms : '');
            }
            lines.push(cells.map(q).join(','));
        }
        return { name: `live-round-${r.id}.csv`, body: lines.join('\n') + '\n' };
    }

    // ============================================
    // FOR THE CAMPAIGN (tv-campaign.service)
    // ============================================

    /** Cash promised in prizes across a campaign's rounds still to be decided or won. */
    async roundsMoney(campaignId) {
        const r = await pool.query(
            `SELECT prize_ranks FROM tv_live_rounds WHERE campaign_id = $1 AND status NOT IN ('cancelled','failed','final')`,
            [Number(campaignId)]);
        let cash = 0;
        for (const x of r.rows) for (const p of (Array.isArray(x.prize_ranks) ? x.prize_ranks : [])) cash += Number(p.amount) || 0;
        return { cash, rounds: r.rows.length };
    }

    /** Lines for the campaign's "ready to publish" list. */
    async checklist(c) {
        if (!c || c.kind === 'party') return [];
        const r = await pool.query(
            `SELECT stage, through_count, state_quota FROM tv_live_rounds
             WHERE campaign_id = $1 AND status NOT IN ('cancelled','failed') ORDER BY starts_at`, [c.id]);
        const out = [];
        out.push({ key: 'rounds', ok: r.rows.length > 0, text: c.kind === 'cup' ? 'At least one round in the cup' : 'At least one Live Round', warning: false });
        if (c.kind === 'cup' && r.rows.length) {
            const stages = [...new Set(r.rows.map(x => x.stage))].sort((a, b) => a - b);
            const top = stages[stages.length - 1];
            const gaps = stages.some((s, i) => s !== i + 1);
            out.push({ key: 'stages', ok: !gaps, text: 'Stages numbered 1, 2, 3 and so on, with none missing', warning: false });
            const cut = r.rows.filter(x => x.stage < top).every(x => x.through_count || x.state_quota);
            out.push({ key: 'through', ok: cut, text: 'Every round before the final says how many go through', warning: false });
        }
        if (c.area_unit === 'city' && !(c.area_cities || []).length) {
            out.push({ key: 'cities', ok: false, text: 'The area is a city: name it (or choose state instead)', warning: true });
        }
        return out;
    }

    /**
     * For the TV: each campaign's next round (or the one whose lobby is open),
     * keyed by campaign id. Never throws.
     */
    async nextFor(campaignIds) {
        const out = new Map();
        if (!campaignIds.length) return out;
        try {
            const r = await pool.query(
                `SELECT DISTINCT ON (campaign_id) * FROM tv_live_rounds
                 WHERE campaign_id = ANY($1::int[]) AND status IN ('scheduled','open')
                   AND starts_at > NOW() + ($2 || ' milliseconds')::interval
                 ORDER BY campaign_id, starts_at`,
                [campaignIds.map(Number), String(ENTRY_CLOSES_MS)]);
            const now = Date.now();
            for (const x of r.rows) {
                const v = this.view(x, now);
                out.set(Number(x.campaign_id), {
                    id: v.id, name: v.name, stage: v.stage, startsAt: v.startsAt, lobbyOpensAt: v.lobbyOpensAt,
                    entryClosesAt: v.entryClosesAt, lobbyOpen: v.lobbyOpen, questions: v.questions
                });
            }
        } catch (e) { logger.error(`Live rounds: next rounds not read — ${e.message}`); }
        return out;
    }

    // ============================================
    // A TV OPENS A ROOM FOR A ROUND (tv-party.openRoom)
    // ============================================

    /** May a TV open a room for this round now? The campaign was already checked for the TV. */
    async forRoom(campaign, roundId) {
        await tvAuth.ensureSchema();
        const r = await this._round(roundId);
        if (!r || Number(r.campaign_id) !== Number(campaign.id)) return { ok: false, reason: 'no_round' };
        if (!['scheduled', 'open'].includes(r.status)) return { ok: false, reason: 'round_closed' };
        const t = this.times(r);
        const now = Date.now();
        if (now < t.lobbyOpens) return { ok: false, reason: 'round_not_open', lobbyOpensAt: new Date(t.lobbyOpens) };
        if (now >= t.entryCloses) return { ok: false, reason: 'round_closed' };
        if (r.status === 'scheduled') {
            const opened = await this.open(r);
            if (!opened) return { ok: false, reason: 'round_closed' };
        }
        const c = await this._campaign(r.campaign_id);
        return {
            ok: true,
            live: {
                roundId: r.id, name: r.name, stage: r.stage, startsAt: new Date(t.start), entryClosesAt: new Date(t.entryCloses),
                questions: r.questions, unit: c.area_unit, area: areaLabel(c), kind: c.kind,
                resultsUrl: this.resultsUrl(r.id)
            }
        };
    }

    // ============================================
    // A PHONE, BEFORE JOINING
    // ============================================

    async _location(campaignId, userId) {
        const r = await pool.query(`SELECT city, state, country FROM tv_live_locations WHERE campaign_id = $1 AND user_id = $2`,
            [Number(campaignId), Number(userId)]);
        return r.rows[0] || null;
    }

    /** Once a player has been ranked in one of the campaign's rounds, where they said they are stays put. */
    async _locationLocked(campaignId, userId) {
        const r = await pool.query(
            `SELECT 1 FROM tv_live_entries e JOIN tv_live_rounds r ON r.id = e.round_id
             WHERE r.campaign_id = $1 AND e.user_id = $2 AND e.ranked LIMIT 1`, [Number(campaignId), Number(userId)]);
        return r.rows.length > 0;
    }

    /** What the phone needs to know about the round, before joining. */
    async phoneInfo(live, campaignId, account) {
        const c = await this._campaign(campaignId);
        const unit = (c && c.area_unit) || 'none';
        const out = {
            roundId: live.roundId, name: live.name, stage: live.stage, startsAt: live.startsAt, entryClosesAt: live.entryClosesAt,
            questions: live.questions, unit, area: areaLabel(c), kind: c ? c.kind : 'live', resultsUrl: this.resultsUrl(live.roundId),
            states: unit === 'state' || unit === 'city' ? NIGERIAN_STATES : undefined,
            cities: unit === 'city' && c && (c.area_cities || []).length ? c.area_cities : undefined,
            countries: unit === 'country' && c && (c.area_countries || []).length ? c.area_countries : undefined
        };
        if (account) {
            out.location = await this._location(campaignId, account.id);
            out.locationLocked = await this._locationLocked(campaignId, account.id);
        }
        return out;
    }

    /** A signed-in player says where they are, for this campaign. */
    async saveLocation(campaignId, account, body = {}) {
        await tvAuth.ensureSchema();
        const c = await this._campaign(campaignId);
        if (!c || c.kind === 'party') return { ok: false, reason: 'not_live' };
        if (await this._locationLocked(c.id, account.id)) return { ok: false, reason: 'location_locked' };
        const unit = c.area_unit;
        let city = null, state = null, country = null;
        if (unit === 'city' || unit === 'state') {
            state = STATE_SET.get(String(body.state || '').trim().toLowerCase()) || null;
            if (!state) return { ok: false, reason: 'pick_state' };
            if (unit === 'city') {
                city = clean(body.city, 40);
                if (!city || city.length < 2 || !/^[\p{L}][\p{L} .'-]*$/u.test(city)) return { ok: false, reason: 'type_city' };
            }
        } else if (unit === 'country') {
            country = clean(body.country, 56);
            if (!country || country.length < 2 || !/^[\p{L}][\p{L} .'()-]*$/u.test(country)) return { ok: false, reason: 'type_country' };
        } else {
            return { ok: true, location: null };
        }
        await pool.query(
            `INSERT INTO tv_live_locations (campaign_id, user_id, city, state, country) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (campaign_id, user_id) DO UPDATE SET city = $3, state = $4, country = $5, set_at = NOW()`,
            [c.id, account.id, city, state, country]);
        return { ok: true, location: { city, state, country } };
    }

    /**
     * May this account join a room for the round? It must have said where it
     * is (when the campaign asks), and must not be in another TV's lobby for
     * the same round: one entry per account per round.
     */
    async canJoinRoom(roundId, campaignId, account, roomId) {
        const c = await this._campaign(campaignId);
        if (c && c.area_unit !== 'none') {
            const loc = await this._location(c.id, account.id);
            const has = loc && (c.area_unit === 'country' ? loc.country : loc.state);
            if (!has) return { ok: false, reason: 'location_required', unit: c.area_unit };
        }
        const other = await pool.query(
            `SELECT r.id FROM tv_players p JOIN tv_rooms r ON r.id = p.tv_room_id
             WHERE r.live_round_id = $1 AND r.id <> $2 AND r.status IN ('lobby','playing')
               AND p.user_id = $3 AND p.left_at IS NULL AND p.removed_at IS NULL LIMIT 1`,
            [Number(roundId), Number(roomId), account.id]);
        if (other.rows[0]) return { ok: false, reason: 'already_in_round' };
        return { ok: true };
    }

    /** A ranked player's number, at the end. Timed by the server from when the question appeared. */
    async saveTiebreak(roundId, userId, value, ms) {
        const s = String(value == null ? '' : value).replace(/,/g, '').trim();
        const v = Number(s);
        if (s === '' || !Number.isFinite(v) || Math.abs(v) >= 1e12) return { ok: false, reason: 'bad_number' };
        const u = await pool.query(
            `UPDATE tv_live_entries SET tiebreak_value = $3, tiebreak_ms = $4
             WHERE round_id = $1 AND user_id = $2 AND ranked AND tiebreak_value IS NULL RETURNING user_id`,
            [Number(roundId), Number(userId), v, Math.max(0, Math.round(ms))]);
        if (!u.rows[0]) return { ok: false, reason: 'already_answered' };
        return { ok: true, value: v };
    }

    // ============================================
    // THE CLOCK
    // ============================================

    startClock() {
        if (this._clock) return;
        const run = () => this.tick().catch(e => logger.error(`Live rounds tick failed: ${e.message}`));
        run();
        this._clock = setInterval(run, TICK_MS);
        if (this._clock.unref) this._clock.unref();
    }

    _unarm(id) {
        const t = this.timers.get(Number(id));
        if (t) clearTimeout(t);
        this.timers.delete(Number(id));
    }

    /**
     * Every 15 seconds: open lobbies that are due, arm the exact start of the
     * rounds about to begin, rank rounds that should have been ranked by now,
     * and make results final once their dispute window has closed.
     */
    async tick() {
        await tvAuth.ensureSchema();
        this._ticks++;
        const now = Date.now();
        const r = await pool.query(
            `SELECT * FROM tv_live_rounds
             WHERE (status IN ('scheduled','open') AND starts_at < NOW() + INTERVAL '20 minutes')
                OR status = 'playing'
                OR (status = 'ranked' AND $1::boolean)
             ORDER BY starts_at LIMIT 200`,
            [this._ticks % 4 === 1]
        );
        for (const round of r.rows) {
            try {
                const t = this.times(round);
                if (round.status === 'scheduled' || round.status === 'open') {
                    if (now > t.start + LATE_LIMIT_MS) { await this._fail(round, 'The server was not running when the round was due'); continue; }
                    if (round.status === 'scheduled' && now >= t.lobbyOpens) await this.open(round);
                    if (now >= t.entryCloses - TICK_MS - 1000 && !this.timers.has(round.id)) {
                        const timer = setTimeout(() => {
                            this.timers.delete(round.id);
                            this.begin(round.id).catch(e => logger.error(`Live round ${round.id}: start failed — ${e.message}`));
                        }, Math.max(0, t.entryCloses - Date.now()));
                        if (timer.unref) timer.unref();
                        this.timers.set(round.id, timer);
                    }
                } else if (round.status === 'playing') {
                    const goAt = Math.max(t.start, new Date(round.started_at || round.starts_at).getTime());
                    const questionMs = (await tvSettings.values())['party.question_seconds'] * 1000;
                    if (now > goAt + this.lengthMs(round, questionMs) + RANK_AFTER_MS) await this.rank(round.id);
                } else if (round.status === 'ranked') {
                    await this.finalise(round);
                }
            } catch (e) {
                logger.error(`Live round ${round.id}: tick failed — ${e.message}`);
            }
        }
    }

    async _fail(round, reason) {
        await pool.query(
            `UPDATE tv_live_rounds SET status = 'failed', fail_reason = $2, updated_at = NOW()
             WHERE id = $1 AND status IN ('scheduled','open')`, [round.id, String(reason).slice(0, 200)]);
        this._unarm(round.id);
        await this._closeLobbies(round.id, 'round_failed');
        logger.error(`📣 Live round ${round.id} failed: ${reason}`);
    }

    /**
     * The lobby opens: the questions are chosen now, so nobody can have seen
     * them in the brand's everyday party first. Questions from the campaign's
     * earlier rounds, and from its rooms in the last 30 days, are left out
     * when the bank allows. Returns true if the round is open.
     */
    async open(round) {
        if (round.question_ids && round.question_ids.length) {
            if (round.status === 'scheduled') {
                await pool.query(`UPDATE tv_live_rounds SET status = 'open', opened_at = COALESCE(opened_at, NOW()) WHERE id = $1 AND status = 'scheduled'`, [round.id]);
            }
            return true;
        }
        const c = await this._campaign(round.campaign_id);
        if (!c || !c.category) { await this._fail(round, 'The campaign has no question category'); return false; }
        const ids = await this._buildSet(c, round);
        if (!ids) { await this._fail(round, `The ${c.category} category cannot fill ${round.questions} questions`); return false; }
        const upd = await pool.query(
            `UPDATE tv_live_rounds SET question_ids = $2, status = 'open', opened_at = NOW()
             WHERE id = $1 AND question_ids IS NULL AND status IN ('scheduled','open') RETURNING id`,
            [round.id, ids]);
        if (upd.rows[0]) logger.info(`📣 Live round ${round.id} open: ${ids.length} questions chosen`);
        return true;
    }

    async _buildSet(c, round) {
        const n = Number(round.questions) || SET_SIZE;
        const earlier = await pool.query(
            `SELECT question_ids FROM tv_live_rounds WHERE campaign_id = $1 AND id <> $2 AND question_ids IS NOT NULL`, [c.id, round.id]);
        const fromRounds = [...new Set(earlier.rows.flatMap(x => x.question_ids || []))];
        const played = await pool.query(
            `SELECT DISTINCT q.question_id FROM tv_room_questions q JOIN tv_rooms r ON r.id = q.tv_room_id
             WHERE r.campaign_id = $1 AND r.created_at > NOW() - INTERVAL '30 days'`, [c.id]);
        const fromRooms = played.rows.map(x => Number(x.question_id));
        for (const exclude of [[...fromRounds, ...fromRooms], fromRounds, []]) {
            const ids = await this._ladder([c.category], exclude, n);
            if (ids) return ids;
        }
        return null;
    }

    /**
     * n questions, easiest first, from the Challenge bank's 15-step ladder.
     * Fewer than 15: steps spread evenly up the ladder. More: a second ladder
     * with none of the first's questions, the two woven together.
     */
    async _ladder(categories, exclude, n) {
        const one = await questionService.buildChallengeQuestionSet(categories, exclude);
        if (!one || !one.ok) return null;
        const a = [...one.questionIds].sort((x, y) => x.position - y.position).map(x => Number(x.questionId));
        if (n === a.length) return a;
        if (n < a.length) {
            const pick = [];
            for (let i = 0; i < n; i++) pick.push(a[Math.round(i * (a.length - 1) / (n - 1))]);
            return [...new Set(pick)].length === n ? pick : null;
        }
        const two = await questionService.buildChallengeQuestionSet(categories, [...exclude, ...a]);
        if (!two || !two.ok) return null;
        const b = [...two.questionIds].sort((x, y) => x.position - y.position).map(x => Number(x.questionId));
        const woven = [];
        for (let i = 0; i < a.length; i++) { woven.push(a[i]); if (b[i] != null) woven.push(b[i]); }
        return woven.slice(0, n);
    }

    /**
     * Entry closes: who is ranked is decided for every room at once, each
     * player's entry is written, and every room is started with the same plan.
     */
    async begin(roundId) {
        await tvAuth.ensureSchema();
        const id = Number(roundId);
        try {
            const got = await redis.set(`tv_live:begin:${id}`, String(process.pid), 'EX', 900, 'NX');
            if (got !== 'OK') return { ok: false, reason: 'already_started' };
        } catch (e) {
            logger.error(`Live round ${id}: start lock not taken (${e.message}); going on, as one server runs rounds`);
        }
        let round = await this._round(id);
        if (!round || !['scheduled', 'open'].includes(round.status)) return { ok: false, reason: 'not_due' };
        const c = await this._campaign(round.campaign_id);
        if (!campaigns().isLiveRow(c)) { await this._fail(round, 'The campaign was paused or ended before the round'); return { ok: false, reason: 'campaign_over' }; }
        if (!(round.question_ids && round.question_ids.length)) {
            if (!(await this.open(round))) return { ok: false, reason: 'no_questions' };
            round = await this._round(id);
        }

        // Every room still in its lobby, and everyone in it.
        const rooms = await pool.query(
            `SELECT r.id, r.tv_device_id, d.approx_location, d.venue
             FROM tv_rooms r JOIN tv_devices d ON d.id = r.tv_device_id
             WHERE r.live_round_id = $1 AND r.status = 'lobby' ORDER BY r.id`, [id]);
        const candidates = [];
        const empty = [];
        const seen = new Set();
        const states = await mapLimit(rooms.rows, PARALLEL, room => store.load(room.id).catch(() => null));
        for (const [k, room] of rooms.rows.entries()) {
            const state = states[k];
            if (!state || state.status !== 'lobby') continue;
            const active = (state.order || []).filter(pid => {
                const p = state.players[pid];
                return p && !p.leftAt && !p.removedAt && p.userId;
            });
            if (!active.length) { empty.push(room.id); continue; }
            for (const pid of active) {
                const p = state.players[pid];
                if (seen.has(p.userId)) continue;              // one entry per account (canJoinRoom stops this before it happens)
                seen.add(p.userId);
                candidates.push({ roomId: room.id, deviceId: room.tv_device_id, place: room.approx_location || null,
                                  venue: !!room.venue, pid, userId: p.userId, joinedAt: p.joinedAt || 0 });
            }
        }

        const userIds = candidates.map(x => x.userId);
        const locs = userIds.length ? await pool.query(
            `SELECT user_id, city, state, country FROM tv_live_locations WHERE campaign_id = $1 AND user_id = ANY($2::int[])`,
            [c.id, userIds]) : { rows: [] };
        const prev = await this._previous(c, round);
        const decided = this.decide({ c, round, candidates, locations: new Map(locs.rows.map(x => [x.user_id, x])), prev });

        if (decided.length) {
            const cols = { round: [], user: [], room: [], player: [], device: [], ranked: [], why: [], city: [], state: [], country: [], tvs: [], seed: [], stepped: [] };
            for (const d of decided) {
                cols.round.push(id); cols.user.push(d.userId); cols.room.push(d.roomId); cols.player.push(d.pid); cols.device.push(d.deviceId);
                cols.ranked.push(d.ranked); cols.why.push(d.why); cols.city.push(d.city); cols.state.push(d.state); cols.country.push(d.country);
                cols.tvs.push(d.tvState); cols.seed.push(d.seed); cols.stepped.push(!!d.steppedIn);
            }
            await pool.query(
                `INSERT INTO tv_live_entries (round_id, user_id, tv_room_id, tv_player_id, tv_device_id, ranked, why_unranked,
                                              city, state, country, tv_state, seed, stepped_in)
                 SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::int[], $5::int[], $6::boolean[], $7::text[],
                                      $8::text[], $9::text[], $10::text[], $11::text[], $12::int[], $13::boolean[])
                 ON CONFLICT (round_id, user_id) DO NOTHING`,
                [cols.round, cols.user, cols.room, cols.player, cols.device, cols.ranked, cols.why,
                 cols.city, cols.state, cols.country, cols.tvs, cols.seed, cols.stepped]);
        }

        const set = await tvSettings.values();
        const t = this.times(round);
        const plan = {
            roundId: id,
            // Late (a restart, a slow start): every room still starts together, a few seconds from now.
            goAt: Math.max(t.start, Date.now() + 8000),
            questionMs: set['party.question_seconds'] * 1000,
            total: round.question_ids.length,
            questionIds: round.question_ids.map(Number),
            tiebreak: round.tiebreak_text ? { text: round.tiebreak_text } : null
        };
        await pool.query(
            `UPDATE tv_live_rounds SET status = 'playing', started_at = to_timestamp($2 / 1000.0) WHERE id = $1`, [id, plan.goAt]);

        const unrankedByRoom = new Map();
        for (const d of decided) {
            if (!unrankedByRoom.has(d.roomId)) unrankedByRoom.set(d.roomId, {});
            unrankedByRoom.get(d.roomId)[d.pid] = d.ranked ? null : d.why;
        }
        let started = 0;
        await mapLimit([...unrankedByRoom.keys()], PARALLEL, async roomId => {
            try {
                const out = await party().startLive(roomId, plan, unrankedByRoom.get(roomId));
                if (out && out.ok) started++;
            } catch (e) {
                logger.error(`Live round ${id}: room ${roomId} did not start — ${e.message}`);
            }
        });
        await mapLimit(empty, PARALLEL, roomId => party().closeRoom(roomId, 'no_players').catch(() => {}));
        logger.info(`📣 Live round ${id} started: ${started} room(s), ${decided.length} player(s), ${decided.filter(d => d.ranked).length} ranked`);
        if (!started) await this.rank(id);
        return { ok: true, rooms: started, players: decided.length };
    }

    /** The stage before, in a cup: who went through, and the reserves, in order. */
    async _previous(c, round) {
        if (c.kind !== 'cup' || !round.stage) return null;
        if (round.stage === 1) {
            const r = await pool.query(
                `SELECT e.user_id FROM tv_live_entries e JOIN tv_live_rounds r ON r.id = e.round_id
                 WHERE r.campaign_id = $1 AND r.stage = 1 AND r.id <> $2 AND r.status IN ('ranked','final') AND e.outcome = 'through'`,
                [c.id, round.id]);
            return { stage: 1, alreadyThrough: new Set(r.rows.map(x => x.user_id)) };
        }
        const r = await pool.query(
            `SELECT e.user_id, e.outcome, e.place, e.reserve_order, COALESCE(e.state, e.tv_state) AS state, r.starts_at, r.state_quota
             FROM tv_live_entries e JOIN tv_live_rounds r ON r.id = e.round_id
             WHERE r.campaign_id = $1 AND r.stage = $2 AND r.status IN ('ranked','final') AND e.outcome IN ('through','reserve')
             ORDER BY r.starts_at, e.outcome, e.reserve_order NULLS LAST, e.place`,
            [c.id, round.stage - 1]);
        const through = new Map();
        const reserves = [];
        let quota = false;
        for (const x of r.rows) {
            if (x.state_quota) quota = true;
            const row = { userId: x.user_id, place: x.place, state: x.state || 'Unknown' };
            if (x.outcome === 'through') through.set(x.user_id, row);
            else reserves.push(row);
        }
        return { stage: round.stage, through, reserves, quota };
    }

    /**
     * Who is ranked. Pure: everything it needs is passed in, so it can be
     * tested on its own. Returns one decision per candidate.
     */
    decide({ c, round, candidates, locations, prev }) {
        const { stateFromPlace } = require('./tv-campaign.service');
        const areaStates = (c.regions || []).length && c.audience === 'chosen' ? new Set(c.regions) : null;
        const unit = c.area_unit || 'none';
        const venues = new Set((round.venue_tvs || []).map(Number));

        const out = candidates.map(x => {
            const loc = locations.get(x.userId) || null;
            const tvState = stateFromPlace(x.place);
            const d = { ...x, ranked: true, why: null, tvState, city: loc ? loc.city : null, state: loc ? loc.state : null,
                        country: loc ? loc.country : null, seed: null, steppedIn: false };
            const no = why => { if (d.ranked) { d.ranked = false; d.why = why; } };

            // 1. where
            const tvKnown = !!x.place;
            if (unit === 'none') {
                if (c.audience !== 'all') {
                    if (!tvKnown) no('tv_unknown');
                    else if (!tvState || (areaStates && !areaStates.has(tvState))) no('outside_area');
                }
            } else if (unit === 'state' || unit === 'city') {
                if (!loc || !loc.state || (unit === 'city' && !loc.city)) no('no_location');
                else if (!tvKnown) no('tv_unknown');
                else if (tvState !== loc.state) no('outside_area');
                else if (areaStates && !areaStates.has(loc.state)) no('outside_area');
                else if (unit === 'city' && (c.area_cities || []).length && !(c.area_cities || []).some(k => same(k, loc.city))) no('outside_area');
            } else if (unit === 'country') {
                if (!loc || !loc.country) no('no_location');
                else if ((c.area_countries || []).length && !(c.area_countries || []).some(k => same(k, loc.country))) no('outside_area');
                else if (!tvKnown) no('tv_unknown');
                else if (isNigeria(loc.country) ? (!tvState || (areaStates && !areaStates.has(tvState))) : !!tvState) no('outside_area');
            }

            // 2. the cup
            if (prev && prev.stage === 1 && round.stage === 1) {
                if (prev.alreadyThrough.has(x.userId)) no('already_through');
            } else if (prev) {
                const t = prev.through.get(x.userId);
                const resIdx = prev.reserves.findIndex(r => r.userId === x.userId);
                if (t) d.seed = t.place;
                else if (resIdx >= 0) { d.reserve = resIdx; d.seed = 100000 + resIdx; d.group = prev.reserves[resIdx].state; }
                else no('not_through');
                if (t) d.group = t.state;
            }

            // 3. a venue round
            if (venues.size && !venues.has(Number(x.deviceId))) no('not_venue');
            return d;
        });

        // 4. one (or n) ranked per TV: the best-placed from the stage before
        //    first, then whoever joined first. Reserves wait for step 5.
        const perTv = Number(round.ranked_per_tv) || 0;
        const takenByRoom = new Map();
        const order = (a, b) => (a.seed == null ? 1e9 : a.seed) - (b.seed == null ? 1e9 : b.seed) || a.joinedAt - b.joinedAt || a.userId - b.userId;
        for (const d of out.filter(d => d.ranked && d.reserve === undefined).sort(order)) {
            const n = takenByRoom.get(d.roomId) || 0;
            if (perTv && n >= perTv) { d.ranked = false; d.why = 'one_per_tv'; continue; }
            takenByRoom.set(d.roomId, n + 1);
        }

        // 5. reserves step in for qualifiers who did not come (or cannot be
        //    ranked here), in reserve order; per state, if places went by state.
        if (prev && prev.through) {
            const groupOf = d => (prev.quota ? (d.group || 'Unknown') : '*');
            const missing = new Map();
            for (const [uid, t] of prev.through) {
                const here = out.find(d => d.userId === uid && d.ranked);
                if (!here) {
                    const g = prev.quota ? t.state : '*';
                    missing.set(g, (missing.get(g) || 0) + 1);
                }
            }
            for (const d of out.filter(d => d.reserve !== undefined).sort((a, b) => a.reserve - b.reserve)) {
                if (!d.ranked) continue;                   // failed a check above
                const g = groupOf(d);
                const n = takenByRoom.get(d.roomId) || 0;
                if ((missing.get(g) || 0) > 0 && !(perTv && n >= perTv)) {
                    missing.set(g, missing.get(g) - 1);
                    takenByRoom.set(d.roomId, n + 1);
                    d.steppedIn = true;
                } else {
                    d.ranked = false;
                    d.why = (missing.get(g) || 0) > 0 ? 'one_per_tv' : 'reserve_not_needed';
                }
            }
        }
        return out.map(({ reserve, group, place, venue, ...rest }) => rest);
    }

    // ============================================
    // THE END OF THE ROUND
    // ============================================

    /** A room of the round has finished or closed. Once none is left playing, the round is ranked. */
    async roomFinished(roundId) {
        const r = await pool.query(
            `SELECT COUNT(*)::int AS n FROM tv_rooms WHERE live_round_id = $1 AND status IN ('lobby','playing')`, [Number(roundId)]);
        if (Number(r.rows[0].n) === 0) {
            const round = await this._round(roundId);
            if (round && round.status === 'playing') await this.rank(round.id);
        }
    }

    /**
     * The places across the area. Right answers first, then the total time;
     * then, only for an exact tie, the closest number at the end, then who
     * typed it sooner. In a cup, the top go through and the next few are
     * reserves (per state, if the round has a quota). Run again, with
     * again: true, after an admin takes someone off.
     */
    async rank(roundId, { again = false } = {}) {
        const id = Number(roundId);
        try {
            const got = await redis.set(`tv_live:rank:${id}`, String(process.pid), 'EX', 60, 'NX');
            if (got !== 'OK') return { ok: false, reason: 'busy' };
        } catch (e) { /* one server: go on */ }
        try {
            const round = await this._round(id);
            if (!round) return { ok: false, reason: 'no_round' };
            if (!(round.status === 'playing' || (again && round.status === 'ranked'))) return { ok: false, reason: 'not_due' };
            const n = Number(round.questions) || SET_SIZE;
            // A question with no answer row at all (the TV closed the room
            // early, say) counts as the full clock, as an unanswered one does.
            const clockMs = (await tvSettings.values())['party.question_seconds'] * 1000;

            await pool.query(
                `UPDATE tv_live_entries e SET correct = s.c, total_ms = s.t
                 FROM (SELECT e2.user_id,
                              COUNT(a.id) FILTER (WHERE a.is_correct = true)::int AS c,
                              (COALESCE(SUM(a.answer_ms), 0) + ($2::int - COUNT(a.id)) * $3::int)::int AS t
                       FROM tv_live_entries e2 LEFT JOIN tv_answers a ON a.tv_player_id = e2.tv_player_id AND a.position <= $2
                       WHERE e2.round_id = $1 GROUP BY e2.user_id) s
                 WHERE e.round_id = $1 AND e.user_id = s.user_id`, [id, n, clockMs]);

            const ranked = await pool.query(
                `SELECT user_id, COALESCE(state, tv_state, 'Unknown') AS grp FROM tv_live_entries
                 WHERE round_id = $1 AND ranked
                 ORDER BY correct DESC, total_ms ASC,
                          ABS(tiebreak_value - $2::numeric) ASC NULLS LAST, tiebreak_ms ASC NULLS LAST, created_at, user_id`,
                [id, round.tiebreak_answer == null ? 0 : round.tiebreak_answer]);

            const c = await this._campaign(round.campaign_id);
            const cut = c.kind === 'cup' && (round.through_count || round.state_quota);
            const users = [], places = [], outcomes = [], reserveOrders = [];
            const perGroup = new Map();
            ranked.rows.forEach((x, i) => {
                users.push(x.user_id); places.push(i + 1);
                if (!cut) { outcomes.push(null); reserveOrders.push(null); return; }
                const g = round.state_quota ? x.grp : '*';
                const k = (perGroup.get(g) || 0) + 1;
                perGroup.set(g, k);
                const top = round.state_quota || round.through_count;
                if (k <= top) { outcomes.push('through'); reserveOrders.push(null); }
                else if (k <= top + Number(round.reserves || 0)) { outcomes.push('reserve'); reserveOrders.push(k - top); }
                else { outcomes.push('out'); reserveOrders.push(null); }
            });
            await pool.query(
                `UPDATE tv_live_entries SET place = NULL, outcome = NULL, reserve_order = NULL WHERE round_id = $1 AND NOT ranked`, [id]);
            if (users.length) {
                await pool.query(
                    `UPDATE tv_live_entries e SET place = v.place, outcome = v.outcome, reserve_order = v.ro
                     FROM unnest($2::int[], $3::int[], $4::text[], $5::smallint[]) AS v(user_id, place, outcome, ro)
                     WHERE e.round_id = $1 AND e.user_id = v.user_id`,
                    [id, users, places, outcomes, reserveOrders]);
            }
            await pool.query(
                `UPDATE tv_live_rounds SET status = 'ranked', ranked_at = COALESCE(ranked_at, NOW()) WHERE id = $1`, [id]);
            this._forget(id);
            logger.info(`📣 Live round ${id} ranked${again ? ' again' : ''}: ${users.length} ranked player(s)`);
            return { ok: true, ranked: users.length };
        } finally {
            try { await redis.del(`tv_live:rank:${id}`); } catch (e) { /* expires by itself */ }
        }
    }

    /**
     * After the dispute window, with every dispute answered: the results are
     * final, and the round's prizes go to the best-placed players who can
     * win them (old enough, under the campaign's limit per player), from the
     * money the brand paid in.
     */
    async finalise(round, { now = Date.now() } = {}) {
        if (!round || round.status !== 'ranked') return { ok: false, reason: 'not_due' };
        const c = await this._campaign(round.campaign_id);
        const closes = new Date(round.ranked_at).getTime() + (Number(c.dispute_hours) || 48) * 3600e3;
        if (now < closes) return { ok: false, reason: 'window_open', closesAt: new Date(closes) };
        const open = await pool.query(`SELECT COUNT(*)::int AS n FROM tv_live_disputes WHERE round_id = $1 AND status = 'open'`, [round.id]);
        if (Number(open.rows[0].n) > 0) return { ok: false, reason: 'disputes_open' };
        const upd = await pool.query(
            `UPDATE tv_live_rounds SET status = 'final', final_at = NOW() WHERE id = $1 AND status = 'ranked' RETURNING id`, [round.id]);
        if (!upd.rows[0]) return { ok: false, reason: 'not_due' };
        this._forget(round.id);
        const ranks = Array.isArray(round.prize_ranks) ? round.prize_ranks : [];
        let made = 0;
        if (ranks.length) {
            const board = await pool.query(
                `SELECT user_id, tv_player_id FROM tv_live_entries WHERE round_id = $1 AND ranked AND place IS NOT NULL
                 ORDER BY place LIMIT 500`, [round.id]);
            made = await prizes().settleRanked(c, `round:${round.id}`, ranks,
                board.rows.map(x => ({ userId: x.user_id, playerId: x.tv_player_id })));
        }
        this._forget(round.id);
        logger.info(`📣 Live round ${round.id} final${made ? `: ${made} prize place(s)` : ''}`);
        return { ok: true, prizes: made };
    }

    // ============================================
    // THE PUBLIC PAGE (/tv/live/:id)
    // ============================================

    /**
     * What anyone with the link sees: the round, then, once it is ranked,
     * the places (usernames, right answers, time; the state when the area is
     * by state or city), the cut line, the questions and their answers, and
     * the winners once final. A signed-in player also gets their own line.
     */
    async publicData(roundId, { account = null, find = null } = {}) {
        await tvAuth.ensureSchema();
        // Every phone asks for its place as the round ends, so what is the
        // same for everyone is kept for a few seconds; only each player's own
        // line is read every time.
        const words = String(find || '').trim().slice(0, 30);
        const key = `${Number(roundId)}`;
        const hit = !words && this._pub && this._pub.get(key);
        let out;
        if (hit && hit.until > Date.now()) {
            out = JSON.parse(hit.json);
        } else {
            out = await this._publicPart(roundId, words);
            if (!out.ok) return out;
            if (!words) {
                if (!this._pub) this._pub = new Map();
                if (this._pub.size > 200) this._pub.clear();
                this._pub.set(key, { until: Date.now() + PUBLIC_CACHE_MS, json: JSON.stringify(out) });
            }
        }
        if (account) await this._mine(out, account);
        const { _r, ...shown } = out;
        return shown;
    }

    /** The results page changed: its kept copy goes. */
    _forget(id) {
        if (this._pub) this._pub.delete(String(Number(id)));
    }

    async _publicPart(roundId, words) {
        const r = await this._round(roundId);
        if (!r || r.status === 'cancelled') return { ok: false, reason: 'no_round' };
        const c = await this._campaign(r.campaign_id);
        if (!c || c.status === 'draft') return { ok: false, reason: 'no_round' };
        const t = this.times(r);
        const showState = c.area_unit === 'state' || c.area_unit === 'city';
        const out = {
            ok: true,
            round: {
                id: r.id, name: r.name, stage: r.stage, status: r.status, startsAt: r.starts_at, questions: r.questions,
                entryClosesAt: new Date(t.entryCloses), failReason: r.status === 'failed' ? r.fail_reason : null
            },
            campaign: {
                id: c.id, name: c.name, brandName: c.brand_name, kind: c.kind, colourMain: c.colour_main, colourAccent: c.colour_accent,
                area: areaLabel(c), disputeHours: c.dispute_hours
            },
            rules: [
                'Same questions, same order and same clock on every TV. Each TV shows the answers in its own order.',
                'Places go by right answers, then total answer time as our server measured it. An exact tie goes to the closest answer to the number question at the end.',
                'Only signed-in players whose TV and typed place are in the area are ranked. Everyone else plays for fun.',
                `Results become final ${c.dispute_hours} hours after the round, once every question about them has an answer.`
            ]
        };
        const counts = await pool.query(
            `SELECT COUNT(*)::int AS players, COUNT(*) FILTER (WHERE ranked)::int AS ranked, COUNT(DISTINCT tv_room_id)::int AS tvs
             FROM tv_live_entries WHERE round_id = $1`, [r.id]);
        out.counts = counts.rows[0];
        if (r.status === 'open' || r.status === 'scheduled') {
            const lobby = await pool.query(
                `SELECT COUNT(DISTINCT r.id)::int AS tvs, COUNT(p.id)::int AS players
                 FROM tv_rooms r LEFT JOIN tv_players p ON p.tv_room_id = r.id AND p.left_at IS NULL AND p.removed_at IS NULL
                 WHERE r.live_round_id = $1 AND r.status = 'lobby'`, [r.id]);
            out.lobby = lobby.rows[0];
        }
        if (r.status === 'ranked' || r.status === 'final') {
            out.closesAt = new Date(new Date(r.ranked_at).getTime() + (Number(c.dispute_hours) || 48) * 3600e3);
            const board = await pool.query(
                `SELECT e.place, e.correct, e.total_ms, e.outcome, e.reserve_order, e.state, e.tv_state, u.username
                 FROM tv_live_entries e JOIN users u ON u.id = e.user_id
                 WHERE e.round_id = $1 AND e.ranked AND e.place IS NOT NULL ORDER BY e.place LIMIT $2`, [r.id, BOARD_SHOWN]);
            const row = x => ({ place: x.place, username: x.username, correct: x.correct, seconds: Math.round((x.total_ms || 0) / 100) / 10,
                                outcome: x.outcome, reserveOrder: x.reserve_order, state: showState ? (x.state || x.tv_state || null) : null });
            out.board = board.rows.map(row);
            out.cut = c.kind === 'cup' && (r.through_count || r.state_quota)
                ? (r.state_quota ? { perState: r.state_quota, reserves: r.reserves } : { top: r.through_count, reserves: r.reserves }) : null;
            if (words) {
                const f = await pool.query(
                    `SELECT e.place, e.correct, e.total_ms, e.outcome, e.reserve_order, e.state, e.tv_state, u.username
                     FROM tv_live_entries e JOIN users u ON u.id = e.user_id
                     WHERE e.round_id = $1 AND e.ranked AND e.place IS NOT NULL AND LOWER(u.username) = LOWER($2)`, [r.id, words]);
                out.found = f.rows[0] ? row(f.rows[0]) : null;
            }
            const qs = await pool.query(
                `SELECT id, question_text, option_a, option_b, option_c, option_d, correct_answer, fun_fact
                 FROM questions WHERE id = ANY($1::int[])`, [r.question_ids || []]);
            const byId = new Map(qs.rows.map(q => [Number(q.id), q]));
            out.questions = (r.question_ids || []).map((qid, i) => {
                const q = byId.get(Number(qid)) || {};
                const k = String(q.correct_answer || '').trim().toUpperCase();
                return { position: i + 1, text: q.question_text || null, answer: q['option_' + k.toLowerCase()] || null, funFact: q.fun_fact || null };
            });
            out.tiebreak = r.tiebreak_text ? { text: r.tiebreak_text, answer: r.tiebreak_answer == null ? null : Number(r.tiebreak_answer) } : null;
            if (r.status === 'final') {
                const w = await pool.query(
                    `SELECT a.place, a.prize_type, a.amount, a.item, u.username FROM tv_campaign_awards a JOIN users u ON u.id = a.user_id
                     WHERE a.campaign_id = $1 AND a.basis = 'leaderboard' AND a.period_key = $2
                       AND a.status IN ('won','sent','received') ORDER BY a.place`, [c.id, `round:${r.id}`]);
                out.winners = w.rows.map(x => ({ place: x.place, username: x.username, prize: x.prize_type === 'cash' ? naira(x.amount) : x.item }));
            }
        }
        out._r = { id: r.id, status: r.status };
        return out;
    }

    /** The signed-in player's own line, and their disputes, added to the page's data. */
    async _mine(out, account) {
        const r = out._r;
        {
            const me = await pool.query(
                `SELECT e.*, u.username FROM tv_live_entries e JOIN users u ON u.id = e.user_id WHERE e.round_id = $1 AND e.user_id = $2`,
                [r.id, account.id]);
            const e = me.rows[0];
            if (e) {
                const of = Number(out.counts.ranked) || 0;
                out.me = {
                    username: e.username, ranked: e.ranked, why: e.why_unranked ? WHY[e.why_unranked] : null,
                    whyCode: e.why_unranked, disqualifiedReason: e.disqualified_reason || null,
                    correct: e.correct, seconds: e.total_ms == null ? null : Math.round(e.total_ms / 100) / 10,
                    place: e.place, of, outcome: e.outcome, reserveOrder: e.reserve_order, steppedIn: e.stepped_in
                };
                const d = await pool.query(
                    `SELECT id, text, status, answer, created_at, answered_at FROM tv_live_disputes WHERE round_id = $1 AND user_id = $2 ORDER BY id`,
                    [r.id, account.id]);
                out.myDisputes = d.rows.map(x => ({ id: x.id, text: x.text, status: x.status, answer: x.answer, createdAt: x.created_at }));
                out.canDispute = r.status === 'ranked' && d.rows.length < DISPUTES_PER_PLAYER && Date.now() < new Date(out.closesAt).getTime();
            }
            out.signedIn = true;
        }
        return out;
    }

    /** A player who played questions the results, while the window is open. */
    async dispute(roundId, account, text) {
        const r = await this._round(roundId);
        if (!r) return { ok: false, reason: 'no_round' };
        if (r.status !== 'ranked') return { ok: false, reason: r.status === 'final' ? 'results_final' : 'not_ranked_yet' };
        const c = await this._campaign(r.campaign_id);
        if (Date.now() >= new Date(r.ranked_at).getTime() + (Number(c.dispute_hours) || 48) * 3600e3) return { ok: false, reason: 'window_closed' };
        const e = await pool.query(`SELECT 1 FROM tv_live_entries WHERE round_id = $1 AND user_id = $2`, [r.id, account.id]);
        if (!e.rows[0]) return { ok: false, reason: 'not_in_round' };
        const words = clean(text, 1000);
        if (!words || words.length < 10) return { ok: false, reason: 'say_more' };
        const n = await pool.query(`SELECT COUNT(*)::int AS n FROM tv_live_disputes WHERE round_id = $1 AND user_id = $2`, [r.id, account.id]);
        if (Number(n.rows[0].n) >= DISPUTES_PER_PLAYER) return { ok: false, reason: 'too_many_disputes' };
        const ins = await pool.query(
            `INSERT INTO tv_live_disputes (round_id, user_id, text) VALUES ($1, $2, $3) RETURNING id`, [r.id, account.id, words]);
        logger.info(`📣 Live round ${r.id}: dispute ${ins.rows[0].id} from user ${account.id}`);
        return { ok: true, id: ins.rows[0].id };
    }
}

module.exports = new TvLiveRoundService();
module.exports.TvLiveRoundService = TvLiveRoundService;
module.exports.WHY = WHY;
module.exports.KINDS = KINDS;
module.exports.UNITS = UNITS;
module.exports.WHERE_FINAL = WHERE_FINAL;
module.exports.areaLabel = areaLabel;
module.exports.LOBBY_OPENS_MS = LOBBY_OPENS_MS;
module.exports.ENTRY_CLOSES_MS = ENTRY_CLOSES_MS;
module.exports.TIEBREAK_MS = TIEBREAK_MS;
module.exports.shuffle = shuffle;
