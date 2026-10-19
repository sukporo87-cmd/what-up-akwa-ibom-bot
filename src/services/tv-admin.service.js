// ============================================
// FILE: src/services/tv-admin.service.js
// WUT TV — what the TV admin page reads and does.
//
// READS: live and recent Party rooms, the registered TVs, who is signed in on
// a TV right now, the settings, and every Party category the bank holds.
//
// ROOMS NOBODY JOINED are left out of the recent list once they have ended:
// a venue TV opens one on its attract screen each hour it stands idle
// (batch 3), and they carry nothing worth reading. A live room is always
// shown, empty or not.
//
// ACTIONS, each one logged to the admin activity log by the route:
//   * close a live room         through tv-party.closeRoom, reason 'admin',
//                               so every phone and the TV are told
//   * block or unblock a TV     a blocked TV is refused on its next request;
//                               blocking also closes its live room and signs
//                               out whoever is signed in on it
//   * sign someone out of a TV  reason 'admin'
//   * change a setting          tv-settings.service, within its limits
//   * name a TV and keep notes  shown wherever the page names that TV
//   * mark a venue TV           its attract screen shows a Party code (batch 3)
//   * the newest app version    older TVs say an update is out (batch 3)
//
// A TV IS CALLED by the name an admin gave it, else its own name (the one
// its owner set in the TV's settings, when that says which TV it is), else
// the name the server gave it (tv-identity.service), else its number. Its details pop-up shows what it
// reports about itself and its approximate place, never its internet address.
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

class TvAdminService {

    async overview() {
        await tvAuth.ensureSchema();
        const rooms = await pool.query(
            `SELECT r.id, r.join_code, r.status, r.style, r.close_reason, r.categories, r.max_players,
                    r.created_at, r.started_at, r.finished_at, r.result_counted,
                    d.id AS device_id, COALESCE(d.admin_name, d.details->>'ownName', d.tv_name, d.label) AS tv_label,
                    (SELECT COUNT(*) FROM tv_players p WHERE p.tv_room_id = r.id AND p.removed_at IS NULL)::int AS players
             FROM tv_rooms r JOIN tv_devices d ON d.id = r.tv_device_id
             WHERE r.status IN ('lobby','playing')
                OR (r.created_at > NOW() - INTERVAL '${RECENT_HOURS} hours'
                    AND EXISTS (SELECT 1 FROM tv_players p WHERE p.tv_room_id = r.id))
             ORDER BY (r.status IN ('lobby','playing')) DESC, r.created_at DESC
             LIMIT 100`
        );
        const devices = await pool.query(
            `SELECT d.id, d.label, d.platform, d.app_version, d.first_seen, d.last_seen, d.blocked, d.blocked_reason,
                    d.tv_name, d.admin_name, d.approx_location, d.venue,
                    d.details->>'manufacturer' AS maker, d.details->>'model' AS model, d.details->>'deviceName' AS own_name,
                    d.details->>'ownName' AS own_label,
                    (SELECT COUNT(*) FROM tv_rooms r WHERE r.tv_device_id = d.id AND r.created_at > NOW() - INTERVAL '7 days')::int AS rooms_7d,
                    (SELECT COUNT(*) FROM tv_solo_rounds s WHERE s.tv_device_id = d.id AND s.started_at > NOW() - INTERVAL '7 days')::int AS solo_7d
             FROM tv_devices d
             ORDER BY d.last_seen DESC
             LIMIT 200`
        );
        const sessions = await pool.query(
            `SELECT s.id, s.tv_device_id, COALESCE(d.admin_name, d.details->>'ownName', d.tv_name, d.label) AS tv_label, u.username, s.created_at, s.last_active_at
             FROM tv_sessions s
             JOIN tv_devices d ON d.id = s.tv_device_id
             JOIN users u ON u.id = s.user_id
             WHERE s.ended_at IS NULL
             ORDER BY s.last_active_at DESC`
        );
        const live = rooms.rows.filter(r => r.status === 'lobby' || r.status === 'playing');
        const latestVersion = (await tvSettings.values())['app.latest_version'] || null;
        return {
            ok: true,
            latestVersion,
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
                    r.finished_at, r.result_counted, COALESCE(d.admin_name, d.details->>'ownName', d.tv_name, d.label) AS tv_label
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

    /**
     * Everything known about one TV, for the details pop-up. Its internet
     * address is used here only to spot a reinstall; it is never sent to the
     * page.
     */
    async device(deviceId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `SELECT d.id, d.label, d.platform, d.app_version, d.first_seen, d.last_seen, d.blocked, d.blocked_reason,
                    d.tv_name, d.admin_name, d.admin_notes, d.details, d.details_at, d.approx_location, d.venue,
                    (SELECT COUNT(*) FROM tv_rooms r WHERE r.tv_device_id = d.id)::int AS rooms_total,
                    (SELECT COUNT(*) FROM tv_rooms r WHERE r.tv_device_id = d.id AND r.status = 'finished')::int AS games_finished,
                    (SELECT COUNT(*) FROM tv_players p JOIN tv_rooms r ON r.id = p.tv_room_id
                      WHERE r.tv_device_id = d.id AND p.removed_at IS NULL)::int AS players_total,
                    (SELECT COUNT(*) FROM tv_solo_rounds s WHERE s.tv_device_id = d.id)::int AS solo_total,
                    (SELECT COUNT(*) FROM tv_sessions s WHERE s.tv_device_id = d.id)::int AS signins_total
             FROM tv_devices d WHERE d.id = $1`,
            [deviceId]
        );
        if (!r.rows[0]) return { ok: false, error: 'No such TV' };
        // Probably the same TV, installed again: same maker, model and own
        // name, from the same local network (the same /24 of addresses).
        const same = await pool.query(
            `SELECT o.id, o.tv_name, o.admin_name, o.app_version, o.first_seen, o.last_seen
             FROM tv_devices o JOIN tv_devices d ON d.id = $1
             WHERE o.id <> d.id
               AND o.details IS NOT NULL AND d.details IS NOT NULL
               AND o.details->>'model' = d.details->>'model'
               AND COALESCE(o.details->>'manufacturer', '') = COALESCE(d.details->>'manufacturer', '')
               AND COALESCE(o.details->>'deviceName', '') = COALESCE(d.details->>'deviceName', '')
               AND network(set_masklen(COALESCE(o.last_ip, o.register_ip), 24)) =
                   network(set_masklen(COALESCE(d.last_ip, d.register_ip), 24))
             ORDER BY o.last_seen DESC
             LIMIT 5`,
            [deviceId]
        );
        const recentRooms = await pool.query(
            `SELECT r.id, r.status, r.style, r.created_at,
                    (SELECT COUNT(*) FROM tv_players p WHERE p.tv_room_id = r.id AND p.removed_at IS NULL)::int AS players
             FROM tv_rooms r WHERE r.tv_device_id = $1 ORDER BY r.created_at DESC LIMIT 5`,
            [deviceId]
        );
        const recentSolo = await pool.query(
            `SELECT s.id, s.status, s.end_reason, s.reached, s.points, s.category, s.source, s.started_at, u.username
             FROM tv_solo_rounds s LEFT JOIN users u ON u.id = s.user_id
             WHERE s.tv_device_id = $1 ORDER BY s.started_at DESC LIMIT 5`,
            [deviceId]
        );
        return { ok: true, device: r.rows[0], sameTv: same.rows, recentRooms: recentRooms.rows, recentSolo: recentSolo.rows };
    }

    /** An admin's name and notes for a TV. Empty clears them. */
    async nameDevice(deviceId, adminName, adminNotes) {
        await tvAuth.ensureSchema();
        const clean = (v, max) => {
            const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
            return s ? s.slice(0, max) : null;
        };
        const name = clean(adminName, 60);
        const notes = adminNotes == null ? null : String(adminNotes).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 500) || null;
        const r = await pool.query(
            `UPDATE tv_devices SET admin_name = $2, admin_notes = $3 WHERE id = $1 RETURNING id`,
            [deviceId, name, notes]
        );
        if (!r.rows[0]) return { ok: false, error: 'No such TV' };
        return { ok: true, adminName: name, adminNotes: notes };
    }

    /**
     * A venue TV (batch 3): its attract screen shows a live Party code and
     * keeps the screen on. The TV picks this up the next time it comes back
     * to its home screen.
     */
    async setVenue(deviceId, on) {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `UPDATE tv_devices SET venue = $2 WHERE id = $1 RETURNING id`,
            [deviceId, on === true]
        );
        if (!r.rows[0]) return { ok: false, error: 'No such TV' };
        return { ok: true, venue: on === true };
    }

    /** The newest TV app version; a TV with an older one says so on its home screen. */
    async setLatestVersion(version, admin) {
        return tvSettings.setLatestVersion(version, admin);
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
