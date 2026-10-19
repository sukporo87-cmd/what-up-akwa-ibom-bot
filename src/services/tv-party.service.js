// ============================================
// FILE: src/services/tv-party.service.js
// WUT TV — the Party game: a TV is the board, phones are the controllers.
//
// ITS OWN ENGINE, WITH THE ARENA'S RULES. A Party player may have no account,
// and the live challenge arena is keyed by user id from end to end — its
// rounds, its scores, its participants and every table under it. So Party
// does not run inside the arena; it carries the arena's rules across
// unchanged, here, for players addressed by a room-scoped player id:
//
//   * the server keeps the clock — every answer is timed from askedAt, which
//     the server set; nothing a phone says about elapsed time is believed
//   * the correct answer never leaves the server before the reveal, and it is
//     not even held in the room state — it is read from questions at reveal
//   * one locked answer per question (a UNIQUE constraint, not just a check)
//   * no per-answer messages to the room: the TV gets a batched count
//   * 15 questions, 10 seconds each, 50:50 adds 5 seconds to the shared clock
//     once per question, no Skip
//   * an unanswered question costs the full clock, so stalling is never free
//   * ties break on total time; a result needs at least two finishers
//
// Same values as the arena today, kept as TV's own constants so a change to
// Challenge mode never silently changes Party, or the other way round.
//
// REUSED, READ-ONLY: question.service's challenge bank — the readiness report
// for the category list, and buildChallengeQuestionSet for the fifteen
// questions. Nothing in Challenge mode is called that writes.
//
// RESTARTS. Room state is in Redis (tv-room-store.service). Timers are not, so
// recover() runs at boot and re-arms every live room from the deadlines it
// stored: a question whose clock ran out during the restart is revealed at
// once; one still running gets the time it has left, never a fresh clock.
//
// TWO STYLES. 'standard' is the above. 'race' (fastest finger first) gives
// each question to the quickest correct answer:
//   * the answer buttons stay locked for RACE_LOCK_MS after the question
//     appears, so everyone starts together and nobody taps before reading
//   * the first correct answer ends the question — after a short settle
//     window, so a phone on a slow connection is judged fairly (below)
//   * a wrong answer costs a point in the game; winning a question earns
//     one. Only the winner of a question earns ledger points (10/20/30),
//     so leaderboard points stay positive
//   * no 50:50
// WHO WAS FASTEST is decided here, never by a phone. Each answer is timed by
// its arrival. Each phone's round trip is measured quietly through the game
// (the phone acknowledges every question the moment it arrives) and taken off
// its arrival time, capped at RACE_LAG_CAP_MS, so faking a slow connection
// gains at most the cap. Two answers closer than RACE_TIE_MS after that go to
// the one that physically arrived first. Close to fair; never perfect over
// mobile networks. To decide, the server reads the correct answer when the
// first answer of a Race question arrives; it is held in memory, never in the
// room state, and never sent anywhere before the reveal.
//
// ADMIN SETTINGS. The clock, the 50:50 bonus, the Race values, the room size
// and the rooms-per-hour limit can be changed on the TV admin page
// (tv-settings.service). The constants below are the defaults. A game takes
// its values when it STARTS (g.rules) and keeps them to the end, so a change
// never moves the clock under a game already running; a room takes its size
// when it opens. The Party categories an admin switches off are left out of
// the list the TV offers.
//
// PRIZES (phase 5) live in tv-prize.service. This engine only carries the
// prize on the room for the screens, refuses to start while its payment is
// still out, writes the places of a prize game that is ended early (so the
// leader can be paid), and asks tv-prize to settle the prize once a room has
// ended. It never decides who is paid.
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const tvAuth = require('./tv-auth.service');
const store = require('./tv-room-store.service');
const tvSettings = require('./tv-settings.service');
const tvNames = require('../utils/tv-names');
const QuestionService = require('./question.service');

const questionService = new QuestionService();

// ---- the rules (same values as the live arena) ----
const QUESTIONS_PER_ROUND = 15;
const QUESTION_MS = 10000;
const FIFTY_FIFTY_BONUS_MS = 5000;
const ANSWER_GRACE_MS = 1500;
const REVEAL_PAUSE_MS = 4000;
const MIN_FINISHERS = 2;
// 3, 2, 1, Go!: the first question appears this long after the host starts,
// at the same moment on the TV and every phone (goAt, in server time).
const COUNTDOWN_MS = 4000;

// ---- Race style ----
const STYLES = ['standard', 'race'];
const RACE_LOCK_MS = 2500;          // buttons locked while the question is read
const RACE_SETTLE_MS = 300;         // after the first correct answer, wait this long for faster-but-later ones
const RACE_LAG_CAP_MS = 250;        // the most a phone's measured delay can take off its time
const RACE_TIE_MS = 50;             // closer than this after adjustment is a tie: first to arrive wins
const RACE_LAG_SAMPLES = 5;         // the delay used is the median of the last few
const RACE_WIN = 1;                 // game score for taking a question
const RACE_WRONG = 1;               // game score lost for a wrong answer

// ---- the room ----
const MAX_PLAYERS = 20;
const MIN_PLAYERS_TO_START = 2;
const LOBBY_TTL_MS = 60 * 60 * 1000;
const PLAYING_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_CATEGORIES = 3;

// ---- traffic ----
// The TV's "4 of 6 answered" is coalesced, never sent per answer.
const ANSWER_COUNT_COALESCE_MS = 1000;
// Lobby changes go to every phone, so they are coalesced like arena presence.
const LOBBY_COALESCE_MS = 2000;
// "Away" means gone for longer than one full question.
const AWAY_AFTER_MS = QUESTION_MS + REVEAL_PAUSE_MS;

// ---- abuse ----
// A room code is six digits, so it can be guessed. These cap how fast.
const JOIN_LIMIT_PER_IP = 60;
const JOIN_MISS_LIMIT_PER_IP = 10;
const JOIN_LIMIT_PER_CODE = 80;
const JOIN_WINDOW_SECONDS = 600;
const ROOMS_PER_DEVICE_PER_HOUR = 30;
const REGISTRATIONS_PER_IP_PER_HOUR = 20;

const CATEGORY_CACHE_MS = 10 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;

const LETTERS = ['A', 'B', 'C', 'D'];

const pointsFor = n => (n <= 5 ? 10 : n <= 10 ? 20 : 30);

class TvPartyService {

    constructor() {
        // The countdown's length. The test suites shorten it with
        // WUT_TV_COUNTDOWN_MS; nothing sets that in production.
        const cd = Number(process.env.WUT_TV_COUNTDOWN_MS);
        this.countdownMs = Number.isFinite(cd) && cd >= 0 && cd <= 10000 ? cd : COUNTDOWN_MS;
        /** @type {Map<number, NodeJS.Timeout>} one game timer per room */
        this.timers = new Map();
        /** @type {Map<number, NodeJS.Timeout>} */
        this.countTimers = new Map();
        /** @type {Map<number, NodeJS.Timeout>} */
        this.lobbyTimers = new Map();
        this._readinessRows = null;
        this._categoriesAt = 0;
        this._sweep = null;
        /** @type {Map<number, Map<number, number[]>>} Race: each phone's measured round trips, by room */
        this.lag = new Map();
        /** @type {Map<number, {key: string, correct: string|null}>} Race: the current question's answer, never in room state */
        this.raceKeys = new Map();
    }

    // ============================================
    // RATE LIMITS
    // ============================================

    async _overLimit(key, limit, windowSeconds) {
        try {
            const n = await redis.incr(key);
            if (n === 1) await redis.expire(key, windowSeconds);
            return n > limit;
        } catch (e) {
            // Redis down: let people play. The limits slow guessing; they are
            // not what keeps a room's state safe.
            return false;
        }
    }

    async _isLimited(key, limit) {
        try { return (parseInt(await redis.get(key), 10) || 0) >= limit; } catch (e) { return false; }
    }

    registrationAllowed(ip) {
        return this._overLimit(`tv_rate:register:${ip || 'unknown'}`, REGISTRATIONS_PER_IP_PER_HOUR, 3600)
            .then(over => !over);
    }

    // ============================================
    // CATEGORIES
    // ============================================
    // The ones the challenge bank can actually fill. A category that cannot
    // build a fifteen-question ladder would fail at Start, in front of a room.

    async _readiness() {
        if (this._readinessRows && Date.now() - this._categoriesAt < CATEGORY_CACHE_MS) return this._readinessRows;
        this._readinessRows = await questionService.getChallengeBankReadiness();
        this._categoriesAt = Date.now();
        return this._readinessRows;
    }

    /** The categories the TV offers: ones the bank can fill, less any an admin switched off. */
    async getCategories() {
        const readiness = await this._readiness();
        const off = new Set((await tvSettings.values())['party.categories_off']);
        return readiness.filter(r => r.ready && !off.has(r.category)).map(r => r.category).sort();
    }

    /** Every category the bank holds, ready or not, for the admin page. Never cached stale after a change. */
    async categoryReport() {
        this._readinessRows = null;
        const readiness = await this._readiness();
        const off = new Set((await tvSettings.values())['party.categories_off']);
        return readiness.map(r => ({ ...r, on: !off.has(r.category) }))
            .sort((a, b) => String(a.category).localeCompare(String(b.category)));
    }

    // ============================================
    // VIEWS
    // ============================================
    // What each audience is allowed to see. Built here and nowhere else, so
    // there is one place to check that nothing leaks.

    _active(p) { return !!p && !p.leftAt && !p.removedAt; }

    _activeIds(state) {
        return (state.order || []).filter(pid => this._active(state.players[pid]));
    }

    _isAway(state, pid) {
        const p = state.players[pid];
        if (!this._active(p)) return false;
        return store.playerGoneFor(state.id, pid) > AWAY_AFTER_MS;
    }

    _publicPlayer(state, pid) {
        const p = state.players[pid];
        return {
            id: p.id,
            name: p.name,
            avatar: p.avatar,
            colour: p.colour,
            signedIn: !!p.userId,
            host: state.hostPlayerId === p.id,
            left: !!p.leftAt,
            removed: !!p.removedAt,
            away: this._isAway(state, pid)
        };
    }

    _roster(state) {
        return (state.order || []).filter(pid => !state.players[pid].removedAt)
            .map(pid => this._publicPlayer(state, pid));
    }

    _awayIds(state) {
        return this._activeIds(state).filter(pid => this._isAway(state, pid));
    }

    joinUrl(code) {
        const base = process.env.WEB_PLAY_URL || 'https://play.whatsuptrivia.com.ng';
        return `${base}/p/${code}`;
    }

    tvSnapshot(state) {
        const g = state.game;
        return {
            room: {
                id: state.id,
                code: state.code,
                joinUrl: this.joinUrl(state.code),
                status: state.status,
                closeReason: state.closeReason || null,
                hostPlayerId: state.hostPlayerId || null,
                categories: state.categories || [],
                style: state.style || 'standard',
                maxPlayers: state.maxPlayers,
                playerCount: this._activeIds(state).length,
                players: this._roster(state),
                prize: state.prize || null
            },
            game: g ? {
                style: g.style || 'standard',
                phase: g.phase,
                position: g.position,
                total: QUESTIONS_PER_ROUND,
                expiresAt: g.phase === 'question' ? g.expiresAt : null,
                opensAt: g.phase === 'question' ? (g.opensAt || null) : null,
                goAt: g.phase === 'starting' ? (g.goAt || null) : null,
                // Question text and options only while it is being asked or
                // revealed. Never the correct answer before the reveal.
                question: (g.phase === 'question' || g.phase === 'reveal') ? g.question : null,
                answered: g.phase === 'question' ? Object.keys(g.locked || {}).length : null,
                of: (g.enrolled || []).filter(pid => this._active(state.players[pid])).length,
                reveal: g.phase === 'reveal' ? g.lastReveal || null : null,
                board: g.board || [],
                final: g.final || null
            } : null
        };
    }

    playerSnapshot(state, pid) {
        const g = state.game;
        const p = state.players[pid];
        const enrolled = !!(g && (g.enrolled || []).includes(pid));
        const lock = g && g.locked ? g.locked[pid] : null;
        const fifty = g && g.fifty ? g.fifty[pid] : null;
        return {
            room: {
                id: state.id,
                code: state.code,
                status: state.status,
                closeReason: state.closeReason || null,
                hostPlayerId: state.hostPlayerId || null,
                youAreHost: state.hostPlayerId === pid,
                hostFree: !this._hostActive(state),
                categories: state.categories || [],
                style: state.style || 'standard',
                playerCount: this._activeIds(state).length,
                maxPlayers: state.maxPlayers,
                prize: state.prize || null,
                // The countdown to the first question, for the phone to show.
                ...(g && g.phase === 'starting' && g.goAt ? { goAt: g.goAt } : {}),
                // While the room is open, each phone can change its avatar,
                // so it is told which ones are already taken.
                ...(state.status === 'lobby' ? {
                    avatars: tvNames.AVATARS,
                    takenAvatars: this._activeIds(state).filter(x => x !== pid).map(x => state.players[x].avatar)
                } : {}),
                // The host runs the room from their phone, so they see who is
                // in it — the same names the TV is already showing everyone.
                ...(state.hostPlayerId === pid ? {
                    players: this._activeIds(state).map(x => {
                        const v = this._publicPlayer(state, x);
                        return { id: v.id, name: v.name, avatar: v.avatar, colour: v.colour, host: v.host, away: v.away };
                    })
                } : {})
            },
            me: this._publicPlayer(state, pid),
            game: g && enrolled ? {
                style: g.style || 'standard',
                phase: g.phase,
                position: g.position,
                total: QUESTIONS_PER_ROUND,
                expiresAt: g.phase === 'question' ? g.expiresAt : null,
                opensAt: g.phase === 'question' ? (g.opensAt || null) : null,
                letters: g.phase === 'question' ? this._lettersFor(g, pid) : null,
                locked: g.phase === 'question' && lock ? lock.chosen : null,
                fiftyFiftyAvailable: g.style !== 'race' && !fifty,
                lastResult: (g.results && g.results[pid]) || null,
                final: (g.finalByPlayer && g.finalByPlayer[pid]) || null
            } : null,
            spectating: !!(g && !enrolled)
        };
    }

    _lettersFor(g, pid) {
        const f = g.fifty && g.fifty[pid];
        return f && f.position === g.position ? f.keep : LETTERS;
    }

    _hostActive(state) {
        return !!(state.hostPlayerId && this._active(state.players[state.hostPlayerId]));
    }

    // Lobby changes are coalesced so twenty phones are not each sent a frame
    // per arrival. The TV is told about every arrival at once: there is one.
    _scheduleLobbyUpdate(roomId) {
        if (this.lobbyTimers.has(roomId)) return;
        const t = setTimeout(() => {
            this.lobbyTimers.delete(roomId);
            store.withRoom(roomId, (state, tx) => {
                if (!state || state.status === 'closed') return;
                for (const pid of this._activeIds(state)) {
                    tx.player(pid, 'player.room', this.playerSnapshot(state, pid).room);
                }
            }).catch(e => logger.error(`TV room ${roomId}: lobby update failed — ${e.message}`));
        }, LOBBY_COALESCE_MS);
        if (t.unref) t.unref();
        this.lobbyTimers.set(roomId, t);
    }

    // ============================================
    // ROOMS
    // ============================================

    async _liveRoomForDevice(deviceId) {
        const r = await pool.query(
            `SELECT id FROM tv_rooms WHERE tv_device_id = $1 AND status IN ('lobby','playing')
             ORDER BY created_at DESC LIMIT 1`,
            [deviceId]
        );
        return r.rows[0] ? r.rows[0].id : null;
    }

    _newCode() {
        return String(require('crypto').randomInt(100000, 1000000));
    }

    /**
     * A TV opens a Party room. A TV that already has a live room gets that
     * room back — a room belongs to the TV, not to the connection — unless
     * it asks for a fresh one, which closes the old room first.
     */
    async openRoom(device, { fresh = false } = {}) {
        await tvAuth.ensureSchema();

        const existing = await this._liveRoomForDevice(device.id);
        if (existing && !fresh) {
            const state = await this._loadOrRebuild(existing);
            if (state) {
                return {
                    ok: true, resumed: true, roomId: state.id, joinCode: state.code,
                    joinUrl: this.joinUrl(state.code), status: state.status, maxPlayers: state.maxPlayers
                };
            }
        }
        if (existing) await this.closeRoom(existing, 'replaced');

        const settings = await tvSettings.values();
        const maxPlayers = settings['rooms.max_players'];
        if (await this._overLimit(`tv_rate:rooms:${device.id}`, settings['rooms.per_tv_per_hour'], 3600)) {
            return { ok: false, reason: 'too_many_rooms' };
        }

        let row = null;
        for (let attempt = 0; attempt < 6 && !row; attempt++) {
            try {
                const r = await pool.query(
                    `INSERT INTO tv_rooms (tv_device_id, join_code, max_players, expires_at)
                     VALUES ($1, $2, $3, NOW() + INTERVAL '60 minutes')
                     RETURNING id, join_code, created_at, expires_at`,
                    [device.id, this._newCode(), maxPlayers]
                );
                row = r.rows[0];
            } catch (e) {
                // 23505: that code is in use by a live room. Pick another.
                if (e.code !== '23505') throw e;
            }
        }
        if (!row) return { ok: false, reason: 'no_code_available' };

        const now = Date.now();
        await store.create({
            id: row.id,
            deviceId: device.id,
            code: row.join_code,
            status: 'lobby',
            closeReason: null,
            hostPlayerId: null,
            maxPlayers,
            categories: [],
            style: 'standard',
            createdAt: now,
            expiresAt: now + LOBBY_TTL_MS,
            players: {},
            order: [],
            game: null
        });

        logger.info(`📺 TV ${device.id} opened room ${row.id} (code ${row.join_code})`);
        return {
            ok: true, resumed: false, roomId: row.id, joinCode: row.join_code,
            joinUrl: this.joinUrl(row.join_code), status: 'lobby', maxPlayers
        };
    }

    /**
     * Redis lost a LOBBY room (eviction, a flush): rebuild it from the record.
     * A room that was mid-game cannot be rebuilt honestly — the clock and the
     * locked answers lived in Redis — so it is closed rather than guessed at.
     */
    async _loadOrRebuild(roomId) {
        const state = await store.load(roomId);
        if (state) return state;

        const r = await pool.query(`SELECT * FROM tv_rooms WHERE id = $1`, [roomId]);
        const room = r.rows[0];
        if (!room || !['lobby', 'playing'].includes(room.status)) return null;
        if (room.status === 'playing') {
            await this._closeInDb(roomId, 'state_lost');
            logger.error(`TV room ${roomId}: live state lost mid-game — closed`);
            // No places can be written honestly: a paid prize goes back.
            this._settlePrize(roomId);
            return null;
        }

        const players = await pool.query(
            `SELECT * FROM tv_players WHERE tv_room_id = $1 ORDER BY id`, [roomId]
        );
        const rebuilt = {
            id: room.id,
            deviceId: room.tv_device_id,
            code: room.join_code,
            status: 'lobby',
            closeReason: null,
            hostPlayerId: room.host_player_id || null,
            maxPlayers: room.max_players,
            categories: room.categories || [],
            style: STYLES.includes(room.style) ? room.style : 'standard',
            createdAt: new Date(room.created_at).getTime(),
            expiresAt: new Date(room.expires_at).getTime(),
            players: {},
            order: [],
            game: null,
            rev: 0,
            tvLogCount: 0
        };
        for (const p of players.rows) {
            rebuilt.players[p.id] = {
                id: p.id, name: p.display_name, key: p.name_key, avatar: p.avatar, colour: p.colour,
                userId: p.user_id || null, tokenHash: p.phone_token_hash, phoneRefHash: p.phone_ref_hash || null,
                joinedAt: new Date(p.joined_at).getTime(),
                leftAt: p.left_at ? new Date(p.left_at).getTime() : null,
                removedAt: p.removed_at ? new Date(p.removed_at).getTime() : null,
                logCount: 0
            };
            rebuilt.order.push(p.id);
        }
        // The room's prize, if one has been added and not taken off.
        try {
            const pr = await pool.query(
                `SELECT * FROM tv_prizes WHERE tv_room_id = $1 AND status IN ('pending','settled')`, [roomId]
            );
            if (pr.rows[0]) rebuilt.prize = require('./tv-prize.service').view(pr.rows[0]);
        } catch (e) { logger.error(`TV room ${roomId}: prize not read on rebuild — ${e.message}`); }
        // rev restarts above anything a screen could have seen: the old
        // numbers are gone with the old log, so every reconnect gets a snapshot.
        rebuilt.rev = Date.now();
        await store.create(rebuilt);
        logger.warn(`TV room ${roomId}: lobby rebuilt from the database`);
        return rebuilt;
    }

    async _closeInDb(roomId, reason) {
        await pool.query(
            `UPDATE tv_rooms SET status = 'closed', close_reason = $2, finished_at = COALESCE(finished_at, NOW())
             WHERE id = $1 AND status IN ('lobby','playing')`,
            [roomId, reason]
        );
    }

    async closeRoom(roomId, reason) {
        const id = Number(roomId);
        let hadPrize = false;
        const out = await store.withRoom(id, async (state, tx) => {
            if (!state) {
                await this._closeInDb(id, reason);
                hadPrize = true; // unknown without the state: let tv-prize look
                return { ok: true };
            }
            if (state.status === 'closed' || state.status === 'finished') return { ok: true, already: true };

            // A prize game ended after it started: its places are written as
            // they stand, so the prize goes to whoever is ahead rather than
            // back to the host (tv-prize.resolveRoom).
            const g = state.game;
            if (state.status === 'playing' && g && state.prize && state.prize.status === 'settled') {
                const revealed = g.phase === 'reveal' ? g.position : Math.max(0, (g.position || 0) - 1);
                if (revealed >= 1) await this._writePlaces(await this._board(state));
            }
            hadPrize = !!(state.prize && state.prize.status === 'settled');
            state.status = 'closed';
            state.closeReason = reason;
            if (state.game) state.game.phase = 'closed';
            await this._closeInDb(id, reason);

            tx.tv('room.closed', { reason });
            for (const pid of this._activeIds(state)) tx.player(pid, 'room.closed', { reason });
            tx.after.push(async () => store.closeRoomStreams(id));
            return { ok: true };
        });
        this._clearTimers(id);
        if (hadPrize) this._settlePrize(id);
        logger.info(`📺 TV room ${id} closed (${reason})`);
        return out;
    }

    /** Asks tv-prize to settle a room's prize, outside the room's queue. */
    _settlePrize(roomId) {
        this._queue(roomId, () => require('./tv-prize.service').resolveRoom(roomId));
    }

    async _writePlaces(board) {
        if (!board.length) return;
        const values = board.map((b, i) => `($${i * 4 + 1}::int, $${i * 4 + 2}::smallint, $${i * 4 + 3}::int, $${i * 4 + 4}::smallint)`).join(', ');
        const params = [];
        for (const b of board) params.push(b.id, b.c, b.t, b.rank);
        await pool.query(
            `UPDATE tv_players p SET final_correct = v.c, final_total_ms = v.t, final_rank = v.r
             FROM (VALUES ${values}) AS v(id, c, t, r) WHERE p.id = v.id`,
            params
        );
    }

    /**
     * A guest in the lobby switches to the account signed in on their phone
     * (phase 5: only signed-in players can win a prize). Same player, same
     * avatar; the name becomes the username.
     */
    async useAccount(roomId, pid, account) {
        return store.withRoom(roomId, async (state, tx) => {
            if (!state || state.status !== 'lobby') return { ok: false, reason: 'not_in_lobby' };
            const me = state.players[pid];
            if (!this._active(me)) return { ok: false, reason: 'not_in_room' };
            if (me.userId === account.id) return { ok: true, already: true, player: this._publicPlayer(state, pid) };
            if (me.userId) return { ok: false, reason: 'already_signed_in' };
            if (Object.values(state.players).some(x => x.userId === account.id && !x.removedAt)) {
                return { ok: false, reason: 'account_in_room' };
            }
            let name = tvNames.accountName(account.username);
            const takenKeys = Object.values(state.players).filter(x => x.id !== pid).map(x => x.key);
            if (takenKeys.includes(tvNames.nameKey(name))) name = tvNames.numberedName(name, takenKeys);
            if (!name) return { ok: false, reason: 'name_taken' };
            try {
                await pool.query(
                    `UPDATE tv_players SET user_id = $2, display_name = $3, name_key = $4 WHERE id = $1`,
                    [pid, account.id, name, tvNames.nameKey(name)]
                );
            } catch (e) {
                if (e.code === '23505') return { ok: false, reason: 'account_in_room' };
                throw e;
            }
            me.userId = account.id;
            me.name = name;
            me.key = tvNames.nameKey(name);
            tx.dirty = true;
            tx.tv('room.player_updated', { player: this._publicPlayer(state, pid) });
            tx.player(pid, 'player.snapshot', this.playerSnapshot(state, pid));
            this._scheduleLobbyUpdate(state.id);
            return { ok: true, player: this._publicPlayer(state, pid) };
        });
    }

    // ============================================
    // AUTHENTICATING A PLAYER
    // ============================================
    // The token names its room and its player. It is checked against the
    // hash held for exactly that player in exactly that room, so a token can
    // never be used to read or act as anybody else.

    async authenticatePlayer(token, roomId) {
        const parsed = tvAuth.parsePlayerToken(token);
        if (!parsed) return { ok: false, reason: 'no_player_token' };
        if (parsed.roomId !== Number(roomId)) return { ok: false, reason: 'wrong_room' };

        const state = await this._loadOrRebuild(parsed.roomId);
        if (!state) return { ok: false, reason: 'no_room' };
        const p = state.players[parsed.playerId];
        if (!p || !tvAuth.sameHash(p.tokenHash, tvAuth.hash(token))) return { ok: false, reason: 'bad_player_token' };
        if (p.removedAt) return { ok: false, reason: 'removed' };
        return { ok: true, playerId: p.id, state };
    }

    // ============================================
    // REVIEW (batch 3) — a player's own answers, on their phone, after the game
    // ============================================
    // Each question that was asked, the answer this player gave, the right
    // answer, how many got it, and the points it earned them. Read from the
    // database, not the room state, so it still works once the TV has closed
    // the room and Redis has let it go.
    //
    // ONLY ONCE THE GAME IS OVER, AND ONLY YOUR OWN. A room in the lobby or
    // still playing is refused, so this can never show a right answer early.
    // The player token decides whose answers; there is no player id to ask
    // for, and nobody else's choices are sent (only how many were right).

    async review(roomId, playerToken) {
        const parsed = tvAuth.parsePlayerToken(playerToken);
        if (!parsed) return { ok: false, reason: 'no_player_token' };
        if (parsed.roomId !== Number(roomId)) return { ok: false, reason: 'wrong_room' };
        await tvAuth.ensureSchema();

        const pr = await pool.query(
            `SELECT p.id, p.phone_token_hash, p.removed_at, r.status, r.style
             FROM tv_players p JOIN tv_rooms r ON r.id = p.tv_room_id
             WHERE p.id = $1 AND p.tv_room_id = $2`,
            [parsed.playerId, parsed.roomId]
        );
        const p = pr.rows[0];
        if (!p || !tvAuth.sameHash(p.phone_token_hash, tvAuth.hash(playerToken))) return { ok: false, reason: 'bad_player_token' };
        if (p.removed_at) return { ok: false, reason: 'removed' };
        if (p.status === 'lobby' || p.status === 'playing') return { ok: false, reason: 'not_finished' };

        const slots = await pool.query(
            `SELECT position, question_id FROM tv_room_questions WHERE tv_room_id = $1 ORDER BY position`,
            [parsed.roomId]
        );
        const answers = await pool.query(
            `SELECT tv_player_id, position, chosen, is_correct, answer_ms, won, lag_ms
             FROM tv_answers WHERE tv_room_id = $1 ORDER BY position, answer_ms`,
            [parsed.roomId]
        );
        // A question counts as asked once anyone has an answer row for it:
        // every player gets one per question, a timeout included.
        const asked = new Set(answers.rows.map(a => Number(a.position)));
        const shown = slots.rows.filter(x => asked.has(Number(x.position)));
        const bank = new Map();
        if (shown.length) {
            const q = await pool.query(
                `SELECT id, question_text, option_a, option_b, option_c, option_d, correct_answer, category, difficulty, fun_fact
                 FROM questions WHERE id = ANY($1::int[])`,
                [shown.map(x => Number(x.question_id))]
            );
            for (const row of q.rows) bank.set(Number(row.id), row);
        }
        const pts = await pool.query(
            `SELECT question_number, points FROM tv_points WHERE tv_player_id = $1`, [p.id]
        );
        const pointsAt = new Map(pts.rows.map(x => [Number(x.question_number), Number(x.points)]));

        const steps = shown.map(x => {
            const pos = Number(x.position);
            const q = bank.get(Number(x.question_id)) || {};
            const c = String(q.correct_answer || '').trim().toUpperCase();
            const here = answers.rows.filter(a => Number(a.position) === pos);
            const mine = here.find(a => a.tv_player_id === p.id) || null;
            return {
                position: pos,
                text: q.question_text || null,
                options: { A: q.option_a || '', B: q.option_b || '', C: q.option_c || '', D: q.option_d || '' },
                correct: LETTERS.includes(c) ? c : null,
                category: q.category || null,
                // The fun fact, as web play shows it after a question (Oct 19).
                funFact: q.fun_fact || null,
                chosen: mine && LETTERS.includes(mine.chosen) ? mine.chosen : null,
                right: !!(mine && mine.is_correct === true),
                ms: mine ? Number(mine.answer_ms) || 0 : null,
                won: mine ? mine.won === true : false,
                gotIt: here.filter(a => a.is_correct === true).length,
                of: here.length,
                points: pointsAt.get(pos) || 0
            };
        });
        return { ok: true, review: { roomId: parsed.roomId, style: p.style || 'standard', steps } };
    }

    // ============================================
    // JOIN
    // ============================================

    /**
     * @param code      six digits from the QR link or typed on the phone
     * @param input     { name, allowNumber }
     * @param ctx       { ip, playerToken, phoneRef, account }  account = signed-in user row or null
     */
    async join(code, input = {}, ctx = {}) {
        await tvAuth.ensureSchema();
        const ip = ctx.ip || 'unknown';

        if (await this._isLimited(`tv_rate:miss:${ip}`, JOIN_MISS_LIMIT_PER_IP)) {
            return { ok: false, status: 429, reason: 'too_many_attempts' };
        }
        if (await this._overLimit(`tv_rate:join:${ip}`, JOIN_LIMIT_PER_IP, JOIN_WINDOW_SECONDS)) {
            return { ok: false, status: 429, reason: 'too_many_attempts' };
        }
        if (!/^\d{6}$/.test(String(code || ''))) {
            await this._overLimit(`tv_rate:miss:${ip}`, JOIN_MISS_LIMIT_PER_IP, JOIN_WINDOW_SECONDS);
            return { ok: false, status: 404, reason: 'no_room' };
        }

        const found = await pool.query(
            `SELECT id FROM tv_rooms WHERE join_code = $1 AND status IN ('lobby','playing')`,
            [String(code)]
        );
        if (!found.rows[0]) {
            await this._overLimit(`tv_rate:miss:${ip}`, JOIN_MISS_LIMIT_PER_IP, JOIN_WINDOW_SECONDS);
            return { ok: false, status: 404, reason: 'no_room' };
        }
        const roomId = found.rows[0].id;

        if (await this._overLimit(`tv_rate:code:${code}`, JOIN_LIMIT_PER_CODE, JOIN_WINDOW_SECONDS)) {
            return { ok: false, status: 429, reason: 'too_many_attempts' };
        }

        const live = await this._loadOrRebuild(roomId);
        if (!live) return { ok: false, status: 404, reason: 'no_room' };

        const phoneRef = ctx.phoneRef || null;
        const phoneRefHash = phoneRef ? tvAuth.hash(phoneRef) : null;
        const tokenHash = ctx.playerToken ? tvAuth.hash(ctx.playerToken) : null;
        const parsedToken = ctx.playerToken ? tvAuth.parsePlayerToken(ctx.playerToken) : null;

        const result = await store.withRoom(roomId, async (state, tx) => {
            if (!state) return { ok: false, status: 404, reason: 'no_room' };
            if (state.status !== 'lobby' && state.status !== 'playing') {
                return { ok: false, status: 410, reason: 'room_closed' };
            }

            // 1. The same phone, still holding its token: nothing to do.
            if (parsedToken && parsedToken.roomId === state.id) {
                const p = state.players[parsedToken.playerId];
                if (p && tvAuth.sameHash(p.tokenHash, tokenHash)) {
                    if (p.removedAt) return { ok: false, status: 403, reason: 'removed' };
                    if (!p.leftAt) {
                        return { ok: true, rejoined: true, player: this._publicPlayer(state, p.id),
                                 playerId: p.id, token: ctx.playerToken, roomId: state.id };
                    }
                }
            }

            // 2. The same phone, token lost (cleared storage, new tab), or the
            //    same account on another phone, or a player who left and came
            //    back: the same player, new token.
            let existing = null;
            if (parsedToken && parsedToken.roomId === state.id) {
                const p = state.players[parsedToken.playerId];
                if (p && tvAuth.sameHash(p.tokenHash, tokenHash)) existing = p;
            }
            if (!existing && ctx.account) {
                existing = Object.values(state.players).find(x => x.userId === ctx.account.id) || null;
            }
            if (!existing && phoneRefHash) {
                existing = Object.values(state.players).find(x => x.phoneRefHash === phoneRefHash) || null;
            }
            if (existing) {
                if (existing.removedAt) return { ok: false, status: 403, reason: 'removed' };
                const enrolled = state.game && (state.game.enrolled || []).includes(existing.id);
                if (existing.leftAt && state.status !== 'lobby' && !enrolled) {
                    return { ok: false, status: 409, reason: 'already_started' };
                }
                if (existing.leftAt && state.status === 'lobby' &&
                    this._activeIds(state).length >= state.maxPlayers) {
                    return { ok: false, status: 409, reason: 'room_full' };
                }
                const minted = tvAuth.mintPlayerToken(state.id, existing.id);
                const wasLeft = !!existing.leftAt;
                existing.tokenHash = minted.hash;
                existing.leftAt = null;
                if (phoneRefHash) existing.phoneRefHash = phoneRefHash;
                await pool.query(
                    `UPDATE tv_players SET phone_token_hash = $2, left_at = NULL,
                            phone_ref_hash = COALESCE($3, phone_ref_hash)
                     WHERE id = $1`,
                    [existing.id, minted.hash, phoneRefHash]
                );
                tx.dirty = true;
                if (wasLeft) {
                    tx.tv('room.player_joined', { player: this._publicPlayer(state, existing.id), returning: true });
                    this._scheduleLobbyUpdate(state.id);
                }
                return { ok: true, rejoined: true, player: this._publicPlayer(state, existing.id),
                         playerId: existing.id, token: minted.token, roomId: state.id };
            }

            // 3. Somebody new.
            if (state.status !== 'lobby') return { ok: false, status: 409, reason: 'already_started' };
            if (this._activeIds(state).length >= state.maxPlayers) {
                return { ok: false, status: 409, reason: 'room_full' };
            }

            let name;
            if (ctx.account) {
                // A signed-in player is shown by their web username. It was
                // checked against the web rule (letters, digits, underscore)
                // when it was made, so it is NOT put through the guest-name
                // rule, which refuses digits and underscores and would turn
                // most real usernames into "Player". It still passes the
                // abuse filter, because it is going on a public screen.
                name = tvNames.accountName(ctx.account.username);
            } else {
                const v = tvNames.validateName(input.name);
                if (!v.ok) return { ok: false, status: 400, reason: v.reason };
                name = v.name;
            }

            const takenKeys = Object.values(state.players).map(x => x.key);
            if (takenKeys.includes(tvNames.nameKey(name))) {
                // A guest can add an initial. An account's name is its
                // username, so a clash is numbered at once rather than
                // offered an initial that would only make them a guest.
                if (!input.allowNumber && !ctx.account) {
                    // Offer an initial first. Only a player who declines it
                    // gets a number.
                    return {
                        ok: false, status: 409, reason: 'name_taken', name,
                        suggestions: { withInitial: `${name} _.`, numbered: tvNames.numberedName(name, takenKeys) }
                    };
                }
                name = tvNames.numberedName(name, takenKeys);
                if (!name) return { ok: false, status: 409, reason: 'name_taken' };
            }

            const look = tvNames.assignLook(this._activeIds(state).map(pid => state.players[pid]));
            const idRow = await pool.query(`SELECT nextval(pg_get_serial_sequence('tv_players','id')) AS id`);
            const playerId = Number(idRow.rows[0].id);
            const minted = tvAuth.mintPlayerToken(state.id, playerId);

            await pool.query(
                `INSERT INTO tv_players (id, tv_room_id, user_id, display_name, name_key, avatar, colour,
                                         phone_token_hash, phone_ref_hash, join_ip)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [playerId, state.id, ctx.account ? ctx.account.id : null, name, tvNames.nameKey(name),
                 look.avatar, look.colour, minted.hash, phoneRefHash, tvAuth._inet(ctx.ip)]
            );

            state.players[playerId] = {
                id: playerId, name, key: tvNames.nameKey(name), avatar: look.avatar, colour: look.colour,
                userId: ctx.account ? ctx.account.id : null, tokenHash: minted.hash, phoneRefHash,
                joinedAt: Date.now(), leftAt: null, removedAt: null, logCount: 0
            };
            state.order.push(playerId);

            tx.tv('room.player_joined', { player: this._publicPlayer(state, playerId),
                                          playerCount: this._activeIds(state).length });
            this._scheduleLobbyUpdate(state.id);

            return { ok: true, rejoined: false, player: this._publicPlayer(state, playerId),
                     playerId, token: minted.token, roomId: state.id };
        });

        return result;
    }

    // ============================================
    // LOBBY ACTIONS
    // ============================================

    async takeHost(roomId, pid) {
        return store.withRoom(roomId, async (state, tx) => {
            if (!state || state.status === 'closed' || state.status === 'finished') {
                return { ok: false, reason: 'room_closed' };
            }
            if (state.hostPlayerId === pid) return { ok: true, already: true };
            if (this._hostActive(state)) return { ok: false, reason: 'host_taken' };

            state.hostPlayerId = pid;
            await pool.query(`UPDATE tv_rooms SET host_player_id = $2 WHERE id = $1`, [state.id, pid]);
            tx.tv('room.host_changed', { hostPlayerId: pid });
            // The new host's phone switches to the host screen now, not at the
            // next coalesced lobby update.
            tx.player(pid, 'player.room', this.playerSnapshot(state, pid).room);
            this._scheduleLobbyUpdate(state.id);
            return { ok: true };
        });
    }

    /**
     * A player picks their own avatar, in the lobby. Anyone who skips keeps
     * the one they were given on joining. Two phones reaching for the same
     * one at once are settled here, one change at a time: the second is told
     * it has gone.
     */
    async setAvatar(roomId, pid, avatar) {
        if (!tvNames.isAvatar(avatar)) return { ok: false, reason: 'bad_avatar' };
        return store.withRoom(roomId, async (state, tx) => {
            if (!state || state.status !== 'lobby') return { ok: false, reason: 'not_in_lobby' };
            const me = state.players[pid];
            if (!this._active(me)) return { ok: false, reason: 'not_in_room' };
            if (me.avatar === avatar) return { ok: true, avatar };
            const taken = this._activeIds(state).some(x => x !== pid && state.players[x].avatar === avatar);
            if (taken) return { ok: false, reason: 'avatar_taken' };

            me.avatar = avatar;
            await pool.query(`UPDATE tv_players SET avatar = $2 WHERE id = $1`, [pid, avatar]);
            tx.tv('room.player_updated', { player: this._publicPlayer(state, pid) });
            this._scheduleLobbyUpdate(state.id);
            return { ok: true, avatar };
        });
    }

    /** Categories are picked on the TV, by whoever holds the remote, or by the host. */
    async setCategories(roomId, actor, categories) {
        const wanted = [...new Set((Array.isArray(categories) ? categories : [])
            .map(c => String(c || '').trim().toLowerCase()).filter(Boolean))];
        if (wanted.length < 1 || wanted.length > MAX_CATEGORIES) return { ok: false, reason: 'pick_one_to_three' };

        const available = await this.getCategories();
        if (!wanted.every(c => available.includes(c))) return { ok: false, reason: 'unknown_category' };

        return store.withRoom(roomId, async (state, tx) => {
            if (!state || state.status !== 'lobby') return { ok: false, reason: 'not_in_lobby' };
            if (actor.playerId && state.hostPlayerId !== actor.playerId) return { ok: false, reason: 'not_host' };

            state.categories = wanted;
            await pool.query(`UPDATE tv_rooms SET categories = $2 WHERE id = $1`, [state.id, wanted]);
            tx.tv('room.categories_set', { categories: wanted });
            this._scheduleLobbyUpdate(state.id);
            return { ok: true, categories: wanted };
        });
    }

    /** Standard or Race, chosen in the lobby on the TV (or by the host). Fixed at Start. */
    async setStyle(roomId, actor, style) {
        const wanted = String(style || '').trim().toLowerCase();
        if (!STYLES.includes(wanted)) return { ok: false, reason: 'bad_style' };
        return store.withRoom(roomId, async (state, tx) => {
            if (!state || state.status !== 'lobby') return { ok: false, reason: 'not_in_lobby' };
            if (actor.playerId && state.hostPlayerId !== actor.playerId) return { ok: false, reason: 'not_host' };
            if (state.style === wanted) return { ok: true, style: wanted };

            state.style = wanted;
            await pool.query(`UPDATE tv_rooms SET style = $2 WHERE id = $1`, [state.id, wanted]);
            tx.tv('room.style_set', { style: wanted });
            this._scheduleLobbyUpdate(state.id);
            return { ok: true, style: wanted };
        });
    }

    async leave(roomId, pid) {
        const out = await store.withRoom(roomId, async (state, tx) => {
            if (!state) return { ok: false, reason: 'no_room' };
            const p = state.players[pid];
            if (!this._active(p)) return { ok: true, already: true };

            p.leftAt = Date.now();
            await pool.query(`UPDATE tv_players SET left_at = NOW() WHERE id = $1`, [pid]);
            tx.dirty = true;
            tx.tv('room.player_left', { playerId: pid, reason: 'left', playerCount: this._activeIds(state).length });
            if (state.hostPlayerId === pid) {
                state.hostPlayerId = null;
                await pool.query(`UPDATE tv_rooms SET host_player_id = NULL WHERE id = $1`, [state.id]);
                tx.tv('room.host_changed', { hostPlayerId: null });
            }
            this._scheduleLobbyUpdate(state.id);
            return { ok: true, emptyMatch: this._noActiveEnrolled(state), allIn: this._allLocked(state) };
        });
        this._afterDeparture(roomId, out);
        return out;
    }

    /** The host removes a player. A removed phone cannot rejoin this room. */
    async removePlayer(roomId, hostPid, targetPid) {
        const out = await store.withRoom(roomId, async (state, tx) => {
            if (!state || state.status === 'closed' || state.status === 'finished') {
                return { ok: false, reason: 'room_closed' };
            }
            if (state.hostPlayerId !== hostPid) return { ok: false, reason: 'not_host' };
            if (targetPid === hostPid) return { ok: false, reason: 'cannot_remove_self' };
            const target = state.players[targetPid];
            if (!target || target.removedAt) return { ok: false, reason: 'no_such_player' };

            target.removedAt = Date.now();
            await pool.query(`UPDATE tv_players SET removed_at = NOW() WHERE id = $1`, [targetPid]);
            tx.player(targetPid, 'player.removed', {});
            tx.tv('room.player_left', { playerId: targetPid, reason: 'removed',
                                        playerCount: this._activeIds(state).length });
            tx.after.push(async () => store.closePlayerStreams(state.id, targetPid));
            this._scheduleLobbyUpdate(state.id);
            return { ok: true, emptyMatch: this._noActiveEnrolled(state), allIn: this._allLocked(state) };
        });
        this._afterDeparture(roomId, out);
        return out;
    }

    // Somebody went. If nobody is left playing, the game ends; if everyone
    // still playing has already locked in, the reveal need not wait for the
    // one who left.
    _afterDeparture(roomId, out) {
        if (!out || !out.ok) return;
        if (out.emptyMatch) {
            this._queue(roomId, async () => {
                const state = await store.load(roomId);
                const g = state && state.game;
                if (g && g.phase === 'question') await this._reveal(roomId, 'everyone_left');
                await this._finish(roomId);
            });
        } else if (out.allIn) {
            this._cancelCount(Number(roomId));
            this._queue(roomId, () => this._reveal(roomId, 'all_locked'));
        }
    }

    _allLocked(state) {
        if (state.status !== 'playing' || !state.game || state.game.phase !== 'question') return false;
        const playing = state.game.enrolled.filter(pid => this._active(state.players[pid]));
        return playing.length > 0 && playing.every(pid => state.game.locked[pid]);
    }

    _noActiveEnrolled(state) {
        if (state.status !== 'playing' || !state.game) return false;
        return (state.game.enrolled || []).filter(pid => this._active(state.players[pid])).length === 0;
    }

    // ============================================
    // START
    // ============================================

    async start(roomId, pid) {
        const out = await store.withRoom(roomId, async (state, tx) => {
            if (!state) return { ok: false, reason: 'no_room' };
            if (state.status !== 'lobby') return { ok: false, reason: 'already_started' };
            if (state.hostPlayerId !== pid) return { ok: false, reason: 'not_host' };
            if (!state.categories || !state.categories.length) return { ok: false, reason: 'no_categories' };
            // A prize whose payment has not cleared: not until it has.
            if (state.prize && state.prize.status === 'pending') return { ok: false, reason: 'prize_pending' };
            const players = this._activeIds(state);
            if (players.length < MIN_PLAYERS_TO_START) return { ok: false, reason: 'not_enough_players' };

            // The room locks here: late joiners are turned away from now on.
            state.status = 'playing';
            state.expiresAt = Date.now() + PLAYING_TTL_MS;
            // This game's rules, fixed now for the whole game.
            const set = await tvSettings.values();
            state.game = {
                style: STYLES.includes(state.style) ? state.style : 'standard',
                rules: {
                    questionMs: set['party.question_seconds'] * 1000,
                    fiftyBonusMs: set['party.fifty_bonus_seconds'] * 1000,
                    raceLockMs: set['race.lock_ms'],
                    raceWrong: set['race.wrong_penalty']
                },
                phase: 'starting', position: 0, enrolled: players,
                locked: {}, fifty: {}, results: {}, board: [], startedAt: Date.now(),
                // The countdown: everyone sees 3, 2, 1, Go! and the first
                // question lands at goAt, whatever else happens meanwhile.
                goAt: Date.now() + this.countdownMs
            };
            await pool.query(
                `UPDATE tv_rooms SET status = 'playing', started_at = NOW(),
                        expires_at = NOW() + INTERVAL '2 hours'
                 WHERE id = $1 AND status = 'lobby'`,
                [state.id]
            );
            tx.tv('game.starting', { players: players.length, categories: state.categories, style: state.game.style, goAt: state.game.goAt });
            for (const p of players) tx.player(p, 'player.room', this.playerSnapshot(state, p).room);
            return { ok: true, players: players.length };
        });
        if (out && out.ok) this._queue(roomId, () => this._prepareSet(roomId));
        return out;
    }

    /**
     * Build the fifteen questions. Questions this TV served in the last week
     * are avoided first, so a bar's regulars do not see the same ladder twice;
     * if the bank is too thin for that, any fifteen will do.
     */
    async _prepareSet(roomId) {
        const id = Number(roomId);
        const have = await pool.query(
            `SELECT COUNT(*)::int AS n FROM tv_room_questions WHERE tv_room_id = $1`, [id]
        );
        if ((have.rows[0] && have.rows[0].n) !== QUESTIONS_PER_ROUND) {
            const state = await store.load(id);
            if (!state || state.status !== 'playing') return;

            const recent = await pool.query(
                `SELECT q.question_id FROM tv_room_questions q
                 JOIN tv_rooms r ON r.id = q.tv_room_id
                 WHERE r.tv_device_id = $1 AND r.created_at > NOW() - INTERVAL '7 days' AND r.id <> $2`,
                [state.deviceId, id]
            );
            const exclude = recent.rows.map(r => r.question_id);

            let built = await questionService.buildChallengeQuestionSet(state.categories, exclude);
            if (!built.ok && exclude.length) built = await questionService.buildChallengeQuestionSet(state.categories, []);
            if (!built.ok) {
                logger.error(`TV room ${id}: the question bank cannot fill a set for ${state.categories.join(', ')}`);
                await this.closeRoom(id, 'no_questions');
                return;
            }

            const values = built.questionIds.map((q, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(', ');
            const params = [id];
            for (const q of built.questionIds) params.push(q.position, q.questionId);
            await pool.query(
                `INSERT INTO tv_room_questions (tv_room_id, position, question_id) VALUES ${values}
                 ON CONFLICT (tv_room_id, position) DO NOTHING`,
                params
            );
        }
        // The first question waits for the end of the countdown. Building the
        // set happens during it, so it costs no extra time. A game started
        // before the countdown existed has no goAt and goes straight on.
        const now = await store.load(id);
        const goAt = now && now.game && now.game.phase === 'starting' ? Number(now.game.goAt) || 0 : 0;
        if (goAt > Date.now()) {
            this._arm(id, goAt, () => this._nextQuestion(id));
            return;
        }
        return this._nextQuestion(id);
    }

    // ============================================
    // QUESTIONS
    // ============================================

    async _nextQuestion(roomId) {
        const id = Number(roomId);
        const out = await store.withRoom(id, async (state, tx) => {
            if (!state || state.status !== 'playing' || !state.game) return { done: true };
            const g = state.game;
            if (g.phase === 'question') return { done: false, already: true };

            const position = (g.position || 0) + 1;
            if (position > QUESTIONS_PER_ROUND) return { finish: true };

            const q = await pool.query(
                `SELECT s.question_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d
                 FROM tv_room_questions s
                 JOIN questions q ON q.id = s.question_id
                 WHERE s.tv_room_id = $1 AND s.position = $2`,
                [id, position]
            );
            const row = q.rows[0];
            if (!row) {
                logger.error(`TV room ${id}: no question at position ${position}`);
                return { finish: true };
            }

            const now = Date.now();
            g.phase = 'question';
            g.position = position;
            g.questionId = row.question_id;
            // correct_answer is deliberately NOT selected above. It is read at
            // the reveal and is never part of the room state.
            g.question = {
                text: row.question_text,
                options: { A: row.option_a, B: row.option_b, C: row.option_c, D: row.option_d }
            };
            const race = g.style === 'race';
            g.askedAt = now;
            // Race: the buttons open after a moment to read, and the clock
            // runs from then. Standard: they open at once.
            const rules = this._rules(g);
            g.opensAt = race ? now + rules.raceLockMs : now;
            g.expiresAt = g.opensAt + rules.questionMs;
            g.extendedAt = null;
            g.locked = {};
            g.nextAt = null;
            g.lastReveal = null;
            g.raceFirstAt = null;

            const playing = g.enrolled.filter(pid => this._active(state.players[pid]));
            tx.tv('game.question', {
                position, total: QUESTIONS_PER_ROUND, text: g.question.text, options: g.question.options,
                expiresAt: g.expiresAt, opensAt: g.opensAt, style: g.style || 'standard',
                answered: 0, of: playing.length, away: this._awayIds(state)
            });
            // The phone gets the clock and the letters. The question stays on the TV.
            for (const pid of playing) {
                tx.player(pid, 'player.question', {
                    position, total: QUESTIONS_PER_ROUND, expiresAt: g.expiresAt, opensAt: g.opensAt,
                    style: g.style || 'standard', at: now,
                    letters: LETTERS, fiftyFiftyAvailable: !race && !g.fifty[pid]
                });
            }
            return { armAt: g.expiresAt + ANSWER_GRACE_MS };
        });

        if (out && out.finish) return this._finish(id);
        if (out && out.armAt) this._arm(id, out.armAt, () => this._reveal(id, 'timeout'));
        return out;
    }

    // ============================================
    // ANSWER — locked, never broadcast
    // ============================================

    async answer(roomId, pid, position, choice) {
        const letter = String(choice || '').trim().toUpperCase();
        if (!LETTERS.includes(letter)) return { ok: false, reason: 'bad_choice' };

        const out = await store.withRoom(roomId, async (state, tx) => {
            if (!state || state.status !== 'playing' || !state.game) return { ok: false, reason: 'not_playing' };
            const g = state.game;
            if (g.phase !== 'question') return { ok: false, reason: 'not_playing' };
            if (Number(position) !== g.position) return { ok: false, reason: 'wrong_question' };
            if (!g.enrolled.includes(pid)) return { ok: false, reason: 'not_in_match' };
            if (!this._active(state.players[pid])) return { ok: false, reason: 'not_in_match' };
            if (g.locked[pid]) return { ok: false, reason: 'already_locked' };

            const now = Date.now();
            const race = g.style === 'race';
            // Race: a tap before the buttons open is refused, and costs nothing.
            if (race && now < g.opensAt) return { ok: false, reason: 'too_early' };
            if (now > g.expiresAt + ANSWER_GRACE_MS) return { ok: false, reason: 'too_late' };
            const f = g.fifty[pid];
            if (f && f.position === g.position && !f.keep.includes(letter)) {
                return { ok: false, reason: 'option_removed' };
            }

            // Timed by the server, from the moment the buttons opened (the
            // moment it asked, in Standard). Capped at the clock, so the grace
            // window is never worth anything.
            const from = g.opensAt || g.askedAt;
            const clock = g.expiresAt - from;
            const ms = Math.max(0, Math.min(now - from, clock));
            const lag = race ? this._lagFor(state.id, pid) : null;

            const ins = await pool.query(
                `INSERT INTO tv_answers (tv_room_id, tv_player_id, position, question_id, chosen, answer_ms, lag_ms)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (tv_player_id, position) DO NOTHING
                 RETURNING id`,
                [state.id, pid, g.position, g.questionId, letter, ms, lag]
            );
            if (!ins.rows[0]) return { ok: false, reason: 'already_locked' };

            g.locked[pid] = race ? { chosen: letter, ms, at: now, lag } : { chosen: letter, ms };
            // The player is told their answer is in, and nothing else. No
            // correctness, no broadcast. The TV hears a count, later, batched.
            tx.player(pid, 'player.locked', { position: g.position, chosen: letter });

            // Race: the first correct answer starts the settle window. The
            // answer is checked here, on the server, and goes nowhere.
            let settleAt = null;
            if (race && !g.raceFirstAt && letter === await this._raceKey(state.id, g)) {
                g.raceFirstAt = now;
                settleAt = now + RACE_SETTLE_MS;
            }

            const playing = g.enrolled.filter(x => this._active(state.players[x]));
            const allIn = playing.every(x => g.locked[x]);
            return { ok: true, locked: true, allIn, settleAt, position: g.position };
        });

        if (out && out.ok) {
            if (out.settleAt && !out.allIn) {
                this._cancelCount(Number(roomId));
                this._arm(Number(roomId), out.settleAt, () => this._reveal(roomId, 'won'));
            } else if (out.allIn) {
                this._cancelCount(Number(roomId));
                this._queue(roomId, () => this._reveal(roomId, 'all_locked'));
            } else {
                this._scheduleCount(Number(roomId));
            }
            return { ok: true, locked: true };
        }
        return out;
    }

    /** This game's rules. A game started before the settings existed uses the defaults. */
    _rules(g) {
        const r = (g && g.rules) || {};
        return {
            questionMs: r.questionMs || QUESTION_MS,
            fiftyBonusMs: r.fiftyBonusMs != null ? r.fiftyBonusMs : FIFTY_FIFTY_BONUS_MS,
            raceLockMs: r.raceLockMs || RACE_LOCK_MS,
            raceWrong: r.raceWrong || RACE_WRONG
        };
    }

    /** The correct answer to a Race question, from the database, kept in memory only. */
    async _raceKey(roomId, g) {
        const key = `${g.position}:${g.questionId}`;
        const have = this.raceKeys.get(roomId);
        if (have && have.key === key) return have.correct;
        const c = await pool.query(`SELECT correct_answer FROM questions WHERE id = $1`, [g.questionId]);
        const correct = String((c.rows[0] && c.rows[0].correct_answer) || '').trim().toUpperCase() || null;
        this.raceKeys.set(roomId, { key, correct });
        return correct;
    }

    /**
     * Race: a phone says a question has just arrived. The round trip from the
     * server sending it to this arriving is that phone's delay, both ways —
     * the same path its answer takes. Kept in memory: after a restart the
     * delays are measured again from the next question.
     */
    async seen(roomId, pid, position) {
        const id = Number(roomId);
        const state = await store.load(id);
        const g = state && state.game;
        if (!g || g.style !== 'race' || g.phase !== 'question' || Number(position) !== g.position) {
            return { ok: true, counted: false };
        }
        if (!g.enrolled.includes(pid)) return { ok: true, counted: false };
        const rtt = Date.now() - g.askedAt;
        // Arriving after the buttons opened, it says nothing useful.
        if (rtt < 0 || rtt > this._rules(g).raceLockMs) return { ok: true, counted: false };
        if (!this.lag.has(id)) this.lag.set(id, new Map());
        const mine = this.lag.get(id).get(pid) || [];
        mine.push(rtt);
        while (mine.length > RACE_LAG_SAMPLES) mine.shift();
        this.lag.get(id).set(pid, mine);
        return { ok: true, counted: true };
    }

    /** The delay taken off a phone's answers: the median of its last few, capped. */
    _lagFor(roomId, pid) {
        const samples = this.lag.get(Number(roomId)) && this.lag.get(Number(roomId)).get(pid);
        if (!samples || !samples.length) return 0;
        const sorted = [...samples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        return Math.max(0, Math.min(RACE_LAG_CAP_MS, Math.round(median)));
    }

    /** Who took a Race question: the earliest adjusted arrival; a near tie goes to who arrived first. */
    _raceWinner(g, correct) {
        const right = Object.entries(g.locked)
            .filter(([, l]) => correct && l.chosen === correct && typeof l.at === 'number')
            .map(([pid, l]) => ({ pid: Number(pid), at: l.at, adj: l.at - (l.lag || 0), ms: l.ms }))
            .sort((a, b) => a.adj - b.adj);
        if (!right.length) return null;
        const close = right.filter(c => c.adj - right[0].adj < RACE_TIE_MS);
        return close.sort((a, b) => a.at - b.at || a.pid - b.pid)[0];
    }

    _scheduleCount(roomId) {
        if (this.countTimers.has(roomId)) return;
        const t = setTimeout(() => {
            this.countTimers.delete(roomId);
            store.withRoom(roomId, (state, tx) => {
                if (!state || !state.game || state.game.phase !== 'question') return;
                const g = state.game;
                const playing = g.enrolled.filter(x => this._active(state.players[x]));
                // Not logged: it is superseded within a second, and a
                // reconnecting TV gets the current count in its snapshot.
                tx.tv('game.answer_count', {
                    position: g.position, answered: Object.keys(g.locked).length, of: playing.length
                }, { log: false });
            }).catch(e => logger.error(`TV room ${roomId}: answer count failed — ${e.message}`));
        }, ANSWER_COUNT_COALESCE_MS);
        if (t.unref) t.unref();
        this.countTimers.set(roomId, t);
    }

    _cancelCount(roomId) {
        const t = this.countTimers.get(roomId);
        if (t) clearTimeout(t);
        this.countTimers.delete(roomId);
    }

    // ============================================
    // 50:50 — the shared clock moves for everyone
    // ============================================

    async fiftyFifty(roomId, pid, position) {
        const out = await store.withRoom(roomId, async (state, tx) => {
            if (!state || state.status !== 'playing' || !state.game) return { ok: false, reason: 'not_playing' };
            const g = state.game;
            if (g.phase !== 'question' || Number(position) !== g.position) return { ok: false, reason: 'not_current_question' };
            if (g.style === 'race') return { ok: false, reason: 'not_in_race' };
            if (!g.enrolled.includes(pid) || !this._active(state.players[pid])) return { ok: false, reason: 'not_in_match' };
            if (g.locked[pid]) return { ok: false, reason: 'already_locked' };
            if (g.fifty[pid]) return { ok: false, reason: 'already_used' };
            if (Date.now() > g.expiresAt) return { ok: false, reason: 'too_late' };

            const c = await pool.query(`SELECT correct_answer FROM questions WHERE id = $1`, [g.questionId]);
            const correct = String((c.rows[0] && c.rows[0].correct_answer) || '').trim().toUpperCase();
            if (!LETTERS.includes(correct)) return { ok: false, reason: 'unavailable' };

            const wrong = LETTERS.filter(l => l !== correct);
            const keepWrong = wrong[require('crypto').randomInt(0, wrong.length)];
            const keep = [correct, keepWrong].sort();
            g.fifty[pid] = { position: g.position, keep };

            let extended = false;
            if (g.extendedAt !== g.position) {
                g.extendedAt = g.position;
                g.expiresAt += this._rules(g).fiftyBonusMs;
                extended = true;
                tx.tv('game.clock_extended', { position: g.position, expiresAt: g.expiresAt });
                for (const x of g.enrolled.filter(x => this._active(state.players[x]))) {
                    if (x !== pid) tx.player(x, 'player.clock_extended', { position: g.position, expiresAt: g.expiresAt });
                }
            }
            // Only this phone learns which two letters are left.
            tx.player(pid, 'player.fifty', { position: g.position, letters: keep, expiresAt: g.expiresAt });
            return { ok: true, letters: keep, expiresAt: g.expiresAt, extended, armAt: g.expiresAt + ANSWER_GRACE_MS };
        });

        if (out && out.ok && out.extended) this._arm(Number(roomId), out.armAt, () => this._reveal(roomId, 'timeout'));
        if (out && out.ok) return { ok: true, letters: out.letters, expiresAt: out.expiresAt };
        return out;
    }

    // ============================================
    // REVEAL
    // ============================================

    async _reveal(roomId, trigger) {
        const id = Number(roomId);
        try {
            const out = await store.withRoom(id, async (state, tx) => {
                if (!state || state.status !== 'playing' || !state.game) return null;
                const g = state.game;
                if (g.phase !== 'question') return null;
                g.phase = 'reveal';
                tx.dirty = true;

                const c = await pool.query(`SELECT correct_answer FROM questions WHERE id = $1`, [g.questionId]);
                const correct = String((c.rows[0] && c.rows[0].correct_answer) || '').trim().toUpperCase() || null;

                // Everyone enrolled who did not lock in is recorded at the full
                // clock, so a dropped phone cannot win a tiebreak.
                const clock = g.expiresAt - g.askedAt;
                const missing = g.enrolled.filter(pid => !g.locked[pid]);
                if (missing.length) {
                    await pool.query(
                        `INSERT INTO tv_answers (tv_room_id, tv_player_id, position, question_id, chosen, answer_ms)
                          SELECT $1::int, pid, $2::smallint, $3::int, NULL::text, $4::int
                         FROM unnest($5::int[]) AS pid
                         ON CONFLICT (tv_player_id, position) DO NOTHING`,
                        [id, g.position, g.questionId, clock, missing]
                    );
                }

                await pool.query(
                    `UPDATE tv_answers SET is_correct = (chosen IS NOT NULL AND chosen = $3)
                     WHERE tv_room_id = $1 AND position = $2`,
                    [id, g.position, correct]
                );

                // Race: one answer takes the question, and that is recorded.
                const race = g.style === 'race';
                const winner = race ? this._raceWinner(g, correct) : null;
                if (race) {
                    await pool.query(
                        `UPDATE tv_answers SET won = (tv_player_id = $3)
                         WHERE tv_room_id = $1 AND position = $2`,
                        [id, g.position, winner ? winner.pid : 0]
                    );
                    this.raceKeys.delete(id);
                }

                // The ledger: one row per correct answer, never a total. In
                // Race, only the answer that took the question.
                await pool.query(
                    `INSERT INTO tv_points (user_id, guest_ref, mode, question_number, points, tv_room_id, tv_player_id)
                     SELECT p.user_id,
                            CASE WHEN p.user_id IS NULL THEN 'tvp:' || p.id END,
                            'party', a.position, $3::smallint, a.tv_room_id, p.id
                     FROM tv_answers a
                     JOIN tv_players p ON p.id = a.tv_player_id
                     WHERE a.tv_room_id = $1 AND a.position = $2 AND a.is_correct = true
                       AND ($4::boolean = false OR a.won = true)
                     ON CONFLICT (tv_player_id, question_number) WHERE tv_player_id IS NOT NULL DO NOTHING`,
                    [id, g.position, pointsFor(g.position), race]
                );

                const board = await this._board(state);
                g.board = board;
                const byId = new Map(board.map(b => [b.id, b]));
                const correctCount = g.enrolled.filter(pid => g.locked[pid] && g.locked[pid].chosen === correct).length;
                const winnerName = winner && state.players[winner.pid] ? state.players[winner.pid].name : null;
                g.lastReveal = {
                    position: g.position, correctAnswer: correct, correctCount,
                    ...(race ? { winnerPlayerId: winner ? winner.pid : null, winnerName, winnerMs: winner ? winner.ms : null } : {})
                };
                g.nextAt = Date.now() + REVEAL_PAUSE_MS;

                tx.tv('game.reveal', {
                    position: g.position, correctAnswer: correct, trigger,
                    correctCount, answered: Object.keys(g.locked).length,
                    of: g.enrolled.filter(pid => this._active(state.players[pid])).length,
                    style: g.style || 'standard',
                    ...(race ? { winnerPlayerId: winner ? winner.pid : null, winnerName, winnerMs: winner ? winner.ms : null } : {})
                });
                tx.tv('game.standings', { position: g.position, board, style: g.style || 'standard', away: this._awayIds(state) });

                for (const pid of g.enrolled) {
                    if (!this._active(state.players[pid])) continue;
                    const mine = g.locked[pid] || null;
                    const row = byId.get(pid) || { c: 0, t: 0, s: 0, rank: null };
                    const right = !!(mine && mine.chosen === correct);
                    const won = !!(winner && winner.pid === pid);
                    const result = {
                        position: g.position,
                        chosen: mine ? mine.chosen : null,
                        correct: right,
                        correctAnswer: correct,
                        points: race ? (won ? pointsFor(g.position) : 0) : (right ? pointsFor(g.position) : 0),
                        score: race ? { c: row.c, t: row.t, s: row.s } : { c: row.c, t: row.t },
                        rank: row.rank,
                        of: board.filter(b => b.rank != null).length,
                        ...(race ? {
                            style: 'race', won,
                            // +1 for taking it, -1 for a wrong answer, 0 otherwise
                            change: won ? RACE_WIN : (mine && !right ? -this._rules(g).raceWrong : 0),
                            winnerName: won ? null : winnerName
                        } : {})
                    };
                    g.results[pid] = result;
                    tx.player(pid, 'player.result', result);
                }
                return { nextAt: g.nextAt };
            });
            if (out) this._arm(id, out.nextAt, () => this._nextQuestion(id));
        } catch (error) {
            // Called from a timer: a throw here would be an unhandled
            // rejection. A room that cannot reveal is closed, not left hanging.
            logger.error(`TV room ${id}: reveal failed — ${error.message}`);
            await this.closeRoom(id, 'state_lost').catch(() => {});
        }
    }

    /**
     * Standard: correct answers, then total time. Race: the game score (one
     * for each question taken, minus one for each wrong answer), then
     * questions taken, then the time of the ones taken. Left and removed
     * players are shown but unranked.
     */
    async _board(state) {
        if (state.game && state.game.style === 'race') return this._raceBoard(state);
        const r = await pool.query(
            `SELECT tv_player_id AS id,
                    COUNT(*) FILTER (WHERE is_correct = true)::int AS c,
                    COALESCE(SUM(answer_ms), 0)::int AS t
             FROM tv_answers WHERE tv_room_id = $1 GROUP BY tv_player_id`,
            [state.id]
        );
        const rows = new Map(r.rows.map(x => [Number(x.id), { c: Number(x.c), t: Number(x.t) }]));
        const entries = (state.game.enrolled || []).map(pid => {
            const p = state.players[pid];
            const s = rows.get(pid) || { c: 0, t: 0 };
            return { id: pid, c: s.c, t: s.t, finisher: this._active(p), left: !!(p && p.leftAt), removed: !!(p && p.removedAt) };
        });
        const ranked = entries.filter(e => e.finisher).sort((a, b) => b.c - a.c || a.t - b.t);
        ranked.forEach((e, i) => { e.rank = i + 1; });
        const others = entries.filter(e => !e.finisher).map(e => ({ ...e, rank: null }));
        return [...ranked, ...others].map(({ finisher, ...rest }) => rest);
    }

    async _raceBoard(state) {
        const r = await pool.query(
            `SELECT tv_player_id AS id,
                    COUNT(*) FILTER (WHERE won = true)::int AS w,
                    COUNT(*) FILTER (WHERE chosen IS NOT NULL AND is_correct = false)::int AS x,
                    COALESCE(SUM(answer_ms) FILTER (WHERE won = true), 0)::int AS t
             FROM tv_answers WHERE tv_room_id = $1 GROUP BY tv_player_id`,
            [state.id]
        );
        const rows = new Map(r.rows.map(x => [Number(x.id), { w: Number(x.w), x: Number(x.x), t: Number(x.t) }]));
        const entries = (state.game.enrolled || []).map(pid => {
            const p = state.players[pid];
            const v = rows.get(pid) || { w: 0, x: 0, t: 0 };
            return {
                id: pid, c: v.w, t: v.t, s: v.w * RACE_WIN - v.x * this._rules(state.game).raceWrong, w: v.w, x: v.x,
                finisher: this._active(p), left: !!(p && p.leftAt), removed: !!(p && p.removedAt)
            };
        });
        const ranked = entries.filter(e => e.finisher).sort((a, b) => b.s - a.s || b.w - a.w || a.t - b.t);
        ranked.forEach((e, i) => { e.rank = i + 1; });
        const others = entries.filter(e => !e.finisher).map(e => ({ ...e, rank: null }));
        return [...ranked, ...others].map(({ finisher, ...rest }) => rest);
    }

    // ============================================
    // FINISH
    // ============================================

    async _finish(roomId) {
        const id = Number(roomId);
        let prizeToSettle = false;
        try {
            await store.withRoom(id, async (state, tx) => {
                if (!state || state.status !== 'playing' || !state.game) return;
                const g = state.game;
                if (g.phase === 'done') return;
                g.phase = 'grading';

                const board = await this._board(state);
                const finishers = board.filter(b => b.rank != null);
                const counted = finishers.length >= MIN_FINISHERS;
                const winner = counted ? finishers[0] : null;

                const pts = await pool.query(
                    `SELECT tv_player_id AS id, COALESCE(SUM(points), 0)::int AS points
                     FROM tv_points WHERE tv_room_id = $1 GROUP BY tv_player_id`,
                    [id]
                );
                const pointsBy = new Map(pts.rows.map(x => [Number(x.id), Number(x.points)]));

                await this._writePlaces(board);
                if (state.prize && state.prize.status === 'settled') prizeToSettle = true;
                await pool.query(
                    `UPDATE tv_rooms SET status = 'finished', finished_at = NOW(), result_counted = $2
                     WHERE id = $1`,
                    [id, counted]
                );

                state.status = 'finished';
                g.phase = 'done';
                g.board = board;
                g.final = { counted, winnerPlayerId: winner ? winner.id : null };
                g.finalByPlayer = {};

                const race = g.style === 'race';
                tx.tv('game.finished', { board, counted, winnerPlayerId: winner ? winner.id : null, style: g.style || 'standard' });
                for (const b of board) {
                    if (!this._active(state.players[b.id])) continue;
                    const mine = {
                        rank: b.rank, of: finishers.length, correct: b.c, totalMs: b.t,
                        points: pointsBy.get(b.id) || 0, counted,
                        won: !!(winner && winner.id === b.id),
                        ...(race ? { style: 'race', score: b.s, taken: b.w, wrong: b.x } : {})
                    };
                    g.finalByPlayer[b.id] = mine;
                    tx.player(b.id, 'player.finished', mine);
                }
            });
        } catch (error) {
            logger.error(`TV room ${id}: could not finish — ${error.message}`);
            await this.closeRoom(id, 'state_lost').catch(() => {});
        }
        this._clearTimers(id);
        if (prizeToSettle) this._settlePrize(id);
    }

    // ============================================
    // TIMERS
    // ============================================

    _arm(roomId, atMs, fn) {
        const id = Number(roomId);
        const existing = this.timers.get(id);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
            if (this.timers.get(id) === t) this.timers.delete(id);
            Promise.resolve().then(fn).catch(e => logger.error(`TV room ${id}: timer job failed — ${e.message}`));
        }, Math.max(0, atMs - Date.now()));
        if (t.unref) t.unref();
        this.timers.set(id, t);
    }

    /** Run outside the caller's room queue (a job queued from inside it would wait for itself). */
    _queue(roomId, fn) {
        setImmediate(() => {
            Promise.resolve().then(fn).catch(e => logger.error(`TV room ${roomId}: job failed — ${e.message}`));
        });
    }

    _clearTimers(roomId) {
        const id = Number(roomId);
        // A room that has ended takes its measured delays and Race answer with it.
        this.lag.delete(id);
        this.raceKeys.delete(id);
        for (const map of [this.timers, this.countTimers, this.lobbyTimers]) {
            const t = map.get(id);
            if (t) clearTimeout(t);
            map.delete(id);
        }
    }

    // ============================================
    // RESTART RECOVERY
    // ============================================
    // Every live room is re-armed from the deadlines in its stored state. A
    // question that ran out while the server was down is revealed at once; a
    // question still running keeps the time it had left — never a fresh clock.

    async recover() {
        await tvAuth.ensureSchema();
        const r = await pool.query(`SELECT id, status FROM tv_rooms WHERE status IN ('lobby','playing')`);
        let armed = 0;
        for (const row of r.rows) {
            try {
                const state = await this._loadOrRebuild(row.id);
                if (!state || state.status !== 'playing' || !state.game) continue;
                const g = state.game;
                if (g.phase === 'starting') this._queue(row.id, () => this._prepareSet(row.id));
                else if (g.phase === 'question' && g.raceFirstAt) this._arm(row.id, g.raceFirstAt + RACE_SETTLE_MS, () => this._reveal(row.id, 'won'));
                else if (g.phase === 'question') this._arm(row.id, g.expiresAt + ANSWER_GRACE_MS, () => this._reveal(row.id, 'timeout'));
                else if (g.phase === 'reveal') this._arm(row.id, g.nextAt || Date.now(), () => this._nextQuestion(row.id));
                else if (g.phase === 'grading') this._queue(row.id, () => this._finish(row.id));
                else continue;
                armed++;
            } catch (e) {
                logger.error(`TV room ${row.id}: recovery failed — ${e.message}`);
            }
        }
        if (r.rows.length) logger.info(`📺 TV recovery: ${r.rows.length} live room(s), ${armed} game timer(s) re-armed`);
        return { rooms: r.rows.length, armed };
    }

    /** Lobbies nobody started are closed when they expire. */
    async sweepExpired() {
        const r = await pool.query(
            `SELECT id FROM tv_rooms WHERE status = 'lobby' AND expires_at < NOW()`
        );
        for (const row of r.rows) await this.closeRoom(row.id, 'expired');
        return r.rows.length;
    }

    startSweep() {
        if (this._sweep) return;
        const run = () => {
            this.sweepExpired().catch(e => logger.error('TV sweep failed:', e.message));
            require('./tv-prize.service').sweep().catch(e => logger.error('TV prize sweep failed:', e.message));
        };
        run();
        this._sweep = setInterval(run, SWEEP_MS);
        if (this._sweep.unref) this._sweep.unref();
    }
}

module.exports = new TvPartyService();
module.exports.QUESTIONS_PER_ROUND = QUESTIONS_PER_ROUND;
module.exports.QUESTION_MS = QUESTION_MS;
module.exports.FIFTY_FIFTY_BONUS_MS = FIFTY_FIFTY_BONUS_MS;
module.exports.ANSWER_GRACE_MS = ANSWER_GRACE_MS;
module.exports.REVEAL_PAUSE_MS = REVEAL_PAUSE_MS;
module.exports.MAX_PLAYERS = MAX_PLAYERS;
module.exports.MIN_FINISHERS = MIN_FINISHERS;
module.exports.pointsFor = pointsFor;
module.exports.STYLES = STYLES;
module.exports.RACE_LOCK_MS = RACE_LOCK_MS;
module.exports.RACE_SETTLE_MS = RACE_SETTLE_MS;
module.exports.RACE_LAG_CAP_MS = RACE_LAG_CAP_MS;
module.exports.RACE_TIE_MS = RACE_TIE_MS;
module.exports.COUNTDOWN_MS = COUNTDOWN_MS;
