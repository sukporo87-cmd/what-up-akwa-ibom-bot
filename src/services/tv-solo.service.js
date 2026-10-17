// ============================================
// FILE: src/services/tv-solo.service.js
// WUT TV — Solo: one person, the TV and the remote.
//
// PRACTICE, PLAYED ON A TV. The same question source as Practice
// (question.service.getQuestionByDifficulty with 'practice', which reads the
// practice_mode bank by question number), the same 12/11/10-second ladder, one
// 50:50 and one Skip, and a wrong answer or a timeout ends the round. Nothing
// in Practice is called that writes, and no game_sessions row is made: most
// Solo players are guests with no account.
//
// NO CASH, SO NO CLASSIC DEFENCES. No CAPTCHA, photo check or Turbo: they
// protect prize money and Solo has none. What it keeps:
//   * the server keeps the clock — askedAt and expiresAt are set here, and an
//     answer is timed against them, never against anything the TV says
//   * the correct answer never leaves the server before the TV answers, and
//     it is not held in the round state; it is read when the answer arrives
//   * a question can score once per round (a unique index, not just a check)
//
// POINTS ARE A LEDGER. One tv_points row per correct answer: 10 for Q1-5,
// 20 for Q6-10, 30 for Q11-15. A round started while someone is signed in on
// the TV is theirs from the start; a guest's rows are held by guest_ref
// 'tvs:<round>', and move to an account when the guest signs in within 24
// hours (tv-session.service).
//
// RESTART-PROOF BY DESIGN. Solo has no server timers: the round lives in
// Redis under tv_solo:<id>, and every request checks the time against the
// deadline it stored. A deploy mid-question costs nothing but the seconds it
// took.
//
// ONE CATEGORY, IF ASKED FOR. The home screen's Categories tile starts a round
// in one category. Those questions come from the challenge_mode bank — the
// same bank and the same ready-category list as Party, because that is the
// bank whose categories are checked to fill every level of the ladder. The
// position-to-difficulty map is question.service's own
// (difficultiesForPosition), read, never changed.
//
// SEPARATE FROM PARTY. Party's engine, room store and routes are untouched;
// the two share only tv-auth (the TV's identity) and the points ledger.
// ============================================

const crypto = require('crypto');
const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const tvAuth = require('./tv-auth.service');
const QuestionService = require('./question.service');

const questionService = new QuestionService();

// ---- the rules (Practice's values, kept as TV's own) ----
const QUESTIONS_PER_ROUND = 15;
const clockMsFor = n => (n <= 5 ? 12000 : n <= 10 ? 11000 : 10000);
const pointsFor = n => (n <= 5 ? 10 : n <= 10 ? 20 : 30);
const ANSWER_GRACE_MS = 1500;
const LETTERS = ['A', 'B', 'C', 'D'];

// ---- housekeeping ----
const STATE_TTL_SECONDS = 2 * 60 * 60;
const FINISHED_TTL_SECONDS = 60 * 60;
const ROUNDS_PER_DEVICE_PER_HOUR = 60;
const HISTORY_DAYS = 7;
const HISTORY_LIMIT = 300;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const STALE_AFTER = '2 hours';

const stateKey = id => `tv_solo:${id}`;

class TvSoloService {

    constructor() {
        /** @type {Map<number, Promise>} one change at a time per round */
        this.chains = new Map();
        this._lastSweep = 0;
    }

    // ============================================
    // STATE
    // ============================================

    async _load(id) {
        const raw = await redis.get(stateKey(id));
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    async _save(state) {
        const ttl = state.status === 'playing' ? STATE_TTL_SECONDS : FINISHED_TTL_SECONDS;
        await redis.set(stateKey(state.id), JSON.stringify(state), 'EX', ttl);
    }

    _withRound(id, fn) {
        const key = Number(id);
        const prev = this.chains.get(key) || Promise.resolve();
        const run = async () => {
            const state = await this._load(key);
            const out = await fn(state);
            if (state && out && out.__save !== false) await this._save(state);
            if (out) delete out.__save;
            return out;
        };
        const next = prev.then(run, run);
        const tail = next.catch(() => {});
        this.chains.set(key, tail);
        tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
        return next;
    }

    /** Loads a round the calling TV owns, or a refusal. */
    _guard(state, device) {
        if (!state) return { ok: false, reason: 'no_round', __save: false };
        if (state.deviceId !== device.id) return { ok: false, reason: 'not_your_round', __save: false };
        return null;
    }

    // ============================================
    // WHAT THE TV IS SHOWN
    // ============================================

    view(state) {
        const asking = state.status === 'playing' && state.phase === 'question';
        const f = state.fifty && state.fifty.position === state.position ? state.fifty.keep : null;
        return {
            roundId: state.id,
            category: state.category || null,
            status: state.status,
            phase: state.phase,
            position: state.position,
            total: QUESTIONS_PER_ROUND,
            question: (asking || state.phase === 'answered') ? state.question : null,
            expiresAt: asking ? state.expiresAt : null,
            clockMs: asking ? clockMsFor(state.position) : null,
            letters: asking ? (f || LETTERS) : null,
            fiftyAvailable: asking && !state.fiftyUsed,
            skipAvailable: asking && !state.skipUsed,
            correct: state.correct,
            points: state.points,
            endReason: state.endReason || null,
            signedIn: !!state.userId,
            serverNow: Date.now()
        };
    }

    // ============================================
    // START
    // ============================================

    async start(device, opts = {}) {
        await tvAuth.ensureSchema();
        this._maybeSweep();

        let category = null;
        if (opts.category != null && String(opts.category).trim() !== '') {
            category = String(opts.category).trim().toLowerCase();
            const ready = await require('./tv-party.service').getCategories();
            if (!ready.includes(category)) return { ok: false, reason: 'unknown_category' };
        }

        try {
            const n = await redis.incr(`tv_rate:solo:${device.id}`);
            if (n === 1) await redis.expire(`tv_rate:solo:${device.id}`, 3600);
            if (n > ROUNDS_PER_DEVICE_PER_HOUR) return { ok: false, reason: 'too_many_rounds' };
        } catch (e) { /* Redis down: let them play */ }

        // One round at a time per TV. Starting again ends the one before.
        const old = await pool.query(
            `UPDATE tv_solo_rounds SET status = 'finished', end_reason = 'replaced', finished_at = NOW()
             WHERE tv_device_id = $1 AND status = 'playing'
             RETURNING id`,
            [device.id]
        );
        for (const r of old.rows) { try { await redis.del(stateKey(r.id)); } catch (e) { /* expires anyway */ } }

        // Questions this TV has served lately are avoided first, so a family
        // playing every evening does not see the same ladder twice.
        const hist = await pool.query(
            `SELECT q FROM (
                 SELECT unnest(question_ids) AS q, started_at FROM tv_solo_rounds
                 WHERE tv_device_id = $1 AND started_at > NOW() - INTERVAL '${HISTORY_DAYS} days'
             ) x ORDER BY started_at DESC LIMIT ${HISTORY_LIMIT}`,
            [device.id]
        );

        // Signed in on this TV (phase 4): the round and its points are the
        // account's. The route has already checked the session.
        const userId = Number.isInteger(opts.userId) && opts.userId > 0 ? opts.userId : null;
        const ins = await pool.query(
            `INSERT INTO tv_solo_rounds (tv_device_id, category, user_id) VALUES ($1, $2, $3) RETURNING id`,
            [device.id, category, userId]
        );
        const state = {
            id: ins.rows[0].id,
            deviceId: device.id,
            userId,
            category,
            status: 'playing',
            phase: 'starting',
            position: 0,
            questionId: null,
            question: null,
            askedAt: 0,
            expiresAt: 0,
            fifty: null,
            fiftyUsed: false,
            skipUsed: false,
            served: [],
            history: hist.rows.map(r => Number(r.q)),
            correct: 0,
            points: 0,
            endReason: null
        };

        // If the bank cannot fill question 1, the round comes back already
        // finished with end reason no_questions, and the TV says so.
        await this._serve(state, 1);
        await this._save(state);
        logger.info(`📺 TV ${device.id} started Solo round ${state.id}${category ? ` (${category})` : ''}${userId ? ` for user ${userId}` : ''}`);
        return { ok: true, round: this.view(state) };
    }

    /** Puts question `position` on screen. False if the bank could not fill it. */
    async _serve(state, position) {
        const exclude = [...new Set([...state.served, ...state.history])];
        const pick = ex => state.category
            ? this._categoryQuestion(state.category, position, ex)
            : questionService.getQuestionByDifficulty(position, ex, 'practice');
        let q = await pick(exclude);
        if (!q && state.history.length) q = await pick(state.served);
        if (!q) {
            logger.error(`Solo round ${state.id}: no question for position ${position}` +
                         (state.category ? ` in ${state.category}` : ' in the practice bank'));
            await this._finish(state, 'no_questions');
            return false;
        }

        const now = Date.now();
        state.phase = 'question';
        state.position = position;
        state.questionId = q.id;
        // correct_answer is deliberately left behind: it is read again when
        // the TV answers, and is never part of the stored round.
        state.question = {
            text: q.question_text,
            options: { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d }
        };
        state.askedAt = now;
        state.expiresAt = now + clockMsFor(position);
        state.served.push(q.id);

        await pool.query(
            `UPDATE tv_solo_rounds SET question_ids = array_append(question_ids, $2), reached = $3
             WHERE id = $1`,
            [state.id, q.id, position]
        );
        return true;
    }

    /** One active question in this category at this rung of the ladder. Read only. */
    async _categoryQuestion(category, position, exclude) {
        const bankId = await questionService.getChallengeBankId();
        const r = await pool.query(
            `SELECT q.id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d
             FROM questions q
             WHERE q.question_bank_id = $1
               AND LOWER(q.category) = $2
               AND q.difficulty = ANY($3::int[])
               AND q.is_active = true
               AND (q.is_disabled = false OR q.is_disabled IS NULL)
               AND NOT (q.id = ANY($4::int[]))
             ORDER BY RANDOM()
             LIMIT 1`,
            [bankId, category, questionService.difficultiesForPosition(position), exclude.length ? exclude : [0]]
        );
        return r.rows[0] || null;
    }

    async _finish(state, reason) {
        state.status = 'finished';
        state.phase = 'done';
        state.endReason = reason;
        await pool.query(
            `UPDATE tv_solo_rounds SET status = 'finished', end_reason = $2, finished_at = NOW()
             WHERE id = $1 AND status = 'playing'`,
            [state.id, reason]
        );
    }

    async _correctAnswer(questionId) {
        const r = await pool.query(`SELECT correct_answer FROM questions WHERE id = $1`, [questionId]);
        const c = String((r.rows[0] && r.rows[0].correct_answer) || '').trim().toUpperCase();
        return LETTERS.includes(c) ? c : null;
    }

    // ============================================
    // ANSWER
    // ============================================
    // `choice` null means "the clock ran out on the TV". It is only accepted
    // once the server's own clock agrees; before that the TV is told not_yet.

    async answer(device, roundId, position, choice) {
        const letter = choice == null ? null : String(choice).trim().toUpperCase();
        if (letter !== null && !LETTERS.includes(letter)) return { ok: false, reason: 'bad_choice' };

        return this._withRound(roundId, async (state) => {
            const refused = this._guard(state, device);
            if (refused) return refused;
            if (state.status !== 'playing' || state.phase !== 'question') return { ok: false, reason: 'not_asking', __save: false };
            if (Number(position) !== state.position) return { ok: false, reason: 'wrong_question', __save: false };

            const now = Date.now();
            const late = now > state.expiresAt + ANSWER_GRACE_MS;
            if (letter === null && now < state.expiresAt) return { ok: false, reason: 'not_yet', __save: false };

            const correctAnswer = await this._correctAnswer(state.questionId);

            if (letter === null || late) {
                await this._finish(state, 'timeout');
                return { ok: true, result: 'timeout', correctAnswer, scored: 0, round: this.view(state) };
            }

            const f = state.fifty && state.fifty.position === state.position ? state.fifty.keep : null;
            if (f && !f.includes(letter)) return { ok: false, reason: 'option_removed', __save: false };

            if (letter !== correctAnswer) {
                await this._finish(state, 'wrong');
                return { ok: true, result: 'wrong', chosen: letter, correctAnswer, scored: 0, round: this.view(state) };
            }

            const scored = pointsFor(state.position);
            const ins = await pool.query(
                `INSERT INTO tv_points (user_id, guest_ref, mode, question_number, points, tv_solo_round_id)
                 VALUES ($1, $2, 'solo', $3, $4, $5)
                 ON CONFLICT (tv_solo_round_id, question_number) WHERE tv_solo_round_id IS NOT NULL DO NOTHING
                 RETURNING id`,
                [state.userId, state.userId ? null : `tvs:${state.id}`, state.position, scored, state.id]
            );
            if (ins.rows[0]) {
                state.correct += 1;
                state.points += scored;
                await pool.query(
                    `UPDATE tv_solo_rounds SET correct = $2, points = $3 WHERE id = $1`,
                    [state.id, state.correct, state.points]
                );
            }

            if (state.position >= QUESTIONS_PER_ROUND) await this._finish(state, 'complete');
            else state.phase = 'answered';
            return { ok: true, result: 'correct', chosen: letter, correctAnswer, scored, round: this.view(state) };
        });
    }

    /** After a correct answer, the next question, once the TV is ready. */
    async next(device, roundId) {
        return this._withRound(roundId, async (state) => {
            const refused = this._guard(state, device);
            if (refused) return refused;
            if (state.status !== 'playing' || state.phase !== 'answered') return { ok: false, reason: 'not_ready', __save: false };
            await this._serve(state, state.position + 1);
            return { ok: true, round: this.view(state) };
        });
    }

    // ============================================
    // LIFELINES — once each per round, as in Practice
    // ============================================

    async fiftyFifty(device, roundId, position) {
        return this._withRound(roundId, async (state) => {
            const refused = this._guard(state, device);
            if (refused) return refused;
            if (state.status !== 'playing' || state.phase !== 'question' || Number(position) !== state.position) {
                return { ok: false, reason: 'not_asking', __save: false };
            }
            if (state.fiftyUsed) return { ok: false, reason: 'already_used', __save: false };
            if (Date.now() > state.expiresAt) return { ok: false, reason: 'too_late', __save: false };

            const correct = await this._correctAnswer(state.questionId);
            if (!correct) return { ok: false, reason: 'unavailable', __save: false };
            const wrong = LETTERS.filter(l => l !== correct);
            state.fifty = { position: state.position, keep: [correct, wrong[crypto.randomInt(0, wrong.length)]].sort() };
            state.fiftyUsed = true;
            await pool.query(`UPDATE tv_solo_rounds SET fifty_used = true WHERE id = $1`, [state.id]);
            return { ok: true, round: this.view(state) };
        });
    }

    /** A new question at the same level, with a fresh clock. */
    async skip(device, roundId, position) {
        return this._withRound(roundId, async (state) => {
            const refused = this._guard(state, device);
            if (refused) return refused;
            if (state.status !== 'playing' || state.phase !== 'question' || Number(position) !== state.position) {
                return { ok: false, reason: 'not_asking', __save: false };
            }
            if (state.skipUsed) return { ok: false, reason: 'already_used', __save: false };
            if (Date.now() > state.expiresAt) return { ok: false, reason: 'too_late', __save: false };

            state.skipUsed = true;
            state.fifty = null;
            await pool.query(`UPDATE tv_solo_rounds SET skip_used = true WHERE id = $1`, [state.id]);
            await this._serve(state, state.position);
            return { ok: true, round: this.view(state) };
        });
    }

    async quit(device, roundId) {
        return this._withRound(roundId, async (state) => {
            const refused = this._guard(state, device);
            if (refused) return refused;
            if (state.status === 'playing') await this._finish(state, 'quit');
            return { ok: true, round: this.view(state) };
        });
    }

    async get(device, roundId) {
        const state = await this._load(roundId);
        const refused = this._guard(state, device);
        if (refused) { delete refused.__save; return refused; }
        return { ok: true, round: this.view(state) };
    }

    // ============================================
    // HOUSEKEEPING
    // ============================================
    // A TV that is switched off mid-round leaves it 'playing'. They are closed
    // here, at most every ten minutes, when somebody starts a round — so no
    // new timer or boot step is needed in server.js.

    _maybeSweep() {
        if (Date.now() - this._lastSweep < SWEEP_EVERY_MS) return;
        this._lastSweep = Date.now();
        pool.query(
            `UPDATE tv_solo_rounds SET status = 'finished', end_reason = 'expired', finished_at = NOW()
             WHERE status = 'playing' AND started_at < NOW() - INTERVAL '${STALE_AFTER}'`
        ).catch(e => logger.error('Solo sweep failed:', e.message));
    }
}

module.exports = new TvSoloService();
module.exports.QUESTIONS_PER_ROUND = QUESTIONS_PER_ROUND;
module.exports.ANSWER_GRACE_MS = ANSWER_GRACE_MS;
module.exports.clockMsFor = clockMsFor;
module.exports.pointsFor = pointsFor;
