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
// image.service exports the CLASS, not an instance.
const ImageService = require('./image.service');
const imageService = new ImageService();
const deepLinkService = require('./deeplink.service');
const challengeService = require('./challenge.service');

// A card outlives the 24h play window so a late screenshot still resolves.
const CARD_TTL_SECONDS = 7 * 24 * 3600;

class ChallengeCardService {

    _cardKey(challengeId) { return `chal:${challengeId}:card`; }

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
    // Deliberately NOT here any more.
    //
    // ensureRematch() used to run on every card render, creating a challenge
    // nobody had asked for. It inflated the "created" funnel by exactly the
    // number of cards drawn \u2014 10 created against 7 invites sent \u2014 and left a
    // dead row behind every result that was never shared.
    //
    // A rematch is now offered to the player who LOST, and created only if
    // they take it: challenge-chat.service handleRematch(), keyword REMATCH.

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

        // NO AUTO-REMATCH. Creating one per card manufactured a challenge
        // nobody asked for, inflated the "created" funnel by exactly the number
        // of cards rendered, and left a dead row behind every result that was
        // never shared. The card now points at the ORIGINAL challenge, and the
        // rematch is offered to the player who lost \u2014 see
        // challenge-chat.service REMATCHCHALLENGE.
        const rematchUrl = deepLinkService.buildLinks(challenge.code).web;
        const rematchCode = null;

        // generateChallengeCard writes a file and returns its PATH, matching
        // every other generator in image.service. WhatsApp needs the path
        // (uploadMedia streams from disk); the web route needs the bytes. So
        // we keep both, and delete the file once it is cached.
        const filePath = await imageService.generateChallengeCard({
            ...data,
            rematchUrl
        });

        const fs = require('fs');
        const buffer = fs.readFileSync(filePath);

        try {
            await redis.setex(this._cardKey(challenge.id), CARD_TTL_SECONDS, buffer);
        } catch (e) {
            logger.warn(`Could not cache challenge card: ${e.message}`);
        }

        await challengeService.recordEvent(
            challenge.id, winnerUserId, 'card_generated', null,
            { rematchCode: rematchCode || null }
        );

        return { ok: true, buffer, filePath, rematchCode, rematchUrl, data, cached: false };
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