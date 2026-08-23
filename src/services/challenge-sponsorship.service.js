// ============================================
// FILE: src/services/challenge-sponsorship.service.js
// Sponsored prizes: hold, settle, award, refund.
//
// THREE RULES FROM THE BRIEF, AND WHERE EACH ONE LIVES
//
// 1. SETTLED, NOT INITIATED, before the challenge opens.
//    settle() is called ONLY from the gateway webhook. The browser callback
//    sets nothing — it shows a confirming screen and the link goes live when
//    the money clears, exactly like credit tokens already work.
//
// 2. ANTI-COLLUSION WITHHOLDS, never pays and never refunds.
//    award() checks challenges.integrity_hold and creates the transaction
//    with payout_hold = true instead. Refunding a held prize would hand the
//    money straight back to whoever was laundering it.
//
// 3. ONLY A COMPLETED CHALLENGE AWARDS.
//    award() is called from ONE place — the grading -> completed transition.
//    A solo finish never reaches that state, so it can never produce a
//    transaction. That is the whole point of the completion rule: without it
//    an initiator could sponsor ₦50,000, invite nobody real, win by default
//    and claim their own money back through the payout channel.
//
// TRANSACTION TYPES
// 'challenge_prize' and 'challenge_refund', mirroring 'tournament_prize'.
// That one choice inherits CLAIM, bank details, the 72-hour window and the
// admin payout workspace unchanged — AND keeps sponsored money outside
// restrictions.service.getDailyWinnings(), which sums 'prize' alone. The
// ₦30,000 daily cap exemption is that omission, not a flag.
//
// It also keeps sponsored money out of users.total_winnings, which is the main
// leaderboard's ranking key. A sponsored prize must never move a player up the
// published ranking.
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');
const challengeService = require('./challenge.service');

const REFERENCE_PREFIX = 'CHS-';

class ChallengeSponsorshipService {

    // ============================================
    // INITIATE
    // ============================================

    async initiate(challenge, user, platform, gatewayName = null) {
        if (Number(challenge.prize_amount) <= 0) {
            return { ok: false, reason: 'not_sponsored' };
        }
        if (challenge.creator_user_id !== user.id) {
            return { ok: false, reason: 'not_yours' };
        }

        const existing = await pool.query(
            `SELECT payment_status, payment_reference FROM challenge_sponsorships WHERE challenge_id = $1`,
            [challenge.id]
        );
        if (existing.rows[0] && existing.rows[0].payment_status === 'settled') {
            return { ok: false, reason: 'already_settled' };
        }

        const gatewayManager = require('./payment-gateway-manager');
        const gateway = gatewayName
            ? await gatewayManager.getEnabledGatewayByName(gatewayName)
            : await gatewayManager.getDefaultGateway();

        // The prefix is what routes this back to us in the shared webhook
        // processor, the same way TRN- routes tournament payments.
        const reference = `${REFERENCE_PREFIX}${challenge.id}-${user.id}-${Date.now()}`;

        const initResult = await gateway.initialize({
            reference,
            amount: challenge.prize_amount,
            email: user.email || `${user.phone_number}@whatsuptrivia.com`,
            callbackUrl: `${process.env.APP_URL}/payment/callback`,
            customerName: user.full_name,
            metadata: {
                user_id: user.id,
                challenge_id: challenge.id,
                challenge_code: challenge.code,
                prize_amount: challenge.prize_amount,
                platform,
                description: `Challenge prize: ${challenge.code}`
            }
        });

        await pool.query(`
            INSERT INTO challenge_sponsorships
                (challenge_id, user_id, amount, gateway, payment_reference, payment_status)
            VALUES ($1, $2, $3, $4, $5, 'pending')
            ON CONFLICT (challenge_id) DO UPDATE
                SET payment_reference = EXCLUDED.payment_reference,
                    gateway = EXCLUDED.gateway,
                    payment_status = 'pending',
                    updated_at = NOW()
        `, [challenge.id, user.id, challenge.prize_amount, gateway.getName(), reference]);

        logger.info(`Challenge sponsorship initialised via ${gateway.getName()}: ${reference}`);

        return {
            ok: true,
            reference,
            authorizationUrl: initResult.authorization_url,
            gateway: gateway.getName()
        };
    }

    isSponsorshipReference(reference) {
        return typeof reference === 'string' && reference.startsWith(REFERENCE_PREFIX);
    }

    // ============================================
    // SETTLE — webhook only
    // ============================================
    // This is the ONLY thing that opens a sponsored challenge. Idempotent:
    // gateways retry webhooks, and settling twice must not open twice or
    // double-message the initiator.

    async settle(reference) {
        const sponsorship = await pool.query(
            `SELECT * FROM challenge_sponsorships WHERE payment_reference = $1`,
            [reference]
        );

        const row = sponsorship.rows[0];
        if (!row) {
            logger.error(`Sponsorship webhook for unknown reference: ${reference}`);
            return { ok: false, reason: 'unknown_reference' };
        }
        if (row.payment_status === 'settled') {
            return { ok: true, alreadySettled: true, challengeId: row.challenge_id };
        }

        await pool.query(`
            UPDATE challenge_sponsorships
            SET payment_status = 'settled', settled_at = NOW(), updated_at = NOW()
            WHERE id = $1
        `, [row.id]);

        // Only NOW does the link become live. Guarded on the current status so
        // a late webhook cannot reopen a cancelled or expired challenge.
        const opened = await pool.query(`
            UPDATE challenges
            SET status = 'open', opened_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND status = 'awaiting_sponsorship'
            RETURNING id, code
        `, [row.challenge_id]);

        await challengeService.recordEvent(
            row.challenge_id, row.user_id, 'sponsorship_settled', null,
            { amount: row.amount, gateway: row.gateway }
        );

        logger.info(`Challenge sponsorship settled: ${reference} (\u20a6${row.amount})`);

        return {
            ok: true,
            challengeId: row.challenge_id,
            code: opened.rows[0] ? opened.rows[0].code : null,
            userId: row.user_id,
            amount: row.amount,
            opened: opened.rows.length > 0
        };
    }

    // ============================================
    // AWARD — called ONLY at grading -> completed
    // ============================================

    async award(challenge, winnerUserId) {
        const sponsorship = await pool.query(
            `SELECT * FROM challenge_sponsorships
             WHERE challenge_id = $1 AND payment_status = 'settled'`,
            [challenge.id]
        );

        const row = sponsorship.rows[0];
        if (!row) return { ok: false, reason: 'no_settled_sponsorship' };

        // The initiator cannot win their own sponsored prize. This is a
        // backstop: the completion rule already makes a solo win impossible,
        // but if the initiator legitimately wins a real challenge the money is
        // theirs coming back and must not go out through the payout channel.
        if (winnerUserId === challenge.creator_user_id) {
            await pool.query(
                `UPDATE challenge_sponsorships
                 SET payment_status = 'withheld', withheld_reason = 'initiator_won_own_prize',
                     updated_at = NOW() WHERE id = $1`,
                [row.id]
            );
            logger.warn(`Challenge ${challenge.code}: initiator won their own sponsored prize \u2014 withheld`);
            return { ok: false, reason: 'initiator_won' };
        }

        const held = challenge.integrity_hold === true;

        const transaction = await pool.query(`
            INSERT INTO transactions
                (user_id, amount, transaction_type, status, payout_status,
                 payout_hold, hold_reason, platform, win_data)
            VALUES ($1, $2, 'challenge_prize', 'success', 'pending', $3, $4, $5, $6)
            RETURNING id
        `, [
            winnerUserId, row.amount, held,
            held ? 'challenge_integrity_review' : null,
            challenge.created_platform || 'web',
            JSON.stringify({
                challengeId: challenge.id,
                challengeCode: challenge.code,
                sponsorshipId: row.id,
                sponsoredBy: challenge.creator_user_id
            })
        ]);

        await pool.query(`
            UPDATE challenge_sponsorships
            SET payment_status = $1, awarded_transaction_id = $2, updated_at = NOW(),
                withheld_reason = $3
            WHERE id = $4
        `, [
            held ? 'withheld' : 'awarded',
            transaction.rows[0].id,
            held ? 'challenge_integrity_review' : null,
            row.id
        ]);

        logger.info(
            `Challenge ${challenge.code}: \u20a6${row.amount} ${held ? 'WITHHELD for review' : 'awarded'} ` +
            `to user ${winnerUserId} (transaction ${transaction.rows[0].id})`
        );

        return {
            ok: true,
            held,
            amount: row.amount,
            transactionId: transaction.rows[0].id
        };
    }

    // ============================================
    // VOID + REFUND — the challenge did not complete
    // ============================================
    // The 15% split is computed ONCE here and stored. Never recomputed at
    // display time: a percentage derived in two places is how two screens end
    // up disagreeing by a naira. The migration has a CHECK constraint that
    // rejects a row where the halves do not reconcile.
    //
    // The refund is a manual payout, like every other payout on this platform.
    // No gateway refund API is called.

    async voidAndRefund(challenge) {
        const sponsorship = await pool.query(
            `SELECT * FROM challenge_sponsorships
             WHERE challenge_id = $1 AND payment_status IN ('settled','pending')`,
            [challenge.id]
        );

        const row = sponsorship.rows[0];
        if (!row) return { ok: false, reason: 'nothing_to_refund' };

        // A sponsorship that never settled is not the platform's money to
        // split — nothing was taken, so nothing is retained.
        if (row.payment_status === 'pending') {
            await pool.query(
                `UPDATE challenge_sponsorships SET payment_status = 'failed', updated_at = NOW()
                 WHERE id = $1`,
                [row.id]
            );
            return { ok: true, refunded: false, reason: 'never_settled' };
        }

        const split = challengeService.refundSplit(row.amount);

        const transaction = await pool.query(`
            INSERT INTO transactions
                (user_id, amount, transaction_type, status, payout_status, platform, win_data)
            VALUES ($1, $2, 'challenge_refund', 'success', 'pending', $3, $4)
            RETURNING id
        `, [
            row.user_id, split.refund, challenge.created_platform || 'web',
            JSON.stringify({
                challengeId: challenge.id,
                challengeCode: challenge.code,
                sponsorshipId: row.id,
                gross: split.gross,
                retained: split.retained,
                reason: 'challenge_did_not_complete'
            })
        ]);

        await pool.query(`
            UPDATE challenge_sponsorships
            SET payment_status = 'refunded', refunded_at = NOW(),
                refund_amount = $1, retained_amount = $2,
                refund_transaction_id = $3, updated_at = NOW()
            WHERE id = $4
        `, [split.refund, split.retained, transaction.rows[0].id, row.id]);

        await pool.query(`
            UPDATE challenges
            SET status = 'void_refunded', updated_at = NOW()
            WHERE id = $1
        `, [challenge.id]);

        logger.info(
            `Challenge ${challenge.code} void: \u20a6${split.gross} in, \u20a6${split.refund} refundable, ` +
            `\u20a6${split.retained} retained`
        );

        return {
            ok: true,
            refunded: true,
            gross: split.gross,
            refund: split.refund,
            retained: split.retained,
            transactionId: transaction.rows[0].id
        };
    }
}

module.exports = new ChallengeSponsorshipService();
module.exports.REFERENCE_PREFIX = REFERENCE_PREFIX;
