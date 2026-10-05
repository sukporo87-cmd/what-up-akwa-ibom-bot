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
// NO MONEY IN HERE. Sponsored prizes arrive in phase 5.
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const tvAuth = require('./tv-auth.service');
const store = require('./tv-room-store.service');
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
        /** @type {Map<number, NodeJS.Timeout>} one game timer per room */
        this.timers = new Map();
        /** @type {Map<number, NodeJS.Timeout>} */
        this.countTimers = new Map();
        /** @type {Map<number, NodeJS.Timeout>} */
        this.lobbyTimers = new Map();
        this._categories = null;
        this._categoriesAt = 0;
        this._sweep = null;
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

    async getCategories() {
        if (this._categories && Date.now() - this._categoriesAt < CATEGORY_CACHE_MS) return this._categories;
        const readiness = await questionService.getChallengeBankReadiness();
        this._categories = readiness.filter(r => r.ready).map(r => r.category).sort();
        this._categoriesAt = Date.now();
        return this._categories;
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
                maxPlayers: state.maxPlayers,
                playerCount: this._activeIds(state).length,
                players: this._roster(state)
            },
            game: g ? {
                phase: g.phase,
                position: g.position,
                total: QUESTIONS_PER_ROUND,
                expiresAt: g.phase === 'question' ? g.expiresAt : null,
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
                playerCount: this._activeIds(state).length,
                maxPlayers: state.maxPlayers,
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
                phase: g.phase,
                position: g.position,
                total: QUESTIONS_PER_ROUND,
                expiresAt: g.phase === 'question' ? g.expiresAt : null,
                letters: g.phase === 'question' ? this._lettersFor(g, pid) : null,
                locked: g.phase === 'question' && lock ? lock.chosen : null,
                fiftyFiftyAvailable: !fifty,
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

        if (await this._overLimit(`tv_rate:rooms:${device.id}`, ROOMS_PER_DEVICE_PER_HOUR, 3600)) {
            return { ok: false, reason: 'too_many_rooms' };
        }

        let row = null;
        for (let attempt = 0; attempt < 6 && !row; attempt++) {
            try {
                const r = await pool.query(
                    `INSERT INTO tv_rooms (tv_device_id, join_code, max_players, expires_at)
                     VALUES ($1, $2, $3, NOW() + INTERVAL '60 minutes')
                     RETURNING id, join_code, created_at, expires_at`,
                    [device.id, this._newCode(), MAX_PLAYERS]
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
            maxPlayers: MAX_PLAYERS,
            categories: [],
            createdAt: now,
            expiresAt: now + LOBBY_TTL_MS,
            players: {},
            order: [],
            game: null
        });

        logger.info(`📺 TV ${device.id} opened room ${row.id} (code ${row.join_code})`);
        return {
            ok: true, resumed: false, roomId: row.id, joinCode: row.join_code,
            joinUrl: this.joinUrl(row.join_code), status: 'lobby', maxPlayers: MAX_PLAYERS
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
        const out = await store.withRoom(id, async (state, tx) => {
            if (!state) {
                await this._closeInDb(id, reason);
                return { ok: true };
            }
            if (state.status === 'closed' || state.status === 'finished') return { ok: true, already: true };

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
        logger.info(`📺 TV room ${id} closed (${reason})`);
        return out;
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
                const v = tvNames.validateName(String(ctx.account.username || ''));
                name = v.ok ? v.name : 'Player';
            } else {
                const v = tvNames.validateName(input.name);
                if (!v.ok) return { ok: false, status: 400, reason: v.reason };
                name = v.name;
            }

            const takenKeys = Object.values(state.players).map(x => x.key);
            if (takenKeys.includes(tvNames.nameKey(name))) {
                if (!input.allowNumber) {
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
            const players = this._activeIds(state);
            if (players.length < MIN_PLAYERS_TO_START) return { ok: false, reason: 'not_enough_players' };

            // The room locks here: late joiners are turned away from now on.
            state.status = 'playing';
            state.expiresAt = Date.now() + PLAYING_TTL_MS;
            state.game = {
                phase: 'starting', position: 0, enrolled: players,
                locked: {}, fifty: {}, results: {}, board: [], startedAt: Date.now()
            };
            await pool.query(
                `UPDATE tv_rooms SET status = 'playing', started_at = NOW(),
                        expires_at = NOW() + INTERVAL '2 hours'
                 WHERE id = $1 AND status = 'lobby'`,
                [state.id]
            );
            tx.tv('game.starting', { players: players.length, categories: state.categories });
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
            g.askedAt = now;
            g.expiresAt = now + QUESTION_MS;
            g.extendedAt = null;
            g.locked = {};
            g.nextAt = null;
            g.lastReveal = null;

            const playing = g.enrolled.filter(pid => this._active(state.players[pid]));
            tx.tv('game.question', {
                position, total: QUESTIONS_PER_ROUND, text: g.question.text, options: g.question.options,
                expiresAt: g.expiresAt, answered: 0, of: playing.length, away: this._awayIds(state)
            });
            // The phone gets the clock and the letters. The question stays on the TV.
            for (const pid of playing) {
                tx.player(pid, 'player.question', {
                    position, total: QUESTIONS_PER_ROUND, expiresAt: g.expiresAt,
                    letters: LETTERS, fiftyFiftyAvailable: !g.fifty[pid]
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
            if (now > g.expiresAt + ANSWER_GRACE_MS) return { ok: false, reason: 'too_late' };
            const f = g.fifty[pid];
            if (f && f.position === g.position && !f.keep.includes(letter)) {
                return { ok: false, reason: 'option_removed' };
            }

            // Timed by the server, from the moment the server asked. Capped at
            // the clock, so the grace window is never worth anything.
            const clock = g.expiresAt - g.askedAt;
            const ms = Math.max(0, Math.min(now - g.askedAt, clock));

            const ins = await pool.query(
                `INSERT INTO tv_answers (tv_room_id, tv_player_id, position, question_id, chosen, answer_ms)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (tv_player_id, position) DO NOTHING
                 RETURNING id`,
                [state.id, pid, g.position, g.questionId, letter, ms]
            );
            if (!ins.rows[0]) return { ok: false, reason: 'already_locked' };

            g.locked[pid] = { chosen: letter, ms };
            // The player is told their answer is in, and nothing else. No
            // correctness, no broadcast. The TV hears a count, later, batched.
            tx.player(pid, 'player.locked', { position: g.position, chosen: letter });

            const playing = g.enrolled.filter(x => this._active(state.players[x]));
            const allIn = playing.every(x => g.locked[x]);
            return { ok: true, locked: true, allIn, position: g.position };
        });

        if (out && out.ok) {
            if (out.allIn) {
                this._cancelCount(Number(roomId));
                this._queue(roomId, () => this._reveal(roomId, 'all_locked'));
            } else {
                this._scheduleCount(Number(roomId));
            }
            return { ok: true, locked: true };
        }
        return out;
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
                g.expiresAt += FIFTY_FIFTY_BONUS_MS;
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

                // The ledger: one row per correct answer, never a total.
                await pool.query(
                    `INSERT INTO tv_points (user_id, guest_ref, mode, question_number, points, tv_room_id, tv_player_id)
                     SELECT p.user_id,
                            CASE WHEN p.user_id IS NULL THEN 'tvp:' || p.id END,
                            'party', a.position, $3::smallint, a.tv_room_id, p.id
                     FROM tv_answers a
                     JOIN tv_players p ON p.id = a.tv_player_id
                     WHERE a.tv_room_id = $1 AND a.position = $2 AND a.is_correct = true
                     ON CONFLICT (tv_player_id, question_number) WHERE tv_player_id IS NOT NULL DO NOTHING`,
                    [id, g.position, pointsFor(g.position)]
                );

                const board = await this._board(state);
                g.board = board;
                const byId = new Map(board.map(b => [b.id, b]));
                const correctCount = g.enrolled.filter(pid => g.locked[pid] && g.locked[pid].chosen === correct).length;
                g.lastReveal = { position: g.position, correctAnswer: correct, correctCount };
                g.nextAt = Date.now() + REVEAL_PAUSE_MS;

                tx.tv('game.reveal', {
                    position: g.position, correctAnswer: correct, trigger,
                    correctCount, answered: Object.keys(g.locked).length,
                    of: g.enrolled.filter(pid => this._active(state.players[pid])).length
                });
                tx.tv('game.standings', { position: g.position, board, away: this._awayIds(state) });

                for (const pid of g.enrolled) {
                    if (!this._active(state.players[pid])) continue;
                    const mine = g.locked[pid] || null;
                    const row = byId.get(pid) || { c: 0, t: 0, rank: null };
                    const result = {
                        position: g.position,
                        chosen: mine ? mine.chosen : null,
                        correct: !!(mine && mine.chosen === correct),
                        correctAnswer: correct,
                        points: mine && mine.chosen === correct ? pointsFor(g.position) : 0,
                        score: { c: row.c, t: row.t },
                        rank: row.rank,
                        of: board.filter(b => b.rank != null).length
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

    /** Correct answers, then total time. Left and removed players are shown but unranked. */
    async _board(state) {
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

    // ============================================
    // FINISH
    // ============================================

    async _finish(roomId) {
        const id = Number(roomId);
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

                if (board.length) {
                    const values = board.map((b, i) => `($${i * 4 + 1}::int, $${i * 4 + 2}::smallint, $${i * 4 + 3}::int, $${i * 4 + 4}::smallint)`).join(', ');
                    const params = [];
                    for (const b of board) params.push(b.id, b.c, b.t, b.rank);
                    await pool.query(
                        `UPDATE tv_players p SET final_correct = v.c, final_total_ms = v.t, final_rank = v.r
                         FROM (VALUES ${values}) AS v(id, c, t, r) WHERE p.id = v.id`,
                        params
                    );
                }
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

                tx.tv('game.finished', { board, counted, winnerPlayerId: winner ? winner.id : null });
                for (const b of board) {
                    if (!this._active(state.players[b.id])) continue;
                    const mine = {
                        rank: b.rank, of: finishers.length, correct: b.c, totalMs: b.t,
                        points: pointsBy.get(b.id) || 0, counted,
                        won: !!(winner && winner.id === b.id)
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
        const run = () => this.sweepExpired().catch(e => logger.error('TV sweep failed:', e.message));
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
