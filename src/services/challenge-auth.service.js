// ============================================
// FILE: src/services/challenge-auth.service.js
// Play a challenge on web as your WhatsApp or Telegram account.
//
// THE PROBLEM THIS SOLVES
// A WhatsApp player and a web player are different `users` rows. The live
// arena is web-only, so a challenge created in WhatsApp was one its own
// creator could not enter. Account linking would fix it, but drags in
// decisions about merging credits, stats, payouts and claim windows.
//
// THIS DOES NOT LINK ANYTHING. It is the email-OTP flow that already exists,
// with WhatsApp or Telegram as the delivery channel: the username identifies,
// a code sent to a channel only the owner controls authenticates, and the
// session resolves to the real users.id so stats land on the right row.
//
// THREE PROPERTIES THAT MATTER MORE THAN THE FEATURE
//
// 1. THE SESSION IS SCOPED TO ONE CHALLENGE. A code arrives over WhatsApp,
//    sits on a lock screen and is valid for minutes. It must not be a way into
//    an account holding credits, payout history and bank details. The session
//    it creates works on that one challenge and nowhere else \u2014 not Classic,
//    not purchases, not profile, not claims, and not even a different
//    challenge.
//
// 2. TYPING A USERNAME SENDS A MESSAGE TO SOMEBODY ELSE. Uncapped, that is a
//    way to spam any player on the platform. Rate limited per username and per
//    IP, and the message says plainly what to do if they did not ask for it.
//
// 3. THE CODE IS NEVER STORED IN PLAIN TEXT. Hashed, single use, ten minutes,
//    five attempts, bound to one challenge AND one user.
// ============================================

const crypto = require('crypto');
const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

const CODE_TTL_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;

// Deliberately shorter than the normal web session. This is a guest pass for
// one challenge, not a login.
const SESSION_TTL_SECONDS = 6 * 60 * 60;

// Per username per hour, and per IP per hour. The first stops someone being
// messaged repeatedly; the second stops one actor working through a list of
// usernames.
const MAX_REQUESTS_PER_USER = 3;
const MAX_REQUESTS_PER_IP = 10;

class ChallengeAuthService {

    _codeKey(challengeCode, userId) { return `chal_auth:${challengeCode}:${userId}`; }
    _userRateKey(userId) { return `chal_auth_rate:user:${userId}`; }
    _ipRateKey(ip) { return `chal_auth_rate:ip:${ip}`; }

    _hash(code, challengeCode, userId) {
        return crypto.createHash('sha256')
            .update(`${code}:${challengeCode}:${userId}`)
            .digest('hex');
    }

    generateCode() {
        // 6 digits, uniformly random. Not a token \u2014 it is typed by a human off
        // a phone screen, so length is traded against the attempt limit and TTL
        // rather than against brute force.
        return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    }

    // ============================================
    // ISSUE
    // ============================================
    // Called from two places: automatically when a chat user creates a live
    // challenge, and on demand when someone types a username on the web invite
    // screen.

    async issueCode(challenge, user, { deliver = true } = {}) {
        const code = this.generateCode();

        await redis.setex(
            this._codeKey(challenge.code, user.id),
            CODE_TTL_SECONDS,
            JSON.stringify({
                hash: this._hash(code, challenge.code, user.id),
                attempts: 0,
                issuedAt: Date.now()
            })
        );

        if (deliver) {
            const messagingService = this._messaging();
            // A SEPARATE MESSAGE from the invite link, always. Forwarding is
            // how people share on WhatsApp \u2014 they long-press the message with
            // the link and forward the whole thing. A warning does not survive
            // forwarding; a message boundary does.
            await messagingService.sendMessage(user.phone_number, this.codeMessage(code, challenge));
        }

        logger.info(`Challenge auth code issued for user ${user.id} on ${challenge.code}`);
        return { ok: true, code };
    }

    codeMessage(code, challenge) {
        const spaced = code.split('').join(' ');
        return `\u{1F511} *Your code to play: ${spaced}*\n\n` +
               `Open your challenge link, choose *Play as my chat account*, ` +
               `then enter your username and this code.\n\n` +
               `It works only for this one challenge (${challenge.code}) and ` +
               `expires in 10 minutes.\n\n` +
               `_Don't share this code \u2014 it isn't part of the invite._\n` +
               `_Reply *MYCODE* if it expires._`;
    }

    unsolicitedNote() {
        return '\n\n_If you didn\u2019t ask for this, ignore it \u2014 nobody can use it ' +
               'without your phone._';
    }

    // ============================================
    // REQUEST BY USERNAME (from the web invite screen)
    // ============================================

    async requestCode(challenge, username, ip) {
        const clean = String(username || '').trim().replace(/^@/, '');
        if (!clean) return { ok: false, reason: 'no_username' };

        if (ip) {
            const ipCount = await this._bump(this._ipRateKey(ip));
            if (ipCount > MAX_REQUESTS_PER_IP) return { ok: false, reason: 'rate_limited' };
        }

        const result = await pool.query(
            `SELECT id, username, phone_number FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
            [clean]
        );
        const user = result.rows[0];

        // A WRONG USERNAME AND A CORRECT ONE MUST LOOK THE SAME. Saying "no
        // such player" turns this endpoint into a way to test whether a
        // username exists, and usernames appear on every result card.
        if (!user) return { ok: true, delivered: false };

        // Web accounts log in normally; there is nowhere to deliver a code to.
        if (String(user.phone_number || '').startsWith('web_')) {
            return { ok: true, delivered: false };
        }

        const userCount = await this._bump(this._userRateKey(user.id));
        if (userCount > MAX_REQUESTS_PER_USER) return { ok: true, delivered: false };

        const participant = await pool.query(
            `SELECT 1 FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2`,
            [challenge.id, user.id]
        );

        // Not in the challenge yet is fine \u2014 that is how an invitee arrives.
        // They authenticate first, then join.
        const code = this.generateCode();
        await redis.setex(
            this._codeKey(challenge.code, user.id),
            CODE_TTL_SECONDS,
            JSON.stringify({
                hash: this._hash(code, challenge.code, user.id),
                attempts: 0,
                issuedAt: Date.now()
            })
        );

        try {
            const messagingService = this._messaging();
            await messagingService.sendMessage(
                user.phone_number,
                this.codeMessage(code, challenge) + this.unsolicitedNote()
            );
        } catch (error) {
            logger.error(`Could not deliver challenge auth code: ${error.message}`);
            return { ok: true, delivered: false };
        }

        return {
            ok: true,
            delivered: true,
            alreadyJoined: participant.rows.length > 0,
            // Never the whole number. Enough for the player to know which
            // phone to look at, useless to anyone else.
            hint: this._hint(user.phone_number)
        };
    }

    _hint(identifier) {
        const id = String(identifier || '');
        if (id.startsWith('tg_')) return 'Telegram';
        return `WhatsApp ending ${id.slice(-4)}`;
    }

    async _bump(key) {
        try {
            const n = await redis.incr(key);
            if (n === 1) await redis.expire(key, 3600);
            return n;
        } catch (error) {
            // A broken rate limiter must not become a broken login. Fail open
            // on counting, never on verification.
            logger.warn(`Rate limit counter unavailable: ${error.message}`);
            return 0;
        }
    }

    // ============================================
    // VERIFY
    // ============================================

    async verifyCode(challenge, username, code, { ip, userAgent } = {}) {
        const clean = String(username || '').trim().replace(/^@/, '');
        const entered = String(code || '').trim().replace(/\s+/g, '');

        if (!clean || !/^\d{6}$/.test(entered)) {
            return { ok: false, reason: 'bad_input' };
        }

        const result = await pool.query(
            `SELECT * FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
            [clean]
        );
        const user = result.rows[0];
        if (!user) return { ok: false, reason: 'invalid_code' };

        const key = this._codeKey(challenge.code, user.id);
        const raw = await redis.get(key);
        if (!raw) return { ok: false, reason: 'expired' };

        const record = JSON.parse(raw);

        if (record.attempts >= MAX_ATTEMPTS) {
            await redis.del(key);
            return { ok: false, reason: 'too_many_attempts' };
        }

        if (record.hash !== this._hash(entered, challenge.code, user.id)) {
            record.attempts += 1;
            const ttl = await redis.ttl(key);
            await redis.setex(key, ttl > 0 ? ttl : CODE_TTL_SECONDS, JSON.stringify(record));
            return {
                ok: false,
                reason: 'invalid_code',
                attemptsLeft: Math.max(0, MAX_ATTEMPTS - record.attempts)
            };
        }

        // Single use. Burn it before issuing the session, so a replay of the
        // same request cannot mint a second one.
        await redis.del(key);

        const webAuthService = require('./web-auth.service');
        const token = await webAuthService.createSession(user.id, ip, userAgent, {
            type: 'challenge',
            code: challenge.code,
            challengeId: challenge.id
        }, SESSION_TTL_SECONDS);

        logger.info(`Challenge session issued: user ${user.id} on ${challenge.code}`);

        return {
            ok: true,
            token,
            user: { id: user.id, username: user.username },
            scopedTo: challenge.code
        };
    }

    _messaging() {
        if (!this._messagingInstance) {
            const MessagingService = require('./messaging.service');
            this._messagingInstance = new MessagingService();
        }
        return this._messagingInstance;
    }
}

module.exports = new ChallengeAuthService();
module.exports.CODE_TTL_SECONDS = CODE_TTL_SECONDS;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
module.exports.SESSION_TTL_SECONDS = SESSION_TTL_SECONDS;
module.exports.MAX_REQUESTS_PER_USER = MAX_REQUESTS_PER_USER;
module.exports.MAX_REQUESTS_PER_IP = MAX_REQUESTS_PER_IP;