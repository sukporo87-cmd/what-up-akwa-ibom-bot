// ============================================
// FILE: src/services/push.service.js
// Web push for web-play.
// ============================================
//
// WHY THIS EXISTS. A web-only player has no chat identifier, so when their
// challenge lobby opens there is no way to reach them. The lobby-open reminder
// already goes out on WhatsApp and Telegram; this is the same reminder for
// someone who only ever plays in a browser, and it is why `willRemind` could
// not be promised to them before now.
//
// WHAT IT IS NOT. It is not a marketing channel. Every send here is a moment
// the player is already waiting for — their lobby opening, their challenge
// starting. A push that is not the answer to something they asked for is the
// fastest way to lose the permission entirely, and a revoked permission cannot
// be asked for again.
//
// OFF BY DEFAULT, AND SAFE WHEN OFF. Without VAPID keys in the environment
// this service reports itself disabled and every send is a no-op that returns
// quietly. Nothing that calls it needs to know whether it is configured.
//
// THE LIBRARY IS OPTIONAL AT LOAD TIME. `web-push` is required lazily and
// inside a try, so a deploy that has not run `npm install` yet starts normally
// with push switched off, rather than crashing the whole server on boot.

const pool = require('../config/database');
const { logger } = require('../utils/logger');

// The contact address in the VAPID claim. A push service uses it to reach a
// human if a sender starts misbehaving; it is not shown to players.
const CONTACT = process.env.VAPID_SUBJECT || 'mailto:hello@sisystems.ng';

let webpush = null;
let configured = false;
let loadFailed = false;

// Deliberately sticky in both directions: the keys are read once, and a
// process that started without them stays without them until it restarts.
// That is the right behaviour for a credential — re-reading the environment on
// every send would mean a half-configured process silently changing its mind
// mid-run — but it does mean ADDING THE KEYS NEEDS A RESTART, not just a save.
function ensureConfigured() {
    if (configured || loadFailed) return configured;

    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (!publicKey || !privateKey) {
        loadFailed = true;
        logger.info('🔕 Web push is off: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set');
        return false;
    }

    try {
        webpush = require('web-push');
        webpush.setVapidDetails(CONTACT, publicKey, privateKey);
        configured = true;
        logger.info('🔔 Web push ready');
        return true;
    } catch (error) {
        loadFailed = true;
        logger.warn(`🔕 Web push is off: ${error.message}`);
        return false;
    }
}

class PushService {
    constructor() {
        this._schemaReady = false;
    }

    // Idempotent — mirrored in migrations/018-push-subscriptions.sql
    async ensureSchema() {
        if (this._schemaReady) return;
        await pool.query(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                -- The push service's own URL for this device. Unique: a browser
                -- re-subscribing hands back the same endpoint, and two rows for
                -- one device means two notifications for one event.
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                user_agent TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                last_used_at TIMESTAMPTZ,
                -- Consecutive failures. A browser that has been uninstalled
                -- fails forever; this is how the row eventually goes.
                failures SMALLINT NOT NULL DEFAULT 0
            )
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
            ON push_subscriptions (user_id)
        `);
        this._schemaReady = true;
    }

    isEnabled() {
        return ensureConfigured();
    }

    publicKey() {
        return process.env.VAPID_PUBLIC_KEY || null;
    }

    // --------------------------------------------
    // SUBSCRIPTIONS
    // --------------------------------------------

    // A browser hands back the same endpoint when it re-subscribes, so this
    // upserts. It also resets the failure count: the device is demonstrably
    // alive right now, whatever happened to it last week.
    async subscribe(userId, subscription, userAgent) {
        if (!subscription || !subscription.endpoint || !subscription.keys) {
            return { ok: false, error: 'That subscription is incomplete' };
        }
        const { endpoint, keys } = subscription;
        if (!keys.p256dh || !keys.auth) {
            return { ok: false, error: 'That subscription is missing its keys' };
        }
        if (String(endpoint).length > 2000) {
            return { ok: false, error: 'That subscription endpoint is too long' };
        }

        await this.ensureSchema();
        await pool.query(`
            INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (endpoint) DO UPDATE
            SET user_id = EXCLUDED.user_id,
                p256dh = EXCLUDED.p256dh,
                auth = EXCLUDED.auth,
                user_agent = EXCLUDED.user_agent,
                failures = 0
        `, [userId, endpoint, keys.p256dh, keys.auth,
            userAgent ? String(userAgent).slice(0, 300) : null]);

        return { ok: true };
    }

    async unsubscribe(endpoint) {
        if (!endpoint) return { ok: false };
        await this.ensureSchema();
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
        return { ok: true };
    }

    async hasSubscription(userId) {
        if (!this.isEnabled()) return false;
        try {
            await this.ensureSchema();
            const result = await pool.query(
                'SELECT 1 FROM push_subscriptions WHERE user_id = $1 LIMIT 1', [userId]);
            return result.rowCount > 0;
        } catch (error) {
            // Never let a reachability CHECK break the thing that asked.
            return false;
        }
    }

    // --------------------------------------------
    // SENDING
    // --------------------------------------------

    /**
     * Notify one player on every device they have registered.
     *
     * Returns { sent, failed, devices }. NEVER throws and never rejects: this
     * is called from inside a lobby timer and from the challenge arena, and a
     * push failure must not take down the thing that triggered it.
     *
     * payload: { title, body, url, tag }
     *   tag  collapses repeats on the device. Two reminders for the same
     *        challenge replace each other instead of stacking up.
     */
    async notifyUser(userId, payload) {
        if (!this.isEnabled()) return { sent: 0, failed: 0, devices: 0, reason: 'disabled' };

        let rows;
        try {
            await this.ensureSchema();
            const result = await pool.query(
                'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
                [userId]);
            rows = result.rows;
        } catch (error) {
            logger.error(`Could not read push subscriptions for user ${userId}:`, error.message);
            return { sent: 0, failed: 0, devices: 0, reason: 'error' };
        }
        if (!rows.length) return { sent: 0, failed: 0, devices: 0, reason: 'no_devices' };

        const body = JSON.stringify({
            title: payload.title,
            body: payload.body,
            url: payload.url || '/',
            tag: payload.tag || 'wut'
        });

        let sent = 0, failed = 0;
        for (const row of rows) {
            try {
                await webpush.sendNotification({
                    endpoint: row.endpoint,
                    keys: { p256dh: row.p256dh, auth: row.auth }
                }, body, {
                    // A lobby reminder is worthless once the match has started.
                    TTL: Number.isFinite(payload.ttl) ? payload.ttl : 300,
                    urgency: 'high'
                });
                sent++;
                pool.query('UPDATE push_subscriptions SET last_used_at = NOW(), failures = 0 WHERE id = $1',
                    [row.id]).catch(() => {});
            } catch (error) {
                failed++;
                // 404 or 410 is the push service saying this device is gone for
                // good — the browser was uninstalled or the permission revoked.
                // Anything else may be temporary, so it is counted rather than
                // acted on, and the row goes after several in a row.
                const status = error && error.statusCode;
                if (status === 404 || status === 410) {
                    pool.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]).catch(() => {});
                } else {
                    pool.query(`UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1`,
                        [row.id]).catch(() => {});
                    pool.query('DELETE FROM push_subscriptions WHERE id = $1 AND failures >= 8',
                        [row.id]).catch(() => {});
                    logger.warn(`Push to user ${userId} failed (${status || error.message})`);
                }
            }
        }

        return { sent, failed, devices: rows.length };
    }
}

module.exports = new PushService();
// For tests only: the real process reads its keys once and keeps that answer.
module.exports._resetConfigForTests = () => {
    webpush = null; configured = false; loadFailed = false;
};