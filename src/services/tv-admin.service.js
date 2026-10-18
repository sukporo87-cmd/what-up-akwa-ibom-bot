// ============================================
// FILE: src/services/tv-admin.service.js
// WUT TV — what the TV admin page reads and does.
//
// READS: live and recent Party rooms, the registered TVs, who is signed in on
// a TV right now, the settings, and every Party category the bank holds.
//
// ACTIONS, each one logged to the admin activity log by the route:
//   * close a live room         through tv-party.closeRoom, reason 'admin',
//                               so every phone and the TV are told
//   * block or unblock a TV     a blocked TV is refused on its next request;
//                               blocking also closes its live room and signs
//                               out whoever is signed in on it
//   * sign someone out of a TV  reason 'admin'
//   * change a setting          tv-settings.service, within its limits
//
// NOTHING HERE TOUCHES MONEY, A USER'S ACCOUNT, OR ANY NON-TV TABLE. It reads
// users only for usernames.
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');
const tvAuth = require('./tv-auth.service');
const party = require('./tv-party.service');
const tvSettings = require('./tv-settings.service');

const RECENT_HOURS = 48;
const IDLE_MINUTES = 15;

class TvAdminService {

    async overview() {
        await tvAuth.ensureSchema();
        const rooms = await pool.query(
            `SELECT r.id, r.join_code, r.status, r.style, r.close_reason, r.categories, r.max_players,
                    r.created_at, r.started_at, r.finished_at, r.result_counted,
                    d.id AS device_id, d.label AS tv_label,
                    (SELECT COUNT(*) FROM tv_players p WHERE p.tv_room_id = r.id AND p.removed_at IS NULL)::int AS players
             FROM tv_rooms r JOIN tv_devices d ON d.id = r.tv_device_id
             WHERE r.status IN ('lobby','playing') OR r.created_at > NOW() - INTERVAL '${RECENT_HOURS} hours'
             ORDER BY (r.status IN ('lobby','playing')) DESC, r.created_at DESC
             LIMIT 100`
        );
        const devices = await pool.query(
            `SELECT d.id, d.label, d.platform, d.app_version, d.first_seen, d.last_seen, d.blocked, d.blocked_reason,
                    (SELECT COUNT(*) FROM tv_rooms r WHERE r.tv_device_id = d.id AND r.created_at > NOW() - INTERVAL '7 days')::int AS rooms_7d,
                    (SELECT COUNT(*) FROM tv_solo_rounds s WHERE s.tv_device_id = d.id AND s.started_at > NOW() - INTERVAL '7 days')::int AS solo_7d
             FROM tv_devices d
             ORDER BY d.last_seen DESC
             LIMIT 200`
        );
        const sessions = await pool.query(
            `SELECT s.id, s.tv_device_id, d.label AS tv_label, u.username, s.created_at, s.last_active_at
             FROM tv_sessions s
             JOIN tv_devices d ON d.id = s.tv_device_id
             JOIN users u ON u.id = s.user_id
             WHERE s.ended_at IS NULL AND s.last_active_at > NOW() - INTERVAL '${IDLE_MINUTES} minutes'
             ORDER BY s.created_at DESC`
        );
        const live = rooms.rows.filter(r => r.status === 'lobby' || r.status === 'playing');
        return {
            ok: true,
            counts: {
                liveRooms: live.length,
                playersInLiveRooms: live.reduce((a, r) => a + Number(r.players || 0), 0),
                tvsSeenToday: devices.rows.filter(d => new Date(d.last_seen).getTime() > Date.now() - 86400e3).length,
                signedIn: sessions.rows.length
            },
            rooms: rooms.rows,
            devices: devices.rows,
            sessions: sessions.rows
        };
    }

    async room(roomId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `SELECT r.id, r.join_code, r.status, r.style, r.close_reason, r.categories, r.created_at, r.started_at,
                    r.finished_at, r.result_counted, d.label AS tv_label
             FROM tv_rooms r JOIN tv_devices d ON d.id = r.tv_device_id WHERE r.id = $1`,
            [roomId]
        );
        if (!r.rows[0]) return { ok: false, error: 'No such room' };
        const players = await pool.query(
            `SELECT p.id, p.display_name, p.avatar, u.username, p.joined_at, p.left_at, p.removed_at,
                    p.final_correct, p.final_rank,
                    (SELECT COALESCE(SUM(t.points), 0) FROM tv_points t WHERE t.tv_player_id = p.id)::int AS points
             FROM tv_players p LEFT JOIN users u ON u.id = p.user_id
             WHERE p.tv_room_id = $1
             ORDER BY COALESCE(p.final_rank, 999), p.id`,
            [roomId]
        );
        return { ok: true, room: r.rows[0], players: players.rows };
    }

    async closeRoom(roomId) {
        const r = await pool.query(`SELECT status FROM tv_rooms WHERE id = $1`, [roomId]);
        if (!r.rows[0]) return { ok: false, error: 'No such room' };
        if (!['lobby', 'playing'].includes(r.rows[0].status)) return { ok: false, error: 'That room has already ended' };
        await party.closeRoom(roomId, 'admin');
        return { ok: true };
    }

    /** Block (or unblock) a TV. Blocking closes its live room and signs out whoever is on it. */
    async setBlocked(deviceId, blocked, reason) {
        await tvAuth.ensureSchema();
        const why = blocked ? (String(reason || '').trim().slice(0, 200) || 'Blocked by admin') : null;
        const r = await pool.query(
            `UPDATE tv_devices SET blocked = $2, blocked_reason = $3 WHERE id = $1 RETURNING id`,
            [deviceId, !!blocked, why]
        );
        if (!r.rows[0]) return { ok: false, error: 'No such TV' };
        let closedRooms = 0;
        let endedSessions = 0;
        if (blocked) {
            const live = await pool.query(
                `SELECT id FROM tv_rooms WHERE tv_device_id = $1 AND status IN ('lobby','playing')`, [deviceId]
            );
            for (const row of live.rows) {
                await party.closeRoom(row.id, 'admin');
                closedRooms++;
            }
            const ended = await pool.query(
                `UPDATE tv_sessions SET ended_at = NOW(), end_reason = 'blocked'
                 WHERE tv_device_id = $1 AND ended_at IS NULL RETURNING id`,
                [deviceId]
            );
            endedSessions = ended.rows.length;
        }
        logger.info(`📺 TV ${deviceId} ${blocked ? 'blocked' : 'unblocked'} by admin`);
        return { ok: true, blocked: !!blocked, closedRooms, endedSessions };
    }

    async endSession(sessionId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `UPDATE tv_sessions SET ended_at = NOW(), end_reason = 'admin'
             WHERE id = $1 AND ended_at IS NULL RETURNING id`,
            [sessionId]
        );
        if (!r.rows[0]) return { ok: false, error: 'That sign-in has already ended' };
        return { ok: true };
    }

    /** The settings page: every value with its limits, the categories, and Play Now's source. */
    async settings() {
        const described = await tvSettings.describe();
        const categories = await party.categoryReport();
        return {
            ok: true, ...described,
            categories: categories.map(c => ({
                category: c.category, ready: !!c.ready, on: c.on,
                total: Number(c.total || 0), thinnest: Number(c.thinnestLevel || 0),
                levels: Number(c.levelsPresent || 0)
            }))
        };
    }

    async setCategory(category, on, admin) {
        const report = await party.categoryReport();
        return tvSettings.setCategory(category, on, report.map(c => c.category), admin);
    }

    async setPlayNowSource(bank, categories, admin) {
        const ready = await party.getCategories();
        return tvSettings.setSource(bank, categories, ready, admin);
    }
}

module.exports = new TvAdminService();
