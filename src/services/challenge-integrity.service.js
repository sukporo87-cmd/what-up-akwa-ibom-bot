// ============================================
// FILE: src/services/challenge-integrity.service.js
// Anti-collusion gates 2 and 3.
//
// GATE 1 (live since stage 5a) refuses a join when the same device is already
// in the challenge. It runs at the door.
//
// GATE 2 is this file: a pairwise check across everyone who FINISHED, run once
// at grading. It cannot run earlier, because the strongest signal — how two
// people answered — does not exist until they have answered.
//
// GATE 3 is what happens when it trips, and it is deliberately quiet.
//
// TWO SIGNALS, NEVER ONE
// Every check here has a legitimate explanation. Two brothers share a phone.
// A whole office shares an IP. A cybercafé shares both. Two people who know
// the same answers answer at similar speeds. Any single signal used alone
// would accuse families and cybercafé customers of fraud, and this platform
// runs in a country where shared devices and shared connections are normal,
// not suspicious. So a trip requires TWO INDEPENDENT signals, and even then
// the outcome is a hold and a human, never an automatic ban.
//
// WHAT THIS DOES NOT DO
// It does not ban, does not forfeit, does not message the players, and does
// not accuse anyone. It records evidence and holds money. Every decision that
// costs a player something is made by a person looking at the alert.
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

// Two accounts created this close together, in a challenge with money on it,
// is a weak signal on its own and a meaningful one alongside anything else.
const NEW_ACCOUNT_WINDOW_MS = 24 * 3600 * 1000;

// Pearson correlation above this across at least MIN_POSITIONS answers.
// One person playing two rounds produces a near-identical shape: they are
// fast on the ones they know and slow on the ones they do not, twice.
const TIMING_CORRELATION_THRESHOLD = 0.9;
const MIN_POSITIONS_FOR_CORRELATION = 10;

// Or: nearly the same time on nearly every question, which is the other
// fingerprint of one person answering twice from the same knowledge.
const TIGHT_DELTA_MS = 400;
const TIGHT_DELTA_RATIO = 0.8;

class ChallengeIntegrityService {

    // ============================================
    // PEARSON CORRELATION
    // ============================================
    // Pure, so it is testable without a database and without a challenge.

    correlate(a, b) {
        const n = Math.min(a.length, b.length);
        if (n < MIN_POSITIONS_FOR_CORRELATION) return null;

        const x = a.slice(0, n), y = b.slice(0, n);
        const mean = (v) => v.reduce((s, k) => s + k, 0) / v.length;
        const mx = mean(x), my = mean(y);

        let num = 0, dx = 0, dy = 0;
        for (let i = 0; i < n; i++) {
            const a1 = x[i] - mx, b1 = y[i] - my;
            num += a1 * b1; dx += a1 * a1; dy += b1 * b1;
        }

        // Zero variance means someone answered every question in exactly the
        // same time, which is a bot signal rather than a correlation one — and
        // dividing by it would produce NaN or a spurious 1.0.
        if (dx === 0 || dy === 0) return null;

        return num / Math.sqrt(dx * dy);
    }

    tightDeltaRatio(a, b) {
        const n = Math.min(a.length, b.length);
        if (n < MIN_POSITIONS_FOR_CORRELATION) return 0;
        let tight = 0;
        for (let i = 0; i < n; i++) {
            if (Math.abs(a[i] - b[i]) <= TIGHT_DELTA_MS) tight++;
        }
        return tight / n;
    }

    // ============================================
    // GATE 2 — the pairwise check
    // ============================================

    async check(challenge) {
        const finishers = await pool.query(`
            SELECT p.id, p.user_id, p.join_ip::text AS join_ip, p.join_device_id,
                   p.is_new_user, u.username, u.created_at
            FROM challenge_participants p
            JOIN users u ON u.id = p.user_id
            WHERE p.challenge_id = $1 AND p.status = 'finished'
        `, [challenge.id]);

        if (finishers.rows.length < 2) {
            return { tripped: false, reason: 'fewer_than_two_finishers', pairs: [] };
        }

        const timings = await this._timings(challenge.id);
        const sponsored = Number(challenge.prize_amount) > 0;
        const flagged = [];

        for (let i = 0; i < finishers.rows.length; i++) {
            for (let j = i + 1; j < finishers.rows.length; j++) {
                const pair = await this._checkPair(
                    finishers.rows[i], finishers.rows[j], timings, sponsored, challenge
                );
                if (pair.signals.length >= 2) flagged.push(pair);
            }
        }

        return {
            tripped: flagged.length > 0,
            pairs: flagged,
            finishers: finishers.rows.length
        };
    }

    async _timings(challengeId) {
        const result = await pool.query(`
            SELECT r.user_id, a.position, a.answer_ms
            FROM challenge_answers a
            JOIN challenge_rounds r ON r.id = a.round_id
            WHERE a.challenge_id = $1
            ORDER BY r.user_id, a.position
        `, [challengeId]);

        const byUser = new Map();
        for (const row of result.rows) {
            if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
            byUser.get(row.user_id).push(row.answer_ms);
        }
        return byUser;
    }

    async _checkPair(a, b, timings, sponsored, challenge) {
        const signals = [];

        // --- shared device ---
        // Only meaningful on a real browser fingerprint. The identifier-derived
        // value chat platforms produce is per-account and can never collide, so
        // a match here is genuine.
        if (a.join_device_id && b.join_device_id && a.join_device_id === b.join_device_id) {
            signals.push({ type: 'shared_device', weight: 'strong', value: a.join_device_id });
        }

        // --- shared IP ---
        // Exact match only. A /24 match would flag every player on the same
        // ISP block, which in Nigeria is a very large number of unrelated
        // people behind carrier-grade NAT.
        if (a.join_ip && b.join_ip && a.join_ip === b.join_ip) {
            signals.push({ type: 'shared_ip', weight: 'moderate', value: a.join_ip });
        }

        // --- an existing link from device-tracking ---
        const link = await pool.query(`
            SELECT link_type, confidence_score FROM account_links
            WHERE (user_id_1 = $1 AND user_id_2 = $2) OR (user_id_1 = $2 AND user_id_2 = $1)
            ORDER BY confidence_score DESC LIMIT 1
        `, [a.user_id, b.user_id]);

        if (link.rows[0]) {
            signals.push({
                type: 'existing_account_link',
                weight: 'strong',
                value: link.rows[0].link_type,
                confidence: Number(link.rows[0].confidence_score)
            });
        }

        // --- answer timing ---
        const ta = timings.get(a.user_id) || [];
        const tb = timings.get(b.user_id) || [];
        const r = this.correlate(ta, tb);
        const tight = this.tightDeltaRatio(ta, tb);

        if (r !== null && r >= TIMING_CORRELATION_THRESHOLD) {
            signals.push({ type: 'timing_correlation', weight: 'moderate', value: Number(r.toFixed(3)) });
        } else if (tight >= TIGHT_DELTA_RATIO) {
            signals.push({ type: 'timing_near_identical', weight: 'moderate', value: Number(tight.toFixed(2)) });
        }

        // --- both accounts brand new, on a challenge with money on it ---
        // Deliberately only counts when a prize is at stake AND the initiator
        // is one of the pair. Two new players finding the product together is
        // ordinary; two new accounts around the initiator's own prize is the
        // laundering shape.
        if (sponsored) {
            const gap = Math.abs(new Date(a.created_at) - new Date(b.created_at));
            const involvesInitiator =
                a.user_id === challenge.creator_user_id || b.user_id === challenge.creator_user_id;

            if (gap <= NEW_ACCOUNT_WINDOW_MS && involvesInitiator) {
                signals.push({ type: 'coincident_new_accounts', weight: 'weak', value: Math.round(gap / 3600000) + 'h' });
            }
        }

        return {
            userA: a.user_id, userB: b.user_id,
            usernameA: a.username, usernameB: b.username,
            signals
        };
    }

    // ============================================
    // GATE 3 — what happens when it trips
    // ============================================
    //
    //   The round        still played, still scored. We do not delete play.
    //   The result card  still renders. Nothing is said to anyone.
    //   The leaderboard  excluded, via challenges.integrity_hold.
    //   Instrumentation  excluded, so accept and completion rates stay honest.
    //   A sponsored prize HELD. Not paid, and NOT refunded — refunding hands
    //                    the money straight back to whoever was laundering it.
    //   The record       a fraud_alerts row with the full evidence, for a human.
    //
    // Nothing here bans, forfeits or messages a player. A false positive costs
    // a review; a false accusation costs a customer.

    async applyHold(challenge, result) {
        if (!result.tripped) return { held: false };

        await pool.query(
            `UPDATE challenges SET integrity_hold = true, updated_at = NOW() WHERE id = $1`,
            [challenge.id]
        );

        const sponsored = Number(challenge.prize_amount) > 0;
        const severity = sponsored ? 'high' : 'medium';

        for (const pair of result.pairs) {
            const description =
                `Challenge ${challenge.code}: ${pair.signals.length} collusion signals between ` +
                `@${pair.usernameA} and @${pair.usernameB} ` +
                `(${pair.signals.map(s => s.type).join(', ')})` +
                (sponsored ? ` \u2014 \u20a6${challenge.prize_amount} prize withheld pending review` : '');

            // One alert per user in the pair, so it surfaces on either
            // player's fraud report rather than only the first.
            for (const userId of [pair.userA, pair.userB]) {
                await pool.query(`
                    INSERT INTO fraud_alerts (user_id, alert_type, severity, description, evidence, status)
                    VALUES ($1, 'challenge_collusion', $2, $3, $4, 'new')
                `, [
                    userId, severity, description,
                    JSON.stringify({
                        challengeId: challenge.id,
                        challengeCode: challenge.code,
                        prizeAmount: challenge.prize_amount,
                        counterparty: userId === pair.userA ? pair.userB : pair.userA,
                        signals: pair.signals
                    })
                ]);
            }

            // Record the relationship so the next challenge between these two
            // starts from a known link rather than from nothing.
            await pool.query(`
                INSERT INTO account_links (user_id_1, user_id_2, link_type, confidence_score, evidence)
                VALUES ($1, $2, 'challenge_collusion', $3, $4)
                ON CONFLICT DO NOTHING
            `, [
                Math.min(pair.userA, pair.userB),
                Math.max(pair.userA, pair.userB),
                pair.signals.length >= 3 ? 0.9 : 0.7,
                JSON.stringify({ challengeCode: challenge.code, signals: pair.signals })
            ]);
        }

        const challengeService = require('./challenge.service');
        await challengeService.recordEvent(
            challenge.id, null, 'integrity_flagged', null,
            { pairs: result.pairs.length, sponsored, severity }
        );

        logger.warn(
            `\u26a0\ufe0f Challenge ${challenge.code} held: ${result.pairs.length} flagged pair(s), ` +
            `severity ${severity}${sponsored ? ', prize withheld' : ''}`
        );

        return { held: true, severity, sponsored, pairs: result.pairs.length };
    }

    // ============================================
    // RUN — the single entry point, called at grading
    // ============================================
    // Never throws. An integrity check that crashes must not stop two players
    // seeing the result of a game they just played.

    async run(challenge) {
        try {
            const result = await this.check(challenge);
            if (!result.tripped) return { tripped: false };
            const applied = await this.applyHold(challenge, result);
            return { ...applied, tripped: true, pairs: result.pairs };
        } catch (error) {
            logger.error(`Integrity check failed for challenge ${challenge.code}:`, error.message);
            return { tripped: false, error: error.message };
        }
    }

    // ============================================
    // ADMIN REVIEW QUEUE
    // ============================================

    async getReviewQueue(limit = 50) {
        const result = await pool.query(`
            SELECT c.id, c.code, c.prize_amount, c.completed_at, c.format, c.mode,
                   creator.username AS created_by,
                   (SELECT COUNT(*)::int FROM challenge_participants p
                     WHERE p.challenge_id = c.id AND p.status = 'finished') AS finishers,
                   (SELECT json_agg(json_build_object(
                        'alertId', f.id, 'userId', f.user_id, 'severity', f.severity,
                        'evidence', f.evidence, 'status', f.status))
                    FROM fraud_alerts f
                    WHERE f.alert_type = 'challenge_collusion'
                      AND f.evidence->>'challengeId' = c.id::text) AS alerts
            FROM challenges c
            JOIN users creator ON creator.id = c.creator_user_id
            WHERE c.integrity_hold = true
            ORDER BY c.prize_amount DESC, c.completed_at DESC
            LIMIT $1
        `, [limit]);

        return result.rows;
    }

    // ============================================
    // CLEARING A HOLD
    // ============================================
    // Explicitly a human action, and it does NOT pay anything out by itself.
    // Stage 10 owns the award; this only says the challenge is clean.

    async clearHold(challengeId, adminId, notes = '') {
        await pool.query(
            `UPDATE challenges SET integrity_hold = false, updated_at = NOW() WHERE id = $1`,
            [challengeId]
        );

        await pool.query(`
            UPDATE fraud_alerts
            SET status = 'resolved', resolved_by = $1, resolved_at = NOW(), resolution_notes = $2
            WHERE alert_type = 'challenge_collusion' AND evidence->>'challengeId' = $3::text
        `, [adminId, notes || 'Cleared after review', String(challengeId)]);

        logger.info(`Challenge ${challengeId} integrity hold cleared by admin ${adminId}`);
        return { cleared: true };
    }
}

module.exports = new ChallengeIntegrityService();
module.exports.TIMING_CORRELATION_THRESHOLD = TIMING_CORRELATION_THRESHOLD;
module.exports.MIN_POSITIONS_FOR_CORRELATION = MIN_POSITIONS_FOR_CORRELATION;
module.exports.TIGHT_DELTA_MS = TIGHT_DELTA_MS;
