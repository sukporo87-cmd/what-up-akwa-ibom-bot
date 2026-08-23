// ============================================
// FILE: src/services/challenge-arena.service.js
// The synchronous "live arena".
//
// FOUR RULES CARRY THE BANDWIDTH BUDGET. Every one of them is a decision that
// looks like a small convenience if you break it, and costs gigabytes a month
// if you do. A 100ms polling loop already cost 6.7 GB in a month on this
// project; Postgres and Redis are both a network hop from Render.
//
//   1. NO PER-SECOND COUNTDOWN FRAMES. `startsAt` and `expiresAt` go out once,
//      as epoch milliseconds, and the browser counts down locally. A 10-minute
//      lobby at one frame a second would be 600 frames per player before a
//      single question is asked.
//
//   2. NO PER-ANSWER FAN-OUT. A player's answer is never broadcast. Twenty
//      players x fifteen questions x twenty recipients is 6,000 frames a
//      match, roughly ten times the entire rest of the budget.
//
//   3. THE SCOREBOARD IS BATCHED INTO THE REVEAL FRAME, once per question,
//      never as its own event.
//
//   4. IDLE LOBBIES EMIT ONLY ON CHANGE, coalesced on a 2-second timer. A
//      lobby with nobody joining sends nothing but the existing 25s heartbeat.
//
// EXPECTED: ~34 KB per player per 15-question match at 8 players, ~41 KB at
// 20. See the budget section at the bottom of the design doc.
//
// FAIRNESS: answers lock on submission and the correct answer is NOT revealed
// until every player has locked in or the clock expires. Two people in the
// same room must not be able to read each other's reaction.
//
// SINGLE INSTANCE: one in-process timer per match, exactly like activeTimeouts
// in game.service. A second Render instance would split the rooms.
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const gameEvents = require('./game-events.service');
const challengeService = require('./challenge.service');
const challengeRoundService = require('./challenge-round.service');

// Network slack. A client whose answer left in time should not be punished for
// the round trip, and the same grace applies to everyone.
const ANSWER_GRACE_MS = 1500;

// Between the reveal and the next question. Long enough to read the answer,
// short enough that fifteen of them do not become a coffee break.
const REVEAL_PAUSE_MS = 4000;

// The lobby opens this long before the scheduled start.
const LOBBY_OPEN_MS = 10 * 60 * 1000;

// If the initiator is absent or silent, start anyway rather than hanging.
// Sixty seconds is long enough for a live initiator to see the prompt and
// short enough that nineteen people are not held up by one dead battery.
const INITIATOR_GRACE_MS = 60 * 1000;

// The initiator may extend twice, five minutes each.
const EXTENSION_MS = 5 * 60 * 1000;
const MAX_EXTENSIONS = 2;

// Presence changes are coalesced, not sent per join.
const PRESENCE_COALESCE_MS = 2000;

const QUESTIONS_PER_ROUND = 15;

class ChallengeArenaService {

    constructor() {
        /** @type {Map<number, object>} challengeId -> live match state */
        this.matches = new Map();
        /** @type {Map<number, NodeJS.Timeout>} */
        this.timers = new Map();
        /** @type {Map<number, NodeJS.Timeout>} */
        this.presenceTimers = new Map();
    }

    // ============================================
    // LOBBY
    // ============================================

    async joinLobby(challenge, user) {
        if (challenge.mode !== 'live') return { ok: false, reason: 'not_live' };

        const startsAt = new Date(challenge.scheduled_start_at).getTime();
        if (Date.now() < startsAt - LOBBY_OPEN_MS) {
            return { ok: false, reason: 'too_early', opensAt: startsAt - LOBBY_OPEN_MS };
        }

        const state = this.matches.get(challenge.id);
        if (state && state.phase !== 'lobby') {
            // No late entry once questions are running. With an identical set
            // and a shared clock there is no fair way to admit someone at
            // question six.
            return { ok: false, reason: 'already_started' };
        }

        gameEvents.joinRoom(challenge.id, user.id);

        await pool.query(
            `UPDATE challenge_participants SET status = 'in_lobby'
             WHERE challenge_id = $1 AND user_id = $2 AND status IN ('joined','in_lobby')`,
            [challenge.id, user.id]
        );

        await challengeService.recordEvent(challenge.id, user.id, 'joined_lobby', 'web', {});

        this._schedulePresence(challenge);
        this._ensureStartTimer(challenge);

        return {
            ok: true,
            // Sent ONCE. The browser counts down locally from here.
            startsAt,
            present: gameEvents.roomMembers(challenge.id).length
        };
    }

    leaveLobby(challengeId, userId) {
        gameEvents.leaveRoom(challengeId, userId);
        const state = this.matches.get(challengeId);
        if (state && state.phase === 'lobby') {
            this._schedulePresenceById(challengeId);
        }
    }

    // Coalesced on a 2s timer and emitted only on change. An idle lobby sends
    // nothing at all.
    _schedulePresence(challenge) {
        this._schedulePresenceById(challenge.id);
    }

    _schedulePresenceById(challengeId) {
        if (this.presenceTimers.has(challengeId)) return;

        const timer = setTimeout(async () => {
            this.presenceTimers.delete(challengeId);
            try {
                const members = gameEvents.roomMembers(challengeId);
                const roster = await this._roster(challengeId, members);
                gameEvents.emitRoom(challengeId, 'challenge.lobby', {
                    challengeId,
                    present: roster
                });
            } catch (error) {
                logger.error('Lobby presence emit failed:', error.message);
            }
        }, PRESENCE_COALESCE_MS);

        timer.unref?.();
        this.presenceTimers.set(challengeId, timer);
    }

    async _roster(challengeId, memberIds) {
        if (memberIds.length === 0) return [];
        const result = await pool.query(
            `SELECT id, username FROM users WHERE id = ANY($1::int[])`,
            [memberIds]
        );
        return result.rows.map(r => ({ userId: r.id, username: r.username }));
    }

    // ============================================
    // START
    // ============================================

    _ensureStartTimer(challenge) {
        if (this.timers.has(challenge.id)) return;

        if (!this.matches.has(challenge.id)) {
            this.matches.set(challenge.id, {
                challengeId: challenge.id,
                phase: 'lobby',
                extensions: 0,
                startsAt: new Date(challenge.scheduled_start_at).getTime()
            });
        }

        const state = this.matches.get(challenge.id);
        const delay = Math.max(0, state.startsAt - Date.now());

        // ONE timer per match, woken by events rather than polled.
        const timer = setTimeout(() => this._onStartTime(challenge), delay);
        timer.unref?.();
        this.timers.set(challenge.id, timer);
    }

    async _onStartTime(challenge) {
        this.timers.delete(challenge.id);

        const state = this.matches.get(challenge.id);
        if (!state || state.phase !== 'lobby') return;

        const present = gameEvents.roomMembers(challenge.id);

        if (present.length < 2) {
            // Fewer than two people cannot produce a completed challenge, and
            // the completion rule is what protects any sponsored prize.
            gameEvents.emitRoom(challenge.id, 'challenge.abandoned', {
                challengeId: challenge.id, reason: 'not_enough_players'
            });
            await this._expire(challenge);
            return;
        }

        const initiatorPresent = present.includes(challenge.creator_user_id);

        if (!initiatorPresent) {
            // Auto-start rather than hang. The proposal from the design: an
            // absent initiator must not hold up everyone who did turn up.
            logger.info(`Challenge ${challenge.code}: initiator absent, auto-starting`);
            return this.startMatch(challenge);
        }

        if (state.extensions >= MAX_EXTENSIONS) return this.startMatch(challenge);

        // Ask the initiator, and start anyway if they do not answer.
        state.phase = 'awaiting_initiator';
        gameEvents.emit(challenge.creator_user_id, 'challenge.wait_or_start', {
            challengeId: challenge.id,
            present: present.length,
            extensionsLeft: MAX_EXTENSIONS - state.extensions,
            decideBy: Date.now() + INITIATOR_GRACE_MS
        });

        const timer = setTimeout(() => {
            const current = this.matches.get(challenge.id);
            if (current && current.phase === 'awaiting_initiator') {
                logger.info(`Challenge ${challenge.code}: initiator silent, auto-starting`);
                this.startMatch(challenge);
            }
        }, INITIATOR_GRACE_MS);
        timer.unref?.();
        this.timers.set(challenge.id, timer);
    }

    async extend(challenge, userId) {
        const state = this.matches.get(challenge.id);
        if (!state || userId !== challenge.creator_user_id) return { ok: false, reason: 'not_yours' };
        if (state.extensions >= MAX_EXTENSIONS) return { ok: false, reason: 'no_extensions_left' };

        state.extensions++;
        state.phase = 'lobby';
        state.startsAt = Date.now() + EXTENSION_MS;

        const existing = this.timers.get(challenge.id);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => this._onStartTime(challenge), EXTENSION_MS);
        timer.unref?.();
        this.timers.set(challenge.id, timer);

        // Sent once. The browser recounts locally.
        gameEvents.emitRoom(challenge.id, 'challenge.extended', {
            challengeId: challenge.id,
            startsAt: state.startsAt,
            extensionsLeft: MAX_EXTENSIONS - state.extensions
        });

        return { ok: true, startsAt: state.startsAt };
    }

    // ============================================
    // MATCH
    // ============================================

    async startMatch(challenge) {
        const state = this.matches.get(challenge.id) || { challengeId: challenge.id };
        const players = gameEvents.roomMembers(challenge.id);

        const set = await challengeRoundService.ensureQuestionSet(challenge, 1);
        if (!set.ok) {
            gameEvents.emitRoom(challenge.id, 'challenge.abandoned', {
                challengeId: challenge.id, reason: 'no_questions'
            });
            await this._expire(challenge);
            return { ok: false, reason: 'no_questions' };
        }

        // A round row per player, so every existing fraud query and admin
        // inspector sees the live match the same way it sees an async one.
        const rounds = new Map();
        for (const userId of players) {
            const participant = await challengeService.getParticipant(challenge.id, userId);
            if (!participant) continue;
            const started = await challengeRoundService.startRound(
                challenge, participant, { id: userId }, { platform: 'web' }
            );
            if (started.ok) rounds.set(userId, started.round);
        }

        state.phase = 'playing';
        state.position = 0;
        state.rounds = rounds;
        state.scores = new Map(players.map(u => [u, { correct: 0, totalMs: 0 }]));
        this.matches.set(challenge.id, state);

        await pool.query(
            `UPDATE challenges SET status = 'live', started_at = NOW(), updated_at = NOW()
             WHERE id = $1`,
            [challenge.id]
        );

        gameEvents.emitRoom(challenge.id, 'challenge.started', {
            challengeId: challenge.id,
            players: players.length,
            totalQuestions: QUESTIONS_PER_ROUND
        });

        return this._nextQuestion(challenge);
    }

    async _nextQuestion(challenge) {
        const state = this.matches.get(challenge.id);
        if (!state || state.phase !== 'playing') return { ok: false };

        state.position++;
        if (state.position > QUESTIONS_PER_ROUND) return this._endMatch(challenge);

        const anyRound = [...state.rounds.values()][0];
        const question = await challengeRoundService.getQuestion(challenge, anyRound, state.position);
        if (!question) return this._endMatch(challenge);

        // Every player's clock starts server-side, individually, so the
        // per-answer timing recorded in challenge_answers stays honest.
        for (const round of state.rounds.values()) {
            await challengeRoundService.getQuestion(challenge, round, state.position);
        }

        const timeoutMs = challengeService.timeoutFor(challenge.speed_level);
        state.expiresAt = Date.now() + timeoutMs;
        state.locked = new Map();

        // ONE frame per player. expiresAt is an absolute epoch time sent ONCE;
        // the browser counts down locally rather than being told the number
        // every second.
        gameEvents.emitRoom(challenge.id, 'challenge.question', {
            challengeId: challenge.id,
            position: state.position,
            total: QUESTIONS_PER_ROUND,
            text: question.text,
            options: question.options,
            expiresAt: state.expiresAt
        });

        const existing = this.timers.get(challenge.id);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => this._reveal(challenge, 'timeout'),
                                 timeoutMs + ANSWER_GRACE_MS);
        timer.unref?.();
        this.timers.set(challenge.id, timer);

        return { ok: true, position: state.position };
    }

    // ============================================
    // ANSWER — locked, never broadcast
    // ============================================

    async submitAnswer(challenge, user, position, chosen) {
        const state = this.matches.get(challenge.id);
        if (!state || state.phase !== 'playing') return { ok: false, reason: 'not_playing' };
        if (position !== state.position) return { ok: false, reason: 'wrong_question' };
        if (state.locked.has(user.id)) return { ok: false, reason: 'already_locked' };

        const round = state.rounds.get(user.id);
        if (!round) return { ok: false, reason: 'not_in_match' };

        const result = await challengeRoundService.submitAnswer(
            challenge, round, position, chosen, user
        );
        if (!result.ok) return result;

        state.locked.set(user.id, true);

        const score = state.scores.get(user.id);
        if (score) {
            if (result.isCorrect) score.correct++;
            score.totalMs += result.answerMs;
        }

        // The player is told their answer is IN, and nothing else. No
        // correctness, no score, no broadcast to anyone. Two people in the
        // same room must not be able to read each other's reaction.
        gameEvents.emit(user.id, 'challenge.locked', {
            challengeId: challenge.id, position
        });

        // Everyone in: reveal early rather than making them watch a clock run
        // down on a question nobody is still answering.
        if (state.locked.size >= state.rounds.size) {
            const timer = this.timers.get(challenge.id);
            if (timer) clearTimeout(timer);
            await this._reveal(challenge, 'all_locked');
        }

        return { ok: true, locked: true };
    }

    // ============================================
    // REVEAL — the scoreboard rides along
    // ============================================

    async _reveal(challenge, trigger) {
        const state = this.matches.get(challenge.id);
        if (!state || state.phase !== 'playing' || state.revealing) return;
        state.revealing = true;
        this.timers.delete(challenge.id);

        const correct = await pool.query(`
            SELECT q.correct_answer
            FROM challenge_question_sets s
            JOIN questions q ON q.id = s.question_id
            WHERE s.challenge_id = $1 AND s.round_no = 1 AND s.position = $2
        `, [challenge.id, state.position]);

        const correctAnswer = correct.rows[0]
            ? String(correct.rows[0].correct_answer || '').toUpperCase() : null;

        // Anyone who never locked in gets recorded as a timeout at the full
        // clock, so stalling is never free and the tiebreak stays honest.
        for (const [userId, round] of state.rounds) {
            if (state.locked.has(userId)) continue;
            const timedOut = await challengeRoundService.submitAnswer(
                challenge, round, state.position, null, { id: userId }
            );
            const score = state.scores.get(userId);
            if (score && timedOut.ok) score.totalMs += timedOut.answerMs;
        }

        // THE SCOREBOARD IS BATCHED IN HERE, once per question, never as its
        // own event. ~35 bytes per entry.
        const board = [...state.scores.entries()]
            .map(([userId, s]) => ({ u: userId, c: s.correct, t: s.totalMs }))
            .sort((a, b) => b.c - a.c || a.t - b.t);

        gameEvents.emitRoom(challenge.id, 'challenge.reveal', {
            challengeId: challenge.id,
            position: state.position,
            correctAnswer,
            trigger,
            board
        });

        state.revealing = false;

        const timer = setTimeout(() => this._nextQuestion(challenge), REVEAL_PAUSE_MS);
        timer.unref?.();
        this.timers.set(challenge.id, timer);
    }

    // ============================================
    // END
    // ============================================

    async _endMatch(challenge) {
        const state = this.matches.get(challenge.id);
        if (!state) return { ok: false };

        state.phase = 'grading';

        let completion = null;
        for (const [userId, round] of state.rounds) {
            const participant = await challengeService.getParticipant(challenge.id, userId);
            if (!participant) continue;
            const finished = await challengeRoundService.finishRound(
                challenge, round, participant, { id: userId }, { platform: 'web' }
            );
            if (finished.ok) completion = finished.completion;
        }

        const board = await challengeRoundService.getBoard(challenge);

        gameEvents.emitRoom(challenge.id, 'challenge.finished', {
            challengeId: challenge.id,
            board,
            cardUrl: `/challenge/${challenge.code}/card`
        });

        this._teardown(challenge.id);
        return { ok: true, completion };
    }

    async _expire(challenge) {
        await pool.query(
            `UPDATE challenges SET status = 'expired', completion_reason = 'abandoned',
             updated_at = NOW() WHERE id = $1 AND status IN ('open','lobby','live')`,
            [challenge.id]
        );
        this._teardown(challenge.id);
    }

    // Timers are cleared explicitly. An orphaned interval in a long-lived
    // Node process is a slow leak that only shows up as memory growth weeks
    // later.
    _teardown(challengeId) {
        const timer = this.timers.get(challengeId);
        if (timer) clearTimeout(timer);
        this.timers.delete(challengeId);

        const presence = this.presenceTimers.get(challengeId);
        if (presence) clearTimeout(presence);
        this.presenceTimers.delete(challengeId);

        this.matches.delete(challengeId);
        gameEvents.closeRoom(challengeId);
    }

    // ============================================
    // BANDWIDTH ACCOUNTING
    // ============================================
    // Exposed so the instrumentation panel can show the modelled cost against
    // Render's actual metrics, rather than trusting a number in a design doc.

    estimateBytes(players, questions = QUESTIONS_PER_ROUND) {
        const questionFrame = 540;                 // text + 4 options + envelope
        const revealFrame = 120 + players * 35;    // correct answer + batched board
        const lobbyFrames = 20 * 160;
        const heartbeats = 19 * 100;
        const bookends = 4 * 350;
        const answerRoundTrips = questions * 800;  // POST + response + headers

        const perPlayer =
            questions * questionFrame +
            questions * revealFrame +
            lobbyFrames + heartbeats + bookends +
            answerRoundTrips;

        return { perPlayer, perMatch: perPlayer * players };
    }
}

module.exports = new ChallengeArenaService();
module.exports.ANSWER_GRACE_MS = ANSWER_GRACE_MS;
module.exports.REVEAL_PAUSE_MS = REVEAL_PAUSE_MS;
module.exports.INITIATOR_GRACE_MS = INITIATOR_GRACE_MS;
module.exports.MAX_EXTENSIONS = MAX_EXTENSIONS;
module.exports.PRESENCE_COALESCE_MS = PRESENCE_COALESCE_MS;
