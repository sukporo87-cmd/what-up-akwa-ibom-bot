// ============================================
// FILE: src/services/tv-campaign.service.js
// WUT TV, phase 7, step 1 — branded parties: the campaign, as it is set up
// on the admin page (decided Nov 1, 2026).
//
// A brand pays What's Up Trivia upfront to run a sponsored Party on chosen
// TVs, or on every TV in chosen states, for a set period. The brand is the
// host and never plays; a player in the room becomes co-host and runs the
// game (later steps). Today's Party stays available everywhere, unchanged.
//
// WHAT THIS STEP DOES. Everything a campaign needs before it can reach a TV:
//   * the brand: names, tagline, offer, colours
//   * when: start and end, typed and shown in Lagos time
//   * where: TVs chosen by name, and/or Nigerian states (a TV's state comes
//     from its approximate place, which is worked out from its internet
//     address and is close to city level)
//   * the question category, and whether it also appears among everyone's
//     categories (by default a campaign's category is kept for the campaign)
//   * the prize rules: what is won (cash or an item), on what basis (per
//     game, per TV per day, or a leaderboard), and the limits
//   * the terms players agree to, and which details the brand may see
//   * the artwork, approved by an admin before it can be shown
//   * the money paid in, by Super Admins and Finance Officers only
//   * publish, pause, resume, end, and pin
// Nothing in this step is shown on a TV or a phone.
//
// STATE. status is what an admin did: draft, published, paused, ended.
// Whether a published campaign is waiting, live or finished follows from its
// dates (stateOf), so nothing has to switch it at midnight.
//
// CHANGES AFTER PUBLISHING. A campaign can still be corrected while it runs.
// A change to the terms, or to what players share, makes a new terms
// version, which players will have to accept again (step 3). An ended
// campaign can no longer be changed, except its internal notes.
//
// MONEY IS NEVER DELETED. Each payment received is one row; a mistake is put
// right with a correction (a negative amount, with a note), and the total
// can never go below nothing.
//
// One rule reaches today's Party already: a campaign's category is kept out
// of the categories every TV offers, unless the campaign says otherwise
// (reservedCategories, read by tv-party.service).
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');
const tvAuth = require('./tv-auth.service');
const { NIGERIAN_STATES } = require('../utils/ng-places');
const { parseAdminTime } = require('../utils/lagos-time');

const STATUSES = ['draft', 'published', 'paused', 'ended'];
const BASES = ['none', 'per_game', 'per_tv_day', 'leaderboard'];
const PRIZE_TYPES = ['cash', 'item'];
const PERIODS = ['campaign', 'week', 'day'];
const SHARED_FIELDS = ['username', 'city'];                                  // never email or phone
const WINNER_FIELDS = ['full_name', 'username', 'city', 'email', 'phone'];
const PRIZE_MIN = 100;
const PRIZE_MAX = 1000000;
const MAX_RANKS = 10;
const RESERVED_CACHE_MS = 15 * 1000;
const ACTIVE_TV_DAYS = 30;

// The artwork. Every picture but the logo is 16:9 and drawn full width, so it
// is checked for that shape and a size that stays sharp on a TV. The logo is
// a PNG (it sits on the brand's colours, so it needs a see-through
// background).
const ART = Object.freeze({
    logo:  { label: 'Logo', required: true, formats: ['png'], minW: 400, minH: 100, ratio: null,
             help: 'PNG with a see-through background, at least 400 pixels wide.' },
    tile:  { label: 'Home-screen tile', required: true, formats: ['png', 'jpg'], minW: 960, minH: 540, ratio: 16 / 9,
             help: '16:9, at least 960 × 540. Shown in the branded parties row on the TV home screen.' },
    lobby: { label: 'Lobby background', required: true, formats: ['png', 'jpg'], minW: 1920, minH: 1080, ratio: 16 / 9,
             help: '16:9, at least 1920 × 1080. Behind the join code while players arrive.' },
    card:  { label: 'Sponsor card', required: true, formats: ['png', 'jpg'], minW: 1920, minH: 1080, ratio: 16 / 9,
             help: '16:9, at least 1920 × 1080. Shown for a few seconds after every 3rd question.' },
    slide: { label: 'Leaderboard slide', required: false, formats: ['png', 'jpg'], minW: 1920, minH: 1080, ratio: 16 / 9,
             help: '16:9, at least 1920 × 1080. Optional: without it the lobby background is used.' }
});
const MAX_ART_BYTES = 8 * 1024 * 1024;

const STATE_SET = new Map(NIGERIAN_STATES.map(s => [s.toLowerCase(), s]));

/** The Nigerian state a TV's approximate place is in, or null ("Outside Nigeria", unknown). */
function stateFromPlace(place) {
    if (!place) return null;
    const parts = String(place).split(',');
    let s = parts[parts.length - 1].replace(/\(.*?\)/g, '').replace(/\bstate\b/i, '').trim().toLowerCase();
    if (s === 'abuja' || s === 'federal capital territory') s = 'fct';
    return STATE_SET.get(s) || null;
}

const clean = (v, max) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const s = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    return s ? s.slice(0, max) : null;
};
const oneLine = (v, max) => {
    const s = clean(v, max * 2);
    return s == null ? s : s.replace(/\s+/g, ' ').slice(0, max);
};
const colour = v => {
    const s = String(v || '').trim().toUpperCase();
    return /^#[0-9A-F]{6}$/.test(s) ? s : null;
};
const intOrNull = v => (v === null || v === '' || v === undefined) ? null : Number(v);

class TvCampaignService {

    constructor() {
        this._reserved = null;
        this._reservedAt = 0;
        this.storage = null;      // the Cloudinary service, loaded on first use (tests set a double)
        this.categories = null;   // the Party category report, loaded on first use (tests set a double)
    }

    _storage() {
        if (!this.storage) {
            try { this.storage = require('./cloudinary.service'); } catch (e) { this.storage = null; }
        }
        return this.storage;
    }

    async _categoryReport() {
        if (this.categories) return this.categories();
        // Loaded here, not at the top: tv-party.service reads reservedCategories from this file.
        return require('./tv-party.service').categoryReport();
    }

    // ============================================
    // STATE
    // ============================================

    /** draft | scheduled | live | finished | paused | ended. */
    stateOf(c, now = new Date()) {
        if (!c) return null;
        if (c.status === 'draft' || c.status === 'paused' || c.status === 'ended') return c.status;
        const t = now.getTime();
        if (c.starts_at && t < new Date(c.starts_at).getTime()) return 'scheduled';
        if (c.ends_at && t >= new Date(c.ends_at).getTime()) return 'finished';
        return 'live';
    }

    // ============================================
    // READ
    // ============================================

    async list() {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `SELECT c.*,
                    (SELECT COUNT(*)::int FROM tv_campaign_tvs t WHERE t.campaign_id = c.id) AS tv_count,
                    (SELECT COALESCE(SUM(f.amount), 0)::int FROM tv_campaign_funds f WHERE f.campaign_id = c.id) AS funded
             FROM tv_campaigns c
             ORDER BY c.pinned DESC, c.created_at DESC
             LIMIT 300`
        );
        const now = new Date();
        return { ok: true, campaigns: r.rows.map(c => this._summary(c, now)) };
    }

    _summary(c, now) {
        return {
            id: c.id, name: c.name, brandName: c.brand_name, status: c.status, state: this.stateOf(c, now),
            startsAt: c.starts_at, endsAt: c.ends_at, pinned: c.pinned, regions: c.regions || [],
            tvCount: c.tv_count || 0, category: c.category, prizeBasis: c.prize_basis, prizeType: c.prize_type,
            funded: c.funded || 0, updatedAt: c.updated_at
        };
    }

    async get(id) {
        await tvAuth.ensureSchema();
        const c = await this._row(id);
        if (!c) return { ok: false, error: 'No such campaign' };
        const [tvs, art, funds] = await Promise.all([
            pool.query(
                `SELECT d.id, d.tv_name, d.admin_name, d.approx_location, d.venue, d.last_seen, d.blocked
                 FROM tv_campaign_tvs t JOIN tv_devices d ON d.id = t.tv_device_id
                 WHERE t.campaign_id = $1 ORDER BY d.id`, [c.id]),
            pool.query(`SELECT * FROM tv_campaign_art WHERE campaign_id = $1`, [c.id]),
            pool.query(`SELECT * FROM tv_campaign_funds WHERE campaign_id = $1 ORDER BY recorded_at, id`, [c.id])
        ]);
        const campaign = this._full(c, tvs.rows, art.rows, funds.rows);
        campaign.reach = await this._reach(c, tvs.rows.map(t => t.id));
        campaign.checklist = await this._checklist(c, tvs.rows, art.rows, campaign.funded);
        campaign.publishable = campaign.checklist.every(x => x.ok || x.warning);
        return { ok: true, campaign };
    }

    async _row(id) {
        const n = Number(id);
        if (!Number.isInteger(n) || n <= 0) return null;
        const r = await pool.query(`SELECT * FROM tv_campaigns WHERE id = $1`, [n]);
        return r.rows[0] || null;
    }

    _full(c, tvs, art, funds) {
        const funded = funds.reduce((a, f) => a + Number(f.amount), 0);
        const artBySlot = {};
        for (const a of art) {
            artBySlot[a.slot] = {
                url: a.url, width: a.width, height: a.height, bytes: a.bytes, format: a.format,
                uploadedBy: a.uploaded_by, uploadedAt: a.uploaded_at, approvedBy: a.approved_by, approvedAt: a.approved_at
            };
        }
        return {
            id: c.id, name: c.name, brandName: c.brand_name, tagline: c.tagline, offerText: c.offer_text, offerUrl: c.offer_url,
            colourMain: c.colour_main, colourAccent: c.colour_accent,
            status: c.status, state: this.stateOf(c), startsAt: c.starts_at, endsAt: c.ends_at, pinned: c.pinned,
            regions: c.regions || [], category: c.category, categoryPublic: c.category_public,
            prizeBasis: c.prize_basis, prizeType: c.prize_type, prizeAmount: c.prize_amount, prizeItem: c.prize_item,
            prizeRanks: Array.isArray(c.prize_ranks) ? c.prize_ranks : [], leaderboardPeriod: c.leaderboard_period,
            minPlayers: c.min_players, capPerPlayer: c.cap_per_player, prizeGamesPerTvDay: c.prize_games_per_tv_day,
            minAgeToWin: c.min_age_to_win, forChildren: c.for_children,
            termsText: c.terms_text, termsVersion: c.terms_version,
            sharedFields: c.shared_fields || [], winnerFields: c.winner_fields || [],
            approvalReference: c.approval_reference, notes: c.notes,
            createdBy: c.created_by, createdAt: c.created_at, updatedBy: c.updated_by, updatedAt: c.updated_at,
            publishedBy: c.published_by, publishedAt: c.published_at, endedAt: c.ended_at,
            tvs: tvs.map(t => ({
                id: t.id, name: t.admin_name || t.tv_name || `TV ${t.id}`, place: t.approx_location || null,
                state: stateFromPlace(t.approx_location), venue: !!t.venue, lastSeen: t.last_seen, blocked: !!t.blocked
            })),
            art: artBySlot,
            funds: funds.map(f => ({
                id: f.id, amount: Number(f.amount), reference: f.reference, receivedOn: f.received_on, note: f.note,
                recordedBy: f.recorded_by, recordedAt: f.recorded_at
            })),
            funded,
            // Paid out and reserved come with the prizes (step 4). Until then, nothing.
            paidOut: 0, reserved: 0, left: funded
        };
    }

    /** How many TVs the campaign reaches today: chosen ones, and ones in its states seen in the last 30 days. */
    async _reach(c, chosenIds) {
        const r = await pool.query(
            `SELECT id, approx_location, last_seen, blocked FROM tv_devices
             WHERE blocked = false AND last_seen > NOW() - ($1 || ' days')::interval`,
            [String(ACTIVE_TV_DAYS)]
        );
        const states = new Set(c.regions || []);
        const chosen = new Set(chosenIds.map(Number));
        let inRegions = 0;
        const all = new Set();
        for (const d of r.rows) {
            const st = stateFromPlace(d.approx_location);
            if (st && states.has(st)) { inRegions++; all.add(d.id); }
            if (chosen.has(Number(d.id))) all.add(d.id);
        }
        return { chosen: chosen.size, inRegions, activeTotal: all.size, activeDays: ACTIVE_TV_DAYS };
    }

    /** What a campaign still needs before it can be published. A warning does not stop it. */
    async _checklist(c, tvs, art, funded) {
        const out = [];
        const add = (key, ok, text, warning = false) => out.push({ key, ok: !!ok, text, warning: !ok && warning });
        const now = Date.now();

        add('brand', c.name && c.brand_name, 'The campaign and brand names');
        const datesOk = c.starts_at && c.ends_at && new Date(c.ends_at) > new Date(c.starts_at) && new Date(c.ends_at).getTime() > now;
        add('dates', datesOk, 'A start and an end, with the end still to come');
        add('where', tvs.length > 0 || (c.regions || []).length > 0, 'At least one TV or one state');

        let catOk = false;
        if (c.category) {
            try {
                const rep = await this._categoryReport();
                const row = rep.find(x => String(x.category).toLowerCase() === String(c.category).toLowerCase());
                catOk = !!(row && row.ready);
            } catch (e) { catOk = false; }
        }
        add('questions', catOk, c.category
            ? `The ${c.category} category has enough questions for a full game`
            : 'A question category');

        const have = new Map(art.map(a => [a.slot, a]));
        for (const [slot, spec] of Object.entries(ART)) {
            if (!spec.required) continue;
            const a = have.get(slot);
            add(`art_${slot}`, a && a.approved_at, `${spec.label}: uploaded and approved`);
        }
        const slide = have.get('slide');
        if (slide && !slide.approved_at) add('art_slide', false, 'Leaderboard slide: approve it, or remove it');

        add('terms', c.terms_text && c.terms_text.trim().length >= 40, 'The terms players agree to');

        const prize = this._prizeProblem(c);
        add('prizes', !prize, prize || 'The prize rules');

        if (this.paysCash(c)) {
            const need = this.fundingNeeded(c);
            add('money', funded >= need.minimum,
                need.minimum > 0
                    ? `Money paid in covers ${need.what} (₦${need.minimum.toLocaleString('en-NG')}); paid in so far ₦${funded.toLocaleString('en-NG')}`
                    : 'Money paid in');
        }
        add('approval', !!c.approval_reference, 'The promotion approval reference (FCCPC), if one is needed', true);
        return out;
    }

    /**
     * The least the brand must have paid before a cash campaign can go live.
     * A leaderboard's prizes are known in advance, so all of them; a prize per
     * game or per TV per day, at least one.
     */
    fundingNeeded(c) {
        if (!this.paysCash(c)) return { minimum: 0, what: 'nothing' };
        if (c.prize_basis === 'leaderboard') {
            const each = (Array.isArray(c.prize_ranks) ? c.prize_ranks : []).reduce((a, r) => a + (Number(r.amount) || 0), 0);
            const periods = this._periods(c);
            return { minimum: each * periods, what: periods > 1 ? `every leaderboard prize, ${periods} times` : 'every leaderboard prize' };
        }
        return { minimum: Number(c.prize_amount) || 0, what: 'at least one prize' };
    }

    /** Does the campaign pay any prize in cash? A leaderboard may mix cash and items by place. */
    paysCash(c) {
        if (!c || c.prize_basis === 'none') return false;
        if (c.prize_basis === 'leaderboard') {
            return (Array.isArray(c.prize_ranks) ? c.prize_ranks : []).some(r => Number(r.amount) > 0);
        }
        return c.prize_type === 'cash';
    }

    _periods(c) {
        if (c.leaderboard_period === 'campaign' || !c.starts_at || !c.ends_at) return 1;
        const span = new Date(c.ends_at) - new Date(c.starts_at);
        const unit = c.leaderboard_period === 'day' ? 864e5 : 7 * 864e5;
        return Math.max(1, Math.ceil(span / unit));
    }

    _prizeProblem(c) {
        if (c.prize_basis === 'none') return null;
        if (c.prize_basis === 'leaderboard') {
            const ranks = Array.isArray(c.prize_ranks) ? c.prize_ranks : [];
            if (!ranks.length) return 'The leaderboard needs at least one prize';
            if (!c.leaderboard_period) return 'Choose how long each leaderboard runs';
            return null;
        }
        if (c.prize_type === 'cash' && !c.prize_amount) return 'Enter the prize amount';
        if (c.prize_type === 'item' && !c.prize_item) return 'Describe the prize';
        return null;
    }

    // ============================================
    // CREATE, CHANGE, DELETE
    // ============================================

    async create({ name, brandName } = {}, admin) {
        await tvAuth.ensureSchema();
        const n = oneLine(name, 60);
        const b = oneLine(brandName, 40);
        if (!n || n.length < 3) return { ok: false, error: 'Give the campaign a name of at least 3 letters' };
        if (!b || b.length < 2) return { ok: false, error: "Enter the brand's name" };
        const r = await pool.query(
            `INSERT INTO tv_campaigns (name, brand_name, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
            [n, b, admin || 'admin']
        );
        return { ok: true, id: r.rows[0].id };
    }

    /**
     * Change any of a campaign's own fields. Only what is sent is changed.
     * Refused, with the reason, if a value does not make sense.
     */
    async update(id, body = {}, admin) {
        await tvAuth.ensureSchema();
        const c = await this._row(id);
        if (!c) return { ok: false, error: 'No such campaign' };
        const ended = c.status === 'ended';
        const set = {};
        const err = (e) => ({ ok: false, error: e });

        if (ended) {
            if (Object.keys(body).some(k => k !== 'notes')) return err('An ended campaign can no longer be changed, except its notes');
        }

        if (body.name !== undefined) {
            const v = oneLine(body.name, 60);
            if (!v || v.length < 3) return err('Give the campaign a name of at least 3 letters');
            set.name = v;
        }
        if (body.brandName !== undefined) {
            const v = oneLine(body.brandName, 40);
            if (!v || v.length < 2) return err("Enter the brand's name");
            set.brand_name = v;
        }
        if (body.tagline !== undefined) set.tagline = oneLine(body.tagline, 80);
        if (body.offerText !== undefined) set.offer_text = oneLine(body.offerText, 120);
        if (body.offerUrl !== undefined) {
            const v = oneLine(body.offerUrl, 300);
            if (v && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(v)) return err('The offer link must be a full https:// address');
            set.offer_url = v;
        }
        for (const [k, col] of [['colourMain', 'colour_main'], ['colourAccent', 'colour_accent']]) {
            if (body[k] !== undefined) {
                const v = colour(body[k]);
                if (!v) return err('Colours are written like #5B12FC');
                set[col] = v;
            }
        }

        // When. Typed in Lagos time.
        let starts = c.starts_at, ends = c.ends_at;
        if (body.startsAt !== undefined) {
            starts = body.startsAt ? parseAdminTime(body.startsAt) : null;
            if (body.startsAt && !starts) return err('The start is not a date and time');
            set.starts_at = starts;
        }
        if (body.endsAt !== undefined) {
            ends = body.endsAt ? parseAdminTime(body.endsAt) : null;
            if (body.endsAt && !ends) return err('The end is not a date and time');
            set.ends_at = ends;
        }
        if (starts && ends && new Date(ends) <= new Date(starts)) return err('The end must come after the start');

        // Where: states. Chosen TVs have their own call (setTvs).
        if (body.regions !== undefined) {
            if (!Array.isArray(body.regions)) return err('States must be a list');
            const out = [];
            for (const s of body.regions) {
                const st = STATE_SET.get(String(s).trim().toLowerCase());
                if (!st) return err(`${String(s).slice(0, 30)} is not a Nigerian state`);
                if (!out.includes(st)) out.push(st);
            }
            set.regions = out.sort();
        }

        // Questions.
        if (body.category !== undefined) {
            const v = body.category ? String(body.category).trim().toLowerCase().slice(0, 60) : null;
            if (v) {
                const rep = await this._categoryReport();
                if (!rep.some(x => String(x.category).toLowerCase() === v)) return err('That category is not in the question bank');
            }
            set.category = v;
        }
        if (body.categoryPublic !== undefined) set.category_public = body.categoryPublic === true;

        // Prizes.
        if (body.prizeBasis !== undefined) {
            if (!BASES.includes(body.prizeBasis)) return err('Choose how the prize is won');
            set.prize_basis = body.prizeBasis;
        }
        if (body.prizeType !== undefined) {
            if (!PRIZE_TYPES.includes(body.prizeType)) return err('Choose cash or an item');
            set.prize_type = body.prizeType;
        }
        if (body.prizeAmount !== undefined) {
            const v = intOrNull(body.prizeAmount);
            if (v !== null && (!Number.isInteger(v) || v < PRIZE_MIN || v > PRIZE_MAX)) {
                return err(`A cash prize is between ₦${PRIZE_MIN.toLocaleString('en-NG')} and ₦${PRIZE_MAX.toLocaleString('en-NG')}, in whole naira`);
            }
            set.prize_amount = v;
        }
        if (body.prizeItem !== undefined) set.prize_item = oneLine(body.prizeItem, 120);
        if (body.leaderboardPeriod !== undefined) {
            if (body.leaderboardPeriod !== null && !PERIODS.includes(body.leaderboardPeriod)) return err('Choose how long each leaderboard runs');
            set.leaderboard_period = body.leaderboardPeriod;
        }
        if (body.prizeRanks !== undefined) {
            const v = this._ranks(body.prizeRanks);
            if (v.error) return err(v.error);
            set.prize_ranks = JSON.stringify(v.ranks);
        }
        const limits = [
            ['minPlayers', 'min_players', 2, 20, false, 'A prize game needs between 2 and 20 signed-in players'],
            ['capPerPlayer', 'cap_per_player', 1, 1000, true, 'The most prizes one player can win is a number from 1 to 1,000, or blank for no limit'],
            ['prizeGamesPerTvDay', 'prize_games_per_tv_day', 1, 200, true, 'Prize games per TV per day is a number from 1 to 200, or blank for no limit'],
            ['minAgeToWin', 'min_age_to_win', 13, 18, false, 'The age to win is between 13 and 18']
        ];
        for (const [k, col, lo, hi, nullable, msg] of limits) {
            if (body[k] === undefined) continue;
            const v = intOrNull(body[k]);
            if (v === null && nullable) { set[col] = null; continue; }
            if (!Number.isInteger(v) || v < lo || v > hi) return err(msg);
            set[col] = v;
        }
        if (body.forChildren !== undefined) set.for_children = body.forChildren === true;
        const age = set.min_age_to_win !== undefined ? set.min_age_to_win : c.min_age_to_win;
        const kids = set.for_children !== undefined ? set.for_children : c.for_children;
        if (age < 18 && !kids) return err('Winners must be 18 or over, unless the campaign is set up for children and says so');

        // Terms and what players share.
        if (body.termsText !== undefined) set.terms_text = clean(body.termsText, 6000);
        if (body.sharedFields !== undefined) {
            const v = this._fields(body.sharedFields, SHARED_FIELDS);
            if (!v) return err('Every player can only share their username and city with a brand');
            set.shared_fields = v;
        }
        if (body.winnerFields !== undefined) {
            const v = this._fields(body.winnerFields, WINNER_FIELDS);
            if (!v) return err('Unknown winner detail');
            set.winner_fields = v;
        }
        if (body.approvalReference !== undefined) set.approval_reference = oneLine(body.approvalReference, 80);
        if (body.notes !== undefined) set.notes = clean(body.notes, 1000);

        // Only what really changes is written (and logged): the page sends a whole section at a time.
        const same = (col, v) => {
            const was = c[col];
            if (col === 'prize_ranks') return JSON.stringify(Array.isArray(was) ? was : []) === v;
            if (v instanceof Date || was instanceof Date) return !!v && !!was && new Date(v).getTime() === new Date(was).getTime();
            if (Array.isArray(v) || Array.isArray(was)) return String(v || []) === String(was || []);
            return (v === undefined ? null : v) === (was === undefined ? null : was);
        };
        for (const col of Object.keys(set)) if (same(col, set[col])) delete set[col];
        const cols = Object.keys(set);
        if (!cols.length) return { ok: true, changed: [] };

        // Players accept the terms as they stand. After publishing, a change
        // to the terms or to what they share is a new version to accept.
        const termsChanged = c.status !== 'draft' && (
            (set.terms_text !== undefined && set.terms_text !== c.terms_text) ||
            (set.shared_fields !== undefined && String(set.shared_fields) !== String(c.shared_fields || [])) ||
            (set.winner_fields !== undefined && String(set.winner_fields) !== String(c.winner_fields || [])));

        const params = [c.id];
        const parts = cols.map(col => {
            params.push(set[col]);
            return `${col} = $${params.length}${col === 'prize_ranks' ? '::jsonb' : ''}`;
        });
        params.push(admin || 'admin');
        parts.push(`updated_by = $${params.length}`, 'updated_at = NOW()');
        if (termsChanged) parts.push('terms_version = terms_version + 1');
        await pool.query(`UPDATE tv_campaigns SET ${parts.join(', ')} WHERE id = $1`, params);
        this._reserved = null;
        return { ok: true, changed: cols, termsVersionRaised: termsChanged };
    }

    _fields(v, allowed) {
        if (!Array.isArray(v)) return null;
        const out = [];
        for (const f of v) {
            if (!allowed.includes(f)) return null;
            if (!out.includes(f)) out.push(f);
        }
        return allowed.filter(f => out.includes(f));
    }

    _ranks(v) {
        if (!Array.isArray(v)) return { error: 'The leaderboard prizes must be a list' };
        if (v.length > MAX_RANKS) return { error: `At most ${MAX_RANKS} places can win` };
        const ranks = [];
        for (let i = 0; i < v.length; i++) {
            const r = v[i] || {};
            const amount = intOrNull(r.amount);
            const item = oneLine(r.item, 120);
            if (amount === null && !item) return { error: `Place ${i + 1} needs an amount or an item` };
            if (amount !== null && (!Number.isInteger(amount) || amount < PRIZE_MIN || amount > PRIZE_MAX)) {
                return { error: `Place ${i + 1}: a cash prize is between ₦${PRIZE_MIN.toLocaleString('en-NG')} and ₦${PRIZE_MAX.toLocaleString('en-NG')}` };
            }
            ranks.push(amount !== null ? { rank: i + 1, amount } : { rank: i + 1, item });
        }
        return { ranks };
    }

    /** The TVs chosen by name. Replaces the list. */
    async setTvs(id, tvIds, admin) {
        await tvAuth.ensureSchema();
        const c = await this._row(id);
        if (!c) return { ok: false, error: 'No such campaign' };
        if (c.status === 'ended') return { ok: false, error: 'An ended campaign can no longer be changed' };
        if (!Array.isArray(tvIds) || tvIds.length > 2000) return { ok: false, error: 'TVs must be a list' };
        const ids = [...new Set(tvIds.map(Number))];
        if (ids.some(n => !Number.isInteger(n) || n <= 0)) return { ok: false, error: 'Unknown TV' };
        if (ids.length) {
            const r = await pool.query(`SELECT id FROM tv_devices WHERE id = ANY($1::int[])`, [ids]);
            if (r.rows.length !== ids.length) return { ok: false, error: 'One of those TVs is not registered' };
        }
        await pool.query(`DELETE FROM tv_campaign_tvs WHERE campaign_id = $1 AND NOT (tv_device_id = ANY($2::int[]))`, [c.id, ids]);
        if (ids.length) {
            await pool.query(
                `INSERT INTO tv_campaign_tvs (campaign_id, tv_device_id)
                 SELECT $1, x FROM unnest($2::int[]) AS x
                 ON CONFLICT (campaign_id, tv_device_id) DO NOTHING`,
                [c.id, ids]
            );
        }
        await pool.query(`UPDATE tv_campaigns SET updated_by = $2, updated_at = NOW() WHERE id = $1`, [c.id, admin || 'admin']);
        return { ok: true, count: ids.length };
    }

    /** Only a draft that never had money recorded against it can be deleted. */
    async remove(id) {
        await tvAuth.ensureSchema();
        const c = await this._row(id);
        if (!c) return { ok: false, error: 'No such campaign' };
        if (c.status !== 'draft') return { ok: false, error: 'Only a draft can be deleted. End the campaign instead.' };
        const f = await pool.query(`SELECT COUNT(*)::int AS n FROM tv_campaign_funds WHERE campaign_id = $1`, [c.id]);
        if (f.rows[0].n > 0) return { ok: false, error: 'Money has been recorded against this campaign, so it is kept' };
        const art = await pool.query(`SELECT public_id FROM tv_campaign_art WHERE campaign_id = $1`, [c.id]);
        await pool.query(`DELETE FROM tv_campaigns WHERE id = $1 AND status = 'draft'`, [c.id]);
        this._reserved = null;
        const st = this._storage();
        for (const a of art.rows) if (st && st.deleteTvCampaignArt) await st.deleteTvCampaignArt(a.public_id);
        return { ok: true };
    }

    // ============================================
    // ARTWORK
    // ============================================

    artSpec() {
        return Object.entries(ART).map(([slot, s]) => ({ slot, label: s.label, required: s.required, help: s.help,
            formats: s.formats, minWidth: s.minW, minHeight: s.minH, ratio: s.ratio ? '16:9' : null }));
    }

    async signArtUpload(id) {
        const c = await this._row(id);
        if (!c) return { ok: false, error: 'No such campaign' };
        if (c.status === 'ended') return { ok: false, error: 'An ended campaign can no longer be changed' };
        const st = this._storage();
        const signed = st && st.signTvCampaignUpload ? st.signTvCampaignUpload(c.id) : null;
        if (!signed) return { ok: false, error: 'Picture hosting is not set up. Set CLOUDINARY_URL on the server.' };
        return { ok: true, ...signed };
    }

    /** Is this a picture in OUR Cloudinary account, in THIS campaign's folder, with this public id? */
    _ours(campaignId, url, publicId) {
        const st = this._storage();
        const cloud = st && st.cloudName && st.cloudName();
        const folder = st && st.tvCampaignFolder ? st.tvCampaignFolder(campaignId) : null;
        if (!cloud || !folder || !publicId) return false;
        let u;
        try { u = new URL(String(url)); } catch (e) { return false; }
        if (u.protocol !== 'https:' || u.hostname !== 'res.cloudinary.com') return false;
        if (!u.pathname.startsWith(`/${cloud}/image/upload/`)) return false;
        if (!String(publicId).startsWith(folder + '/')) return false;
        return u.pathname.includes('/' + publicId);
    }

    /**
     * Record a picture the admin page has just uploaded to Cloudinary. It
     * replaces the slot's picture (whose file is then deleted) and waits for
     * an admin's approval.
     */
    async saveArt(id, slot, { url, publicId, width, height, bytes, format } = {}, admin) {
        await tvAuth.ensureSchema();
        const c = await this._row(id);
        if (!c) return { ok: false, error: 'No such campaign' };
        if (c.status === 'ended') return { ok: false, error: 'An ended campaign can no longer be changed' };
        const spec = ART[slot];
        if (!spec) return { ok: false, error: 'Unknown picture' };
        if (!this._ours(c.id, url, publicId)) return { ok: false, error: "That picture is not in this campaign's folder" };
        const refuse = async (error) => {
            // The file is already in our account: delete it, so nothing refused is left behind costing storage.
            const st = this._storage();
            if (st && st.deleteTvCampaignArt) await st.deleteTvCampaignArt(String(publicId));
            return { ok: false, error };
        };
        const fmt = String(format || '').toLowerCase() === 'jpeg' ? 'jpg' : String(format || '').toLowerCase();
        if (!spec.formats.includes(fmt)) return refuse(`${spec.label} must be ${spec.formats.map(f => f.toUpperCase()).join(' or ')}`);
        const w = Number(width), h = Number(height), b = bytes == null ? null : Number(bytes);
        if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return refuse('The picture size is missing');
        if (b !== null && (!Number.isInteger(b) || b <= 0)) return refuse('The picture size is missing');
        if (b !== null && b > MAX_ART_BYTES) return refuse('Pictures must be under 8 MB');
        if (w < spec.minW || h < spec.minH) return refuse(`${spec.label} must be at least ${spec.minW} × ${spec.minH} pixels; this one is ${w} × ${h}`);
        if (spec.ratio && Math.abs(w / h - spec.ratio) > 0.01 * spec.ratio) {
            return refuse(`${spec.label} must be 16:9 (like 1920 × 1080); this one is ${w} × ${h}`);
        }
        const old = await pool.query(`SELECT public_id FROM tv_campaign_art WHERE campaign_id = $1 AND slot = $2`, [c.id, slot]);
        await pool.query(
            `INSERT INTO tv_campaign_art (campaign_id, slot, url, public_id, width, height, bytes, format, uploaded_by, uploaded_at, approved_by, approved_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NULL, NULL)
             ON CONFLICT (campaign_id, slot) DO UPDATE SET
                url = EXCLUDED.url, public_id = EXCLUDED.public_id, width = EXCLUDED.width, height = EXCLUDED.height,
                bytes = EXCLUDED.bytes, format = EXCLUDED.format, uploaded_by = EXCLUDED.uploaded_by,
                uploaded_at = NOW(), approved_by = NULL, approved_at = NULL`,
            [c.id, slot, String(url), String(publicId), w, h, b, fmt, admin || 'admin']
        );
        const before = old.rows[0] && old.rows[0].public_id;
        if (before && before !== publicId) {
            const st = this._storage();
            if (st && st.deleteTvCampaignArt) await st.deleteTvCampaignArt(before);
        }
        return { ok: true };
    }

    async approveArt(id, slot, admin) {
        await tvAuth.ensureSchema();
        const c = await this._row(id);
        if (!c) return { ok: false, error: 'No such campaign' };
        if (!ART[slot]) return { ok: false, error: 'Unknown picture' };
        const r = await pool.query(
            `UPDATE tv_campaign_art SET approved_by = $3, approved_at = NOW()
             WHERE campaign_id = $1 AND slot = $2 RETURNING slot`,
            [c.id, slot, admin || 'admin']
        );
        if (!r.rows.length) return { ok: false, error: 'Upload the picture first' };
        return { ok: true };
    }

    async removeArt(id, slot) {
        await tvAuth.ensureSchema();
        const c = await this._row(id);
        if (!c) return { ok: false, error: 'No such campaign' };
        if (c.status === 'ended') return { ok: false, error: 'An ended campaign can no longer be changed' };
        if (!ART[slot]) return { ok: false, error: 'Unknown picture' };
        if (ART[slot].required && c.status !== 'draft') {
            return { ok: false, error: 'A published campaign needs this picture. Upload a replacement instead.' };
        }
        const r = await pool.query(`DELETE FROM tv_campaign_art WHERE campaign_id = $1 AND slot = $2 RETURNING public_id`, [c.id, slot]);
        if (!r.rows.length) return { ok: true };
        const st = this._storage();
        if (st && st.deleteTvCampaignArt) await st.deleteTvCampaignArt(r.rows[0].public_id);
        return { ok: true };
    }

    // ============================================
    // MONEY
    // ============================================

    /**
     * A payment from the brand, as it arrived in our account. A correction is
     * a negative amount with a note, and can never take the total below
     * nothing.
     */
    async addFunds(id, { amount, reference, receivedOn, note } = {}, admin) {
        await tvAuth.ensureSchema();
        const c = await this._row(id);
        if (!c) return { ok: false, error: 'No such campaign' };
        const a = Number(amount);
        if (!Number.isInteger(a) || a === 0 || Math.abs(a) > 100000000) return { ok: false, error: 'Enter the amount in whole naira' };
        const ref = oneLine(reference, 80);
        if (!ref || ref.length < 2) return { ok: false, error: 'Enter the payment reference (as on the bank statement)' };
        const day = String(receivedOn || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(new Date(day + 'T00:00:00Z'))) return { ok: false, error: 'Enter the date the money arrived' };
        if (new Date(day + 'T00:00:00Z').getTime() > Date.now() + 864e5) return { ok: false, error: 'The money cannot arrive in the future' };
        const n = clean(note, 300);
        if (a < 0 && !n) return { ok: false, error: 'A correction needs a note saying why' };
        if (a < 0) {
            const t = await pool.query(`SELECT COALESCE(SUM(amount), 0)::int AS total FROM tv_campaign_funds WHERE campaign_id = $1`, [c.id]);
            if (t.rows[0].total + a < 0) return { ok: false, error: 'A correction cannot take the total below nothing' };
        }
        const r = await pool.query(
            `INSERT INTO tv_campaign_funds (campaign_id, amount, reference, received_on, note, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [c.id, a, ref, day, n, admin || 'admin']
        );
        return { ok: true, id: r.rows[0].id };
    }

    // ============================================
    // PUBLISH, PAUSE, RESUME, END, PIN
    // ============================================

    async publish(id, admin) {
        const got = await this.get(id);
        if (!got.ok) return got;
        const c = got.campaign;
        if (c.status !== 'draft') return { ok: false, error: 'Already published' };
        const missing = c.checklist.filter(x => !x.ok && !x.warning);
        if (missing.length) return { ok: false, error: 'Not ready yet: ' + missing.map(x => x.text).join('; '), checklist: c.checklist };
        const r = await pool.query(
            `UPDATE tv_campaigns SET status = 'published', published_by = $2, published_at = NOW(), updated_by = $2, updated_at = NOW()
             WHERE id = $1 AND status = 'draft' RETURNING id`,
            [c.id, admin || 'admin']
        );
        if (!r.rows.length) return { ok: false, error: 'Already published' };
        return { ok: true };
    }

    async _move(id, from, to, admin, why) {
        await tvAuth.ensureSchema();
        const c = await this._row(id);
        if (!c) return { ok: false, error: 'No such campaign' };
        if (!from.includes(c.status)) return { ok: false, error: why };
        const r = await pool.query(
            `UPDATE tv_campaigns SET status = $2, updated_by = $3, updated_at = NOW()${to === 'ended' ? ', ended_at = NOW()' : ''}
             WHERE id = $1 AND status = ANY($4::text[]) RETURNING id`,
            [c.id, to, admin || 'admin', from]
        );
        if (!r.rows.length) return { ok: false, error: why };
        return { ok: true };
    }

    pause(id, admin) { return this._move(id, ['published'], 'paused', admin, 'Only a published campaign can be paused'); }
    resume(id, admin) { return this._move(id, ['paused'], 'published', admin, 'Only a paused campaign can be resumed'); }
    end(id, admin) { return this._move(id, ['published', 'paused'], 'ended', admin, 'Only a published or paused campaign can be ended'); }

    async pin(id, pinned, admin) {
        await tvAuth.ensureSchema();
        const c = await this._row(id);
        if (!c) return { ok: false, error: 'No such campaign' };
        await pool.query(`UPDATE tv_campaigns SET pinned = $2, updated_by = $3, updated_at = NOW() WHERE id = $1`, [c.id, pinned === true, admin || 'admin']);
        return { ok: true, pinned: pinned === true };
    }

    // ============================================
    // FOR THE REST OF WUT TV
    // ============================================

    /**
     * Categories kept for their campaigns: not offered in everyone's Party,
     * the Categories tile or Solo's category mix. Lower case. Never throws;
     * if the database cannot be read, the last known list is kept.
     */
    async reservedCategories() {
        if (this._reserved && Date.now() - this._reservedAt < RESERVED_CACHE_MS) return this._reserved;
        try {
            await tvAuth.ensureSchema();
            const r = await pool.query(
                `SELECT DISTINCT LOWER(category) AS category, MIN(name) AS campaign FROM tv_campaigns
                 WHERE category IS NOT NULL AND category_public = false
                 GROUP BY LOWER(category)`
            );
            this._reserved = new Map(r.rows.map(x => [x.category, x.campaign]));
            this._reservedAt = Date.now();
        } catch (e) {
            logger.error(`TV campaigns: reserved categories could not be read: ${e.message}`);
            if (!this._reserved) this._reserved = new Map();
        }
        return this._reserved;
    }

    /** For the TV picker on the admin page: every registered TV, with its state. */
    async options() {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `SELECT id, tv_name, admin_name, approx_location, venue, platform, last_seen, blocked
             FROM tv_devices ORDER BY last_seen DESC LIMIT 2000`
        );
        const active = Date.now() - ACTIVE_TV_DAYS * 864e5;
        const perState = new Map(NIGERIAN_STATES.map(s => [s, 0]));
        const tvs = r.rows.map(d => {
            const st = stateFromPlace(d.approx_location);
            const recent = !d.blocked && d.last_seen && new Date(d.last_seen).getTime() > active;
            if (st && recent) perState.set(st, perState.get(st) + 1);
            return {
                id: d.id, name: d.admin_name || d.tv_name || `TV ${d.id}`, tvName: d.tv_name, adminName: d.admin_name,
                place: d.approx_location || null, state: st, venue: !!d.venue, platform: d.platform,
                lastSeen: d.last_seen, blocked: !!d.blocked, recent
            };
        });
        let categories = [];
        try {
            const rep = await this._categoryReport();
            const reserved = await this.reservedCategories();
            categories = rep.map(x => ({
                category: x.category, ready: !!x.ready, total: Number(x.total) || 0,
                offered: !!x.ready && x.on !== false && !reserved.has(String(x.category).toLowerCase()),
                campaign: reserved.get(String(x.category).toLowerCase()) || null
            }));
        } catch (e) {
            logger.error(`TV campaigns: categories could not be read: ${e.message}`);
        }
        return {
            ok: true, tvs, categories, activeDays: ACTIVE_TV_DAYS,
            states: NIGERIAN_STATES.map(s => ({ state: s, tvs: perState.get(s) })),
            art: this.artSpec(), sharedFields: SHARED_FIELDS, winnerFields: WINNER_FIELDS
        };
    }
}

module.exports = new TvCampaignService();
module.exports.TvCampaignService = TvCampaignService;
module.exports.stateFromPlace = stateFromPlace;
module.exports.ART = ART;
