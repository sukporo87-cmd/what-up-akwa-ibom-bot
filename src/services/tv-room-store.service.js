// ============================================
// FILE: src/services/tv-room-store.service.js
// WUT TV — where a Party room lives, and how its events reach the screens.
//
// ROOMS LIVE IN REDIS, NOT IN THE PROCESS. Render restarts this server on
// every deploy, and a TV room in a bar must survive that with its players and
// its current question intact. So the room is one JSON document under
// tv_room:<id>, written on every change. The in-process copy is only a cache
// in front of it: a restart drops the cache and the next read comes from
// Redis. The database (tv_rooms, tv_players, tv_answers) is the record;
// Redis is the live state.
//
// ONE CHANGE AT A TIME PER ROOM. Every mutation runs through withRoom(), which
// queues work per room so two answers arriving in the same millisecond cannot
// both read, modify and overwrite the same document. This assumes one Render
// instance — the same assumption game.service and the challenge arena already
// make. A second instance would need a Redis lock here instead.
//
// EVERY EVENT CARRIES THE ROOM'S rev. Events are numbered from one counter in
// the room document, sent as the SSE `id:` field, and appended to a capped
// Redis list per audience. A TV or phone that reconnects sends Last-Event-ID
// (EventSource does this by itself) and gets what it missed; if the log no
// longer reaches back that far, it gets a snapshot instead.
//
// THIS FILE KNOWS NOTHING ABOUT GAME RULES. It stores, serialises, numbers and
// delivers. The rules are in tv-party.service.js.
//
// SEPARATE FROM game-events.service ON PURPOSE. Web play and the challenge
// arena keep their own registry, untouched. A TV room is addressed by room id
// and player id, never by a user id, because most Party players have no
// account.
// ============================================

const redis = require('../config/redis');
const { logger } = require('../utils/logger');

const ROOM_TTL_SECONDS = 6 * 60 * 60;
const FINISHED_TTL_SECONDS = 60 * 60;
const TV_LOG_CAP = 300;
const PLAYER_LOG_CAP = 80;
const HEARTBEAT_MS = 25000;

const roomKey = id => `tv_room:${id}`;
const tvLogKey = id => `tv_room:${id}:log`;
const playerLogKey = (id, pid) => `tv_room:${id}:p:${pid}`;

class TvRoomStoreService {

    constructor() {
        /** @type {Map<number, object>} roomId -> state (cache in front of Redis) */
        this.cache = new Map();
        /** @type {Map<number, Promise>} roomId -> tail of that room's work queue */
        this.chains = new Map();
        /** @type {Map<number, Set<import('express').Response>>} */
        this.tvConns = new Map();
        /** @type {Map<string, Set<import('express').Response>>} "roomId:playerId" */
        this.playerConns = new Map();
        /** @type {Map<string, number>} "roomId:playerId" -> when their last stream closed */
        this.goneSince = new Map();
        this.bootAt = Date.now();

        this._hb = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
        if (this._hb.unref) this._hb.unref();
    }

    // ============================================
    // STATE
    // ============================================

    async load(roomId) {
        const id = Number(roomId);
        if (this.cache.has(id)) return this.cache.get(id);
        const raw = await redis.get(roomKey(id));
        if (!raw) return null;
        try {
            const state = JSON.parse(raw);
            this.cache.set(id, state);
            return state;
        } catch (e) {
            logger.error(`TV room ${id}: unreadable state in Redis — ${e.message}`);
            return null;
        }
    }

    async _save(state) {
        const ttl = (state.status === 'finished' || state.status === 'closed')
            ? FINISHED_TTL_SECONDS : ROOM_TTL_SECONDS;
        await redis.set(roomKey(state.id), JSON.stringify(state), 'EX', ttl);
        this.cache.set(state.id, state);
    }

    /** First write of a brand-new room. */
    async create(state) {
        state.rev = state.rev || 0;
        state.tvLogCount = state.tvLogCount || 0;
        await this._save(state);
        return state;
    }

    /** Drop the local copy so the next read comes from Redis (used by tests and recovery). */
    forget(roomId) {
        this.cache.delete(Number(roomId));
    }

    // ============================================
    // SERIALISED MUTATION
    // ============================================
    // fn(state, tx) may change state and queue events through tx. After it
    // returns, the state is saved FIRST and the logs written SECOND, so a
    // crash between the two can lose an event from a log but never number two
    // different events with the same rev.

    withRoom(roomId, fn) {
        const id = Number(roomId);
        const prev = this.chains.get(id) || Promise.resolve();
        const run = () => this._run(id, fn);
        const next = prev.then(run, run);
        const tail = next.catch(() => {});
        this.chains.set(id, tail);
        tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id); });
        return next;
    }

    async _run(id, fn) {
        const state = await this.load(id);
        if (!state) return fn(null, null);

        const events = [];
        const tx = {
            dirty: false,
            tv: (type, data = {}, opts = {}) => {
                const rev = ++state.rev;
                events.push({ to: 'tv', type, rev, data, log: opts.log !== false });
                tx.dirty = true;
                return rev;
            },
            player: (pid, type, data = {}, opts = {}) => {
                const rev = ++state.rev;
                events.push({ to: 'player', pid: Number(pid), type, rev, data, log: opts.log !== false });
                tx.dirty = true;
                return rev;
            },
            // Writes that must run after the frames have gone out (closing
            // streams after a room.closed has been delivered, for example).
            after: [],
            // Attach a connection inside the queue, so no event can slip in
            // between the catch-up and the subscription.
            attach: null
        };

        const result = await fn(state, tx);

        if (tx.dirty || events.length) {
            for (const e of events) {
                if (!e.log) continue;
                if (e.to === 'tv') state.tvLogCount = (state.tvLogCount || 0) + 1;
                else if (state.players && state.players[e.pid]) {
                    state.players[e.pid].logCount = (state.players[e.pid].logCount || 0) + 1;
                }
            }
            await this._save(state);
            await this._appendLogs(state, events);
        }

        if (typeof tx.attach === 'function') {
            try { await tx.attach(); } catch (e) { logger.error(`TV room ${id}: attach failed — ${e.message}`); }
        }

        for (const e of events) this._deliver(state.id, e);

        for (const job of tx.after) {
            try { await job(); } catch (e) { logger.error(`TV room ${id}: after-job failed — ${e.message}`); }
        }

        return result;
    }

    async _appendLogs(state, events) {
        const logged = events.filter(e => e.log);
        if (!logged.length) return;
        try {
            const pipe = redis.pipeline();
            const touched = new Map();
            for (const e of logged) {
                const key = e.to === 'tv' ? tvLogKey(state.id) : playerLogKey(state.id, e.pid);
                pipe.rpush(key, JSON.stringify({ rev: e.rev, type: e.type, data: e.data }));
                touched.set(key, e.to === 'tv' ? TV_LOG_CAP : PLAYER_LOG_CAP);
            }
            for (const [key, cap] of touched) {
                pipe.ltrim(key, -cap, -1);
                pipe.expire(key, ROOM_TTL_SECONDS);
            }
            await pipe.exec();
        } catch (e) {
            // A lost log entry costs a reconnecting screen a snapshot instead
            // of a replay. It must never cost the room.
            logger.error(`TV room ${state.id}: event log write failed — ${e.message}`);
        }
    }

    // ============================================
    // DELIVERY
    // ============================================

    _frame(roomId, e) {
        const body = JSON.stringify({ type: e.type, rev: e.rev, roomId, ...e.data, at: Date.now() });
        return `id: ${e.rev}\nevent: ${e.type}\ndata: ${body}\n\n`;
    }

    _write(set, frame) {
        if (!set) return 0;
        let n = 0;
        for (const res of [...set]) {
            try { res.write(frame); n++; } catch (err) { set.delete(res); }
        }
        return n;
    }

    _deliver(roomId, e) {
        const frame = this._frame(roomId, e);
        if (e.to === 'tv') return this._write(this.tvConns.get(roomId), frame);
        // A player's events go to that player's own streams and nowhere else.
        return this._write(this.playerConns.get(`${roomId}:${e.pid}`), frame);
    }

    // ============================================
    // CATCH-UP
    // ============================================
    // Returns the logged events after `since`, or null when the log cannot
    // prove it still holds all of them — in which case the caller sends a
    // snapshot instead of a partial history.

    async eventsSince(state, audience, since, pid = null) {
        const s = Number(since);
        if (!Number.isFinite(s) || s < 0 || s > state.rev) return null;
        if (s === state.rev) return [];

        const key = audience === 'tv' ? tvLogKey(state.id) : playerLogKey(state.id, pid);
        const cap = audience === 'tv' ? TV_LOG_CAP : PLAYER_LOG_CAP;
        const count = audience === 'tv'
            ? (state.tvLogCount || 0)
            : ((state.players && state.players[pid] && state.players[pid].logCount) || 0);

        let rows;
        try { rows = await redis.lrange(key, 0, -1); } catch (e) { return null; }
        const entries = (rows || []).map(r => { try { return JSON.parse(r); } catch (e) { return null; } })
            .filter(Boolean);

        // The log is complete if it never needed trimming and still holds
        // every entry we wrote to it.
        const complete = count <= cap && entries.length === count;
        if (!complete) {
            // Trimmed (or partly lost): only trustworthy if the oldest entry we
            // still hold is the very next event after `since`.
            if (!entries.length || entries[0].rev > s + 1) return null;
        }
        return entries.filter(x => x.rev > s);
    }

    // ============================================
    // CONNECTIONS
    // ============================================

    openStream(res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.write('retry: 3000\n\n');
    }

    writeEvent(res, roomId, e) {
        try { res.write(this._frame(roomId, e)); return true; } catch (err) { return false; }
    }

    addTv(roomId, res) {
        const id = Number(roomId);
        if (!this.tvConns.has(id)) this.tvConns.set(id, new Set());
        this.tvConns.get(id).add(res);
    }

    removeTv(roomId, res) {
        const id = Number(roomId);
        const set = this.tvConns.get(id);
        if (!set) return;
        set.delete(res);
        if (!set.size) this.tvConns.delete(id);
    }

    addPlayer(roomId, pid, res) {
        const key = `${Number(roomId)}:${Number(pid)}`;
        if (!this.playerConns.has(key)) this.playerConns.set(key, new Set());
        this.playerConns.get(key).add(res);
        this.goneSince.delete(key);
    }

    removePlayer(roomId, pid, res) {
        const key = `${Number(roomId)}:${Number(pid)}`;
        const set = this.playerConns.get(key);
        if (!set) return;
        set.delete(res);
        if (!set.size) {
            this.playerConns.delete(key);
            this.goneSince.set(key, Date.now());
        }
    }

    isPlayerConnected(roomId, pid) {
        return (this.playerConns.get(`${Number(roomId)}:${Number(pid)}`)?.size || 0) > 0;
    }

    /** How long this player has had no open stream, in ms (0 if connected). */
    playerGoneFor(roomId, pid) {
        if (this.isPlayerConnected(roomId, pid)) return 0;
        const since = this.goneSince.get(`${Number(roomId)}:${Number(pid)}`) || this.bootAt;
        return Date.now() - since;
    }

    closePlayerStreams(roomId, pid) {
        const key = `${Number(roomId)}:${Number(pid)}`;
        const set = this.playerConns.get(key);
        if (set) for (const res of [...set]) { try { res.end(); } catch (e) { /* gone */ } }
        this.playerConns.delete(key);
    }

    closeRoomStreams(roomId) {
        const id = Number(roomId);
        const tv = this.tvConns.get(id);
        if (tv) for (const res of [...tv]) { try { res.end(); } catch (e) { /* gone */ } }
        this.tvConns.delete(id);
        for (const key of [...this.playerConns.keys()]) {
            if (key.startsWith(`${id}:`)) {
                for (const res of [...this.playerConns.get(key)]) { try { res.end(); } catch (e) { /* gone */ } }
                this.playerConns.delete(key);
            }
        }
    }

    _heartbeat() {
        for (const map of [this.tvConns, this.playerConns]) {
            for (const [key, set] of map) {
                for (const res of [...set]) {
                    try { res.write(': ping\n\n'); } catch (e) { set.delete(res); }
                }
                if (!set.size) map.delete(key);
            }
        }
    }
}

module.exports = new TvRoomStoreService();
module.exports.ROOM_TTL_SECONDS = ROOM_TTL_SECONDS;
module.exports.TV_LOG_CAP = TV_LOG_CAP;
module.exports.PLAYER_LOG_CAP = PLAYER_LOG_CAP;
module.exports.roomKey = roomKey;
