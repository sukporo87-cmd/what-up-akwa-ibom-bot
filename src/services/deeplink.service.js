// ============================================
// FILE: src/services/deeplink.service.js
// One parser for every "come straight to this thing" link, across all three
// platforms.
//
// WHY THIS EXISTS
// A link that survives a first-time user is the difference between an invite
// that converts and one that dies at a registration screen. Three separate
// features need the same plumbing:
//
//   Challenges     t.me/WhatsUpTrivia_bot?start=c_K7P2M4RN
//                  wa.me/2349160363909?text=CHALLENGE K7P2M4RN
//                  play.whatsuptrivia.com.ng/c/K7P2M4RN
//
//   Tournaments    ?start=tour_12   (BACKLOG item 2 — parser ready, handler
//                                    not yet registered)
//
//   Referrals      ?start=ref_ABC123
//
// Telegram had NO deep-link parser before this file: a `/start c_XXXX` payload
// arrived at routeMessage as ordinary text and fell through to the menu, so
// the code was silently discarded.
//
// TWO PARTS
//
// 1. PARSING — pure, synchronous, no I/O. Every branch is testable without a
//    database.
//
// 2. THE PENDING STORE — a first-time chat user hits terms, then six
//    registration steps, before they exist as a user. The code has to survive
//    all of it. Registration threads `stateData` through every step, which
//    works but is fragile: one handler that forgets to spread `...stateData`
//    drops it, and two of them rebuild the object by hand. So the code lives
//    in its own Redis key instead — independent of the state machine, survives
//    a RESET mid-registration, and expires on its own.
// ============================================

const redis = require('../config/redis');
const { logger } = require('../utils/logger');

// Crockford base32 without vowels: no accidental words, and no I/O/1/0
// confusion when somebody reads a code off a screen and types it back.
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

// 48 hours — matches the async challenge invite window. A code held longer
// than the invite it points at is a link to an expired thing.
const PENDING_TTL_SECONDS = 48 * 60 * 60;

class DeepLinkService {

    // ============================================
    // CODE HELPERS
    // ============================================

    isValidCode(code) {
        return typeof code === 'string' && CODE_PATTERN.test(code);
    }

    /** Generates a challenge code. Not cryptographic — collisions are handled
     *  by a UNIQUE constraint and a retry, not by entropy alone. */
    generateCode() {
        const crypto = require('crypto');
        const bytes = crypto.randomBytes(CODE_LENGTH);
        let out = '';
        for (let i = 0; i < CODE_LENGTH; i++) {
            out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
        }
        return out;
    }

    // ============================================
    // PARSE
    // ============================================
    // Accepts anything a user might arrive with and returns
    // { type, value, raw } or null. Never throws.
    //
    //   /start c_K7P2M4RN     -> { type: 'challenge',  value: 'K7P2M4RN' }
    //   c_K7P2M4RN            -> { type: 'challenge',  value: 'K7P2M4RN' }
    //   CHALLENGE K7P2M4RN    -> { type: 'challenge',  value: 'K7P2M4RN' }
    //   /start tour_12        -> { type: 'tournament', value: 12 }
    //   JOIN TOURNAMENT 12    -> { type: 'tournament', value: 12 }
    //   /start ref_ABC123     -> { type: 'referral',   value: 'ABC123' }
    //   /start                -> null  (a bare start is just a start)
    //   MENU                  -> null

    parse(message) {
        if (typeof message !== 'string') return null;

        const raw = message.trim();
        if (!raw) return null;

        // Strip a leading /start (with or without a payload) and any @botname
        // suffix Telegram adds in group chats.
        const withoutStart = raw.replace(/^\/start(?:@\w+)?\s*/i, '');
        const candidate = withoutStart.trim();
        if (!candidate) return null;

        const upper = candidate.toUpperCase();

        // --- challenge ---
        // c_CODE (Telegram payload) or CHALLENGE CODE (WhatsApp pre-filled text)
        const challengeMatch =
            upper.match(/^C_([A-Z0-9]+)$/) ||
            upper.match(/^CHALLENGE\s+([A-Z0-9]+)$/);

        if (challengeMatch) {
            const code = challengeMatch[1];
            // A malformed code is still a challenge intent — the caller should
            // say "that code doesn't look right", not fall through to the menu
            // as though nothing was typed.
            return { type: 'challenge', value: code, valid: this.isValidCode(code), raw };
        }

        // --- tournament (BACKLOG item 2) ---
        const tournamentMatch =
            upper.match(/^TOUR_(\d{1,9})$/) ||
            upper.match(/^JOIN\s+TOURNAMENT\s+(\d{1,9})$/);

        if (tournamentMatch) {
            const id = parseInt(tournamentMatch[1], 10);
            return { type: 'tournament', value: id, valid: id > 0, raw };
        }

        // --- referral ---
        const referralMatch = upper.match(/^REF_([A-Z0-9]{4,16})$/);
        if (referralMatch) {
            return { type: 'referral', value: referralMatch[1], valid: true, raw };
        }

        return null;
    }

    // ============================================
    // HANDLER REGISTRY
    // ============================================
    // Features register themselves rather than the parser importing them.
    // Keeps this file free of require() cycles into game code, and means a
    // parsed type with no handler yet degrades to "not available" instead of
    // throwing. `tournament` is parsed today and deliberately unregistered.

    constructor() {
        this.handlers = new Map();
    }

    register(type, handler) {
        if (typeof handler !== 'function') {
            throw new Error(`Deep-link handler for "${type}" must be a function`);
        }
        this.handlers.set(type, handler);
        logger.info(`🔗 Deep-link handler registered: ${type}`);
    }

    hasHandler(type) {
        return this.handlers.has(type);
    }

    /**
     * Runs the registered handler for a parsed link.
     * Returns true if the link was consumed and the caller should stop routing.
     * A handler that throws is logged and treated as not-consumed, so a broken
     * feature drops the user into the normal menu rather than into silence.
     */
    async dispatch(link, context) {
        if (!link || !this.handlers.has(link.type)) return false;

        try {
            const consumed = await this.handlers.get(link.type)(link, context);
            return consumed !== false;
        } catch (error) {
            logger.error(`Deep-link handler "${link.type}" failed:`, error.message);
            return false;
        }
    }

    // ============================================
    // PENDING STORE
    // ============================================
    // Held against the raw platform identifier (a phone number, tg_<id>, or
    // web_<id>) because at the moment we store it there may be no user row yet.

    _key(identifier) {
        return `pending_link:${identifier}`;
    }

    async setPending(identifier, link) {
        if (!identifier || !link) return false;
        try {
            await redis.setex(
                this._key(identifier),
                PENDING_TTL_SECONDS,
                JSON.stringify({ type: link.type, value: link.value, at: Date.now() })
            );
            return true;
        } catch (error) {
            logger.error('Could not store pending deep link:', error.message);
            return false;
        }
    }

    /** Reads WITHOUT clearing — for showing "you were invited to..." mid-flow. */
    async peekPending(identifier) {
        if (!identifier) return null;
        try {
            const raw = await redis.get(this._key(identifier));
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            logger.error('Could not read pending deep link:', error.message);
            return null;
        }
    }

    /**
     * Reads AND clears. Call this once, after registration commits.
     * Delete-then-return so a crash between the two cannot leave a code that
     * replays into every future session.
     */
    async consumePending(identifier) {
        const pending = await this.peekPending(identifier);
        if (!pending) return null;

        try {
            await redis.del(this._key(identifier));
        } catch (error) {
            logger.error('Could not clear pending deep link:', error.message);
        }

        return pending;
    }

    // ============================================
    // LINK BUILDERS
    // ============================================
    // One place that knows the URL shapes, so a bot username or number change
    // is a single edit rather than a grep.

    buildLinks(code) {
        const webBase = process.env.WEB_PLAY_URL || 'https://play.whatsuptrivia.com.ng';
        const botUser = process.env.TELEGRAM_BOT_USERNAME || 'WhatsUpTrivia_bot';
        const waNumber = process.env.WHATSAPP_NUMBER || '2349160363909';

        return {
            web: `${webBase}/c/${code}`,
            telegram: `https://t.me/${botUser}?start=c_${code}`,
            whatsapp: `https://wa.me/${waNumber}?text=${encodeURIComponent('CHALLENGE ' + code)}`
        };
    }

    /**
     * "Enter this tournament, on the platform I already use."
     *
     * The payloads are exactly the two shapes parse() already recognises —
     * `tour_<id>` for Telegram's ?start= and `JOIN TOURNAMENT <id>` for
     * WhatsApp's pre-filled text — so these links land in the handler
     * registered in webhook.controller rather than in the generic menu.
     *
     * Web is a query parameter rather than a path segment: /c/<code> is a
     * challenge route the play app already owns, and tournaments have no
     * such route. play.html reads ?tournament= at boot, holds it across
     * signup, and opens the entry screen on that tournament once the
     * player is authenticated.
     */
    buildTournamentLinks(tournamentId) {
        const id = parseInt(tournamentId, 10);
        if (!Number.isInteger(id) || id <= 0) return null;

        const webBase = process.env.WEB_PLAY_URL || 'https://play.whatsuptrivia.com.ng';
        const botUser = process.env.TELEGRAM_BOT_USERNAME || 'WhatsUpTrivia_bot';
        const waNumber = process.env.WHATSAPP_NUMBER || '2349160363909';

        return {
            web: `${webBase}/?tournament=${id}`,
            telegram: `https://t.me/${botUser}?start=tour_${id}`,
            whatsapp: `https://wa.me/${waNumber}?text=${encodeURIComponent('JOIN TOURNAMENT ' + id)}`
        };
    }
}

module.exports = new DeepLinkService();
module.exports.CODE_ALPHABET = CODE_ALPHABET;
module.exports.CODE_LENGTH = CODE_LENGTH;
module.exports.PENDING_TTL_SECONDS = PENDING_TTL_SECONDS;
