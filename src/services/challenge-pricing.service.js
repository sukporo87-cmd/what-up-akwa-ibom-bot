// ============================================
// FILE: src/services/challenge-pricing.service.js
// What a challenge costs, and the one place that decides it.
//
// TWO RULES CARRY EVERYTHING HERE.
//
// 1. BANDS ROUND UP TO THE TIER CEILING.
//    A challenge is charged the first band it fits under, so 3 or 4 seats pay
//    the 5-seat rate and 7 pay the 10-seat rate. Charged on the seats CHOSEN
//    at creation, never on who actually turns up: the creator is buying a room
//    of that size, and filling it is their job.
//
// 2. THE PRICE IS SNAPSHOTTED ONTO THE CHALLENGE, NOT LOOKED UP LATER.
//    Every figure this service produces is written to the challenge row at
//    creation. Refunds, reconciliation and the financial report read the row.
//    If they read the live price list instead, raising the 5-seat band on
//    Tuesday would silently change what a challenge created on Monday refunds,
//    and the books would stop tying out with no visible cause.
//
// ARITHMETIC IS INTEGER NAIRA THROUGHOUT. The fee is basis points (1500 = 15%)
// so a percentage never introduces a fraction of a naira that one screen
// rounds up and another rounds down.
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

// Used when the table has not been created yet, or a read fails. These are the
// agreed numbers, so a failure degrades to correct pricing rather than free
// challenges.
const FALLBACK = {
    mode: 'free',
    bands: [
        { upTo: 2,  charge: 500 },
        { upTo: 5,  charge: 1500 },
        { upTo: 10, charge: 2500 },
        { upTo: 15, charge: 3500 },
        { upTo: 20, charge: 5000 }
    ],
    prizeFeeBps: 1500
};

const CACHE_MS = 60 * 1000;

class ChallengePricingService {

    constructor() {
        this._cache = null;
        this._cachedAt = 0;
    }

    // ============================================
    // THE PRICE LIST
    // ============================================

    async getPricing({ fresh = false } = {}) {
        if (!fresh && this._cache && (Date.now() - this._cachedAt) < CACHE_MS) {
            return this._cache;
        }

        try {
            const result = await pool.query(
                `SELECT mode, band_2, band_5, band_10, band_15, band_20, prize_fee_bps
                 FROM challenge_pricing WHERE id = 1`
            );

            const row = result.rows[0];
            if (!row) return FALLBACK;

            const pricing = {
                mode: row.mode,
                bands: [
                    { upTo: 2,  charge: Number(row.band_2) },
                    { upTo: 5,  charge: Number(row.band_5) },
                    { upTo: 10, charge: Number(row.band_10) },
                    { upTo: 15, charge: Number(row.band_15) },
                    { upTo: 20, charge: Number(row.band_20) }
                ],
                prizeFeeBps: Number(row.prize_fee_bps)
            };

            this._cache = pricing;
            this._cachedAt = Date.now();
            return pricing;
        } catch (error) {
            // A missing table means 016 has not run. Fall back rather than
            // failing creation outright.
            logger.error('Could not read challenge pricing, using defaults:', error.message);
            return FALLBACK;
        }
    }

    async isPaidMode() {
        return (await this.getPricing()).mode === 'paid';
    }

    invalidate() {
        this._cache = null;
        this._cachedAt = 0;
    }

    // ============================================
    // SETUP CHARGE
    // ============================================

    /**
     * The band a given seat count falls into.
     *
     * Rounds UP: 4 seats pays the 5-seat rate. Anything above the largest band
     * pays the largest band rather than falling through to zero — a free
     * 20-player challenge caused by a mis-set price list would be worse than
     * an overcharge, because it is silent.
     */
    setupChargeFor(seats, pricing) {
        const bands = (pricing && pricing.bands) || FALLBACK.bands;
        const n = Math.max(2, parseInt(seats, 10) || 2);

        for (const band of bands) {
            if (n <= band.upTo) return band.charge;
        }
        return bands[bands.length - 1].charge;
    }

    // ============================================
    // PRIZE FEE
    // ============================================

    /**
     * The sponsor pays the prize PLUS the fee, and both are disclosed before
     * payment. A ₦5,000 prize at 15% is ₦750, so ₦5,750 is collected.
     *
     * This is deliberately not the old "retain 15% on failure" model: a fee
     * discovered at refund time reads as a penalty, while a fee shown before
     * payment is a price. Same money, and only one of them generates a
     * complaint.
     */
    prizeFeeFor(prizeAmount, pricing) {
        const bps = (pricing && pricing.prizeFeeBps !== undefined)
            ? pricing.prizeFeeBps
            : FALLBACK.prizeFeeBps;

        const prize = Math.max(0, parseInt(prizeAmount, 10) || 0);
        if (prize === 0) return 0;

        // Rounded up: the platform should never be short by the rounding, and
        // a naira in the player's favour is not worth a fractional-kobo bug.
        return Math.ceil((prize * bps) / 10000);
    }

    // ============================================
    // THE WHOLE QUOTE
    // ============================================

    /**
     * Everything the creator owes, itemised. The caller writes these figures
     * onto the challenge row; nothing recomputes them afterwards.
     */
    async quote({ seats, prizeAmount = 0 }) {
        const pricing = await this.getPricing();
        const paid = pricing.mode === 'paid';

        const setup = paid ? this.setupChargeFor(seats, pricing) : 0;
        const prize = Math.max(0, parseInt(prizeAmount, 10) || 0);
        const fee = this.prizeFeeFor(prize, pricing);

        return {
            paidMode: paid,
            seats: Math.max(2, parseInt(seats, 10) || 2),
            setupCharge: setup,
            prizeAmount: prize,
            prizeFee: fee,
            prizeFeeBps: pricing.prizeFeeBps,
            total: setup + prize + fee,
            // True when nothing is owed, so the caller can skip the gateway
            // entirely rather than initialising a ₦0 payment.
            free: (setup + prize + fee) === 0
        };
    }

    /**
     * What a challenge returns when it does not complete.
     *
     * THE SPONSORED PRIZE COMES BACK IN FULL. Nothing else does.
     *
     * The setup charge bought the room and the room was built; the fee was
     * charged for setting the challenge up and it was set up. Getting
     * participants to actually play is the creator's job, and that is exactly
     * what the setup charge buys \u2014 so a challenge nobody joined is a room the
     * creator failed to fill, not a service we failed to deliver.
     *
     * That makes this deliberately unconditional: the same figures whether
     * nobody joined, the invite lapsed, or the creator cancelled after paying.
     * An earlier draft refunded everything when nobody had joined; it was
     * dropped because "did anyone join yet" is a moving target that would have
     * to be re-evaluated at refund time, and a refund rule that depends on
     * timing is a refund rule people will argue about.
     *
     * Money the creator never paid is never "refunded": a free-mode challenge
     * returns zero, because zero was taken.
     */
    refundFor(challenge) {
        const setup = Number(challenge.setup_charge) || 0;
        const prize = Number(challenge.prize_amount) || 0;
        const fee = Number(challenge.prize_fee) || 0;

        return {
            refund: prize,
            retained: setup + fee,
            reason: 'did_not_complete'
        };
    }

    // ============================================
    // ADMIN
    // ============================================

    async updatePricing(changes, adminId) {
        const allowed = ['mode', 'band_2', 'band_5', 'band_10', 'band_15', 'band_20', 'prize_fee_bps'];
        const sets = [];
        const params = [];

        for (const key of allowed) {
            if (changes[key] === undefined) continue;

            if (key === 'mode') {
                if (!['free', 'paid'].includes(changes.mode)) {
                    return { ok: false, error: 'mode must be free or paid' };
                }
                params.push(changes.mode);
            } else {
                const value = parseInt(changes[key], 10);
                if (!Number.isFinite(value) || value < 0) {
                    return { ok: false, error: `${key} must be a positive whole number` };
                }
                if (key === 'prize_fee_bps' && value > 10000) {
                    return { ok: false, error: 'prize_fee_bps cannot exceed 10000 (100%)' };
                }
                params.push(value);
            }
            sets.push(`${key} = $${params.length}`);
        }

        if (sets.length === 0) return { ok: false, error: 'Nothing to update' };

        params.push(adminId || null);
        const result = await pool.query(
            `UPDATE challenge_pricing
             SET ${sets.join(', ')}, updated_at = NOW(), updated_by = $${params.length}
             WHERE id = 1
             RETURNING *`,
            params
        );

        this.invalidate();
        logger.info(`Challenge pricing updated by admin ${adminId}: ${sets.join(', ')}`);

        // Existing challenges are untouched on purpose. They carry the price
        // they were created under.
        return { ok: true, pricing: result.rows[0] };
    }
}

module.exports = new ChallengePricingService();
module.exports.FALLBACK = FALLBACK;
