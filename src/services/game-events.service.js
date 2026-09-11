// ============================================
// FILE: src/services/game-events.service.js
// Server-Sent Events bus for web play.
//
// The game engine is unchanged — it still "sends messages". For web users those
// messages are pushed down an open SSE connection instead of to WhatsApp.
// Structured events (question.asked etc.) are emitted alongside the text so the
// UI can render properly and fall back to text for anything not yet structured.
// ============================================

const redis = require('../config/redis');
const { logger } = require('../utils/logger');

const HEARTBEAT_MS = 25000;   // Render idles out quiet connections; keep them warm

// ============================================
// ONE STREAM PER LIVE GAME
// ============================================
// Every open stream for a user used to receive every question. A second phone
// or tab signed into the same account could watch the game live while someone
// else answered, and nothing noticed.
//
// The rule: while a CLASSIC game is live, the NEWEST stream wins and every
// older one is closed. It runs when a Classic question is delivered
// (emitQuestion) and when a stream connects mid-game (web-game.routes).
//
// CHALLENGE MODE IS NEVER TOUCHED. This does not run for:
//   * any arena event — challenge.question is not a trigger;
//   * a user in an arena room, from lobby entry to match end;
//   * a user the claim guard excludes (web-game.routes registers it: not a
//     web account, or in a challenge chat flow or round).
// A user who is doing anything in challenge mode keeps every stream they
// have, exactly as before this existed.
//
// A closed stream would simply reconnect: EventSource does that by itself, and
// the reconnect would then be the newest and kick the other back. Two devices
// would trade the game every three seconds. So a replaced stream's connection
// id is remembered, and when that same id reconnects the route answers 204 —
// the one status that tells EventSource to stop retrying. Taking the game back
// is a deliberate act on that device ("Play here"), which opens a stream with
// a fresh id and becomes the newest in turn.
const DISPLACED_TTL_MS = 30 * 60 * 1000;
const SNAPSHOT_TTL = 3600;

class GameEventsService {
    constructor() {
        /** @type {Map<number, Set<import('express').Response>>} */
        this.connections = new Map();
        /** @type {Map<number, Set<number>>} challengeId -> userIds */
        this.rooms = new Map();
        /** @type {Map<string, number>} "userId:cid" -> expiry epoch ms */
        this.displaced = new Map();
        /** Called as fn({ userId, closed, reason, type, payload, kept }) */
        this.replacedListeners = [];
        /** async (userId, phone) => boolean. false = leave this user's streams alone. */
        this.claimGuard = null;
        this._streamSeq = 0;

        setInterval(() => this._heartbeat(), HEARTBEAT_MS).unref?.();
    }

    // ============================================
    // CONNECTION REGISTRY
    // ============================================

    subscribe(userId, res, info = {}) {
        if (!this.connections.has(userId)) this.connections.set(userId, new Set());
        // Order of arrival decides "newest", so it is recorded rather than
        // inferred from Set iteration order.
        try {
            res.__wutStream = {
                seq: ++this._streamSeq,
                cid: info.cid || null,
                phone: info.phone || null,
                openedAt: Date.now()
            };
        } catch (e) { /* a frozen or odd res still gets subscribed */ }
        this.connections.get(userId).add(res);
        logger.info(`🔌 SSE connected: user ${userId} (${this.connections.get(userId).size} open)`);
    }

    unsubscribe(userId, res) {
        const set = this.connections.get(userId);
        if (!set) return;
        set.delete(res);
        if (set.size === 0) this.connections.delete(userId);
        logger.info(`🔌 SSE disconnected: user ${userId}`);
    }

    isConnected(userId) {
        return (this.connections.get(userId)?.size || 0) > 0;
    }

    connectionCount(userId) {
        return this.connections.get(userId)?.size || 0;
    }

    /**
     * Close every stream for this user except the newest. Returns how many
     * were closed. Safe to call on every question: with one stream it is a
     * size check and nothing else.
     */
    enforceSingleStream(userId, reason = 'live_game', context = {}) {
        const set = this.connections.get(userId);
        if (!set || set.size <= 1) return 0;
        // Belt and braces: whoever calls this, an arena player is left alone.
        if (this.isInArenaRoom(userId)) return 0;

        const seqOf = r => (r && r.__wutStream && r.__wutStream.seq) || 0;
        const all = [...set];
        const newest = all.reduce((a, b) => (seqOf(b) > seqOf(a) ? b : a));

        let closed = 0;
        for (const res of all) {
            if (res === newest) continue;
            const cid = res.__wutStream && res.__wutStream.cid;
            if (cid) this.displaced.set(`${userId}:${cid}`, Date.now() + DISPLACED_TTL_MS);
            try {
                res.write(`event: stream.replaced\ndata: ${JSON.stringify({
                    type: 'stream.replaced', reason, at: Date.now()
                })}\n\n`);
            } catch (e) { /* already gone */ }
            try { res.end(); } catch (e) { /* already gone */ }
            set.delete(res);
            closed++;
        }

        if (closed > 0) {
            logger.warn(`🔌 Single stream: user ${userId} — closed ${closed} older stream(s) (${reason})`);
            for (const fn of this.replacedListeners) {
                try {
                    fn({
                        userId, closed, reason,
                        type: context.type || null,
                        payload: context.payload || null,
                        kept: newest.__wutStream || null
                    });
                } catch (e) { /* a listener must never break delivery */ }
            }
        }
        return closed;
    }

    /** True if this connection id was replaced and must not reconnect. */
    isDisplaced(userId, cid) {
        if (!cid) return false;
        const key = `${userId}:${cid}`;
        const until = this.displaced.get(key);
        if (!until) return false;
        if (until < Date.now()) { this.displaced.delete(key); return false; }
        return true;
    }

    onStreamReplaced(fn) {
        if (typeof fn === 'function') this.replacedListeners.push(fn);
    }

    setClaimGuard(fn) {
        this.claimGuard = typeof fn === 'function' ? fn : null;
    }

    /** In any arena room — lobby or match. Read-only look at the registry. */
    isInArenaRoom(userId) {
        if (!this.rooms) return false;
        for (const members of this.rooms.values()) {
            if (members.has(userId)) return true;
        }
        return false;
    }

    /**
     * The only entry point that closes streams because of a Classic game.
     * Returns how many were closed; 0 whenever challenge mode is involved or
     * the guard cannot answer.
     */
    async claimForClassic(userId, reason = 'live_game', context = {}) {
        const set = this.connections.get(userId);
        if (!set || set.size <= 1) return 0;
        if (this.isInArenaRoom(userId)) return 0;
        if (!this.claimGuard) return 0;

        const phone = [...set].map(r => r.__wutStream && r.__wutStream.phone).find(Boolean) || null;
        let allowed = false;
        try { allowed = (await this.claimGuard(userId, phone)) === true; }
        catch (e) { allowed = false; }   // unsure means hands off
        if (!allowed) return 0;

        return this.enforceSingleStream(userId, reason, context);
    }

    // ============================================
    // ROOM REGISTRY (live arena)
    // ============================================
    // A room is a set of user ids, and emitRoom() loops the existing per-user
    // emit(). No new connection, no new endpoint, no WebSockets \u2014 the live
    // arena rides the SSE stream that is already open.
    //
    // IN-PROCESS, DELIBERATELY. Like activeTimeouts in game.service, this
    // assumes a single Render instance. A second instance would split rooms in
    // half and neither would see the other's players. That constraint already
    // exists in this codebase; the live arena makes it load-bearing, so it is
    // written down here rather than discovered later.

    joinRoom(challengeId, userId) {
        if (!this.rooms) this.rooms = new Map();
        if (!this.rooms.has(challengeId)) this.rooms.set(challengeId, new Set());
        this.rooms.get(challengeId).add(userId);
        return this.rooms.get(challengeId).size;
    }

    leaveRoom(challengeId, userId) {
        if (!this.rooms || !this.rooms.has(challengeId)) return 0;
        const room = this.rooms.get(challengeId);
        room.delete(userId);
        if (room.size === 0) this.rooms.delete(challengeId);
        return room.size;
    }

    roomMembers(challengeId) {
        if (!this.rooms || !this.rooms.has(challengeId)) return [];
        return [...this.rooms.get(challengeId)];
    }

    closeRoom(challengeId) {
        if (this.rooms) this.rooms.delete(challengeId);
    }

    /**
     * One frame per member. Returns how many actually landed.
     *
     * There is no per-answer fan-out anywhere in the arena: twenty players
     * times fifteen questions times twenty recipients would be 6,000 frames a
     * match. The scoreboard is batched into the reveal frame instead, once per
     * question.
     */
    emitRoom(challengeId, type, payload = {}) {
        let delivered = 0;
        for (const userId of this.roomMembers(challengeId)) {
            if (this.emit(userId, type, payload)) delivered++;
        }
        return delivered;
    }

    // ============================================
    // EMIT
    // ============================================

    /**
     * Push an event to every open connection for a user.
     * Never throws — a dead browser tab must not break the game loop.
     */
    emit(userId, type, payload = {}) {
        const set = this.connections.get(userId);
        if (!set || set.size === 0) return false;


        const frame = `event: ${type}\ndata: ${JSON.stringify({ type, ...payload, at: Date.now() })}\n\n`;
        let delivered = 0;

        for (const res of [...set]) {
            try {
                res.write(frame);
                delivered++;
            } catch (e) {
                set.delete(res);
            }
        }
        return delivered > 0;
    }

    /** Plain text from the game engine — the catch-all fallback. */
    emitMessage(userId, text, extra = {}) {
        return this.emit(userId, 'message', { text, ...extra });
    }

    /**
     * Structured question event. Also snapshotted to Redis so a browser that
     * refreshes or reconnects mid-question can restore its state.
     */
    async emitQuestion(userId, payload) {
        try {
            await redis.setex(`web_snapshot:${userId}`, SNAPSHOT_TTL, JSON.stringify(payload));
        } catch (e) {
            logger.error('Could not snapshot question:', e.message);
        }
        // Classic only: challenge rounds never come through here. A question
        // goes to one stream. See ONE STREAM PER LIVE GAME at the top.
        try {
            await this.claimForClassic(userId, 'live_game', { type: 'question.asked', payload });
        } catch (e) { /* delivery must not depend on this */ }
        return this.emit(userId, 'question.asked', payload);
    }

    /** Latest question snapshot, with the timer recalculated against now. */
    async getSnapshot(userId) {
        try {
            const raw = await redis.get(`web_snapshot:${userId}`);
            if (!raw) return null;

            const snap = JSON.parse(raw);
            if (snap.expiresAt) {
                snap.secondsRemaining = Math.max(0, Math.ceil((snap.expiresAt - Date.now()) / 1000));
                snap.stale = snap.secondsRemaining === 0;
            }
            return snap;
        } catch (e) {
            return null;
        }
    }

    async clearSnapshot(userId) {
        try { await redis.del(`web_snapshot:${userId}`); } catch (e) { /* non-fatal */ }
    }

    // ============================================
    // INTERNAL
    // ============================================

    _heartbeat() {
        // Forget replaced connection ids once they can no longer matter.
        const now = Date.now();
        for (const [key, until] of this.displaced) {
            if (until < now) this.displaced.delete(key);
        }
        for (const [userId, set] of this.connections) {
            for (const res of [...set]) {
                try {
                    res.write(': ping\n\n');
                } catch (e) {
                    set.delete(res);
                }
            }
            if (set.size === 0) this.connections.delete(userId);
        }
    }
}

module.exports = new GameEventsService();