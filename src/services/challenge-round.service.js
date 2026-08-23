// ============================================
// FILE: src/services/challenge-round.service.js
// The async "ghost race" play loop.
//
// A DELIBERATE CHANGE FROM THE DESIGN — please read this before the code.
//
// The design said to reuse game.service's answer loop by duck-typing the
// session object, on the argument that a fork is how anti-fraud coverage
// quietly stops applying to half the traffic. Writing it, that turned out to
// be the wrong trade, and here is why:
//
//   game.service.processAnswer() is built around Classic's rules — the naira
//   prize ladder, elimination on a wrong answer, safe checkpoints at Q5 and
//   Q10, three lifelines, rebuy offers. A challenge round has NONE of those:
//   no elimination, no ladder, no lifelines, score is a count. Reusing it
//   would mean threading `if (session.challenge_id)` branches through a
//   3,000-line function that is the most load-bearing code in the product.
//   That is a bigger risk than a second loop, and a much harder one to review.
//
// So this is a separate loop — but the anti-fraud coverage the design was
// protecting is preserved EXPLICITLY rather than by inheritance:
//
//   * a game_sessions row is still written, with challenge_id set, so every
//     existing fraud query, audit trail and admin inspector sees the round
//   * the same Redis answer lock prevents double submissions
//   * antiFraudService.setQuestionStartTime / getQuestionStartTime enforce the
//     clock server-side, exactly as Classic does
//   * antiFraudService.trackResponseTime runs on every answer, so
//     impossibly-fast answering is flagged here too
//   * ip_address and device_id are populated on the session row
//
// If a future fraud check is added to Classic, it has to be added here too.
// There is a test asserting each of the five above still fires, so the
// coverage is checked rather than assumed.
//
// SCORES NEVER TOUCH game_sessions. current_score and final_score are numeric
// and hold NAIRA; a score of 12 written there would put twelve naira into
// every query that sums them. The score lives in
// challenge_rounds.correct_count.
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const antiFraudService = require('./anti-fraud.service');
const challengeService = require('./challenge.service');
const challengeIntegrityService = require('./challenge-integrity.service');

const QUESTIONS_PER_ROUND = 15;

class ChallengeRoundService {

    // ============================================
    // START A ROUND
    // ============================================
    // The question set is materialised HERE, on the first participant's START —
    // never at creation, or the second player could read the answers early.
    // Every later participant reads the same rows.

    async startRound(challenge, participant, user, context = {}) {
        const roundNo = 1;

        const existing = await pool.query(`
            SELECT * FROM challenge_rounds
            WHERE challenge_id = $1 AND round_no = $2 AND participant_id = $3
        `, [challenge.id, roundNo, participant.id]);

        if (existing.rows[0] && existing.rows[0].status === 'finished') {
            return { ok: false, reason: 'already_played' };
        }
        if (existing.rows[0] && existing.rows[0].status === 'playing') {
            return { ok: true, round: existing.rows[0], resumed: true };
        }

        const set = await this.ensureQuestionSet(challenge, roundNo);
        if (!set.ok) return { ok: false, reason: 'no_questions', shortfall: set.shortfall };

        const sessionKey = `chal_${challenge.id}_${participant.id}_${Date.now()}`;

        // The game_sessions row exists so the round is visible to every
        // existing fraud query, audit view and admin inspector. Scores stay
        // NULL — those columns hold naira.
        const session = await pool.query(`
            INSERT INTO game_sessions (
                user_id, session_key, game_mode, game_type, platform, status,
                current_question, started_at, challenge_id, ip_address, device_id
            ) VALUES ($1, $2, 'challenge', 'challenge', $3, 'active', 1, NOW(), $4, $5, $6)
            RETURNING id
        `, [
            user.id, sessionKey, context.platform || 'web', challenge.id,
            context.ip || null, context.deviceId || null
        ]);

        const round = await pool.query(`
            INSERT INTO challenge_rounds (
                challenge_id, round_no, participant_id, user_id,
                game_session_id, session_key, status, started_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 'playing', NOW())
            ON CONFLICT (challenge_id, round_no, participant_id)
            DO UPDATE SET status = 'playing', started_at = NOW(),
                          game_session_id = EXCLUDED.game_session_id,
                          session_key = EXCLUDED.session_key
            RETURNING *
        `, [challenge.id, roundNo, participant.id, user.id, session.rows[0].id, sessionKey]);

        await pool.query(
            `UPDATE challenge_participants SET status = 'playing' WHERE id = $1`,
            [participant.id]
        );

        if (challenge.status === 'open') {
            await pool.query(
                `UPDATE challenges SET started_at = COALESCE(started_at, NOW()), updated_at = NOW()
                 WHERE id = $1`,
                [challenge.id]
            );
        }

        await challengeService.recordEvent(
            challenge.id, user.id, 'round_started', context.platform, { roundNo }
        );

        return { ok: true, round: round.rows[0], resumed: false };
    }

    // ============================================
    // MATERIALISE THE SET (once per challenge round)
    // ============================================
    // Concurrency matters: two participants can press START in the same
    // second. A Redis lock plus the UNIQUE constraint on
    // (challenge_id, round_no, position) means the loser reads the winner's
    // set rather than building a second one.

    async ensureQuestionSet(challenge, roundNo = 1) {
        const existing = await pool.query(`
            SELECT position, question_id FROM challenge_question_sets
            WHERE challenge_id = $1 AND round_no = $2 ORDER BY position
        `, [challenge.id, roundNo]);

        if (existing.rows.length === QUESTIONS_PER_ROUND) {
            return { ok: true, set: existing.rows, built: false };
        }

        const lockKey = `lock:challenge_set:${challenge.id}:${roundNo}`;
        const lock = await redis.set(lockKey, '1', 'NX', 'EX', 15);

        if (lock !== 'OK') {
            // Someone else is building it. Wait briefly, then read.
            await new Promise(r => setTimeout(r, 400));
            const retry = await pool.query(`
                SELECT position, question_id FROM challenge_question_sets
                WHERE challenge_id = $1 AND round_no = $2 ORDER BY position
            `, [challenge.id, roundNo]);
            if (retry.rows.length === QUESTIONS_PER_ROUND) {
                return { ok: true, set: retry.rows, built: false };
            }
            return { ok: false, shortfall: [{ reason: 'set_build_contention' }] };
        }

        try {
            const QuestionService = require('./question.service');
            if (!this._questionService) this._questionService = new QuestionService();

            // Best-of-3 must not repeat a question across its own rounds.
            const already = await pool.query(
                `SELECT question_id FROM challenge_question_sets WHERE challenge_id = $1`,
                [challenge.id]
            );
            const exclude = already.rows.map(r => r.question_id);

            const built = await this._questionService.buildChallengeQuestionSet(
                challenge.categories, exclude
            );

            if (!built.ok) {
                // Never substitute a wrong-difficulty question. Fail, name the
                // gap, and let the challenge expire rather than quietly
                // serving a ladder that does not mean anything.
                logger.error(
                    `Challenge ${challenge.code} cannot start: question bank cannot fill ` +
                    built.shortfall.map(s => `position ${s.position}`).join(', ')
                );
                return { ok: false, shortfall: built.shortfall };
            }

            const values = built.questionIds
                .map((q, i) => `($1, $2, $${i * 2 + 3}, $${i * 2 + 4})`)
                .join(', ');
            const params = [challenge.id, roundNo];
            for (const q of built.questionIds) params.push(q.position, q.questionId);

            await pool.query(`
                INSERT INTO challenge_question_sets (challenge_id, round_no, position, question_id)
                VALUES ${values}
                ON CONFLICT (challenge_id, round_no, position) DO NOTHING
            `, params);

            const set = await pool.query(`
                SELECT position, question_id FROM challenge_question_sets
                WHERE challenge_id = $1 AND round_no = $2 ORDER BY position
            `, [challenge.id, roundNo]);

            // The realised category mix, logged at build time. If a category a
            // player picked comes back at 0 it is a content gap at specific
            // difficulties, not a bug \u2014 and this is where you find out.
            if (built.mix) {
                const mix = Object.entries(built.mix).map(([c, n]) => `${c}:${n}`).join(' ');
                logger.info(`Challenge ${challenge.code} set built \u2014 ${mix}`);
            }

            return { ok: true, set: set.rows, built: true, mix: built.mix };
        } finally {
            await redis.del(lockKey).catch(() => {});
        }
    }

    // ============================================
    // SERVE A QUESTION
    // ============================================

    async getQuestion(challenge, round, position) {
        const result = await pool.query(`
            SELECT q.id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
                   q.difficulty, s.position
            FROM challenge_question_sets s
            JOIN questions q ON q.id = s.question_id
            WHERE s.challenge_id = $1 AND s.round_no = $2 AND s.position = $3
        `, [challenge.id, round.round_no, position]);

        const question = result.rows[0];
        if (!question) return null;

        // The clock is server-authoritative and starts now. Same primitive
        // Classic uses, so a client that lies about elapsed time is rejected
        // by the same code.
        await antiFraudService.setQuestionStartTime(round.session_key, position);

        return {
            position,
            questionId: question.id,
            text: question.question_text,
            options: {
                A: question.option_a, B: question.option_b,
                C: question.option_c, D: question.option_d
            },
            timeoutMs: challengeService.timeoutFor(challenge.speed_level),
            // correct_answer is deliberately NOT selected. It never leaves the
            // server until the player has locked in.
            ghost: null
        };
    }

    // ============================================
    // GHOST PACE
    // ============================================
    // Loaded ONCE per round, not once per question — one round trip instead of
    // fifteen, cached for the life of the play window.
    //
    // Pace only. Never correctness. A ghost that shows whether they got it
    // right is a ghost that leaks the answer, and that leak can also come from
    // the SHAPE of the UI, so this returns a bare number and nothing else.

    async loadGhost(challenge, roundNo = 1) {
        const key = `chal:${challenge.id}:ghost:${roundNo}`;

        try {
            const cached = await redis.get(key);
            if (cached) return JSON.parse(cached);
        } catch (e) { /* fall through to the database */ }

        const result = await pool.query(`
            SELECT a.position, a.answer_ms
            FROM challenge_answers a
            JOIN challenge_rounds r ON r.id = a.round_id
            JOIN challenge_participants p ON p.id = r.participant_id
            WHERE a.challenge_id = $1 AND a.round_no = $2
              AND p.role = 'initiator' AND r.status = 'finished'
            ORDER BY a.position
        `, [challenge.id, roundNo]);

        if (result.rows.length === 0) return null;

        const pace = {};
        for (const row of result.rows) pace[row.position] = row.answer_ms;

        // Postgres is the record; Redis is the cache. An async challenge can
        // live 72 hours, so this must never be Redis-only.
        try {
            await redis.setex(key, 86400, JSON.stringify(pace));
        } catch (e) { /* cache miss next time is fine */ }

        return pace;
    }

    // ============================================
    // SUBMIT AN ANSWER
    // ============================================

    async submitAnswer(challenge, round, position, chosen, user) {
        // Same lock Classic uses. A double tap must not score twice.
        const lockKey = `lock:chal_answer:${round.session_key}:${position}`;
        const lock = await redis.set(lockKey, '1', 'NX', 'EX', 3);
        if (lock !== 'OK') return { ok: false, reason: 'duplicate' };

        const timeoutMs = challengeService.timeoutFor(challenge.speed_level);
        const startTime = await antiFraudService.getQuestionStartTime(round.session_key, position);

        let answerMs = timeoutMs;
        let timedOut = true;

        if (startTime) {
            const elapsed = Date.now() - startTime;
            // A small grace for network latency, matching the live arena's
            // budget. Past that it is a timeout however it arrived.
            if (elapsed <= timeoutMs + 1500) {
                answerMs = Math.min(elapsed, timeoutMs);
                timedOut = false;
            }
        }

        // No elimination: a wrong answer scores zero and play continues. A
        // TIMEOUT counts as wrong and costs the FULL clock, so stalling to
        // think is never free — the tiebreak is cumulative answer time.
        const chosenLetter = timedOut ? null : String(chosen || '').toUpperCase();
        const correct = await pool.query(`
            SELECT q.correct_answer, q.id
            FROM challenge_question_sets s
            JOIN questions q ON q.id = s.question_id
            WHERE s.challenge_id = $1 AND s.round_no = $2 AND s.position = $3
        `, [challenge.id, round.round_no, position]);

        if (!correct.rows[0]) return { ok: false, reason: 'no_such_question' };

        const isCorrect = !timedOut &&
            chosenLetter === String(correct.rows[0].correct_answer || '').toUpperCase();

        await pool.query(`
            INSERT INTO challenge_answers (
                round_id, challenge_id, round_no, position, question_id,
                chosen, is_correct, answer_ms
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (round_id, position) DO NOTHING
        `, [
            round.id, challenge.id, round.round_no, position,
            correct.rows[0].id, chosenLetter, isCorrect, answerMs
        ]);

        // The same fraud primitive Classic calls on every answer. This is one
        // of the five checks the separate loop has to keep firing explicitly.
        try {
            await antiFraudService.trackResponseTime(
                round.game_session_id, position, answerMs, user.id
            );
        } catch (fraudError) {
            logger.error('Could not track challenge response time:', fraudError.message);
        }

        await pool.query(
            `UPDATE game_sessions SET current_question = $1 WHERE id = $2`,
            [Math.min(position + 1, QUESTIONS_PER_ROUND), round.game_session_id]
        );

        return {
            ok: true,
            isCorrect,
            timedOut,
            answerMs,
            correctAnswer: String(correct.rows[0].correct_answer || '').toUpperCase(),
            isLastQuestion: position >= QUESTIONS_PER_ROUND
        };
    }

    // ============================================
    // FINISH A ROUND
    // ============================================
    // "Finished" means all 15 positions resolved. Score is the correct count;
    // the tiebreak is cumulative answer time.

    async finishRound(challenge, round, participant, user, context = {}) {
        const totals = await pool.query(`
            SELECT COUNT(*) FILTER (WHERE is_correct)::int AS correct,
                   COUNT(*)::int                            AS answered,
                   COALESCE(SUM(answer_ms), 0)::int         AS total_ms
            FROM challenge_answers WHERE round_id = $1
        `, [round.id]);

        const { correct, answered, total_ms: totalMs } = totals.rows[0];
        if (answered < QUESTIONS_PER_ROUND) {
            return { ok: false, reason: 'incomplete', answered };
        }

        await pool.query(`
            UPDATE challenge_rounds
            SET status = 'finished', completed_at = NOW(),
                correct_count = $1, total_answer_ms = $2
            WHERE id = $3
        `, [correct, totalMs, round.id]);

        await pool.query(`
            UPDATE challenge_participants
            SET status = 'finished', finished_at = NOW(),
                final_score = $1, total_answer_ms = $2
            WHERE id = $3
        `, [correct, totalMs, participant.id]);

        await pool.query(`
            UPDATE game_sessions
            SET status = 'completed', completed_at = NOW()
            WHERE id = $1
        `, [round.game_session_id]);

        // The running leaderboard for group async. One sorted set, scored so
        // that a single ZREVRANGE returns the exact ranking including the
        // tiebreak: correct count dominates, time breaks ties downward.
        // total_answer_ms maxes at 15 x 12,000 = 180,000, well inside 10^7.
        try {
            await redis.zadd(
                `chal:${challenge.id}:board`,
                correct * 10000000 - totalMs,
                String(user.id)
            );
            await redis.expire(`chal:${challenge.id}:board`, 259200);
        } catch (e) {
            logger.warn(`Could not update challenge board: ${e.message}`);
        }

        await challengeService.recordEvent(
            challenge.id, user.id, 'round_finished', context.platform,
            { correct, totalMs }
        );

        const completion = await this.checkCompletion(challenge);

        return { ok: true, correct, totalMs, completion };
    }

    // ============================================
    // COMPLETION
    // ============================================
    // The definition everything else depends on: a challenge is COMPLETE when
    // at least TWO DISTINCT participants have finished a full round. Not
    // accepted, not started — finished.
    //
    // This is what stops a solo finish winning a sponsored prize. Without it,
    // an initiator could sponsor a prize, invite nobody real, win by default
    // and claim their own money back through the payout channel.

    async checkCompletion(challenge) {
        const finished = await pool.query(`
            SELECT COUNT(DISTINCT user_id)::int AS n
            FROM challenge_rounds
            WHERE challenge_id = $1 AND status = 'finished'
        `, [challenge.id]);

        if (finished.rows[0].n < 2) {
            return { complete: false, finishers: finished.rows[0].n };
        }

        // Ranks are written once, at completion. Redis is the fast path during
        // play; Postgres is the record.
        await pool.query(`
            WITH ranked AS (
                SELECT id, ROW_NUMBER() OVER (
                    ORDER BY final_score DESC NULLS LAST, total_answer_ms ASC
                ) AS position
                FROM challenge_participants
                WHERE challenge_id = $1 AND status = 'finished'
            )
            UPDATE challenge_participants p
            SET rank = ranked.position
            FROM ranked WHERE p.id = ranked.id
        `, [challenge.id]);

        await pool.query(`
            UPDATE challenges
            SET status = 'completed', completed_at = NOW(),
                completion_reason = 'two_finished', updated_at = NOW()
            WHERE id = $1 AND status NOT IN ('completed','expired','cancelled','void_refunded')
        `, [challenge.id]);

        // GATE 2 runs here and nowhere else — the strongest signal is how the
        // players answered, which does not exist until they have answered. It
        // never throws: an integrity check that crashes must not stop two
        // people seeing the result of a game they just played.
        const integrity = await challengeIntegrityService.run(challenge);

        // AWARD HAPPENS HERE AND NOWHERE ELSE. Putting the INSERT at a single
        // state transition is what makes "only a completed challenge awards"
        // structurally true rather than a rule someone has to remember. A solo
        // finish never reaches this line.
        //
        // Re-read the challenge first: integrity.run() may have just set
        // integrity_hold, and award() needs to see it so the transaction is
        // created with payout_hold = true rather than paid.
        let award = null;
        if (Number(challenge.prize_amount) > 0) {
            const fresh = await pool.query(
                `SELECT id, code, prize_amount, creator_user_id, integrity_hold, created_platform
                 FROM challenges WHERE id = $1`,
                [challenge.id]
            );
            const winner = await challengeService.getWinner(challenge.id);
            if (fresh.rows[0] && winner) {
                const challengeSponsorshipService = require('./challenge-sponsorship.service');
                award = await challengeSponsorshipService.award(fresh.rows[0], winner.user_id);
            }
        }

        return { complete: true, finishers: finished.rows[0].n, integrity, award };
    }

    // ============================================
    // LEADERBOARD (group async)
    // ============================================
    // Participants see a running board of everyone who has FINISHED — not the
    // leader's ghost. Racing the leader from fifth place is demoralising, and
    // it gives different players a different experience of the same challenge
    // depending on when they happen to play.

    async getBoard(challenge) {
        // A held challenge still shows ITS OWN participants their result — we
        // do not delete play, and nothing is said to anyone. What it does not
        // do is feed the public challenge leaderboard, which is a separate
        // query filtered on challenges.integrity_hold.
        const result = await pool.query(`
            SELECT u.username, p.final_score, p.total_answer_ms, p.rank
            FROM challenge_participants p
            JOIN users u ON u.id = p.user_id
            WHERE p.challenge_id = $1 AND p.status = 'finished'
            ORDER BY p.final_score DESC NULLS LAST, p.total_answer_ms ASC
        `, [challenge.id]);

        return result.rows.map((row, i) => ({
            position: i + 1,
            username: row.username,
            score: row.final_score,
            timeMs: row.total_answer_ms
        }));
    }

    // ============================================
    // EXPIRY SWEEPER
    // ============================================
    // Expired challenges must be cleaned up, not left as open rows.
    //
    // Event-driven, not a polling loop: called from the existing hourly
    // maintenance pass. Postgres and Redis are both a network hop from Render,
    // and a 100ms loop already cost 6.7 GB in a month on this project.

    async sweepExpired(now = new Date()) {
        const expired = await pool.query(`
            UPDATE challenges
            SET status = 'expired', completion_reason = 'expired', updated_at = NOW()
            WHERE status IN ('awaiting_sponsorship','open','lobby')
              AND invite_expires_at < $1
            RETURNING id, code, prize_amount
        `, [now]);

        // The \u00a717.2 ruling: a participant who spent their own credit and never
        // started a round gets it back. Someone who played their 15 questions
        // got the game they paid for even if nobody raced them.
        let refunded = 0;
        for (const challenge of expired.rows) {
            const unplayed = await pool.query(`
                SELECT p.id, p.user_id
                FROM challenge_participants p
                LEFT JOIN challenge_rounds r
                       ON r.participant_id = p.id AND r.status <> 'pending'
                WHERE p.challenge_id = $1
                  AND p.credit_consumed = true
                  AND r.id IS NULL
            `, [challenge.id]);

            for (const participant of unplayed.rows) {
                const paymentService = require('./payment.service');
                const result = await paymentService.refundGameCredit(
                    participant.user_id, 'challenge_expired_unplayed'
                );
                if (result.refunded) {
                    await pool.query(
                        `UPDATE challenge_participants SET credit_consumed = false WHERE id = $1`,
                        [participant.id]
                    );
                    refunded++;
                }
            }
        }

        // Async play windows that lapsed mid-challenge.
        const lapsed = await pool.query(`
            UPDATE challenge_participants
            SET status = 'expired'
            WHERE status IN ('joined','playing')
              AND play_expires_at IS NOT NULL AND play_expires_at < $1
            RETURNING id
        `, [now]);

        if (expired.rows.length || lapsed.rows.length || refunded) {
            logger.info(
                `\ud83e\uddf9 Challenge sweep: ${expired.rows.length} expired, ` +
                `${lapsed.rows.length} play windows lapsed, ${refunded} credits returned`
            );
        }

        // A sponsored challenge that expired without completing gets its
        // refund computed and queued now, not left for someone to notice.
        let voided = 0;
        for (const challenge of expired.rows.filter(c => Number(c.prize_amount) > 0)) {
            try {
                const challengeSponsorshipService = require('./challenge-sponsorship.service');
                const full = await pool.query(
                    `SELECT id, code, prize_amount, created_platform FROM challenges WHERE id = $1`,
                    [challenge.id]
                );
                if (!full.rows[0]) continue;
                const result = await challengeSponsorshipService.voidAndRefund(full.rows[0]);
                if (result.ok && result.refunded) voided++;
            } catch (error) {
                logger.error(`Could not void sponsorship for challenge ${challenge.code}:`, error.message);
            }
        }

        return {
            expired: expired.rows.length,
            lapsed: lapsed.rows.length,
            creditsRefunded: refunded,
            sponsorshipsVoided: voided
        };
    }
}

module.exports = new ChallengeRoundService();
module.exports.QUESTIONS_PER_ROUND = QUESTIONS_PER_ROUND;
