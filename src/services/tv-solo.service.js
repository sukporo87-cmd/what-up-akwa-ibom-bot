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
// ADMIN SETTINGS (the TV admin page, tv-settings.service). The three clock
// steps and the rounds-per-hour limit can be changed; the constants here are
// the defaults. So can where Play Now's questions come from: the Practice
// bank (the default), the Classic or Tournament bank, or a mix of Party
// categories. A round takes its clock and its source when it STARTS and
// keeps them, so a change never moves the clock under a round being played.
// Classic and Tournament questions are read here by their bank and the same
// difficulty bands Classic uses, with no fallback to another bank: if the
// bank runs dry the round ends saying so, rather than quietly serving
// questions from somewhere else.
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
const tvSettings = require('./tv-settings.service');

const questionService = new QuestionService();

// ---- the rules (Practice's values, kept as TV's own) ----
const QUESTIONS_PER_ROUND = 15;
// The default ladder. A round uses its own copy, taken from the settings at start.
const clockMsFor = n => (n <= 5 ? 12000 : n <= 10 ? 11000 : 10000);
const DEFAULT_CLOCK = [12000, 11000, 10000];
// Classic's difficulty bands by question number (question.service), for
// reading the Classic and Tournament banks.
const bandFor = n => (n <= 5 ? [1, 7] : n <= 10 ? [6, 12] : [11, 15]);
const BANK_NAMES = { classic: 'classic_mode', tournament: 'tournaments' };
const pointsFor = n => (n <= 5 ? 10 : n <= 10 ? 20 : 30);
const ANSWER_GRACE_MS = 1500;
const LETTERS = ['A', 'B', 'C', 'D'];

// ---- housekeeping ----
const STATE_TTL_SECONDS = 2 * 60 * 60;
const FINISHED_TTL_SECONDS = 60 * 60;
const ROUNDS_PER_DEVICE_PER_HOUR = 60;   // the default; the admin setting decides
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
            clockMs: asking ? this._clockFor(state, state.position) : null,
            source: (state.source && state.source.bank) || 'practice',
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

        const settings = await tvSettings.values();
        try {
            const n = await redis.incr(`tv_rate:solo:${device.id}`);
            if (n === 1) await redis.expire(`tv_rate:solo:${device.id}`, 3600);
            if (n > settings['solo.rounds_per_tv_per_hour']) return { ok: false, reason: 'too_many_rounds' };
        } catch (e) { /* Redis down: let them play */ }

        // Where this round's questions come from. The Categories tile names
        // one category; Play Now uses the admin's choice, and a choice of
        // categories keeps only the ones still on offer.
        let source;
        if (category) {
            source = { bank: 'categories', categories: [category] };
        } else {
            const chosen = settings['solo.play_now_source'];
            source = { bank: chosen.bank, categories: [] };
            if (chosen.bank === 'categories') {
                const ready = await require('./tv-party.service').getCategories();
                source.categories = chosen.categories.filter(c => ready.includes(c));
                if (!source.categories.length) {
                    logger.warn('Play Now: none of the chosen categories is on offer; using the practice questions');
                    source = { bank: 'practice', categories: [] };
                }
            }
        }
        const clock = [settings['solo.seconds_q1_5'], settings['solo.seconds_q6_10'], settings['solo.seconds_q11_15']]
            .map(x => x * 1000);

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
            `INSERT INTO tv_solo_rounds (tv_device_id, category, user_id, source) VALUES ($1, $2, $3, $4) RETURNING id`,
            [device.id, category, userId, source.bank]
        );
        const state = {
            id: ins.rows[0].id,
            deviceId: device.id,
            userId,
            category,
            source,
            clock,
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
        const src = state.source || (state.category ? { bank: 'categories', categories: [state.category] } : { bank: 'practice' });
        const pick = ex => src.bank === 'categories' ? this._categoryQuestion(src.categories, position, ex)
            : BANK_NAMES[src.bank] ? this._bankQuestion(BANK_NAMES[src.bank], position, ex)
            : questionService.getQuestionByDifficulty(position, ex, 'practice');
        let q = await pick(exclude);
        if (!q && state.history.length) q = await pick(state.served);
        if (!q) {
            logger.error(`Solo round ${state.id}: no question for position ${position} from ${src.bank}` +
                         (src.categories && src.categories.length ? ` (${src.categories.join(', ')})` : ''));
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
        state.expiresAt = now + this._clockFor(state, position);
        state.served.push(q.id);

        await pool.query(
            `UPDATE tv_solo_rounds SET question_ids = array_append(question_ids, $2), reached = $3
             WHERE id = $1`,
            [state.id, q.id, position]
        );
        return true;
    }

    /** This round's clock for question n: its own copy, or the default ladder. */
    _clockFor(state, n) {
        const c = Array.isArray(state.clock) && state.clock.length === 3 ? state.clock : DEFAULT_CLOCK;
        return n <= 5 ? c[0] : n <= 10 ? c[1] : c[2];
    }

    /** One active question from the Classic or Tournament bank, at Classic's band for this rung. Read only. */
    async _bankQuestion(bankName, position, exclude) {
        const [lo, hi] = bandFor(position);
        const r = await pool.query(
            `SELECT q.id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d
             FROM questions q
             JOIN question_banks qb ON qb.id = q.question_bank_id
             WHERE qb.bank_name = $1
               AND q.difficulty BETWEEN $2 AND $3
               AND q.is_active = true
               AND (q.is_disabled = false OR q.is_disabled IS NULL)
               AND NOT (q.id = ANY($4::int[]))
             ORDER BY RANDOM()
             LIMIT 1`,
            [bankName, lo, hi, exclude.length ? exclude : [0]]
        );
        return r.rows[0] || null;
    }

    /** One active question in these categories at this rung of the ladder. Read only. */
    async _categoryQuestion(categories, position, exclude) {
        const bankId = await questionService.getChallengeBankId();
        const r = await pool.query(
            `SELECT q.id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d
             FROM questions q
             WHERE q.question_bank_id = $1
               AND LOWER(q.category) = ANY($2::text[])
               AND q.difficulty = ANY($3::int[])
               AND q.is_active = true
               AND (q.is_disabled = false OR q.is_disabled IS NULL)
               AND NOT (q.id = ANY($4::int[]))
             ORDER BY RANDOM()
             LIMIT 1`,
            [bankId, categories, questionService.difficultiesForPosition(position), exclude.length ? exclude : [0]]
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

    /**
     * One answer, as it was given, for the Audit Trail and for reviewing a
     * round: the question, the letter (null for a timeout or a skip), how
     * long it took, and the result. Never fails the answer itself.
     */
    async _record(state, letter, now, result) {
        const entry = {
            n: state.position, q: state.questionId, chosen: letter,
            ms: Math.max(0, now - (state.askedAt || now)), result,
            fifty: !!(state.fifty && state.fifty.position === state.position)
        };
        try {
            await pool.query(
                `UPDATE tv_solo_rounds SET answers = answers || $2::jsonb WHERE id = $1`,
                [state.id, JSON.stringify([entry])]
            );
        } catch (e) { logger.error(`Solo round ${state.id}: answer not recorded: ${e.message}`); }
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
                await this._record(state, null, now, 'timeout');
                await this._finish(state, 'timeout');
                return { ok: true, result: 'timeout', correctAnswer, scored: 0, round: this.view(state) };
            }

            const f = state.fifty && state.fifty.position === state.position ? state.fifty.keep : null;
            if (f && !f.includes(letter)) return { ok: false, reason: 'option_removed', __save: false };

            await this._record(state, letter, now, letter === correctAnswer ? 'correct' : 'wrong');

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
            await this._record(state, null, Date.now(), 'skipped');
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
    // REVIEW (batch 3) — the round, answer by answer, once it is over
    // ============================================
    // Shown on the TV after the summary: each question, the answer given, the
    // right one, how long it took, and what it scored. For every question
    // source, Classic and Tournament included (an admin's choice, for
    // in-house testing). Read from the round's own record, so it works after
    // a deploy and for a round the TV picks up again.
    //
    // NOTHING IS SHOWN BEFORE THE ROUND IS OVER: a round still being played
    // is refused, so the review can never be a way to see a right answer
    // early. Only the TV that played the round can read it.

    async review(device, roundId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `SELECT id, tv_device_id, status, end_reason, reached, correct, points, category, source, question_ids, answers
             FROM tv_solo_rounds WHERE id = $1`,
            [roundId]
        );
        const round = r.rows[0];
        if (!round) return { ok: false, reason: 'no_round' };
        if (round.tv_device_id !== device.id) return { ok: false, reason: 'not_your_round' };
        if (round.status !== 'finished') return { ok: false, reason: 'not_finished' };

        const answers = Array.isArray(round.answers) ? round.answers : [];
        const given = new Set(answers.map(a => Number(a.q)));
        // The question on screen when the round was stopped (or replaced, or
        // left to expire) has no answer. It is shown, as not answered.
        const served = (round.question_ids || []).map(Number);
        const last = served.length ? served[served.length - 1] : null;
        // (A round from before answers were recorded has served questions and
        // no answers; its last question is not taken for an unanswered one.)
        const pending = last != null && !given.has(last) && (answers.length > 0 || served.length === 1) ? last : null;

        const ids = [...new Set([...given, ...(pending != null ? [pending] : [])])].filter(Number.isInteger);
        const bank = new Map();
        if (ids.length) {
            const q = await pool.query(
                `SELECT id, question_text, option_a, option_b, option_c, option_d, correct_answer, category, difficulty
                 FROM questions WHERE id = ANY($1::int[])`,
                [ids]
            );
            for (const row of q.rows) bank.set(Number(row.id), row);
        }
        const pts = await pool.query(
            `SELECT question_number, points FROM tv_points WHERE tv_solo_round_id = $1`, [roundId]
        );
        const pointsAt = new Map(pts.rows.map(p => [Number(p.question_number), Number(p.points)]));

        const show = (id) => {
            const q = bank.get(Number(id)) || {};
            const c = String(q.correct_answer || '').trim().toUpperCase();
            return {
                text: q.question_text || null,
                options: { A: q.option_a || '', B: q.option_b || '', C: q.option_c || '', D: q.option_d || '' },
                correct: LETTERS.includes(c) ? c : null,
                category: q.category || null
            };
        };
        const steps = answers.map(a => ({
            position: Number(a.n), ...show(a.q),
            chosen: LETTERS.includes(a.chosen) ? a.chosen : null,
            result: a.result, ms: Number(a.ms) || 0, fifty: !!a.fifty,
            points: a.result === 'correct' ? (pointsAt.get(Number(a.n)) || 0) : 0
        }));
        if (pending != null) {
            steps.push({ position: Number(round.reached) || steps.length + 1, ...show(pending),
                         chosen: null, result: 'unanswered', ms: 0, fifty: false, points: 0 });
        }
        return {
            ok: true,
            review: {
                roundId: round.id, endReason: round.end_reason, correct: Number(round.correct) || 0,
                points: Number(round.points) || 0, category: round.category || null, source: round.source || 'practice',
                // Rounds played before answers were recorded (backend before
                // 18 October 2026) have nothing to show.
                recorded: steps.length > 0, steps
            }
        };
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
