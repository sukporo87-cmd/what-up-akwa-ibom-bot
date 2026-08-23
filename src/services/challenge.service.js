// ============================================
// FILE: src/services/challenge.service.js
// "Challenge a Friend" — schema owner and shared constants.
//
// STAGE 3 SCOPE: this file currently owns the schema and the vocabulary and
// nothing else. Creation, joining, entry models and scoring land in stage 5,
// and the play loop in stage 6. Keeping it deliberately empty of behaviour
// means stage 3 can be deployed and verified on its own.
//
// The ensureSchema() below is GENERATED from migrations/010, 011 and 013 — the
// statements are byte-identical to the files, so the runtime mirror cannot
// drift from the SQL in the repo. If you change a migration, regenerate rather
// than hand-editing both.
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');
const deepLinkService = require('./deeplink.service');

// ============================================
// VOCABULARY
// ============================================
// Every enum in one place, matching the CHECK constraints exactly. Code that
// compares against a string literal instead of one of these is how a status
// typo becomes a row that no query ever finds again.

const MODES = ['async', 'live'];
const FORMATS = ['direct', 'group'];
const ENTRY_MODELS = ['credit', 'prepaid', 'free'];

const STATUS = {
    DRAFT: 'draft',
    AWAITING_SPONSORSHIP: 'awaiting_sponsorship',
    OPEN: 'open',
    LOBBY: 'lobby',
    LIVE: 'live',
    GRADING: 'grading',
    COMPLETED: 'completed',
    EXPIRED: 'expired',
    CANCELLED: 'cancelled',
    VOID_REFUNDED: 'void_refunded'
};

const PARTICIPANT_STATUS = {
    INVITED: 'invited',
    JOINED: 'joined',
    IN_LOBBY: 'in_lobby',
    PLAYING: 'playing',
    FINISHED: 'finished',
    FORFEITED: 'forfeited',
    EXPIRED: 'expired'
};

// The clock. One value in v1 — see the design note on Speed Levels: three
// clocks would make the challenge leaderboard incoherent for exactly the
// reason challenge scores are kept off the main one.
const SPEED_LEVEL_MS = { 1: 12000, 2: 10000, 3: 8000 };
const DEFAULT_SPEED_LEVEL = 2;

const QUESTIONS_PER_ROUND = 15;
const MAX_PARTICIPANTS = 20;

// Invites die 48h after creation; an accepted async challenge stays playable
// for 24h from THAT participant's acceptance.
const INVITE_TTL_HOURS = 48;
const PLAY_TTL_HOURS = 24;

// Retained when a sponsored challenge fails to complete. Stored as basis
// points so the arithmetic is integer-only — money should never touch a float.
const REFUND_RETENTION_BPS = 1500;   // 15.00%

// Sponsored prize bounds. Below the minimum the claim flow costs more than the
// prize; the maximum caps how much sponsor money the platform holds at once
// and how much can move through a single hop. Sponsored prizes are outside the
// \u20a630,000 daily payout cap by design, so this is the only ceiling there is.
const MIN_PRIZE = 1000;
const MAX_PRIZE = 100000;

// 13+ plays anywhere. 18+ to put money up.
const SPONSOR_MIN_AGE = 18;

class ChallengeService {

    // ============================================
    // ENSURE SCHEMA
    // ============================================
    // Idempotent — mirrored in migrations/010, 011 and 013. Cached after the
    // first success so it is not 26 round trips on every call; Postgres is a
    // network hop from Render and this would otherwise be the most expensive
    // no-op in the codebase.

    constructor() {
        this._schemaReady = false;
    }

    async ensureSchema() {
        if (this._schemaReady) return;

        for (const sql of ChallengeService.SCHEMA_STATEMENTS) {
            await pool.query(sql);
        }

        this._schemaReady = true;
        logger.info('🗄️  Challenge schema verified');
    }

    // ============================================
    // CLOCK
    // ============================================
    // The single source of truth for a challenge's answer clock. Turbo mode,
    // penalty timers and the progressive DIFFICULTY_TIMERS ladder are all
    // bypassed inside a challenge: player A racing a 12s clock while player B
    // gets 7s from question six is not a duel, it is two different games.
    // Turbo DETECTION still runs and still writes its flags — we record it, we
    // just do not change the clock.

    timeoutFor(speedLevel) {
        return SPEED_LEVEL_MS[speedLevel] || SPEED_LEVEL_MS[DEFAULT_SPEED_LEVEL];
    }

    // ============================================
    // VALIDATION
    // ============================================
    // Pure and synchronous, so every branch is testable without a database.
    // Returns { valid, errors, normalised }. Mirrors the CHECK constraints in
    // migration 010 exactly — the database is the backstop, not the first line.

    validateCreation(input = {}, user = {}) {
        const errors = [];
        const n = {};

        n.mode = String(input.mode || '').toLowerCase();
        if (!MODES.includes(n.mode)) errors.push('Pick async or live');

        n.format = String(input.format || '').toLowerCase();
        if (!FORMATS.includes(n.format)) errors.push('Pick a 1v1 or a group challenge');

        n.rounds = parseInt(input.rounds, 10) || 1;
        if (![1, 3].includes(n.rounds)) errors.push('A challenge is 1 round or best of 3');
        // Best of three means first to win two rounds. That has no single
        // definition for seven players, so it stays where the phrase means
        // what it says.
        if (n.rounds === 3 && !(n.mode === 'live' && n.format === 'direct')) {
            errors.push('Best of 3 is only available for a live 1v1 challenge');
        }

        // One clock in v1. The column exists so levels can be switched on
        // later without a migration; nothing renders a selector today.
        n.speedLevel = DEFAULT_SPEED_LEVEL;

        const categories = Array.isArray(input.categories) ? input.categories : [];
        n.categories = [...new Set(categories.map(c => String(c || '').trim().toLowerCase()).filter(Boolean))];
        if (n.categories.length < 1 || n.categories.length > 3) {
            errors.push('Choose between 1 and 3 categories');
        }

        n.entryModel = String(input.entryModel || '').toLowerCase();
        if (!ENTRY_MODELS.includes(n.entryModel)) errors.push('Pick how people get in');

        n.maxParticipants = parseInt(input.maxParticipants, 10) || (n.format === 'direct' ? 2 : 0);
        if (n.format === 'direct') {
            n.maxParticipants = 2;
        } else if (!(n.maxParticipants >= 2 && n.maxParticipants <= MAX_PARTICIPANTS)) {
            errors.push(`A group challenge is between 2 and ${MAX_PARTICIPANTS} players`);
        }

        if (n.entryModel === 'prepaid') {
            n.prepaidSlots = parseInt(input.prepaidSlots, 10) || 0;
            if (!(n.prepaidSlots >= 1 && n.prepaidSlots <= MAX_PARTICIPANTS)) {
                errors.push(`Pay for between 1 and ${MAX_PARTICIPANTS} entries`);
            } else if (n.maxParticipants && n.prepaidSlots > n.maxParticipants) {
                errors.push('You cannot pay for more entries than the challenge holds');
            }
        } else {
            n.prepaidSlots = null;
        }

        n.prizeAmount = parseInt(input.prizeAmount, 10) || 0;
        if (n.prizeAmount < 0) errors.push('A prize cannot be negative');
        if (n.prizeAmount > 0) {
            if (n.prizeAmount < MIN_PRIZE) errors.push(`The smallest prize you can sponsor is \u20a6${MIN_PRIZE.toLocaleString()}`);
            if (n.prizeAmount > MAX_PRIZE) errors.push(`The largest prize you can sponsor is \u20a6${MAX_PRIZE.toLocaleString()}`);

            // 13+ plays, 18+ sponsors. Checked at creation, before the gateway
            // is ever called, so an under-18 never reaches a checkout screen
            // they would be bounced from. A NULL age is unverified, not adult.
            const age = parseInt(user.age, 10);
            if (!Number.isFinite(age) || age < SPONSOR_MIN_AGE) {
                errors.push(`You need to be ${SPONSOR_MIN_AGE} or over to put up a prize. You can still create this challenge for bragging rights.`);
            }
        }

        if (n.mode === 'live') {
            const when = input.scheduledStartAt ? new Date(input.scheduledStartAt) : null;
            if (!when || isNaN(when.getTime())) {
                errors.push('A live challenge needs a start time');
            } else if (when.getTime() < Date.now() - 60000) {
                errors.push('That start time has already passed');
            } else {
                n.scheduledStartAt = when;
            }
        } else {
            n.scheduledStartAt = null;
        }

        return { valid: errors.length === 0, errors, normalised: n };
    }

    // ============================================
    // EXPIRY WINDOWS
    // ============================================
    // Live: an unaccepted invite dies at the scheduled start.
    // Async: invites die 48h after creation, and an ACCEPTED async challenge
    // stays playable for 24h from that participant's acceptance — per
    // participant, not per challenge.

    inviteExpiryFor(mode, scheduledStartAt, now = new Date()) {
        if (mode === 'live' && scheduledStartAt) return new Date(scheduledStartAt);
        return new Date(now.getTime() + INVITE_TTL_HOURS * 3600 * 1000);
    }

    playExpiryFor(acceptedAt = new Date()) {
        return new Date(new Date(acceptedAt).getTime() + PLAY_TTL_HOURS * 3600 * 1000);
    }

    // ============================================
    // CREATE
    // ============================================
    // A sponsored challenge is born in awaiting_sponsorship and its link is
    // DEAD until the gateway webhook confirms settlement. Not the browser
    // callback — settled, not initiated, before anyone can join.

    async createChallenge(user, input, platform) {
        await this.ensureSchema();

        const { valid, errors, normalised } = this.validateCreation(input, user);
        if (!valid) return { ok: false, errors };

        const questionBankId = await this._questionBankId();
        const now = new Date();
        const sponsored = normalised.prizeAmount > 0;

        const status = sponsored ? STATUS.AWAITING_SPONSORSHIP : STATUS.OPEN;
        const inviteExpiresAt = this.inviteExpiryFor(normalised.mode, normalised.scheduledStartAt, now);

        // Codes are generated, not derived, so a collision is possible and
        // handled by the UNIQUE constraint rather than by hoping. Five
        // attempts against a 29^8 space is not a real risk; the retry exists
        // so a collision is a retry rather than a 500.
        let challenge = null;
        for (let attempt = 0; attempt < 5 && !challenge; attempt++) {
            const code = deepLinkService.generateCode();
            try {
                const result = await pool.query(`
                    INSERT INTO challenges (
                        code, creator_user_id, mode, format, rounds, speed_level,
                        categories, entry_model, prepaid_slots, max_participants,
                        prize_amount, status, question_bank_id,
                        scheduled_start_at, opened_at, invite_expires_at, created_platform
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
                    RETURNING *
                `, [
                    code, user.id, normalised.mode, normalised.format, normalised.rounds,
                    normalised.speedLevel, normalised.categories, normalised.entryModel,
                    normalised.prepaidSlots, normalised.maxParticipants, normalised.prizeAmount,
                    status, questionBankId, normalised.scheduledStartAt,
                    sponsored ? null : now, inviteExpiresAt, platform
                ]);
                challenge = result.rows[0];
            } catch (error) {
                if (this._isDuplicateCode(error)) {
                    logger.warn(`Challenge code collision on attempt ${attempt + 1}, retrying`);
                    continue;
                }
                throw error;
            }
        }

        if (!challenge) return { ok: false, errors: ['Could not create a challenge right now. Try again.'] };

        // The initiator is a participant. In async they play first and their
        // round becomes the ghost; in live they are simply the first in the
        // lobby. Either way they count toward the two distinct finishers that
        // define completion.
        await pool.query(`
            INSERT INTO challenge_participants (challenge_id, user_id, role, status, entry_method)
            VALUES ($1, $2, 'initiator', 'joined', $3)
        `, [challenge.id, user.id, normalised.entryModel]);

        await this.recordEvent(challenge.id, user.id, 'created', platform, {
            mode: normalised.mode, format: normalised.format,
            entryModel: normalised.entryModel, sponsored
        });

        return {
            ok: true,
            challenge,
            links: deepLinkService.buildLinks(challenge.code),
            // A sponsored challenge is not shareable yet and the caller must
            // not render a link that would 404 for whoever it is sent to.
            shareable: !sponsored
        };
    }

    _isDuplicateCode(error) {
        return error && error.code === '23505' && String(error.constraint || '').includes('code');
    }

    async _questionBankId() {
        const QuestionService = require('./question.service');
        if (!this._questionService) this._questionService = new QuestionService();
        return this._questionService.getChallengeBankId();
    }

    // ============================================
    // LOOKUP
    // ============================================

    async getByCode(code) {
        if (!deepLinkService.isValidCode(code)) return null;

        const result = await pool.query(`
            SELECT c.*,
                   u.username AS creator_username,
                   (SELECT COUNT(*)::int FROM challenge_participants p
                     WHERE p.challenge_id = c.id AND p.status <> 'expired') AS participant_count
            FROM challenges c
            JOIN users u ON u.id = c.creator_user_id
            WHERE c.code = $1
        `, [code]);

        return result.rows[0] || null;
    }

    // ============================================
    // PARTICIPANT / ROUND LOOKUPS
    // ============================================
    // Challenge rounds are fetched here, never through
    // game.service.getActiveSession() — that method now filters
    // challenge_id IS NULL so Classic can never pick one up.

    async getParticipant(challengeId, userId) {
        const result = await pool.query(
            `SELECT * FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2`,
            [challengeId, userId]
        );
        return result.rows[0] || null;
    }

    async getWinner(challengeId) {
        const result = await pool.query(
            `SELECT user_id, rank, final_score, total_answer_ms
             FROM challenge_participants
             WHERE challenge_id = $1 AND status = 'finished'
             ORDER BY final_score DESC NULLS LAST, total_answer_ms ASC
             LIMIT 1`,
            [challengeId]
        );
        return result.rows[0] || null;
    }

    async getRoundFor(challengeId, userId, roundNo = 1) {
        const result = await pool.query(
            `SELECT * FROM challenge_rounds
             WHERE challenge_id = $1 AND user_id = $2 AND round_no = $3
             ORDER BY id DESC LIMIT 1`,
            [challengeId, userId, roundNo]
        );
        return result.rows[0] || null;
    }

    // ============================================
    // JOIN
    // ============================================
    // Every refusal is a distinct reason, because "you cannot join" with no
    // explanation is the single most annoying thing an invite link can do.

    async joinChallenge(code, user, context = {}) {
        await this.ensureSchema();

        const challenge = await this.getByCode(code);
        if (!challenge) return { ok: false, reason: 'not_found' };

        if (challenge.status === STATUS.AWAITING_SPONSORSHIP) {
            return { ok: false, reason: 'not_ready', challenge };
        }
        if (![STATUS.OPEN, STATUS.LOBBY].includes(challenge.status)) {
            return { ok: false, reason: 'closed', challenge };
        }
        if (new Date(challenge.invite_expires_at).getTime() < Date.now()) {
            return { ok: false, reason: 'expired', challenge };
        }
        if (challenge.creator_user_id === user.id) {
            return { ok: false, reason: 'own_challenge', challenge };
        }
        if (challenge.participant_count >= challenge.max_participants) {
            return { ok: false, reason: 'full', challenge };
        }

        // Anti-collusion gate 1: the same device already in this challenge.
        // Only fires on a browser fingerprint that qualified as strong —
        // an identifier-derived value cannot collide and a low-entropy sample
        // would link strangers.
        if (context.deviceId) {
            const clash = await pool.query(`
                SELECT 1 FROM challenge_participants
                WHERE challenge_id = $1 AND join_device_id = $2 LIMIT 1
            `, [challenge.id, context.deviceId]);
            if (clash.rows.length > 0) {
                await this.recordEvent(challenge.id, user.id, 'integrity_flagged',
                    context.platform, { gate: 'join_device_clash' });
                return { ok: false, reason: 'device_already_in', challenge };
            }
        }

        // Entry. A prepaid slot is only free while slots remain; past that the
        // joiner spends their own credit rather than being turned away.
        let entryMethod = challenge.entry_model;
        let creditConsumed = false;

        if (challenge.entry_model === 'prepaid') {
            const used = await pool.query(`
                SELECT COUNT(*)::int AS n FROM challenge_participants
                WHERE challenge_id = $1 AND entry_method = 'prepaid'
            `, [challenge.id]);
            entryMethod = used.rows[0].n < challenge.prepaid_slots ? 'prepaid' : 'credit';
        }

        if (entryMethod === 'credit') {
            const paymentService = require('./payment.service');
            const spend = await paymentService.deductGameAtomic(user.id);
            if (!spend.deducted) return { ok: false, reason: 'no_credits', challenge };
            creditConsumed = true;
        }

        const now = new Date();
        const playExpiresAt = challenge.mode === 'async' ? this.playExpiryFor(now) : null;

        // Account created within the hour — the "acceptors who are brand-new
        // users" metric, and the number that decides whether this is a growth
        // feature or a retention feature.
        const isNewUser = user.created_at
            ? (now.getTime() - new Date(user.created_at).getTime()) < 3600 * 1000
            : false;

        try {
            await pool.query(`
                INSERT INTO challenge_participants (
                    challenge_id, user_id, role, status, entry_method, credit_consumed,
                    joined_at, accepted_at, play_expires_at, join_ip, join_device_id, is_new_user
                ) VALUES ($1,$2,'invitee','joined',$3,$4,$5,$5,$6,$7,$8,$9)
            `, [
                challenge.id, user.id, entryMethod, creditConsumed, now,
                playExpiresAt, context.ip || null, context.deviceId || null, isNewUser
            ]);
        } catch (error) {
            // The UNIQUE constraint is the real one-account-one-entry gate,
            // and it cannot be raced. If it fires we must hand the credit back
            // — the join did not happen.
            if (error && error.code === '23505') {
                if (creditConsumed) {
                    const paymentService = require('./payment.service');
                    await paymentService.refundGameCredit(user.id, 'duplicate_join');
                }
                return { ok: false, reason: 'already_joined', challenge };
            }
            throw error;
        }

        await this.recordEvent(challenge.id, user.id, 'accepted', context.platform, {
            entryMethod, isNewUser
        });

        return { ok: true, challenge, entryMethod, creditConsumed, isNewUser };
    }

    // ============================================
    // CANCEL
    // ============================================
    // Free until someone joins or pays; final after that. Stated on the
    // creation screen before anything is spent.

    async cancelChallenge(code, user) {
        const challenge = await this.getByCode(code);
        if (!challenge) return { ok: false, reason: 'not_found' };
        if (challenge.creator_user_id !== user.id) return { ok: false, reason: 'not_yours' };
        if (![STATUS.OPEN, STATUS.AWAITING_SPONSORSHIP].includes(challenge.status)) {
            return { ok: false, reason: 'already_running', challenge };
        }
        // The initiator does not count against themselves.
        if (challenge.participant_count > 1) return { ok: false, reason: 'someone_joined', challenge };

        const sponsorship = await pool.query(
            `SELECT payment_status FROM challenge_sponsorships WHERE challenge_id = $1`,
            [challenge.id]
        );
        if (sponsorship.rows[0] && sponsorship.rows[0].payment_status === 'settled') {
            return { ok: false, reason: 'prize_paid', challenge };
        }

        await pool.query(
            `UPDATE challenges SET status = $1, completion_reason = 'cancelled', updated_at = NOW()
             WHERE id = $2`,
            [STATUS.CANCELLED, challenge.id]
        );

        return { ok: true, challenge };
    }

    // ============================================
    // INSTRUMENTATION
    // ============================================
    // Fire-and-forget: every metric in the brief comes out of this table, and
    // none of them is worth failing a join for.

    async recordEvent(challengeId, userId, event, platform = null, meta = {}) {
        try {
            await pool.query(`
                INSERT INTO challenge_events (challenge_id, user_id, event, platform, meta)
                VALUES ($1, $2, $3, $4, $5)
            `, [challengeId, userId || null, event, platform || null, JSON.stringify(meta || {})]);
        } catch (error) {
            logger.error(`Could not record challenge event "${event}":`, error.message);
        }
    }

    // ============================================
    // REFUND SPLIT
    // ============================================
    // Computed once at failure and STORED on the sponsorship row, never
    // recomputed at display time — a percentage derived in two places is how
    // two screens end up disagreeing by a naira. Integer arithmetic
    // throughout; the retained half is rounded and the refund is the
    // remainder, so the two always reconcile to the original amount.

    refundSplit(amount) {
        const gross = Math.max(0, Math.round(Number(amount) || 0));
        const retained = Math.round((gross * REFUND_RETENTION_BPS) / 10000);
        return { gross, retained, refund: gross - retained };
    }
}

ChallengeService.SCHEMA_STATEMENTS = Object.freeze([
    `CREATE TABLE IF NOT EXISTS challenges (
    id                  SERIAL PRIMARY KEY,

    code                TEXT NOT NULL UNIQUE,

    creator_user_id     INTEGER NOT NULL REFERENCES users(id),

    mode                TEXT NOT NULL CHECK (mode IN ('async','live')),
    format              TEXT NOT NULL CHECK (format IN ('direct','group')),

    rounds              SMALLINT NOT NULL DEFAULT 1 CHECK (rounds IN (1,3)),

    speed_level         SMALLINT NOT NULL DEFAULT 2 CHECK (speed_level BETWEEN 1 AND 3),

    categories          TEXT[] NOT NULL CHECK (
                            array_length(categories, 1) BETWEEN 1 AND 3
                        ),

    entry_model         TEXT NOT NULL CHECK (entry_model IN ('credit','prepaid','free')),
    prepaid_slots       SMALLINT CHECK (prepaid_slots IS NULL OR prepaid_slots BETWEEN 1 AND 20),
    max_participants    SMALLINT NOT NULL CHECK (max_participants BETWEEN 2 AND 20),

    prize_amount        INTEGER NOT NULL DEFAULT 0 CHECK (prize_amount >= 0),

    status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                            'draft','awaiting_sponsorship','open','lobby','live',
                            'grading','completed','expired','cancelled','void_refunded'
                        )),

    question_bank_id    INTEGER NOT NULL,

    scheduled_start_at  TIMESTAMPTZ,
    opened_at           TIMESTAMPTZ,
    invite_expires_at   TIMESTAMPTZ NOT NULL,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,

    completion_reason   TEXT CHECK (completion_reason IS NULL OR completion_reason IN (
                            'two_finished','expired','abandoned','cancelled'
                        )),

    integrity_hold      BOOLEAN NOT NULL DEFAULT false,

    created_platform    TEXT NOT NULL CHECK (created_platform IN ('whatsapp','telegram','web')),
    settings            JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT challenges_best_of_three_is_live_1v1 CHECK (
        rounds = 1 OR (mode = 'live' AND format = 'direct')
    ),
    CONSTRAINT challenges_direct_is_two CHECK (
        format <> 'direct' OR max_participants = 2
    ),
    CONSTRAINT challenges_prepaid_has_slots CHECK (
        (entry_model = 'prepaid' AND prepaid_slots IS NOT NULL)
        OR (entry_model <> 'prepaid' AND prepaid_slots IS NULL)
    )
)`,
    `CREATE INDEX IF NOT EXISTS idx_challenges_code
    ON challenges (code)`,
    `CREATE INDEX IF NOT EXISTS idx_challenges_creator
    ON challenges (creator_user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_challenges_sweeper
    ON challenges (invite_expires_at)
    WHERE status IN ('awaiting_sponsorship','open','lobby','live')`,
    `CREATE TABLE IF NOT EXISTS challenge_participants (
    id                  SERIAL PRIMARY KEY,
    challenge_id        INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    user_id             INTEGER NOT NULL REFERENCES users(id),

    role                TEXT NOT NULL CHECK (role IN ('initiator','invitee')),
    status              TEXT NOT NULL DEFAULT 'invited' CHECK (status IN (
                            'invited','joined','in_lobby','playing','finished','forfeited','expired'
                        )),

    entry_method        TEXT CHECK (entry_method IS NULL OR entry_method IN ('credit','prepaid','free')),

    credit_consumed     BOOLEAN NOT NULL DEFAULT false,

    joined_at           TIMESTAMPTZ,
    accepted_at         TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ,

    play_expires_at     TIMESTAMPTZ,

    final_score         SMALLINT CHECK (final_score IS NULL OR final_score BETWEEN 0 AND 45),
    total_answer_ms     INTEGER,
    rank                SMALLINT,

    join_ip             INET,
    join_device_id      TEXT,
    collusion_flags     JSONB NOT NULL DEFAULT '{}'::jsonb,

    is_new_user         BOOLEAN NOT NULL DEFAULT false,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT challenge_participants_unique UNIQUE (challenge_id, user_id)
)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_participants_challenge
    ON challenge_participants (challenge_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_participants_user
    ON challenge_participants (user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_participants_play_expiry
    ON challenge_participants (play_expires_at)
    WHERE status IN ('joined','playing')`,
    `CREATE TABLE IF NOT EXISTS challenge_question_sets (
    id                  SERIAL PRIMARY KEY,
    challenge_id        INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    round_no            SMALLINT NOT NULL CHECK (round_no BETWEEN 1 AND 3),
    position            SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 15),
    question_id         INTEGER NOT NULL REFERENCES questions(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT challenge_question_sets_slot UNIQUE (challenge_id, round_no, position),
    CONSTRAINT challenge_question_sets_no_repeat UNIQUE (challenge_id, question_id)
)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_question_sets_lookup
    ON challenge_question_sets (challenge_id, round_no, position)`,
    `CREATE TABLE IF NOT EXISTS challenge_rounds (
    id                  SERIAL PRIMARY KEY,
    challenge_id        INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    round_no            SMALLINT NOT NULL CHECK (round_no BETWEEN 1 AND 3),
    participant_id      INTEGER NOT NULL REFERENCES challenge_participants(id) ON DELETE CASCADE,
    user_id             INTEGER NOT NULL REFERENCES users(id),

    game_session_id     INTEGER,
    session_key         TEXT,

    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                            'pending','playing','finished','abandoned','expired'
                        )),

    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,

    correct_count       SMALLINT NOT NULL DEFAULT 0 CHECK (correct_count BETWEEN 0 AND 15),
    total_answer_ms     INTEGER NOT NULL DEFAULT 0,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT challenge_rounds_unique UNIQUE (challenge_id, round_no, participant_id)
)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_rounds_challenge
    ON challenge_rounds (challenge_id, round_no)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_rounds_user
    ON challenge_rounds (user_id, completed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_rounds_session
    ON challenge_rounds (game_session_id)
    WHERE game_session_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS challenge_answers (
    id                  SERIAL PRIMARY KEY,
    round_id            INTEGER NOT NULL REFERENCES challenge_rounds(id) ON DELETE CASCADE,
    challenge_id        INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    round_no            SMALLINT NOT NULL CHECK (round_no BETWEEN 1 AND 3),
    position            SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 15),
    question_id         INTEGER NOT NULL,

    chosen              TEXT CHECK (chosen IS NULL OR chosen IN ('A','B','C','D')),
    is_correct          BOOLEAN NOT NULL DEFAULT false,
    answer_ms           INTEGER NOT NULL,

    answered_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT challenge_answers_unique UNIQUE (round_id, position)
)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_answers_ghost
    ON challenge_answers (challenge_id, round_no, position)`,
    `CREATE TABLE IF NOT EXISTS challenge_sponsorships (
    id                      SERIAL PRIMARY KEY,
    challenge_id            INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    user_id                 INTEGER NOT NULL REFERENCES users(id),

    amount                  INTEGER NOT NULL CHECK (amount > 0),

    gateway                 TEXT,
    payment_reference       TEXT UNIQUE,

    payment_status          TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN (
                                'pending','settled','failed','withheld','awarded','refunded'
                            )),

    settled_at              TIMESTAMPTZ,

    awarded_transaction_id  INTEGER,

    refunded_at             TIMESTAMPTZ,
    refund_amount           INTEGER CHECK (refund_amount IS NULL OR refund_amount >= 0),
    retained_amount         INTEGER CHECK (retained_amount IS NULL OR retained_amount >= 0),
    refund_transaction_id   INTEGER,

    withheld_reason         TEXT,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT challenge_sponsorships_one_per_challenge UNIQUE (challenge_id),

    CONSTRAINT challenge_sponsorships_split_together CHECK (
        (refund_amount IS NULL AND retained_amount IS NULL)
        OR (refund_amount IS NOT NULL AND retained_amount IS NOT NULL)
    ),
    CONSTRAINT challenge_sponsorships_split_reconciles CHECK (
        refund_amount IS NULL OR (refund_amount + retained_amount = amount)
    )
)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_sponsorships_challenge
    ON challenge_sponsorships (challenge_id)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_sponsorships_user
    ON challenge_sponsorships (user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_sponsorships_reference
    ON challenge_sponsorships (payment_reference)
    WHERE payment_reference IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_sponsorships_open
    ON challenge_sponsorships (payment_status, created_at)
    WHERE payment_status IN ('pending','settled','withheld')`,
    `CREATE TABLE IF NOT EXISTS challenge_events (
    id              SERIAL PRIMARY KEY,
    challenge_id    INTEGER REFERENCES challenges(id) ON DELETE CASCADE,
    user_id         INTEGER,

    event           TEXT NOT NULL CHECK (event IN (
                        'created','invite_sent','invite_opened','accepted','joined_lobby',
                        'round_started','round_finished','abandoned','card_generated',
                        'card_shared','sponsorship_settled','integrity_flagged'
                    )),

    platform        TEXT CHECK (platform IS NULL OR platform IN ('whatsapp','telegram','web')),
    meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_events_challenge
    ON challenge_events (challenge_id, event)`,
    `CREATE INDEX IF NOT EXISTS idx_challenge_events_funnel
    ON challenge_events (event, created_at DESC)`,
    `ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS challenge_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_game_sessions_challenge
    ON game_sessions (challenge_id)
    WHERE challenge_id IS NOT NULL`,
]);

const challengeService = new ChallengeService();

module.exports = challengeService;
module.exports.MODES = MODES;
module.exports.FORMATS = FORMATS;
module.exports.ENTRY_MODELS = ENTRY_MODELS;
module.exports.STATUS = STATUS;
module.exports.PARTICIPANT_STATUS = PARTICIPANT_STATUS;
module.exports.SPEED_LEVEL_MS = SPEED_LEVEL_MS;
module.exports.DEFAULT_SPEED_LEVEL = DEFAULT_SPEED_LEVEL;
module.exports.QUESTIONS_PER_ROUND = QUESTIONS_PER_ROUND;
module.exports.MAX_PARTICIPANTS = MAX_PARTICIPANTS;
module.exports.INVITE_TTL_HOURS = INVITE_TTL_HOURS;
module.exports.PLAY_TTL_HOURS = PLAY_TTL_HOURS;
module.exports.REFUND_RETENTION_BPS = REFUND_RETENTION_BPS;
module.exports.MIN_PRIZE = MIN_PRIZE;
module.exports.MAX_PRIZE = MAX_PRIZE;
module.exports.SPONSOR_MIN_AGE = SPONSOR_MIN_AGE;
