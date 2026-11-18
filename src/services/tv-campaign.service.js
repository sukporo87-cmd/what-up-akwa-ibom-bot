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
//
// STEPS 2 AND 3 (Nov 1, 2026): ON THE TVS AND THE PHONES. At the end of this
// file, what the rest of WUT TV reads:
//   * which campaigns a TV may show now (availableFor): published, between
//     its start and end, and either chosen for that TV or running in the
//     state the TV is in. Pinned first, then by name. Searchable.
//   * what the TV shows of one (tvView) and what a phone shows (phoneView),
//     built here so nothing else decides what a brand's party says
//   * the artwork, served to the TVs from this server (artFile), approved
//     pictures only, resized by Cloudinary to what a TV needs
//   * the terms, and each player's agreement to them (consent), which a
//     player gives once per terms version before their first game
//   * the finder: a phone scans a QR code on the TV, searches, and opens a
//     campaign on that TV (startFinder and the finder* methods), held in
//     Redis for 30 minutes
//
// HOW WIDELY (Nov 1): a campaign's audience is 'chosen' (the TVs chosen by
// name and the states ticked), 'nigeria' (every TV placed in a Nigerian
// state, and any chosen by name) or 'all' (every TV, anywhere, including TVs
// abroad or with no known place: the widest reach). A cash campaign set to
// 'all' is warned about, not stopped: a promotion approved for Nigeria may
// not cover winners abroad.
//
// LIVE ROUNDS AND THE BRAND CUP (Nov 18): a campaign's kind is 'party'
// (today's), 'live' (ranked rounds at set times, on every TV in the area at
// once) or 'cup' (rounds in stages, ending in a final). The rounds are kept
// and run by tv-live-round.service; here are the campaign's own settings for
// them: the area each player types (city, state, country, or nothing), the
// cities or countries that count, the dispute window, where a cup's final is
// played, and the campaign's place in the TV home screen carousel. A TV is
// told each campaign's next round with the rest of the campaign (tvView).
//
// A TV IS CALLED what it is called everywhere else in WUT TV: the admin's
// name for it, else its owner's name for it, else the server's, else what
// it said it was when it registered (tvName below).
// ============================================

const crypto = require('crypto');
const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const tvAuth = require('./tv-auth.service');
const { NIGERIAN_STATES } = require('../utils/ng-places');
const { parseAdminTime } = require('../utils/lagos-time');
const campaignPrizes = require('./tv-campaign-prize.service');

const STATUSES = ['draft', 'published', 'paused', 'ended'];
const BASES = ['none', 'per_game', 'per_tv_day', 'leaderboard'];
const PRIZE_TYPES = ['cash', 'item'];
const PERIODS = ['campaign', 'week', 'day'];
// How widely a campaign reaches (028): the TVs chosen and states ticked; every
// TV in Nigeria (plus any chosen by name); or every TV, anywhere.
const AUDIENCES = ['chosen', 'nigeria', 'all'];
const SHARED_FIELDS = ['username', 'city'];                                  // never email or phone
const WINNER_FIELDS = ['full_name', 'username', 'city', 'email', 'phone'];
const PRIZE_MIN = 100;
const PRIZE_MAX = 1000000;
const MAX_RANKS = 10;
const RESERVED_CACHE_MS = 15 * 1000;
const ACTIVE_TV_DAYS = 30;
// Live Rounds and the Brand Cup (030)
const KINDS = ['party', 'live', 'cup'];
const AREA_UNITS = ['none', 'city', 'state', 'country'];
const FINAL_WHERE = ['home', 'venue'];
// Set by an admin, never by a player (Nov 18): the style of a campaign's
// everyday party (a Live Round has its own, per round), and how long each
// sponsor card stays on the TV.
const STYLES = ['standard', 'race'];
const SPONSOR_SECONDS_MIN = 3;
const SPONSOR_SECONDS_MAX = 30;
const SPONSOR_SECONDS_DEFAULT = 8;
const liveRounds = () => require('./tv-live-round.service');

// The artwork. Every picture but the logo is 16:9 and drawn full width, so it
// is checked for that shape and a size that stays sharp on a TV. The logo is
// a PNG (it sits on the brand's colours, so it needs a see-through
// background).
const ART = Object.freeze({
    logo:  { label: 'Logo', required: true, formats: ['png'], minW: 400, minH: 100, ratio: null,
             help: 'PNG with a see-through background, at least 400 pixels wide.' },
    tile:  { label: 'Home-screen tile', required: true, formats: ['png', 'jpg'], minW: 960, minH: 540, ratio: 16 / 9,
             help: '16:9, at least 960 × 540. Shown in the campaigns row on the TV home screen.' },
    lobby: { label: 'Lobby background', required: true, formats: ['png', 'jpg'], minW: 1920, minH: 1080, ratio: 16 / 9,
             help: '16:9, at least 1920 × 1080. Behind the join code while players arrive.' },
    card:  { label: 'Sponsor card', required: true, formats: ['png', 'jpg'], minW: 1920, minH: 1080, ratio: 16 / 9,
             help: '16:9, at least 1920 × 1080. Shown after every 3rd question, for the time set under Game.' },
    // Up to three more, shown in turn with the first (Nov 18): a brand can say
    // something different at each break. With fewer cards than breaks, they repeat.
    card2: { label: 'Sponsor card 2', required: false, formats: ['png', 'jpg'], minW: 1920, minH: 1080, ratio: 16 / 9,
             help: 'Optional. Shown at the 2nd break, then the cards take turns.' },
    card3: { label: 'Sponsor card 3', required: false, formats: ['png', 'jpg'], minW: 1920, minH: 1080, ratio: 16 / 9,
             help: 'Optional. Shown at the 3rd break.' },
    card4: { label: 'Sponsor card 4', required: false, formats: ['png', 'jpg'], minW: 1920, minH: 1080, ratio: 16 / 9,
             help: 'Optional. Shown at the 4th break.' },
    slide: { label: 'Leaderboard slide', required: false, formats: ['png', 'jpg'], minW: 1920, minH: 1080, ratio: 16 / 9,
             help: '16:9, at least 1920 × 1080. Optional: without it the lobby background is used.' }
});
const MAX_ART_BYTES = 8 * 1024 * 1024;

// What the TVs are sent: each picture resized by Cloudinary to the most a TV
// draws it at, as a JPEG or PNG (a TV's browser may be years old), and kept in
// this server's memory once fetched.
const ART_WIDTH = Object.freeze({ logo: 800, tile: 960, lobby: 1920, card: 1920, card2: 1920, card3: 1920, card4: 1920, slide: 1920 });
const ART_CACHE_BYTES = 40 * 1024 * 1024;
const ART_FETCH_TIMEOUT_MS = 10000;

// The finder: a short code shown as a QR code on the TV.
const FINDER_TTL_SECONDS = 30 * 60;
const FINDER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const FINDER_LOOKS_PER_IP = 120;            // searches and picks from one network, per 10 minutes
const FINDER_WINDOW_SECONDS = 600;

const FIELD_WORDS = Object.freeze({
    username: 'your username', city: 'your city', full_name: 'your full name',
    email: 'your email address', phone: 'your phone number'
});
const naira = n => '\u20a6' + Number(n || 0).toLocaleString('en-NG');

const STATE_SET = new Map(NIGERIAN_STATES.map(s => [s.toLowerCase(), s]));

/** The Nigerian state a TV's approximate place is in, or null ("Outside Nigeria", unknown). */
function stateFromPlace(place) {
    if (!place) return null;
    const parts = String(place).split(',');
    let s = parts[parts.length - 1].replace(/\(.*?\)/g, '').replace(/\bstate\b/i, '').trim().toLowerCase();
    if (s === 'abuja' || s === 'federal capital territory') s = 'fct';
    return STATE_SET.get(s) || null;
}

/**
 * A TV's state, from the best source there is (032, Nov 18): an admin's
 * setting, else the last player's phone there, else its internet address.
 * The address alone is often wrong in Nigeria (mobile networks use the same
 * addresses across the country), so it is only the last resort.
 */
function tvState(row) {
    if (!row) return null;
    if (row.place_state && STATE_SET.has(String(row.place_state).toLowerCase())) return STATE_SET.get(String(row.place_state).toLowerCase());
    return stateFromPlace(row.approx_location);
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

/** A TV's name, in the order the rest of WUT TV uses (tv-admin, tv-audit, tv-identity). */
const tvName = d => d.admin_name || (d.details && d.details.ownName) || d.own_name || d.tv_name || d.label || `TV ${d.id}`;

class TvCampaignService {

    constructor() {
        this._reserved = null;
        this._reservedAt = 0;
        this.storage = null;      // the Cloudinary service, loaded on first use (tests set a double)
        this.categories = null;   // the Party category report, loaded on first use (tests set a double)
        this.http = null;         // axios, loaded on first use (tests set a double)
        this.artCache = new Map();  // url -> { body, type }
        this.artCacheBytes = 0;
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
            startsAt: c.starts_at, endsAt: c.ends_at, pinned: c.pinned, regions: c.regions || [], audience: c.audience || 'chosen',
            tvCount: c.tv_count || 0, category: c.category, prizeBasis: c.prize_basis, prizeType: c.prize_type,
            funded: c.funded || 0, updatedAt: c.updated_at, kind: c.kind || 'party', featuredOrder: c.featured_order || null
        };
    }

    async get(id) {
        await tvAuth.ensureSchema();
        const c = await this._row(id);
        if (!c) return { ok: false, error: 'No such campaign' };
        const [tvs, art, funds] = await Promise.all([
            pool.query(
                `SELECT d.id, d.tv_name, d.admin_name, d.details->>'ownName' AS own_name, d.label,
                        d.approx_location, d.place_state, d.place_source, d.venue, d.last_seen, d.blocked
                 FROM tv_campaign_tvs t JOIN tv_devices d ON d.id = t.tv_device_id
                 WHERE t.campaign_id = $1 ORDER BY d.id`, [c.id]),
            pool.query(`SELECT * FROM tv_campaign_art WHERE campaign_id = $1`, [c.id]),
            pool.query(`SELECT * FROM tv_campaign_funds WHERE campaign_id = $1 ORDER BY recorded_at, id`, [c.id])
        ]);
        const campaign = this._full(c, tvs.rows, art.rows, funds.rows);
        const money = await campaignPrizes.poolOf(c.id);
        Object.assign(campaign, { paidOut: money.paidOut, reserved: money.reserved, won: money.won, owed: money.owed, left: money.left });
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
            regions: c.regions || [], audience: c.audience || 'chosen', category: c.category, categoryPublic: c.category_public,
            prizeBasis: c.prize_basis, prizeType: c.prize_type, prizeAmount: c.prize_amount, prizeItem: c.prize_item,
            prizeRanks: Array.isArray(c.prize_ranks) ? c.prize_ranks : [], leaderboardPeriod: c.leaderboard_period,
            minPlayers: c.min_players, capPerPlayer: c.cap_per_player, prizeGamesPerTvDay: c.prize_games_per_tv_day,
            minAgeToWin: c.min_age_to_win, forChildren: c.for_children,
            termsText: c.terms_text, termsVersion: c.terms_version,
            sharedFields: c.shared_fields || [], winnerFields: c.winner_fields || [],
            approvalReference: c.approval_reference, notes: c.notes,
            kind: c.kind || 'party', areaUnit: c.area_unit || 'state', areaCities: c.area_cities || [], areaCountries: c.area_countries || [],
            disputeHours: c.dispute_hours || 48, finalWhere: c.final_where || 'home', featuredOrder: c.featured_order || null,
            style: STYLES.includes(c.style) ? c.style : 'standard', sponsorSeconds: this.sponsorSeconds(c),
            createdBy: c.created_by, createdAt: c.created_at, updatedBy: c.updated_by, updatedAt: c.updated_at,
            publishedBy: c.published_by, publishedAt: c.published_at, endedAt: c.ended_at,
            tvs: tvs.map(t => ({
                id: t.id, name: tvName(t), serverName: t.tv_name || null, place: t.approx_location || null,
                state: tvState(t), placeSource: t.place_source || null, venue: !!t.venue, lastSeen: t.last_seen, blocked: !!t.blocked
            })),
            art: artBySlot,
            funds: funds.map(f => ({
                id: f.id, amount: Number(f.amount), reference: f.reference, receivedOn: f.received_on, note: f.note,
                recordedBy: f.recorded_by, recordedAt: f.recorded_at
            })),
            funded,
            // Paid out, held for games in play, and left: filled in by get()
            // from the prizes (step 4).
            paidOut: 0, reserved: 0, won: 0, owed: 0, left: funded
        };
    }

    /**
     * How many TVs the campaign reaches today: chosen ones, and the ones its
     * area takes in (its states, every state, or everywhere) seen in the last
     * 30 days.
     */
    async _reach(c, chosenIds) {
        const r = await pool.query(
            `SELECT id, approx_location, place_state, last_seen, blocked FROM tv_devices
             WHERE blocked = false AND last_seen > NOW() - ($1 || ' days')::interval`,
            [String(ACTIVE_TV_DAYS)]
        );
        const states = new Set(c.regions || []);
        const audience = c.audience || 'chosen';
        const chosen = new Set(chosenIds.map(Number));
        let inRegions = 0;
        const all = new Set();
        for (const d of r.rows) {
            const st = tvState(d);
            const inArea = audience === 'all' || (st && (audience === 'nigeria' || states.has(st)));
            if (inArea) { inRegions++; all.add(d.id); }
            if (chosen.has(Number(d.id))) all.add(d.id);
        }
        return { audience, chosen: chosen.size, inRegions, activeTotal: all.size, activeDays: ACTIVE_TV_DAYS };
    }

    /** What a campaign still needs before it can be published. A warning does not stop it. */
    async _checklist(c, tvs, art, funded) {
        const out = [];
        const add = (key, ok, text, warning = false) => out.push({ key, ok: !!ok, text, warning: !ok && warning });
        const now = Date.now();

        add('brand', c.name && c.brand_name, 'The campaign and brand names');
        const datesOk = c.starts_at && c.ends_at && new Date(c.ends_at) > new Date(c.starts_at) && new Date(c.ends_at).getTime() > now;
        add('dates', datesOk, 'A start and an end, with the end still to come');
        add('where', (c.audience && c.audience !== 'chosen') || tvs.length > 0 || (c.regions || []).length > 0,
            'Every TV, every TV in Nigeria, or at least one TV or one state');

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
        // Live Rounds and the Brand Cup: the rounds, and the money their prizes need.
        if (c.kind && c.kind !== 'party') {
            try {
                for (const x of await liveRounds().checklist(c)) add(x.key, x.ok, x.text, x.warning);
                const rm = await liveRounds().roundsMoney(c.id);
                if (rm.cash > 0) {
                    const need = rm.cash + (this.paysCash(c) ? this.fundingNeeded(c).minimum : 0);
                    add('round_money', funded >= need,
                        `Money paid in covers the rounds' cash prizes${this.paysCash(c) ? ' and the everyday party prize' : ''} (₦${need.toLocaleString('en-NG')}); paid in so far ₦${funded.toLocaleString('en-NG')}`);
                }
            } catch (e) {
                add('rounds', false, `The rounds could not be read (${e.message})`);
            }
        }
        add('approval', !!c.approval_reference, 'The promotion approval reference (FCCPC), if one is needed', true);
        if (c.audience === 'all' && this.paysCash(c)) {
            add('abroad', false, 'Cash prizes on every TV, anywhere: TVs abroad or with no known place can win too. Check the promotion approval covers them, or choose every TV in Nigeria', true);
        }
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

        // How widely: the chosen TVs and states, every TV in Nigeria, or every TV.
        if (body.audience !== undefined) {
            if (!AUDIENCES.includes(body.audience)) return err('Choose where the campaign runs');
            set.audience = body.audience;
        }

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

        // Live Rounds and the Brand Cup (030).
        if (body.kind !== undefined && body.kind !== (c.kind || 'party')) {
            if (!KINDS.includes(body.kind)) return err('Choose the campaign type');
            if (c.status !== 'draft') return err('The campaign type can only be changed while it is a draft');
            const r = await pool.query(`SELECT COUNT(*)::int AS n FROM tv_live_rounds WHERE campaign_id = $1 AND status <> 'cancelled'`, [c.id]);
            if (body.kind === 'party' && r.rows[0].n > 0) return err('Cancel its rounds first: an everyday party has no rounds');
            set.kind = body.kind;
        }
        if (body.areaUnit !== undefined) {
            if (!AREA_UNITS.includes(body.areaUnit)) return err('Choose what players type: city, state, country, or nothing');
            set.area_unit = body.areaUnit;
        }
        const placeList = (v, max, what) => {
            if (!Array.isArray(v)) return { error: `${what} must be a list` };
            const out = [];
            for (const x of v) {
                const t = oneLine(x, 56);
                if (!t) continue;
                if (t.length < 2 || !/^[\p{L}][\p{L} .'()-]*$/u.test(t)) return { error: `"${String(x).slice(0, 30)}" is not a place name` };
                if (!out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t);
            }
            if (out.length > max) return { error: `At most ${max} ${what.toLowerCase()}` };
            return { list: out };
        };
        if (body.areaCities !== undefined) {
            const v = placeList(body.areaCities, 30, 'Cities');
            if (v.error) return err(v.error);
            set.area_cities = v.list;
        }
        if (body.areaCountries !== undefined) {
            const v = placeList(body.areaCountries, 60, 'Countries');
            if (v.error) return err(v.error);
            set.area_countries = v.list;
        }
        if (body.disputeHours !== undefined) {
            const v = intOrNull(body.disputeHours);
            if (!Number.isInteger(v) || v < 24 || v > 72) return err('The dispute window is between 24 and 72 hours');
            set.dispute_hours = v;
        }
        if (body.finalWhere !== undefined) {
            if (!FINAL_WHERE.includes(body.finalWhere)) return err('Choose where the final is played');
            set.final_where = body.finalWhere;
        }
        if (body.featuredOrder !== undefined) {
            const v = intOrNull(body.featuredOrder);
            if (v !== null && (!Number.isInteger(v) || v < 1 || v > 99)) return err('The place in the carousel is a number from 1 to 99, or blank');
            set.featured_order = v;
        }

        // The game (031): the everyday party's style, and the sponsor card's time.
        if (body.style !== undefined) {
            if (!STYLES.includes(body.style)) return err('Choose Standard or Race');
            set.style = body.style;
        }
        if (body.sponsorSeconds !== undefined) {
            const v = intOrNull(body.sponsorSeconds);
            if (!Number.isInteger(v) || v < SPONSOR_SECONDS_MIN || v > SPONSOR_SECONDS_MAX) {
                return err(`A sponsor card shows for ${SPONSOR_SECONDS_MIN} to ${SPONSOR_SECONDS_MAX} seconds`);
            }
            set.sponsor_seconds = v;
        }

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
        // A draft's rounds never started (a draft is on no TV), so they go with it.
        await pool.query(`DELETE FROM tv_live_rounds WHERE campaign_id = $1 AND status IN ('scheduled','cancelled')
                          AND EXISTS (SELECT 1 FROM tv_campaigns WHERE id = $1 AND status = 'draft')`, [c.id]);
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
            `SELECT id, tv_name, admin_name, details->>'ownName' AS own_name, label, approx_location, place_state, place_source,
                    venue, platform, last_seen, blocked
             FROM tv_devices ORDER BY last_seen DESC LIMIT 2000`
        );
        const active = Date.now() - ACTIVE_TV_DAYS * 864e5;
        const perState = new Map(NIGERIAN_STATES.map(s => [s, 0]));
        const tvs = r.rows.map(d => {
            const st = tvState(d);
            const recent = !d.blocked && d.last_seen && new Date(d.last_seen).getTime() > active;
            if (st && recent) perState.set(st, perState.get(st) + 1);
            return {
                id: d.id, name: tvName(d), tvName: d.tv_name, adminName: d.admin_name, ownName: d.own_name || null,
                place: d.approx_location || null, state: st, placeSource: d.place_source || null, venue: !!d.venue, platform: d.platform,
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
            art: this.artSpec(), sharedFields: SHARED_FIELDS, winnerFields: WINNER_FIELDS, audiences: AUDIENCES,
            kinds: KINDS, areaUnits: AREA_UNITS, finalWhere: FINAL_WHERE
        };
    }

    // ============================================
    // ON THE TVS AND PHONES (steps 2 and 3)
    // ============================================

    /** A campaign that can be played right now: published and between its dates. */
    isLiveRow(c, now = new Date()) {
        return !!c && c.status === 'published' && this.stateOf(c, now) === 'live';
    }

    /**
     * The campaigns this TV may show now, pinned first and then by name. With
     * a search, only those whose name, brand, tagline or category has it.
     * Never throws: a TV home screen must open even if this cannot be read.
     */
    async availableFor(deviceId, { q } = {}) {
        try {
            await tvAuth.ensureSchema();
            const d = await pool.query(`SELECT id, approx_location, place_state FROM tv_devices WHERE id = $1`, [Number(deviceId)]);
            if (!d.rows[0]) return [];
            const state = tvState(d.rows[0]);
            const r = await pool.query(
                `SELECT c.* FROM tv_campaigns c
                 WHERE c.status = 'published' AND c.starts_at <= NOW() AND c.ends_at > NOW()
                   AND (c.audience = 'all'
                        OR ($2::text IS NOT NULL AND (c.audience = 'nigeria' OR $2::text = ANY(c.regions)))
                        OR EXISTS (SELECT 1 FROM tv_campaign_tvs t WHERE t.campaign_id = c.id AND t.tv_device_id = $1))
                 ORDER BY c.pinned DESC, c.featured_order NULLS LAST, c.ends_at, LOWER(c.name), c.id
                 LIMIT 60`,
                [d.rows[0].id, state]
            );
            let rows = r.rows.filter(c => this.isLiveRow(c));
            const words = String(q || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
            if (words) {
                rows = rows.filter(c => [c.name, c.brand_name, c.tagline, c.category]
                    .some(x => x && String(x).toLowerCase().includes(words)));
            }
            const art = await this._approvedArt(rows.map(c => c.id));
            // A prize the brand's money no longer covers, or this TV's prize
            // games for today already played, is not offered (step 4).
            const off = new Map();
            try {
                const left = await campaignPrizes.leftFor(rows.filter(c => this.paysCash(c)).map(c => c.id));
                for (const c of rows) {
                    const why = await campaignPrizes.unavailable(c, d.rows[0].id, left.get(Number(c.id)));
                    if (why) off.set(c.id, why);
                }
            } catch (e) {
                logger.error(`TV campaigns for TV ${deviceId}: prize state not read — ${e.message}`);
            }
            // Live Rounds and the Brand Cup: each campaign's next round.
            const next = await liveRounds().nextFor(rows.filter(c => c.kind && c.kind !== 'party').map(c => c.id));
            return rows.map(c => this.tvView(c, art.get(c.id) || {}, { off: off.get(c.id) || null, next: next.get(Number(c.id)) || null }));
        } catch (e) {
            logger.error(`TV campaigns for TV ${deviceId} could not be read: ${e.message}`);
            return [];
        }
    }

    /** One campaign, if this TV may show it now; else null. */
    async forDevice(campaignId, deviceId) {
        const id = Number(campaignId);
        if (!Number.isInteger(id) || id <= 0) return null;
        const list = await this.availableFor(deviceId);
        return list.find(c => c.id === id) || null;
    }

    /** The TV view of a campaign by id, whatever its state (a room already open keeps its brand). */
    async viewById(campaignId) {
        const c = await this._row(campaignId);
        if (!c) return null;
        const art = await this._approvedArt([c.id]);
        return this.tvView(c, art.get(c.id) || {});
    }

    async _approvedArt(ids) {
        const out = new Map();
        if (!ids.length) return out;
        const r = await pool.query(
            `SELECT campaign_id, slot, uploaded_at FROM tv_campaign_art
             WHERE campaign_id = ANY($1::int[]) AND approved_at IS NOT NULL`,
            [ids]
        );
        for (const a of r.rows) {
            if (!out.has(a.campaign_id)) out.set(a.campaign_id, {});
            // The upload time in the address, so a replaced picture is never
            // served from a TV's cache.
            out.get(a.campaign_id)[a.slot] = `/tv/campaign-art/${a.campaign_id}/${a.slot}?v=${new Date(a.uploaded_at).getTime() || 0}`;
        }
        return out;
    }

    /** The prize in words: a full line for the campaign screen, a short one for tiles. */
    prizeWords(c) {
        const basis = c.prize_basis;
        if (!basis || basis === 'none') return { text: 'Play for the fun of it', short: 'Just for fun' };
        if (basis === 'leaderboard') {
            const ranks = Array.isArray(c.prize_ranks) ? c.prize_ranks : [];
            const per = { campaign: 'campaign', week: 'weekly', day: 'daily' }[c.leaderboard_period] || 'campaign';
            const top = ranks[0] ? (Number(ranks[0].amount) > 0 ? naira(ranks[0].amount) : String(ranks[0].item || 'a prize')) : 'a prize';
            return {
                text: `Top ${ranks.length || 1} on the ${per} leaderboard win prizes. First place: ${top}`,
                short: `${per[0].toUpperCase()}${per.slice(1)} leaderboard prizes`
            };
        }
        const what = c.prize_type === 'cash' ? naira(c.prize_amount) : String(c.prize_item || 'A prize');
        if (basis === 'per_tv_day') {
            const n = Number(c.prize_games_per_tv_day) || 1;
            return {
                text: `${what} to the winner of ${n === 1 ? 'the first game' : `each of the first ${n} games`} on this TV every day`,
                short: `${what} a day on this TV`
            };
        }
        return { text: `${what} to the winner of every game`, short: `${what} every game` };
    }

    /** Who can play and win, in one line. */
    rulesLine(c) {
        const parts = ['Signed-in players only'];
        if (c.prize_basis && c.prize_basis !== 'none') {
            parts.push(c.for_children ? `For children: ${c.min_age_to_win} and over to win` : `${c.min_age_to_win || 18} and over to win`);
            if (c.min_players) parts.push(`at least ${c.min_players} players for a prize`);
        }
        return parts.join(' · ');
    }

    /**
     * Everything a TV shows of a campaign. Never the money paid, the terms
     * text, or internal notes. live.off says the prize is not on offer just
     * now (step 4: the money is used up, or this TV's prize games for today
     * are done), and why. The offer link goes through /tv/offer/<id>, which
     * counts the opening for the brand's report and sends the player on to
     * the brand's own page.
     */
    tvView(c, art = {}, live = {}) {
        const off = live && live.off ? live.off : null;
        const words = off ? campaignPrizes.offWords(off, c) : this.prizeWords(c);
        return {
            id: c.id, name: c.name, brandName: c.brand_name, tagline: c.tagline || null,
            offerText: c.offer_text || null, offerUrl: c.offer_url ? this.offerLink(c.id) : null,
            colourMain: c.colour_main || '#5B12FC', colourAccent: c.colour_accent || '#FADF05',
            category: c.category ? String(c.category).toLowerCase() : null,
            pinned: !!c.pinned, endsAt: c.ends_at,
            // Live Rounds and the Brand Cup: the kind, the carousel place, and the next round.
            kind: c.kind || 'party', featuredOrder: c.featured_order || null,
            // Set on the admin page, never by a player: the everyday party's
            // style, and how long each sponsor card shows.
            style: STYLES.includes(c.style) ? c.style : 'standard', sponsorSeconds: this.sponsorSeconds(c),
            live: c.kind && c.kind !== 'party' ? {
                area: liveRounds().areaLabel(c), unit: c.area_unit || 'state', next: (live && live.next) || null
            } : null,
            prize: {
                basis: off ? 'none' : c.prize_basis, type: c.prize_type, amount: c.prize_amount || null, item: c.prize_item || null,
                ranks: Array.isArray(c.prize_ranks) ? c.prize_ranks : [], period: c.leaderboard_period || null,
                minPlayers: c.min_players, text: words.text, short: words.short
            },
            rules: this.rulesLine(c), forChildren: !!c.for_children, minAgeToWin: c.min_age_to_win,
            termsVersion: c.terms_version,
            art: {
                logo: art.logo || null, tile: art.tile || null, lobby: art.lobby || null,
                card: art.card || null, slide: art.slide || art.lobby || null,
                // More sponsor cards, shown in turn with the first.
                card2: art.card2 || null, card3: art.card3 || null, card4: art.card4 || null
            }
        };
    }

    /** How long each sponsor card shows, in seconds (031). */
    sponsorSeconds(c) {
        const v = Number(c && c.sponsor_seconds);
        return Number.isInteger(v) && v >= SPONSOR_SECONDS_MIN && v <= SPONSOR_SECONDS_MAX ? v : SPONSOR_SECONDS_DEFAULT;
    }

    /** What a phone shows, from the TV view a room carries. */
    phoneView(v) {
        if (!v) return null;
        return {
            id: v.id, name: v.name, brandName: v.brandName, tagline: v.tagline,
            colourMain: v.colourMain, colourAccent: v.colourAccent,
            logo: v.art && v.art.logo, tile: v.art && v.art.tile,
            prizeText: v.prize && v.prize.text, prizeShort: v.prize && v.prize.short,
            rules: v.rules, category: v.category, offerText: v.offerText,
            offerUrl: v.offerUrl ? v.offerUrl + (v.offerUrl.includes('?') ? '&' : '?') + 'from=phone' : null, endsAt: v.endsAt,
            kind: v.kind || 'party', style: v.style || 'standard'
        };
    }

    /** The address the TV's QR code and the phone's button open: counted, then on to the brand. */
    offerLink(campaignId) {
        return `${process.env.WEB_PLAY_URL || 'https://play.whatsuptrivia.com.ng'}/tv/offer/${Number(campaignId)}`;
    }

    /**
     * Someone opened the brand's offer: one more on today's count (Lagos day),
     * from the TV's QR code or the phone's button. Nothing about who. Returns
     * the brand's own address, or null if there is none.
     */
    async openOffer(campaignId, source) {
        await tvAuth.ensureSchema();
        const c = await this._row(campaignId);
        if (!c || !c.offer_url || !/^https:\/\//.test(c.offer_url)) return null;
        const from = source === 'phone' ? 'phone' : 'tv';
        try {
            await pool.query(
                `INSERT INTO tv_campaign_offer_opens (campaign_id, opened_on, source, opens) VALUES ($1, $2, $3, 1)
                 ON CONFLICT (campaign_id, opened_on, source) DO UPDATE SET opens = tv_campaign_offer_opens.opens + 1`,
                [c.id, campaignPrizes.lagosDay(Date.now()), from]
            );
        } catch (e) { logger.error(`Campaign ${c.id}: offer opening not counted — ${e.message}`); }
        return c.offer_url;
    }

    /** The terms a player agrees to, with what the brand will see, in words. */
    async terms(campaignId) {
        const c = await this._row(campaignId);
        if (!c) return null;
        const words = list => (list || []).map(f => FIELD_WORDS[f]).filter(Boolean);
        return {
            version: c.terms_version, text: c.terms_text || '', brandName: c.brand_name,
            shares: words(c.shared_fields), winnerShares: words(c.winner_fields),
            live: this.isLiveRow(c)
        };
    }

    async hasConsent(campaignId, userId, version) {
        const r = await pool.query(
            `SELECT 1 FROM tv_campaign_consents WHERE campaign_id = $1 AND user_id = $2 AND terms_version = $3`,
            [Number(campaignId), Number(userId), Number(version)]
        );
        return r.rows.length > 0;
    }

    /**
     * May this signed-in player join a game of this campaign now? They must
     * have agreed to its current terms, and the campaign must still be on.
     */
    async canJoin(campaignId, userId) {
        const c = await this._row(campaignId);
        if (!this.isLiveRow(c)) return { ok: false, reason: 'campaign_over' };
        if (!(await this.hasConsent(c.id, userId, c.terms_version))) {
            return { ok: false, reason: 'terms_required', termsVersion: c.terms_version };
        }
        return { ok: true };
    }

    /** A player agrees to the terms, at the version they were shown. */
    async consent(campaignId, userId, version, ip) {
        await tvAuth.ensureSchema();
        const c = await this._row(campaignId);
        if (!c) return { ok: false, reason: 'no_campaign' };
        if (!this.isLiveRow(c)) return { ok: false, reason: 'campaign_over' };
        if (Number(version) !== Number(c.terms_version)) {
            return { ok: false, reason: 'terms_changed', termsVersion: c.terms_version };
        }
        await pool.query(
            `INSERT INTO tv_campaign_consents (campaign_id, user_id, terms_version, accepted_ip)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [c.id, Number(userId), c.terms_version, tvAuth._inet(ip)]
        );
        return { ok: true, termsVersion: c.terms_version };
    }

    // ---------- the artwork, for the TVs ----------

    _http() {
        if (!this.http) this.http = require('axios');
        return this.http;
    }

    /** An approved picture, resized for a TV: { ok, body, type } or { ok: false, status }. */
    async artFile(campaignId, slot) {
        const id = Number(campaignId);
        if (!Number.isInteger(id) || id <= 0 || !ART[slot]) return { ok: false, status: 404 };
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `SELECT url, format FROM tv_campaign_art WHERE campaign_id = $1 AND slot = $2 AND approved_at IS NOT NULL`,
            [id, slot]
        );
        const a = r.rows[0];
        if (!a) return { ok: false, status: 404 };
        const src = this.sizedUrl(a.url, slot, a.format);
        if (!src) return { ok: false, status: 404 };
        const hit = this.artCache.get(src);
        if (hit) return { ok: true, ...hit };

        let res;
        try {
            res = await this._http().get(src, {
                responseType: 'arraybuffer', timeout: ART_FETCH_TIMEOUT_MS,
                maxContentLength: MAX_ART_BYTES, validateStatus: s => s === 200
            });
        } catch (_) {
            return { ok: false, status: 502 };
        }
        const body = Buffer.from(res.data);
        if (!body.length) return { ok: false, status: 502 };
        const declared = String((res.headers && res.headers['content-type']) || '');
        const type = /^image\/(png|jpeg)$/.test(declared) ? declared : (a.format === 'png' ? 'image/png' : 'image/jpeg');
        while (this.artCache.size && this.artCacheBytes + body.length > ART_CACHE_BYTES) {
            const k = this.artCache.keys().next().value;
            this.artCacheBytes -= this.artCache.get(k).body.length;
            this.artCache.delete(k);
        }
        this.artCache.set(src, { body, type });
        this.artCacheBytes += body.length;
        return { ok: true, body, type };
    }

    /** The Cloudinary address of a picture at a TV's size. Only our own pictures. */
    sizedUrl(url, slot, format) {
        let u;
        try { u = new URL(String(url)); } catch (e) { return null; }
        if (u.protocol !== 'https:' || u.hostname !== 'res.cloudinary.com') return null;
        const at = u.pathname.indexOf('/image/upload/');
        if (at < 0) return null;
        const fmt = format === 'png' ? 'png' : 'jpg';
        const head = u.pathname.slice(0, at + '/image/upload/'.length);
        const rest = u.pathname.slice(at + '/image/upload/'.length);
        return `https://res.cloudinary.com${head}c_limit,w_${ART_WIDTH[slot] || 1920},q_auto,f_${fmt}/${rest}`;
    }

    // ---------- the finder: search on a phone, open on the TV ----------

    _finderCode() {
        let s = '';
        for (let i = 0; i < 8; i++) s += FINDER_ALPHABET[crypto.randomInt(FINDER_ALPHABET.length)];
        return s;
    }

    finderUrl(code) {
        const base = (process.env.WEB_PLAY_URL || 'https://play.whatsuptrivia.com.ng').replace(/\/+$/, '');
        return `${base}/tv/find/${code}`;
    }

    async _finder(code) {
        if (!/^[A-Z0-9]{8}$/.test(String(code || ''))) return null;
        try {
            const raw = await redis.get(`tv_finder:${code}`);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    async _saveFinder(code, f) {
        await redis.setex(`tv_finder:${code}`, FINDER_TTL_SECONDS, JSON.stringify(f));
    }

    /** The TV asks for a code to show as a QR code. */
    async startFinder(deviceId) {
        const code = this._finderCode();
        const f = { deviceId: Number(deviceId), pick: null, at: Date.now() };
        try { await this._saveFinder(code, f); } catch (e) { return { ok: false, reason: 'try_again' }; }
        return { ok: true, code, url: this.finderUrl(code), expiresAt: f.at + FINDER_TTL_SECONDS * 1000 };
    }

    /** The TV checks whether a phone has picked a campaign. A pick is handed over once. */
    async finderStatus(deviceId, code) {
        const f = await this._finder(code);
        if (!f) return { ok: false, reason: 'finder_expired' };
        if (f.deviceId !== Number(deviceId)) return { ok: false, reason: 'not_your_finder' };
        if (!f.pick) return { ok: true, pick: null };
        const pick = f.pick;
        f.pick = null;
        try { await this._saveFinder(code, f); } catch (e) { /* the TV may be told twice; harmless */ }
        return { ok: true, pick };
    }

    async _finderLimited(ip) {
        try {
            const key = `tv_rate:finder:${ip || 'unknown'}`;
            const n = await redis.incr(key);
            if (n === 1) await redis.expire(key, FINDER_WINDOW_SECONDS);
            return n > FINDER_LOOKS_PER_IP;
        } catch (e) { return false; }
    }

    /** The phone lists (and searches) the campaigns the TV it scanned may show. */
    async finderList(code, q, ip) {
        if (await this._finderLimited(ip)) return { ok: false, reason: 'too_many_attempts' };
        const f = await this._finder(code);
        if (!f) return { ok: false, reason: 'finder_expired' };
        const d = await pool.query(
            `SELECT id, tv_name, admin_name, details->>'ownName' AS own_name, label FROM tv_devices WHERE id = $1`, [f.deviceId]);
        const name = d.rows[0] ? tvName(d.rows[0]) : 'This TV';
        const list = await this.availableFor(f.deviceId, { q });
        return { ok: true, tvName: name, campaigns: list.map(v => this.phoneView(v)) };
    }

    /** The phone opens a campaign on the TV. */
    async finderPick(code, campaignId, ip) {
        if (await this._finderLimited(ip)) return { ok: false, reason: 'too_many_attempts' };
        const f = await this._finder(code);
        if (!f) return { ok: false, reason: 'finder_expired' };
        const c = await this.forDevice(campaignId, f.deviceId);
        if (!c) return { ok: false, reason: 'campaign_unavailable' };
        f.pick = c.id;
        try { await this._saveFinder(code, f); } catch (e) { return { ok: false, reason: 'try_again' }; }
        return { ok: true, name: c.name };
    }
}

module.exports = new TvCampaignService();
module.exports.TvCampaignService = TvCampaignService;
module.exports.stateFromPlace = stateFromPlace;
module.exports.tvState = tvState;
module.exports.ART = ART;
module.exports.FINDER_TTL_SECONDS = FINDER_TTL_SECONDS;
