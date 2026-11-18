// ============================================
// FILE: src/services/tv-campaign-prize.service.js
// WUT TV, phase 7, step 4 — a brand's prizes, paid from the money the brand
// paid in (decided Nov 1, built Nov 17, 2026).
//
// The campaign sets the prize (tv-campaign.service); this pays it.
//
// A PRIZE PER GAME, OR PER TV PER DAY. When a branded game starts, it is a
// prize game if:
//   * at least the campaign's minimum number of players start it;
//   * for a prize per TV per day, this TV has not had its prize games today
//     (Lagos time; a game whose prize was not won does not use one up);
//   * for cash, what the brand paid in still covers the prize, after every
//     prize already reserved or won.
// The prize is then reserved (a tv_campaign_awards row), so two games can
// never be promised the same naira. Two games starting at the same moment on
// the last prize: each checks again after reserving, the earlier one keeps it.
//
// When the game ends, the prize goes to the best-placed player who may win
// it: aged at least the campaign's minimum (18 unless it is for children), an
// account that is not suspended, and under the campaign's limit of prizes per
// player. A player passed over is told why on their phone. If fewer than the
// minimum number of players finished, or the game ended early, or nobody may
// win, the prize is released and the money is free again.
//
// A LEADERBOARD. Every counted branded game with at least the minimum number
// of finishers counts. Players are ranked by right answers over the period
// (Race: questions taken), then by less time. When a period ends (the whole
// campaign, each week from the start, or each Lagos day), each place goes to
// the next player down who may win, and every place gets a row, so a period
// is settled once.
//
// PAYING. Cash goes through the WUT TV payout queue (tv_payouts), with the
// bank details the winner gives on their prizes page, as a host's prize does:
// the same Mark paid, Hold, and "it arrived" from the winner. An item is
// marked sent by an admin, with a note, and the winner says it arrived. An
// admin can void a prize that has not been paid (cheating, say); its money is
// free again.
//
// What the brand may see of a winner (the campaign's winner_fields, agreed in
// the terms) is copied when the prize is won, and only that.
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');
const tvAuth = require('./tv-auth.service');
const { LAGOS_OFFSET_MS } = require('../utils/lagos-time');

const DAY_MS = 864e5;
const WEEK_MS = 7 * DAY_MS;
const HELD_STATUSES = ['reserved', 'won'];                  // cash that is no longer free
const WON_STATUSES = ['won', 'sent', 'received'];
const STALE_RESERVATION_MS = 2 * 60 * 1000;              // a reservation left by a restart is settled by the sweep
const LEADERBOARD_SHOWN = 20;
const MAX_PERIODS_SETTLED_PER_SWEEP = 20;

const naira = n => '₦' + Number(n || 0).toLocaleString('en-NG');
const ordinal = n => {
    const v = Number(n) || 0, t = v % 100;
    return v + (t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th'));
};

/** The Lagos calendar day of a moment, as YYYY-MM-DD. */
function lagosDay(t) {
    return new Date(new Date(t).getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** Lagos midnight at the start of the day of a moment, as a Date. */
function lagosMidnight(t) {
    return new Date(Date.parse(lagosDay(t) + 'T00:00:00Z') - LAGOS_OFFSET_MS);
}

class TvCampaignPrizeService {

    async _campaign(id) {
        const r = await pool.query(`SELECT * FROM tv_campaigns WHERE id = $1`, [id]);
        return r.rows[0] || null;
    }

    _what(a) {
        return a.prize_type === 'cash' ? naira(a.amount) : String(a.item || 'a prize');
    }

    // ============================================
    // THE MONEY
    // ============================================

    /** Paid in, held for games in play, won, paid out, and left, for one campaign. */
    async poolOf(campaignId) {
        const r = await pool.query(
            `SELECT
                (SELECT COALESCE(SUM(amount), 0)::bigint FROM tv_campaign_funds WHERE campaign_id = $1) AS funded,
                (SELECT COALESCE(SUM(amount), 0)::bigint FROM tv_campaign_awards
                  WHERE campaign_id = $1 AND prize_type = 'cash' AND status = 'reserved') AS reserved,
                (SELECT COALESCE(SUM(amount), 0)::bigint FROM tv_campaign_awards
                  WHERE campaign_id = $1 AND prize_type = 'cash' AND status = 'won') AS won,
                (SELECT COALESCE(SUM(po.amount), 0)::bigint FROM tv_payouts po
                  JOIN tv_campaign_awards a ON a.id = po.tv_campaign_award_id
                  WHERE a.campaign_id = $1 AND po.status = 'paid') AS paid_out`,
            [campaignId]
        );
        const x = r.rows[0] || {};
        const funded = Number(x.funded) || 0, reserved = Number(x.reserved) || 0, won = Number(x.won) || 0;
        return { funded, reserved, won, paidOut: Number(x.paid_out) || 0, owed: won - (Number(x.paid_out) || 0), left: funded - reserved - won };
    }

    /** What is left in each of these campaigns, in one query. */
    async leftFor(campaignIds) {
        const ids = [...new Set((campaignIds || []).map(Number).filter(n => n > 0))];
        if (!ids.length) return new Map();
        const r = await pool.query(
            `SELECT c.id,
                    (SELECT COALESCE(SUM(f.amount), 0)::bigint FROM tv_campaign_funds f WHERE f.campaign_id = c.id) -
                    (SELECT COALESCE(SUM(a.amount), 0)::bigint FROM tv_campaign_awards a
                      WHERE a.campaign_id = c.id AND a.prize_type = 'cash' AND a.status = ANY($2::text[])) AS left_amount
             FROM tv_campaigns c WHERE c.id = ANY($1::int[])`,
            [ids, HELD_STATUSES]
        );
        return new Map(r.rows.map(x => [Number(x.id), Number(x.left_amount) || 0]));
    }

    /** How many prize games this TV has had today in a campaign with a prize per TV per day. */
    async tvDayCount(campaignId, deviceId, day = lagosDay(Date.now())) {
        const r = await pool.query(
            `SELECT COUNT(*)::int AS n FROM tv_campaign_awards
             WHERE campaign_id = $1 AND basis = 'per_tv_day' AND tv_device_id = $2 AND period_key = $3
               AND status = ANY($4::text[])`,
            [campaignId, deviceId, day, ['reserved', ...WON_STATUSES]]
        );
        return Number(r.rows[0] && r.rows[0].n) || 0;
    }

    /**
     * Why a TV cannot offer a campaign's prize just now, or null: the money
     * is used up, or this TV has had its prize games today. Used for what
     * the TV shows before a game starts.
     */
    async unavailable(c, deviceId, left = null) {
        if (!c || !['per_game', 'per_tv_day'].includes(c.prize_basis)) return null;
        if (c.prize_type === 'cash') {
            const have = left != null ? left : (await this.leftFor([c.id])).get(Number(c.id)) || 0;
            if (have < Number(c.prize_amount || 0)) return 'pool_empty';
        }
        if (c.prize_basis === 'per_tv_day' && deviceId) {
            if (await this.tvDayCount(c.id, deviceId) >= (Number(c.prize_games_per_tv_day) || 1)) return 'tv_day_done';
        }
        return null;
    }

    /** The words for a prize that is not on offer, for the TV and phones. */
    offWords(reason, c) {
        switch (reason) {
            case 'pool_empty':
                return { text: 'The prizes in this campaign have all been won. Play on for the fun of it.', short: 'Prizes all won' };
            case 'tv_day_done':
                return { text: 'Today’s prize games on this TV have been played. Play on for the fun of it; the prizes are back tomorrow.', short: 'Prize games done for today' };
            case 'too_few_players':
                return { text: `This game has no prize: a prize game needs at least ${c ? c.min_players : 3} players.`, short: 'No prize this game' };
            default:
                return { text: 'Play for the fun of it', short: 'Just for fun' };
        }
    }

    // ============================================
    // A GAME STARTS (called by tv-party.start, inside the room's queue)
    // ============================================

    /**
     * Is this game a prize game? If so, its prize is reserved now. Returns
     * { on, text, short, reason, awardId }.
     */
    async reserveForGame(state, playerIds) {
        await tvAuth.ensureSchema();
        const c = await this._campaign(state.campaign && state.campaign.id);
        if (!c || !c.prize_basis || c.prize_basis === 'none') return { on: false, basis: 'none' };
        if (c.prize_basis === 'leaderboard') {
            return { on: false, basis: 'leaderboard', text: 'This game counts towards the leaderboard.' };
        }
        const off = reason => ({ on: false, basis: c.prize_basis, reason, ...this.offWords(reason, c) });
        if ((playerIds || []).length < Number(c.min_players || 3)) return off('too_few_players');
        const why = await this.unavailable(c, state.deviceId);
        if (why) return off(why);

        const day = lagosDay(Date.now());
        const ins = await pool.query(
            `INSERT INTO tv_campaign_awards (campaign_id, basis, tv_room_id, tv_device_id, period_key, place, prize_type, amount, item, status)
             VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, 'reserved')
             ON CONFLICT (tv_room_id) WHERE tv_room_id IS NOT NULL DO NOTHING
             RETURNING id`,
            [c.id, c.prize_basis, state.id, state.deviceId || null, c.prize_basis === 'per_tv_day' ? day : null,
             c.prize_type, c.prize_type === 'cash' ? Number(c.prize_amount) : null,
             c.prize_type === 'item' ? String(c.prize_item || 'A prize') : null]
        );
        let award = ins.rows[0];
        if (!award) {
            const had = await pool.query(`SELECT id, status FROM tv_campaign_awards WHERE tv_room_id = $1`, [state.id]);
            if (!had.rows[0] || had.rows[0].status !== 'reserved') return off('pool_empty');
            award = had.rows[0];
        }

        // Checked again now the reservation is in: of two games reserving the
        // last prize at once, the earlier one keeps it.
        const check = await pool.query(
            `SELECT
                (SELECT COALESCE(SUM(amount), 0)::bigint FROM tv_campaign_funds WHERE campaign_id = $1) AS funded,
                (SELECT COALESCE(SUM(amount), 0)::bigint FROM tv_campaign_awards
                  WHERE campaign_id = $1 AND prize_type = 'cash' AND (status = 'won' OR (status = 'reserved' AND id <= $2))) AS held,
                (SELECT COUNT(*)::int FROM tv_campaign_awards
                  WHERE campaign_id = $1 AND basis = 'per_tv_day' AND tv_device_id = $3 AND period_key = $4
                    AND (status IN ('won','sent','received') OR (status = 'reserved' AND id <= $2))) AS today`,
            [c.id, award.id, state.deviceId || null, day]
        );
        const k = check.rows[0] || {};
        let lost = null;
        if (c.prize_type === 'cash' && Number(k.held) > Number(k.funded)) lost = 'pool_empty';
        if (!lost && c.prize_basis === 'per_tv_day' && Number(k.today) > (Number(c.prize_games_per_tv_day) || 1)) lost = 'tv_day_done';
        if (lost) {
            await this._release(award.id, lost);
            return off(lost);
        }
        const what = c.prize_type === 'cash' ? naira(c.prize_amount) : String(c.prize_item || 'A prize');
        logger.info(`📣💰 Campaign ${c.id}: room ${state.id} is a prize game (${what}), award ${award.id} reserved`);
        return { on: true, basis: c.prize_basis, awardId: Number(award.id), text: `This game is played for ${what}.`, short: what };
    }

    // ============================================
    // A GAME ENDS
    // ============================================

    async _release(awardId, reason) {
        const r = await pool.query(
            `UPDATE tv_campaign_awards SET status = 'released', reason = $2, resolved_at = NOW()
             WHERE id = $1 AND status = 'reserved' RETURNING *`,
            [awardId, String(reason).slice(0, 200)]
        );
        return r.rows[0] || null;
    }

    /** May this account win a prize in this campaign? { ok } or { ok: false, reason, text }. */
    async eligible(c, userId) {
        const u = await pool.query(`SELECT id, age, is_suspended FROM users WHERE id = $1`, [userId]);
        const user = u.rows[0];
        if (!user || user.is_suspended === true) {
            return { ok: false, reason: 'account_unavailable', text: 'Your account cannot win prizes at the moment, so the prize goes to the next player who can.' };
        }
        const min = Number(c.min_age_to_win) || 18;
        const age = parseInt(user.age, 10);
        if (!Number.isFinite(age) || age < min) {
            return { ok: false, reason: 'too_young', text: `This campaign’s prizes are for players aged ${min} and over, so the prize goes to the next player who can win it.` };
        }
        if (c.cap_per_player) {
            const n = await pool.query(
                `SELECT COUNT(*)::int AS n FROM tv_campaign_awards WHERE campaign_id = $1 AND user_id = $2 AND status = ANY($3::text[])`,
                [c.id, userId, WON_STATUSES]
            );
            if (Number(n.rows[0].n) >= Number(c.cap_per_player)) {
                const cap = Number(c.cap_per_player);
                return { ok: false, reason: 'cap_reached', text: `You have already won ${cap === 1 ? 'the one prize' : `the ${cap} prizes`} one player can win in this campaign, so this one goes to the next player.` };
            }
        }
        return { ok: true };
    }

    /** What the winner agreed the brand may see, copied from their account now. */
    async _winnerDetails(c, userId) {
        const fields = Array.isArray(c.winner_fields) ? c.winner_fields : [];
        const r = await pool.query(`SELECT username, full_name, city, email, phone_number FROM users WHERE id = $1`, [userId]);
        const u = r.rows[0] || {};
        const pick = { full_name: u.full_name, username: u.username, city: u.city, email: u.email, phone: u.phone_number };
        const out = {};
        for (const f of fields) if (pick[f] != null && String(pick[f]).trim()) out[f] = String(pick[f]).trim().slice(0, 120);
        return { fields: out, termsVersion: Number(c.terms_version) || 1 };
    }

    /** The award becomes the winner's; cash goes to the payout queue. */
    async _win(c, award, userId, playerId) {
        const details = await this._winnerDetails(c, userId);
        const upd = await pool.query(
            `UPDATE tv_campaign_awards SET status = 'won', user_id = $2, tv_player_id = $3, winner_details = $4, resolved_at = NOW()
             WHERE id = $1 AND status = $5 RETURNING *`,
            [award.id, userId, playerId || null, JSON.stringify(details), award.status]
        );
        const row = upd.rows[0];
        if (!row) return null;
        let payoutId = null;
        if (row.prize_type === 'cash') {
            const p = await this._payout(row);
            payoutId = p && p.id;
        }
        logger.info(`📣💰 Campaign ${c.id}: award ${row.id} (${this._what(row)}) won by user ${userId}${payoutId ? `, payout ${payoutId}` : ''}`);
        const tvPrize = require('./tv-prize.service');
        await tvPrize._tell(Number(userId),
            `🏆 You won ${this._what(row)} in the ${c.name} on What's Up Trivia TV, from ${c.brand_name}!`,
            row.prize_type === 'cash'
                ? `To get paid, add or check your bank details here: ${tvPrize._prizesUrl()}`
                : `We'll be in touch to get it to you. You can see it here: ${tvPrize._prizesUrl()}`,
            `You won ${this._what(row)} on What's Up Trivia TV`);
        return { ...row, payoutId };
    }

    /**
     * A brand's cash prize in the payout queue. Held, with a note, if the
     * money paid in does not cover it (a leaderboard after a correction).
     */
    async _payout(award) {
        const tvPrize = require('./tv-prize.service');
        const saved = await tvPrize._savedDetails(Number(award.user_id));
        const p = await this.poolOf(award.campaign_id);
        const short = p.left < 0;
        const ins = await pool.query(
            `INSERT INTO tv_payouts (tv_campaign_award_id, kind, user_id, amount, status, hold_reason, bank_name, bank_code,
                                     account_number, account_name, details_verified, details_at)
             VALUES ($1, 'prize', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (tv_campaign_award_id) WHERE tv_campaign_award_id IS NOT NULL DO NOTHING
             RETURNING id, status`,
            [award.id, award.user_id, Number(award.amount),
             short ? 'held' : (saved ? 'ready' : 'awaiting_details'),
             short ? 'The money the brand paid in does not cover this prize yet' : null,
             saved ? saved.bank_name : null, saved ? String(saved.bank_code) : null,
             saved ? String(saved.account_number) : null, saved ? saved.account_name : null,
             !!(saved && saved.verified === true), saved ? new Date() : null]
        );
        if (short) logger.warn(`📣💰 Campaign ${award.campaign_id}: award ${award.id} won but the money paid in is short by ${naira(-p.left)}; payout held`);
        return ins.rows[0] || null;
    }

    /**
     * Settle a room's reserved prize, once the room has finished or closed.
     * Returns what the phones are told: { none } when there was no prize, else
     * { awarded, released, reason, text, winnerPlayerId, messages: { pid: {...} } }.
     */
    async settleRoom(roomId) {
        await tvAuth.ensureSchema();
        const a = (await pool.query(`SELECT * FROM tv_campaign_awards WHERE tv_room_id = $1`, [roomId])).rows[0];
        if (!a || a.status !== 'reserved') return { none: true };
        const c = await this._campaign(a.campaign_id);
        const room = (await pool.query(`SELECT status, result_counted FROM tv_rooms WHERE id = $1`, [roomId])).rows[0];
        if (!room || (room.status !== 'finished' && room.status !== 'closed')) return { none: true, waiting: true };

        const what = this._what(a);
        const players = (await pool.query(
            `SELECT id, user_id, final_rank FROM tv_players
             WHERE tv_room_id = $1 AND final_rank IS NOT NULL AND removed_at IS NULL
             ORDER BY final_rank, id`,
            [roomId]
        )).rows;
        const messages = {};
        const released = async (reason, text, tellAll) => {
            await this._release(a.id, reason);
            if (tellAll) for (const p of players) messages[p.id] = { won: false, text };
            logger.info(`📣💰 Campaign ${a.campaign_id}: award ${a.id} released (${reason})`);
            return { released: true, reason, text, winnerPlayerId: null, messages };
        };

        if (room.status !== 'finished') return released('game_not_finished', 'The game ended before the last question, so its prize was not won.', false);
        const min = Number(c && c.min_players) || 3;
        if (!room.result_counted || players.length < min) {
            return released('too_few_finished', `Fewer than ${min} players finished, so this game’s prize (${what}) was not won.`, true);
        }
        for (const p of players) {
            if (!p.user_id) continue;
            const may = await this.eligible(c, Number(p.user_id));
            if (!may.ok) {
                messages[p.id] = { won: false, text: `You came ${ordinal(p.final_rank)}, but ${may.text.charAt(0).toLowerCase()}${may.text.slice(1)}`, reason: may.reason };
                continue;
            }
            const won = await this._win(c, a, Number(p.user_id), Number(p.id));
            if (!won) return { none: true };
            messages[p.id] = {
                won: true, kind: won.prize_type,
                text: `You won ${what} from ${c.brand_name}!`,
                sub: won.prize_type === 'cash'
                    ? 'We have sent you a message. Add or check your bank details on your prizes page to get paid.'
                    : 'We have sent you a message, and we will be in touch to get it to you.',
                link: '/tv/prizes'
            };
            return { awarded: true, award: Number(won.id), text: `${what} won`, winnerPlayerId: Number(p.id), messages };
        }
        return released('no_eligible_player', `Nobody who finished could win this game’s prize (${what}).`, false);
    }

    // ============================================
    // THE LEADERBOARD
    // ============================================

    /** The periods of a leaderboard campaign: { key, label, from, to }, in order. */
    periods(c) {
        if (!c || !c.starts_at || !c.ends_at) return [];
        const start = new Date(c.starts_at).getTime();
        let end = new Date(c.ends_at).getTime();
        if (c.status === 'ended' && c.ended_at) end = Math.min(end, new Date(c.ended_at).getTime());
        if (!(end > start)) return [];
        const out = [];
        if (c.leaderboard_period === 'week') {
            for (let i = 0, from = start; from < end && i < 260; i++, from += WEEK_MS) {
                out.push({ key: `week:${i + 1}`, label: `Week ${i + 1}`, from: new Date(from), to: new Date(Math.min(from + WEEK_MS, end)) });
            }
        } else if (c.leaderboard_period === 'day') {
            for (let from = start, i = 0; from < end && i < 800; i++) {
                const next = lagosMidnight(from).getTime() + DAY_MS;
                const to = Math.min(next, end);
                out.push({ key: `day:${lagosDay(from)}`, label: lagosDay(from), from: new Date(from), to: new Date(to) });
                from = to;
            }
        } else {
            out.push({ key: 'campaign', label: 'The whole campaign', from: new Date(start), to: new Date(end) });
        }
        return out;
    }

    /** The period running now, or the last one. */
    currentPeriod(c, now = Date.now()) {
        const ps = this.periods(c);
        return ps.find(p => p.from.getTime() <= now && now < p.to.getTime()) || ps[ps.length - 1] || null;
    }

    /**
     * Who leads a period: right answers (Race: questions taken) over the
     * counted branded games with enough finishers, then less time, then who
     * got there first.
     */
    async standings(c, period, limit = LEADERBOARD_SHOWN) {
        if (!period) return [];
        const r = await pool.query(
            `SELECT p.user_id, u.username, u.city,
                    SUM(p.final_correct)::int AS correct, SUM(p.final_total_ms)::bigint AS ms, COUNT(*)::int AS games,
                    MIN(r.finished_at) AS first_at
             FROM tv_players p
             JOIN tv_rooms r ON r.id = p.tv_room_id
             JOIN users u ON u.id = p.user_id
             WHERE r.campaign_id = $1 AND r.status = 'finished' AND r.result_counted = true
               AND r.finished_at >= $2 AND r.finished_at < $3
               AND p.final_rank IS NOT NULL AND p.user_id IS NOT NULL AND p.removed_at IS NULL
               AND (SELECT COUNT(*) FROM tv_players q WHERE q.tv_room_id = r.id AND q.final_rank IS NOT NULL) >= $4
             GROUP BY p.user_id, u.username, u.city
             ORDER BY correct DESC, ms ASC, first_at ASC
             LIMIT $5`,
            [c.id, period.from, period.to, Number(c.min_players) || 3, limit]
        );
        return r.rows.map((x, i) => ({
            place: i + 1, userId: Number(x.user_id), username: x.username, city: x.city || null,
            correct: Number(x.correct) || 0, ms: Number(x.ms) || 0, games: Number(x.games) || 0
        }));
    }

    /** Award a period's places, once, when it has ended. */
    async _settlePeriod(c, period) {
        const ranks = Array.isArray(c.prize_ranks) ? c.prize_ranks : [];
        if (!ranks.length) return 0;
        const had = await pool.query(
            `SELECT COUNT(*)::int AS n FROM tv_campaign_awards WHERE campaign_id = $1 AND basis = 'leaderboard' AND period_key = $2`,
            [c.id, period.key]
        );
        if (Number(had.rows[0].n) > 0) return 0;
        const board = await this.standings(c, period, 50);
        return this.settleRanked(c, period.key, ranks, board);
    }

    /**
     * Places in order, decided: each prize goes to the best-placed player
     * still unpaired who may win it (eligible), or is let go if nobody can.
     * Used by a leaderboard period (above) and by a Live Round once its
     * results are final (tv-live-round.finalise, key 'round:<id>'). board is
     * [{ userId, playerId? }] in place order. Made once per key: a key that
     * already has places is left alone.
     */
    async settleRanked(c, key, ranks, board) {
        ranks = Array.isArray(ranks) ? ranks : [];
        if (!ranks.length) return 0;
        const had = await pool.query(
            `SELECT COUNT(*)::int AS n FROM tv_campaign_awards WHERE campaign_id = $1 AND basis = 'leaderboard' AND period_key = $2`,
            [c.id, key]
        );
        if (Number(had.rows[0].n) > 0) return 0;
        const period = { key };
        let next = 0;
        let made = 0;
        for (let i = 0; i < ranks.length; i++) {
            const prize = ranks[i] || {};
            const cash = Number(prize.amount) > 0;
            let winner = null;
            while (next < board.length && !winner) {
                const cand = board[next++];
                const may = await this.eligible(c, cand.userId);
                if (may.ok) winner = cand;
            }
            const ins = await pool.query(
                `INSERT INTO tv_campaign_awards (campaign_id, basis, period_key, place, prize_type, amount, item, status, reason, resolved_at)
                 VALUES ($1, 'leaderboard', $2, $3, $4, $5, $6, 'reserved', NULL, NULL)
                 ON CONFLICT (campaign_id, period_key, place) WHERE basis = 'leaderboard' DO NOTHING
                 RETURNING *`,
                [c.id, period.key, i + 1, cash ? 'cash' : 'item', cash ? Number(prize.amount) : null, cash ? null : String(prize.item || 'A prize')]
            );
            const row = ins.rows[0];
            if (!row) continue;
            made++;
            if (winner) await this._win(c, row, winner.userId, winner.playerId || null);
            else await this._release(row.id, 'no_eligible_player');
        }
        if (made) logger.info(`📣💰 Campaign ${c.id}: ${period.key} settled (${made} places)`);
        return made;
    }

    async settleLeaderboards(now = Date.now()) {
        const r = await pool.query(
            `SELECT * FROM tv_campaigns
             WHERE prize_basis = 'leaderboard' AND status IN ('published','paused','ended') AND published_at IS NOT NULL
               AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND starts_at < $1`,
            [new Date(now)]
        );
        let settled = 0;
        for (const c of r.rows) {
            const done = await pool.query(
                `SELECT DISTINCT period_key FROM tv_campaign_awards WHERE campaign_id = $1 AND basis = 'leaderboard'`, [c.id]
            );
            const have = new Set(done.rows.map(x => x.period_key));
            for (const p of this.periods(c)) {
                if (settled >= MAX_PERIODS_SETTLED_PER_SWEEP) return settled;
                if (p.to.getTime() > now || have.has(p.key)) continue;
                if (await this._settlePeriod(c, p)) settled++;
            }
        }
        return settled;
    }

    // ============================================
    // HOUSEKEEPING — run by the Party sweep
    // ============================================

    async sweep() {
        await tvAuth.ensureSchema();
        // A reservation whose room ended while this server was restarting.
        const stale = await pool.query(
            `SELECT a.tv_room_id FROM tv_campaign_awards a JOIN tv_rooms r ON r.id = a.tv_room_id
             WHERE a.status = 'reserved' AND r.status IN ('finished','closed') AND a.created_at < $1
             ORDER BY a.id LIMIT 50`,
            [new Date(Date.now() - STALE_RESERVATION_MS)]
        );
        for (const s of stale.rows) await this.settleRoom(Number(s.tv_room_id)).catch(e => logger.error(`Campaign prize sweep, room ${s.tv_room_id}: ${e.message}`));
        await this.settleLeaderboards();
    }

    // ============================================
    // THE ADMIN PAGE
    // ============================================

    _publicAward(a) {
        return {
            id: Number(a.id), basis: a.basis, place: a.place, periodKey: a.period_key, roomId: a.tv_room_id ? Number(a.tv_room_id) : null,
            tvId: a.tv_device_id ? Number(a.tv_device_id) : null, tvName: a.tv_name || null,
            prizeType: a.prize_type, amount: a.amount == null ? null : Number(a.amount), item: a.item,
            status: a.status, reason: a.reason, userId: a.user_id ? Number(a.user_id) : null, username: a.username || null,
            winner: (a.winner_details && a.winner_details.fields) || {},
            sentNote: a.sent_note, sentBy: a.sent_by, sentAt: a.sent_at, receivedAt: a.received_at, voidedBy: a.voided_by,
            payout: a.payout_id ? { id: Number(a.payout_id), status: a.payout_status, paidAt: a.paid_at, receivedAt: a.payout_received_at } : null,
            createdAt: a.created_at, resolvedAt: a.resolved_at
        };
    }

    async awards(campaignId, { limit = 300 } = {}) {
        const r = await pool.query(
            `SELECT a.*, u.username, COALESCE(d.admin_name, d.details->>'ownName', d.tv_name, d.label) AS tv_name,
                    po.id AS payout_id, po.status AS payout_status, po.paid_at, po.received_at AS payout_received_at
             FROM tv_campaign_awards a
             LEFT JOIN users u ON u.id = a.user_id
             LEFT JOIN tv_devices d ON d.id = a.tv_device_id
             LEFT JOIN tv_payouts po ON po.tv_campaign_award_id = a.id
             WHERE a.campaign_id = $1
             ORDER BY a.created_at DESC, a.id DESC
             LIMIT $2`,
            [campaignId, limit]
        );
        return r.rows.map(a => this._publicAward(a));
    }

    /** Everything the campaign page shows about its prizes. */
    async adminView(campaignId) {
        await tvAuth.ensureSchema();
        const c = await this._campaign(campaignId);
        if (!c) return { ok: false, error: 'No such campaign' };
        const [money, list] = await Promise.all([this.poolOf(c.id), this.awards(c.id)]);
        const out = { ok: true, money, awards: list, basis: c.prize_basis };
        if (c.prize_basis === 'leaderboard') {
            const p = this.currentPeriod(c);
            out.leaderboard = p ? { key: p.key, label: p.label, from: p.from, to: p.to, rows: await this.standings(c, p) } : null;
            out.periods = this.periods(c).map(x => ({ key: x.key, label: x.label, from: x.from, to: x.to }));
        }
        return out;
    }

    async _award(awardId) {
        const r = await pool.query(
            `SELECT a.*, c.name AS campaign_name, c.brand_name FROM tv_campaign_awards a
             JOIN tv_campaigns c ON c.id = a.campaign_id WHERE a.id = $1`, [awardId]);
        return r.rows[0] || null;
    }

    /** An item has gone to its winner. */
    async markSent(awardId, note, admin) {
        await tvAuth.ensureSchema();
        const a = await this._award(awardId);
        if (!a) return { ok: false, error: 'No such prize' };
        if (a.prize_type !== 'item') return { ok: false, error: 'A cash prize is paid from the payout queue on the WUT TV page' };
        const n = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (n.length < 3) return { ok: false, error: 'Say how it was sent (e.g. "Delivered by GIG, waybill 12345")' };
        const r = await pool.query(
            `UPDATE tv_campaign_awards SET status = 'sent', sent_note = $2, sent_by = $3, sent_at = NOW()
             WHERE id = $1 AND status = 'won' RETURNING *`,
            [a.id, n, admin || 'admin']
        );
        if (!r.rows[0]) return { ok: false, error: `This prize is ${a.status}; only a prize that has been won can be marked sent` };
        const tvPrize = require('./tv-prize.service');
        await tvPrize._tell(Number(a.user_id),
            `📦 Your prize from ${a.brand_name} is on its way: ${a.item}.\n${n}`,
            `When it arrives, please tell us here: ${tvPrize._prizesUrl()}`,
            `Your What's Up Trivia TV prize is on its way`);
        return { ok: true, award: this._publicAward(r.rows[0]) };
    }

    /**
     * An admin takes back a prize that has not been paid or sent: the money is
     * free again, and a payout waiting in the queue is cancelled.
     */
    async void(awardId, reason, admin) {
        await tvAuth.ensureSchema();
        const a = await this._award(awardId);
        if (!a) return { ok: false, error: 'No such prize' };
        const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (why.length < 3) return { ok: false, error: 'Say why it is being taken back' };
        if (!['won', 'reserved'].includes(a.status)) return { ok: false, error: `This prize is ${a.status} and cannot be taken back` };
        if (a.prize_type === 'cash') {
            const po = await pool.query(`SELECT id, status FROM tv_payouts WHERE tv_campaign_award_id = $1`, [a.id]);
            const p = po.rows[0];
            if (p && ['paid', 'sending'].includes(p.status)) return { ok: false, error: 'It has already been paid, or is being sent' };
            if (p) await pool.query(`UPDATE tv_payouts SET status = 'cancelled', hold_reason = $2 WHERE id = $1 AND status NOT IN ('paid','sending')`, [p.id, 'Taken back: ' + why]);
        }
        const r = await pool.query(
            `UPDATE tv_campaign_awards SET status = 'void', reason = $2, voided_by = $3, resolved_at = NOW()
             WHERE id = $1 AND status IN ('won','reserved') RETURNING *`,
            [a.id, why, admin || 'admin']
        );
        if (!r.rows[0]) return { ok: false, error: 'That prize has just changed; refresh and look again' };
        logger.warn(`📣💰 Campaign ${a.campaign_id}: award ${a.id} voided by ${admin || 'admin'} (${why})`);
        return { ok: true, award: this._publicAward(r.rows[0]) };
    }

    // ============================================
    // THE WINNER, on the prizes page
    // ============================================

    /** Items this account has won, to show beside the cash payouts. */
    async itemsFor(userId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `SELECT a.id, a.item, a.status, a.sent_note, a.sent_at, a.received_at, a.resolved_at, c.name AS campaign, c.brand_name AS brand
             FROM tv_campaign_awards a JOIN tv_campaigns c ON c.id = a.campaign_id
             WHERE a.user_id = $1 AND a.prize_type = 'item' AND a.status = ANY($2::text[])
             ORDER BY a.resolved_at DESC NULLS LAST, a.id DESC LIMIT 50`,
            [userId, WON_STATUSES]
        );
        return r.rows.map(x => ({
            id: Number(x.id), item: x.item, status: x.status, campaign: x.campaign, brand: x.brand,
            sentNote: x.sent_note, sentAt: x.sent_at, receivedAt: x.received_at, wonAt: x.resolved_at
        }));
    }

    /** The winner says their item arrived. */
    async confirmItem(userId, awardId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `UPDATE tv_campaign_awards SET status = 'received', received_at = NOW()
             WHERE id = $1 AND user_id = $2 AND prize_type = 'item' AND status = 'sent'
             RETURNING id, received_at`,
            [awardId, userId]
        );
        if (r.rows[0]) return { ok: true, receivedAt: r.rows[0].received_at };
        const c = await pool.query(`SELECT user_id, status FROM tv_campaign_awards WHERE id = $1`, [awardId]);
        const a = c.rows[0];
        if (!a || Number(a.user_id) !== Number(userId)) return { ok: false, reason: 'not_yours' };
        if (a.status === 'received') return { ok: false, reason: 'already_confirmed' };
        return { ok: false, reason: 'not_sent_yet' };
    }
}

module.exports = new TvCampaignPrizeService();
module.exports.lagosDay = lagosDay;
module.exports.lagosMidnight = lagosMidnight;
module.exports.HELD_STATUSES = HELD_STATUSES;
module.exports.WON_STATUSES = WON_STATUSES;
module.exports.STALE_RESERVATION_MS = STALE_RESERVATION_MS;
