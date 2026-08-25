// ============================================
// FILE: src/services/challenge-analytics.service.js
// Every metric the brief asks for, out of one table.
//
// challenge_events is append-only and carries challenge_id, user_id, event,
// platform and a jsonb meta. Seven questions were named in the brief:
//
//   invites sent · accept rate · acceptors who are brand-new users ·
//   async vs live split · group size distribution ·
//   completion rate per mode · sponsored vs unsponsored
//
// TWO THINGS THIS DELIBERATELY DOES
//
// 1. EXCLUDES HELD CHALLENGES from the rates. A challenge where
//    anti-collusion tripped is not a real accept and not a real completion,
//    and counting it would flatter exactly the numbers a farmer is inflating.
//
// 2. RETURNS NULL, NOT ZERO, for a rate with no denominator. "0% accept rate"
//    on a feature nobody has been invited to yet is a false alarm that costs
//    somebody an afternoon. No data is not the same as bad data.
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

// The backlog's stated bar: if accept rate clears roughly a third, the feature
// is working. Kept here so the panel shows the target rather than a bare
// number nobody can judge.
const ACCEPT_RATE_TARGET = 0.33;

class ChallengeAnalyticsService {

    _rate(numerator, denominator) {
        if (!denominator) return null;
        return Number((numerator / denominator).toFixed(4));
    }

    // ============================================
    // THE FUNNEL
    // ============================================

    async funnel(days = 30) {
        const result = await pool.query(`
            SELECT e.event, e.platform, COUNT(*)::int AS n
            FROM challenge_events e
            LEFT JOIN challenges c ON c.id = e.challenge_id
            WHERE e.created_at > NOW() - ($1 || ' days')::interval
              AND COALESCE(c.integrity_hold, false) = false
            GROUP BY e.event, e.platform
        `, [String(days)]);

        const byEvent = {};
        const byPlatform = {};

        for (const row of result.rows) {
            byEvent[row.event] = (byEvent[row.event] || 0) + row.n;
            const p = row.platform || 'unknown';
            byPlatform[p] = byPlatform[p] || {};
            byPlatform[p][row.event] = row.n;
        }

        const invitesSent = byEvent.invite_sent || 0;
        const opened = byEvent.invite_opened || 0;
        const accepted = byEvent.accepted || 0;

        return {
            created: byEvent.created || 0,
            invitesSent,
            invitesOpened: opened,
            accepted,
            roundsStarted: byEvent.round_started || 0,
            roundsFinished: byEvent.round_finished || 0,
            cardsGenerated: byEvent.card_generated || 0,
            cardsShared: byEvent.card_shared || 0,

            openRate: this._rate(opened, invitesSent),
            // The headline number. Null until there is something to divide by.
            acceptRate: this._rate(accepted, invitesSent),
            acceptRateTarget: ACCEPT_RATE_TARGET,
            meetsTarget: invitesSent > 0 && (accepted / invitesSent) >= ACCEPT_RATE_TARGET,

            byPlatform
        };
    }

    // ============================================
    // NEW USERS
    // ============================================
    // The number that decides whether this is a GROWTH feature or a RETENTION
    // feature. If most acceptors already had accounts, challenges are keeping
    // existing players busy; if a real share are brand new, the invite link is
    // doing acquisition and deserves more investment.

    async newUserAcceptors(days = 30) {
        const result = await pool.query(`
            SELECT COUNT(*)::int                                    AS accepted,
                   COUNT(*) FILTER (WHERE p.is_new_user)::int       AS brand_new
            FROM challenge_participants p
            JOIN challenges c ON c.id = p.challenge_id
            WHERE p.role = 'invitee'
              AND p.accepted_at IS NOT NULL
              AND p.accepted_at > NOW() - ($1 || ' days')::interval
              AND c.integrity_hold = false
        `, [String(days)]);

        const row = result.rows[0] || { accepted: 0, brand_new: 0 };
        return {
            accepted: row.accepted,
            brandNew: row.brand_new,
            share: this._rate(row.brand_new, row.accepted)
        };
    }

    // ============================================
    // MODE, FORMAT, GROUP SIZE, SPONSORSHIP
    // ============================================

    async breakdown(days = 30) {
        const result = await pool.query(`
            SELECT c.mode, c.format, c.status,
                   (c.prize_amount > 0)                             AS sponsored,
                   COALESCE(c.prize_amount, 0)                      AS prize_amount,
                   (SELECT COUNT(*)::int FROM challenge_participants p
                     WHERE p.challenge_id = c.id AND p.status <> 'expired') AS participants
            FROM challenges c
            WHERE c.created_at > NOW() - ($1 || ' days')::interval
              AND c.integrity_hold = false
              -- Rematches are generated by a result card, not created by a
              -- person. Counting them made the funnel report more challenges
              -- created than invites sent, which is impossible.
              AND NOT (c.settings ? 'rematchOf')
        `, [String(days)]);

        const rows = result.rows;

        const modes = { async: 0, live: 0 };
        const formats = { direct: 0, group: 0 };
        const sponsorship = { sponsored: 0, unsponsored: 0, totalPrizePool: 0 };
        const sizes = {};
        const perMode = {
            async: { completed: 0, expired: 0, open: 0 },
            live: { completed: 0, expired: 0, open: 0 }
        };

        for (const row of rows) {
            if (modes[row.mode] !== undefined) modes[row.mode]++;
            if (formats[row.format] !== undefined) formats[row.format]++;

            if (row.sponsored) {
                sponsorship.sponsored++;
                sponsorship.totalPrizePool += Number(row.prize_amount);
            } else {
                sponsorship.unsponsored++;
            }

            // Group size distribution, bucketed by actual participants rather
            // than by the cap the creator chose \u2014 a 20-slot challenge that two
            // people played is a 2-player challenge.
            const size = row.participants;
            sizes[size] = (sizes[size] || 0) + 1;

            const bucket = perMode[row.mode];
            if (!bucket) continue;
            if (row.status === 'completed') bucket.completed++;
            else if (['expired', 'void_refunded', 'cancelled'].includes(row.status)) bucket.expired++;
            else bucket.open++;
        }

        const completionRate = {};
        for (const mode of ['async', 'live']) {
            const b = perMode[mode];
            const settled = b.completed + b.expired;
            completionRate[mode] = {
                completed: b.completed,
                expired: b.expired,
                stillOpen: b.open,
                // Only settled challenges count. An open challenge has not
                // failed yet, and counting it as a failure makes every fresh
                // day look like a collapse.
                rate: this._rate(b.completed, settled)
            };
        }

        return { modes, formats, sponsorship, groupSizes: sizes, completionRate, total: rows.length };
    }

    // ============================================
    // MONEY
    // ============================================

    async money(days = 30) {
        const result = await pool.query(`
            SELECT payment_status, COUNT(*)::int AS n,
                   COALESCE(SUM(amount), 0)::int          AS gross,
                   COALESCE(SUM(refund_amount), 0)::int   AS refunded,
                   COALESCE(SUM(retained_amount), 0)::int AS retained
            FROM challenge_sponsorships
            WHERE created_at > NOW() - ($1 || ' days')::interval
            GROUP BY payment_status
        `, [String(days)]);

        const out = { settled: 0, awarded: 0, withheld: 0, refunded: 0, pending: 0, failed: 0 };
        let grossIn = 0, paidOut = 0, retained = 0;

        for (const row of result.rows) {
            if (out[row.payment_status] !== undefined) out[row.payment_status] = row.n;
            if (['settled', 'awarded', 'withheld', 'refunded'].includes(row.payment_status)) {
                grossIn += row.gross;
            }
            if (row.payment_status === 'awarded') paidOut += row.gross;
            if (row.payment_status === 'refunded') {
                paidOut += row.refunded;
                retained += row.retained;
            }
        }

        return {
            counts: out,
            // Sponsored prizes are PASS-THROUGH money, not house cost. The
            // sponsor paid it in and we hand it on. Reporting in and out as a
            // matched pair is what keeps "prizes paid" from overstating what
            // the business actually spends.
            grossIn,
            paidOut,
            retained,
            netToPlatform: retained,
            currentlyHeld: grossIn - paidOut - retained
        };
    }

    // ============================================
    // EVERYTHING, FOR THE PANEL
    // ============================================

    async summary(days = 30) {
        try {
            const [funnel, newUsers, breakdown, money] = await Promise.all([
                this.funnel(days),
                this.newUserAcceptors(days),
                this.breakdown(days),
                this.money(days)
            ]);
            return { ok: true, days, funnel, newUsers, breakdown, money };
        } catch (error) {
            logger.error('Challenge analytics failed:', error.message);
            return { ok: false, error: error.message };
        }
    }
}

module.exports = new ChallengeAnalyticsService();
module.exports.ACCEPT_RATE_TARGET = ACCEPT_RATE_TARGET;