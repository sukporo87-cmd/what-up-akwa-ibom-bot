// ============================================
// FILE: src/services/challenge-card.service.js
// The result card and the rematch link.
//
// This is the growth engine. A challenge that ends with a message nobody
// screenshots is a challenge that reaches exactly the people who were already
// in it. Two decisions carry the whole thing:
//
//   1. THE LOSER HAS TO BE WILLING TO POST IT. No humiliation copy anywhere —
//      both scores get equal treatment on the card and the accompanying
//      message is neutral. A card only winners share halves the reach.
//
//   2. THE QR IS A LIVE REMATCH, NOT A HOMEPAGE. It encodes a challenge that
//      already exists, same categories and settings, initiator flipped to the
//      winner. One scan puts you in a duel. Sending a beaten player to a
//      creation form is where the loop breaks.
//
// The rematch challenge is created ONCE, when the card is first generated, and
// cached — not eagerly at completion, which would leave a dead row behind
// every challenge nobody shares.
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const imageService = require('./image.service');
const deepLinkService = require('./deeplink.service');
const challengeService = require('./challenge.service');

// A card outlives the 24h play window so a late screenshot still resolves.
const CARD_TTL_SECONDS = 7 * 24 * 3600;

class ChallengeCardService {

    _cardKey(challengeId) { return `chal:${challengeId}:card`; }
    _rematchKey(challengeId) { return `chal:${challengeId}:rematch`; }

    // ============================================
    // CARD DATA
    // ============================================
    // Read from Postgres, never from the Redis board — the board is a cache
    // and the card is a record. If someone screenshots a card, the numbers on
    // it should match what the database says forever.

    async getCardData(challenge) {
        const result = await pool.query(`
            SELECT u.username, p.final_score, p.total_answer_ms, p.rank
            FROM challenge_participants p
            JOIN users u ON u.id = p.user_id
            WHERE p.challenge_id = $1 AND p.status = 'finished'
            ORDER BY p.final_score DESC NULLS LAST, p.total_answer_ms ASC
        `, [challenge.id]);

        const finishers = result.rows;
        if (finishers.length < 2) return null;   // not complete; there is no result to show

        const winner = finishers[0];
        const runnerUp = finishers[1];

        return {
            winnerName: winner.username,
            winnerScore: winner.final_score,
            winnerTimeMs: winner.total_answer_ms,
            loserName: runnerUp.username,
            loserScore: runnerUp.final_score,
            loserTimeMs: runnerUp.total_answer_ms,
            categories: challenge.categories,
            isGroup: challenge.format === 'group',
            groupSize: finishers.length,
            // True when the tiebreak actually decided it. The card only
            // mentions speed when speed mattered.
            wonOnSpeed: winner.final_score === runnerUp.final_score
        };
    }

    // ============================================
    // REMATCH
    // ============================================
    // Same categories, same mode, same format, same entry model — EXCEPT that
    // a sponsored prize is never carried over. A rematch that silently expects
    // someone to put up ₦50,000 again is not a rematch, it is a bill.

    async ensureRematch(challenge, winnerUserId) {
        try {
            const cached = await redis.get(this._rematchKey(challenge.id));
            if (cached) return cached;
        } catch (e) { /* fall through and create */ }

        const existing = await pool.query(
            `SELECT code FROM challenges
             WHERE settings->>'rematchOf' = $1 AND status IN ('open','lobby')
             LIMIT 1`,
            [String(challenge.id)]
        );

        if (existing.rows[0]) {
            await this._cacheRematch(challenge.id, existing.rows[0].code);
            return existing.rows[0].code;
        }

        const winner = await pool.query(`SELECT id, age FROM users WHERE id = $1`, [winnerUserId]);
        if (!winner.rows[0]) return null;

        const created = await challengeService.createChallenge(winner.rows[0], {
            mode: challenge.mode,
            format: challenge.format,
            maxParticipants: challenge.max_participants,
            categories: challenge.categories,
            // Never inherit credit or prepaid entry either: the winner did not
            // agree to pay for a rematch they have not seen.
            entryModel: challenge.entry_model === 'free' ? 'free' : 'credit',
            rounds: 1,
            prizeAmount: 0
        }, challenge.created_platform || 'web');

        if (!created.ok) {
            logger.error(`Could not create rematch for challenge ${challenge.code}: ${created.errors}`);
            return null;
        }

        await pool.query(
            `UPDATE challenges SET settings = settings || $1::jsonb WHERE id = $2`,
            [JSON.stringify({ rematchOf: String(challenge.id) }), created.challenge.id]
        );

        await this._cacheRematch(challenge.id, created.challenge.code);
        return created.challenge.code;
    }

    async _cacheRematch(challengeId, code) {
        try { await redis.setex(this._rematchKey(challengeId), CARD_TTL_SECONDS, code); }
        catch (e) { /* the database lookup above is the fallback */ }
    }

    // ============================================
    // GENERATE
    // ============================================
    // Cached as a PNG in Redis, mirroring how the victory card is served
    // today. Rendering a 1080x1080 canvas per request would be the most
    // expensive thing in the feature.

    async generate(challenge, winnerUserId) {
        try {
            const cached = await redis.getBuffer
                ? await redis.getBuffer(this._cardKey(challenge.id))
                : null;
            if (cached) return { ok: true, buffer: cached, cached: true };
        } catch (e) { /* render fresh */ }

        const data = await this.getCardData(challenge);
        if (!data) return { ok: false, reason: 'not_complete' };

        const rematchCode = await this.ensureRematch(challenge, winnerUserId);
        const rematchUrl = rematchCode
            ? deepLinkService.buildLinks(rematchCode).web
            : deepLinkService.buildLinks(challenge.code).web;

        const buffer = await imageService.generateChallengeCard({
            ...data,
            rematchUrl
        });

        try {
            await redis.setex(this._cardKey(challenge.id), CARD_TTL_SECONDS, buffer);
        } catch (e) {
            logger.warn(`Could not cache challenge card: ${e.message}`);
        }

        await challengeService.recordEvent(
            challenge.id, winnerUserId, 'card_generated', null,
            { rematchCode: rematchCode || null }
        );

        return { ok: true, buffer, rematchCode, rematchUrl, data, cached: false };
    }

    // ============================================
    // CAPTIONS
    // ============================================
    // Deliberately neutral. The card carries the result; the caption must not
    // gloat, because the person most likely to post it into the group is the
    // one who lost.

    caption(data, rematchUrl) {
        if (data.isGroup) {
            return `\ud83c\udfc6 @${data.winnerName} took 1st of ${data.groupSize}.\n\n` +
                   `Think you'd do better? ${rematchUrl}`;
        }
        const line = data.wonOnSpeed
            ? `Same score \u2014 @${data.winnerName} won on speed.`
            : `@${data.winnerName} ${data.winnerScore}/15 \u00b7 @${data.loserName} ${data.loserScore}/15`;

        return `\u2694\ufe0f ${line}\n\nRematch: ${rematchUrl}`;
    }
}

module.exports = new ChallengeCardService();
module.exports.CARD_TTL_SECONDS = CARD_TTL_SECONDS;
