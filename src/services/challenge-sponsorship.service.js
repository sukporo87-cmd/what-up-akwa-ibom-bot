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

    /**
     * Collects everything the creator owes in ONE payment: setup charge, prize
     * and prize fee together.
     *
     * One payment, not three, because three means three gateway fees, three
     * ways to half-succeed, and a challenge that is two-thirds paid for. The
     * challenge row already carries the itemised figures, so a single
     * settlement can be reconciled against them afterwards.
     */
    async initiate(challenge, user, platform, gatewayName = null) {
        const owed = Number(challenge.total_charged) || Number(challenge.prize_amount) || 0;
        if (owed <= 0) {
            return { ok: false, reason: 'nothing_to_pay' };
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
            amount: owed,
            email: user.email || `${user.phone_number}@whatsuptrivia.com`,
            callbackUrl: `${process.env.APP_URL}/payment/callback`,
            customerName: user.full_name,
            metadata: {
                user_id: user.id,
                challenge_id: challenge.id,
                challenge_code: challenge.code,
                // Itemised in the gateway record too, so a dispute months
                // later can be answered without joining back to our tables.
                setup_charge: Number(challenge.setup_charge) || 0,
                prize_amount: Number(challenge.prize_amount) || 0,
                prize_fee: Number(challenge.prize_fee) || 0,
                total_charged: owed,
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
        `, [challenge.id, user.id, owed, gateway.getName(), reference]);

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
                (user_id, amount, transaction_type, payment_status, payout_status,
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
    // RECONCILE A SPONSORSHIP SETTLED OUTSIDE THE SYSTEM
    // ============================================
    // When a match dies mid-flight the money is real but the row still says
    // 'settled', so the dashboard keeps reporting it as held \u2014 correctly,
    // because nothing has told it otherwise. Paying the sponsor back by hand
    // fixes the bank and leaves the books wrong.
    //
    // This records what actually happened. It does NOT move money: it is the
    // bookkeeping entry for a transfer that has already been made, which is
    // why it demands a reference and refuses to run twice.

    async reconcile(challengeId, { outcome, reference, adminId, note = '' }) {
        if (!['refunded', 'awarded'].includes(outcome)) {
            return { ok: false, error: "outcome must be 'refunded' or 'awarded'" };
        }
        if (!String(reference || '').trim()) {
            // Without a reference this is an unauditable adjustment to a money
            // row, which is the one thing a financial record must never allow.
            return { ok: false, error: 'A payment reference is required' };
        }

        const found = await pool.query(
            `SELECT s.*, c.code, c.setup_charge, c.prize_fee, c.total_charged, c.prize_amount
             FROM challenge_sponsorships s
             JOIN challenges c ON c.id = s.challenge_id
             WHERE s.challenge_id = $1`,
            [challengeId]
        );

        const row = found.rows[0];
        if (!row) return { ok: false, error: 'No sponsorship on that challenge' };

        // Already reconciled? Say so rather than paying twice on paper.
        if (['refunded', 'awarded'].includes(row.payment_status)) {
            return { ok: false, error: `Already recorded as ${row.payment_status}` };
        }
        if (row.payment_status !== 'settled' && row.payment_status !== 'withheld') {
            return { ok: false, error: `Nothing to reconcile (status: ${row.payment_status})` };
        }

        const prize = Number(row.prize_amount) || 0;
        const retained = (Number(row.setup_charge) || 0) + (Number(row.prize_fee) || 0);
        const recipient = outcome === 'refunded' ? row.user_id : null;

        let winnerId = recipient;
        if (outcome === 'awarded') {
            const winner = await pool.query(
                `SELECT user_id FROM challenge_participants
                 WHERE challenge_id = $1 AND rank = 1 LIMIT 1`,
                [challengeId]
            );
            if (!winner.rows[0]) return { ok: false, error: 'No winner recorded on that challenge' };
            winnerId = winner.rows[0].user_id;
        }

        // Recorded as ALREADY PAID, because it was. Leaving it pending would
        // put it back in the payout queue and invite a second, real transfer.
        const tx = await pool.query(`
            INSERT INTO transactions
                (user_id, amount, transaction_type, payment_status, payout_status,
                 platform, win_data)
            VALUES ($1, $2, $3, 'success', 'paid', $4, $5)
            RETURNING id
        `, [
            winnerId, prize,
            outcome === 'refunded' ? 'challenge_refund' : 'challenge_prize',
            'admin',
            JSON.stringify({
                challengeId, challengeCode: row.code,
                reconciledOutsideSystem: true,
                reference: String(reference).trim(),
                note: String(note || '').slice(0, 500),
                adminId: adminId || null
            })
        ]);

        await pool.query(`
            UPDATE challenge_sponsorships
            SET payment_status = $1,
                refunded_at = CASE WHEN $1 = 'refunded' THEN NOW() ELSE refunded_at END,
                refund_amount = CASE WHEN $1 = 'refunded' THEN $2 ELSE refund_amount END,
                retained_amount = CASE WHEN $1 = 'refunded' THEN $3 ELSE retained_amount END,
                awarded_transaction_id = CASE WHEN $1 = 'awarded' THEN $4 ELSE awarded_transaction_id END,
                refund_transaction_id = CASE WHEN $1 = 'refunded' THEN $4 ELSE refund_transaction_id END,
                withheld_reason = NULL,
                updated_at = NOW()
            WHERE id = $5
        `, [outcome, prize, retained, tx.rows[0].id, row.id]);

        logger.warn(
            `Challenge ${row.code} sponsorship reconciled as ${outcome} by admin ` +
            `${adminId} \u2014 \u20a6${prize}, ref ${reference}`
        );

        return { ok: true, outcome, amount: prize, retained, transactionId: tx.rows[0].id };
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

        // THE SPLIT COMES FROM THE CHALLENGE, NOT FROM A PERCENTAGE.
        //
        // The fee is now collected UP FRONT and disclosed before payment, so a
        // non-completed challenge returns the PRIZE IN FULL and keeps the
        // setup charge and the fee \u2014 both of which were charged for setting
        // the thing up, and it was set up. Recomputing 15% here would take the
        // fee twice.
        // Unconditional: the prize comes back, the setup charge and fee do not.
        // No "did anyone join" test, because a rule that depends on timing is a
        // rule people argue about.
        const challengePricingService = require('./challenge-pricing.service');
        const split = challengePricingService.refundFor(challenge);

        const transaction = await pool.query(`
            INSERT INTO transactions
                (user_id, amount, transaction_type, payment_status, payout_status, platform, win_data)
            VALUES ($1, $2, 'challenge_refund', 'success', 'pending', $3, $4)
            RETURNING id
        `, [
            row.user_id, split.refund, challenge.created_platform || 'web',
            JSON.stringify({
                challengeId: challenge.id,
                challengeCode: challenge.code,
                sponsorshipId: row.id,
                gross: Number(challenge.total_charged) || row.amount,
                retained: split.retained,
                setupCharge: Number(challenge.setup_charge) || 0,
                prizeFee: Number(challenge.prize_fee) || 0,
                reason: split.reason
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
            `Challenge ${challenge.code} void (${split.reason}): ` +
            `\u20a6${Number(challenge.total_charged) || row.amount} in, ` +
            `\u20a6${split.refund} refundable, \u20a6${split.retained} retained`
        );

        return {
            ok: true,
            refunded: true,
            gross: Number(challenge.total_charged) || row.amount,
            refund: split.refund,
            retained: split.retained,
            reason: split.reason,
            transactionId: transaction.rows[0].id
        };
    }
}

module.exports = new ChallengeSponsorshipService();
module.exports.REFERENCE_PREFIX = REFERENCE_PREFIX;