// ============================================
// FILE: src/services/tv-campaign-report.service.js
// WUT TV, phase 7, step 5 — the brand's report (Nov 17, 2026).
//
// What a brand is sent about its campaign, for the whole campaign or for
// chosen Lagos days. Read only: it changes nothing.
//
//   * reach: TVs that opened the brand's party, by state, and the busiest TVs
//     (a venue by name; a home TV only as "a home TV" and its state)
//   * play: games started, finished and counted; players; plays; agreements
//     to the terms
//   * the sponsor card: how many times it was shown (after questions 3, 6, 9
//     and 12 of each game that got that far), and how many player views that
//     makes (each showing times the players in that game)
//   * the offer: how many times it was opened, from the TV's QR code and from
//     the phones' button (counts only: tv_campaign_offer_opens)
//   * day by day
//   * players: ONLY what they agreed the brand may see (the campaign's
//     shared_fields: username, city). Nothing else, ever, and nothing at all
//     if nothing was agreed
//   * winners: what each winner agreed to share (winner_fields), copied when
//     they won, and how their prize stands
//   * the money (Super Admin and Finance Officer only): paid in, won, paid
//     out, left
// Never an email address or phone number unless a winner agreed to share it.
// ============================================

const pool = require('../config/database');
const tvAuth = require('./tv-auth.service');
const tvCampaigns = require('./tv-campaign.service');
const campaignPrizes = require('./tv-campaign-prize.service');
const { stateFromPlace, tvState } = require('./tv-campaign.service');

const SPONSOR_AFTER = [3, 6, 9, 12];
const MAX_PLAYERS_LISTED = 2000;
const MAX_TVS_LISTED = 25;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const tvName = d => d.admin_name || d.own_name || d.tv_name || d.label || `TV ${d.id}`;

class TvCampaignReportService {

    /** Optional Lagos days to report on, as SQL bounds. */
    _range({ from, to } = {}) {
        const f = DAY.test(String(from || '')) ? String(from) : null;
        const t = DAY.test(String(to || '')) ? String(to) : null;
        if (f && t && t < f) return { error: 'The end day is before the start day' };
        return { from: f, to: t };
    }

    async report(campaignId, { from, to, includeMoney = false } = {}) {
        await tvAuth.ensureSchema();
        const c = await tvCampaigns._row(campaignId);
        if (!c) return { ok: false, error: 'No such campaign' };
        const range = this._range({ from, to });
        if (range.error) return { ok: false, error: range.error };
        // Days are Lagos days. NULL bounds leave that side open.
        const day = col => `(($2::date IS NULL OR (${col} AT TIME ZONE 'Africa/Lagos')::date >= $2::date)
                              AND ($3::date IS NULL OR (${col} AT TIME ZONE 'Africa/Lagos')::date <= $3::date))`;
        const P = [c.id, range.from, range.to];
        const shared = Array.isArray(c.shared_fields) ? c.shared_fields : [];

        // Each started game: where, when, how far it got, and who played.
        const games = (await pool.query(
            `SELECT r.id, r.status, r.result_counted, r.tv_device_id, r.started_at,
                    (r.started_at AT TIME ZONE 'Africa/Lagos')::date::text AS day,
                    COALESCE(MAX(a.position), 0)::int AS reached,
                    COUNT(DISTINCT a.tv_player_id)::int AS players
             FROM tv_rooms r
             LEFT JOIN tv_answers a ON a.tv_room_id = r.id
             WHERE r.campaign_id = $1 AND r.started_at IS NOT NULL AND ${day('r.started_at')}
             GROUP BY r.id`,
            P
        )).rows;
        const cardsOf = g => g.status === 'finished' ? SPONSOR_AFTER.length : SPONSOR_AFTER.filter(n => n < Number(g.reached)).length;

        const opened = (await pool.query(
            `SELECT COUNT(*)::int AS rooms, COUNT(DISTINCT tv_device_id)::int AS tvs
             FROM tv_rooms WHERE campaign_id = $1 AND ${day('created_at')}`, P)).rows[0];

        const people = (await pool.query(
            `SELECT COUNT(DISTINCT p.user_id)::int AS players, COUNT(DISTINCT p.id)::int AS plays
             FROM tv_players p JOIN tv_rooms r ON r.id = p.tv_room_id
             WHERE r.campaign_id = $1 AND r.started_at IS NOT NULL AND ${day('r.started_at')}
               AND p.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM tv_answers a WHERE a.tv_player_id = p.id)`, P)).rows[0];

        const agreed = (await pool.query(
            `SELECT COUNT(DISTINCT user_id)::int AS n FROM tv_campaign_consents WHERE campaign_id = $1 AND ${day('accepted_at')}`, P)).rows[0];

        const opens = (await pool.query(
            `SELECT opened_on::text AS day, source, SUM(opens)::int AS n FROM tv_campaign_offer_opens
             WHERE campaign_id = $1 AND ($2::date IS NULL OR opened_on >= $2::date) AND ($3::date IS NULL OR opened_on <= $3::date)
             GROUP BY opened_on, source`, P)).rows;

        // Day by day.
        const days = new Map();
        const dayRow = d => {
            if (!days.has(d)) days.set(d, { day: d, games: 0, finished: 0, players: new Set(), cards: 0, views: 0, opensTv: 0, opensPhone: 0 });
            return days.get(d);
        };
        const perDayPlayers = (await pool.query(
            `SELECT (r.started_at AT TIME ZONE 'Africa/Lagos')::date::text AS day, p.user_id
             FROM tv_players p JOIN tv_rooms r ON r.id = p.tv_room_id
             WHERE r.campaign_id = $1 AND r.started_at IS NOT NULL AND ${day('r.started_at')} AND p.user_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM tv_answers a WHERE a.tv_player_id = p.id)
             GROUP BY 1, 2`, P)).rows;
        let cards = 0, views = 0;
        for (const g of games) {
            const d = dayRow(g.day);
            const k = cardsOf(g);
            d.games++;
            if (g.status === 'finished') d.finished++;
            d.cards += k;
            d.views += k * Number(g.players);
            cards += k;
            views += k * Number(g.players);
        }
        for (const x of perDayPlayers) dayRow(x.day).players.add(Number(x.user_id));
        let opensTv = 0, opensPhone = 0;
        for (const o of opens) {
            const d = dayRow(o.day);
            if (o.source === 'phone') { d.opensPhone += o.n; opensPhone += o.n; } else { d.opensTv += o.n; opensTv += o.n; }
        }
        const byDay = [...days.values()].sort((a, b) => a.day < b.day ? -1 : 1)
            .map(d => ({ ...d, players: d.players.size }));

        // Where: TVs, by state and the busiest ones.
        const tvRows = (await pool.query(
            `SELECT d.id, d.tv_name, d.admin_name, d.details->>'ownName' AS own_name, d.label, d.approx_location, d.place_state, d.venue,
                    COUNT(DISTINCT r.id) FILTER (WHERE r.started_at IS NOT NULL)::int AS games,
                    COUNT(DISTINCT p.user_id) FILTER (WHERE r.started_at IS NOT NULL)::int AS players
             FROM tv_rooms r
             JOIN tv_devices d ON d.id = r.tv_device_id
             LEFT JOIN tv_players p ON p.tv_room_id = r.id AND p.user_id IS NOT NULL
             WHERE r.campaign_id = $1 AND ${day('r.created_at')}
             GROUP BY d.id`, P)).rows;
        const states = new Map();
        for (const t of tvRows) {
            const s = tvState(t) || (t.approx_location ? 'Outside Nigeria' : 'Not known');
            if (!states.has(s)) states.set(s, { state: s, tvs: 0, games: 0 });
            const x = states.get(s);
            x.tvs++;
            x.games += Number(t.games) || 0;
        }
        const byState = [...states.values()].sort((a, b) => b.games - a.games || b.tvs - a.tvs || (a.state < b.state ? -1 : 1));
        // A venue (a bar, a lounge) is named; a home TV is not, and only its
        // state is given: its name is its owner's, and its place is theirs.
        const topTvs = tvRows.slice().sort((a, b) => b.games - a.games || b.players - a.players).slice(0, MAX_TVS_LISTED)
            .map(t => ({
                name: t.venue ? tvName(t) : 'A home TV',
                place: t.venue ? (t.approx_location || null) : (tvState(t) || (t.approx_location ? 'Outside Nigeria' : null)),
                venue: !!t.venue, games: Number(t.games) || 0, players: Number(t.players) || 0
            }));

        // Players: only what they agreed the brand may see.
        let players = null;
        let byCity = null;
        if (shared.length) {
            const rows = (await pool.query(
                `SELECT u.id, u.username, u.city,
                        COUNT(DISTINCT p.id)::int AS games, COALESCE(SUM(p.final_correct), 0)::int AS correct
                 FROM tv_players p
                 JOIN tv_rooms r ON r.id = p.tv_room_id
                 JOIN users u ON u.id = p.user_id
                 WHERE r.campaign_id = $1 AND r.started_at IS NOT NULL AND ${day('r.started_at')}
                   AND EXISTS (SELECT 1 FROM tv_answers a WHERE a.tv_player_id = p.id)
                 GROUP BY u.id, u.username, u.city
                 ORDER BY games DESC, correct DESC, u.id
                 LIMIT ${MAX_PLAYERS_LISTED}`, P)).rows;
            players = rows.map(x => {
                const o = { games: Number(x.games) || 0, correct: Number(x.correct) || 0 };
                if (shared.includes('username')) o.username = x.username || null;
                if (shared.includes('city')) o.city = x.city || null;
                return o;
            });
            if (shared.includes('city')) {
                const m = new Map();
                for (const x of rows) {
                    const k = String(x.city || '').trim() || 'Not given';
                    m.set(k, (m.get(k) || 0) + 1);
                }
                byCity = [...m.entries()].map(([city, n]) => ({ city, players: n })).sort((a, b) => b.players - a.players).slice(0, 30);
            }
        }

        // Winners: what each agreed to share, and how the prize stands.
        const awards = (await pool.query(
            `SELECT a.*, po.status AS payout_status, po.paid_at
             FROM tv_campaign_awards a LEFT JOIN tv_payouts po ON po.tv_campaign_award_id = a.id
             WHERE a.campaign_id = $1 AND a.status IN ('won','sent','received') AND ${day('a.resolved_at')}
             ORDER BY a.resolved_at, a.place, a.id`, P)).rows;
        const winners = awards.map(a => ({
            when: a.resolved_at, basis: a.basis, period: a.period_key, place: a.place,
            prize: a.prize_type === 'cash' ? { cash: Number(a.amount) } : { item: a.item },
            winner: (a.winner_details && a.winner_details.fields) || {},
            status: a.prize_type === 'cash'
                ? (a.payout_status === 'paid' ? 'paid' : 'being paid')
                : ({ won: 'to send', sent: 'sent', received: 'received' }[a.status] || a.status)
        }));
        const notWon = (await pool.query(
            `SELECT reason, COUNT(*)::int AS n FROM tv_campaign_awards
             WHERE campaign_id = $1 AND status = 'released' AND ${day('resolved_at')} GROUP BY reason`, P)).rows;

        const out = {
            ok: true,
            campaign: {
                id: c.id, name: c.name, brandName: c.brand_name, status: c.status, state: tvCampaigns.stateOf(c),
                startsAt: c.starts_at, endsAt: c.ends_at, endedAt: c.ended_at, audience: c.audience || 'chosen',
                regions: c.regions || [], category: c.category, prize: tvCampaigns.prizeWords(c).text,
                rules: tvCampaigns.rulesLine(c), shared, winnerFields: c.winner_fields || [], termsVersion: c.terms_version,
                offer: c.offer_text || null, hasOfferLink: !!c.offer_url
            },
            range: { from: range.from, to: range.to },
            totals: {
                tvs: Number(opened.tvs) || 0, rooms: Number(opened.rooms) || 0,
                games: games.length, finished: games.filter(g => g.status === 'finished').length,
                counted: games.filter(g => g.status === 'finished' && g.result_counted).length,
                players: Number(people.players) || 0, plays: Number(people.plays) || 0,
                agreed: Number(agreed.n) || 0,
                cards, views, opensTv, opensPhone,
                prizesWon: winners.length,
                prizesNotWon: notWon.reduce((a, x) => a + x.n, 0)
            },
            notWon: notWon.map(x => ({ reason: x.reason, n: x.n })),
            byDay, byState, topTvs, players, byCity, winners,
            generatedAt: new Date()
        };
        if (c.prize_basis === 'leaderboard') {
            const p = campaignPrizes.currentPeriod(c);
            if (p) {
                const rows = await campaignPrizes.standings(c, p, 10);
                out.leaderboard = {
                    label: p.label, from: p.from, to: p.to,
                    rows: rows.map(x => ({ place: x.place, name: shared.includes('username') ? x.username : `Player ${x.place}`,
                                           correct: x.correct, games: x.games }))
                };
            }
        }
        if (includeMoney) {
            const m = await campaignPrizes.poolOf(c.id);
            out.money = { funded: m.funded, won: m.won, reserved: m.reserved, paidOut: m.paidOut, owed: m.owed, left: m.left };
        }
        return out;
    }
}

module.exports = new TvCampaignReportService();
module.exports.SPONSOR_AFTER = SPONSOR_AFTER;
