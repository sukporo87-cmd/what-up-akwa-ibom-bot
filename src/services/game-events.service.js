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
const SNAPSHOT_TTL = 3600;

class GameEventsService {
    constructor() {
        /** @type {Map<number, Set<import('express').Response>>} */
        this.connections = new Map();

        setInterval(() => this._heartbeat(), HEARTBEAT_MS).unref?.();
    }

    // ============================================
    // CONNECTION REGISTRY
    // ============================================

    subscribe(userId, res) {
        if (!this.connections.has(userId)) this.connections.set(userId, new Set());
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