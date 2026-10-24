// ============================================
// FILE: src/services/tv-audit.service.js
// WUT TV in the Audit Trail: Party games, Solo rounds and TV sign-ins, each
// open to the question.
//
// READ ONLY. TV games are kept in their own tables (tv_rooms, tv_answers,
// tv_solo_rounds, tv_sessions) so that they can never touch cash games,
// payouts or player stats. The Audit Trail reads them here; nothing is
// written to game_sessions or game_audit_logs, and nothing here writes at all.
//
// Party: every player's answer to every question (letter, right or wrong,
// time taken; in Race, who took it and the delay allowed for their phone),
// and the points each earned.
// Solo: each answer as given (recorded from migration 023 on; rounds played
// before that show the questions asked and where the round ended).
// ============================================

const pool = require('../config/database');
const tvAuth = require('./tv-auth.service');
const tvFlags = require('./tv-flags.service');

const PAGE = 50;
const DEFAULT_DAYS = 7;
const KINDS = ['party', 'solo', 'signin'];

/** A YYYY-MM-DD date in Lagos time as a timestamp, or null. */
function day(s, endOfDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
    const t = new Date(`${s}T00:00:00+01:00`);
    if (isNaN(t.getTime())) return null;
    return endOfDay ? new Date(t.getTime() + 86400e3) : t;
}

/** A search term for ILIKE, with its wildcards escaped, or null. */
function term(q) {
    const s = String(q || '').trim().slice(0, 60);
    return s ? `%${s.replace(/[\\%_]/g, c => '\\' + c)}%` : null;
}

class TvAuditService {

    _range(opts) {
        const to = day(opts.to, true) || new Date(Date.now() + 60e3);
        const from = day(opts.from, false) || new Date(to.getTime() - DEFAULT_DAYS * 86400e3);
        return [from, to];
    }

    /** One page of Party games, Solo rounds or TV sign-ins, newest first. */
    async search(opts = {}) {
        await tvAuth.ensureSchema();
        const kind = KINDS.includes(opts.kind) ? opts.kind : 'party';
        const [from, to] = this._range(opts);
        const q = term(opts.q);
        const page = Math.max(1, Math.min(200, parseInt(opts.page, 10) || 1));
        const params = [from, to, q, PAGE + 1, (page - 1) * PAGE];
        let r;
        if (kind === 'party') {
            r = await pool.query(
                `SELECT r.id, r.status, r.style, r.close_reason, r.categories, r.result_counted,
                        r.created_at, r.started_at, r.finished_at,
                        d.id AS device_id, COALESCE(d.admin_name, d.details->>'ownName', d.tv_name, d.label) AS tv,
                        (SELECT COUNT(*) FROM tv_players p WHERE p.tv_room_id = r.id AND p.removed_at IS NULL)::int AS players,
                        (SELECT string_agg(COALESCE(u.username, p.display_name), ', ' ORDER BY p.final_rank NULLS LAST, p.id)
                           FROM tv_players p LEFT JOIN users u ON u.id = p.user_id
                          WHERE p.tv_room_id = r.id AND p.removed_at IS NULL) AS who
                 FROM tv_rooms r JOIN tv_devices d ON d.id = r.tv_device_id
                 WHERE r.started_at IS NOT NULL AND r.started_at >= $1 AND r.started_at < $2
                   AND ($3::text IS NULL
                        OR COALESCE(d.admin_name, d.details->>'ownName', d.tv_name, '') ILIKE $3
                        OR EXISTS (SELECT 1 FROM tv_players p LEFT JOIN users u ON u.id = p.user_id
                                    WHERE p.tv_room_id = r.id AND (u.username ILIKE $3 OR p.display_name ILIKE $3)))
                 ORDER BY r.started_at DESC
                 LIMIT $4 OFFSET $5`,
                params
            );
        } else if (kind === 'solo') {
            r = await pool.query(
                `SELECT s.id, s.status, s.end_reason, s.reached, s.correct, s.points, s.category, s.source,
                        s.fifty_used, s.skip_used, s.started_at, s.finished_at, u.username,
                        d.id AS device_id, COALESCE(d.admin_name, d.details->>'ownName', d.tv_name, d.label) AS tv
                 FROM tv_solo_rounds s
                 JOIN tv_devices d ON d.id = s.tv_device_id
                 LEFT JOIN users u ON u.id = s.user_id
                 WHERE s.started_at >= $1 AND s.started_at < $2
                   AND ($3::text IS NULL OR u.username ILIKE $3 OR COALESCE(d.admin_name, d.details->>'ownName', d.tv_name, '') ILIKE $3)
                 ORDER BY s.started_at DESC
                 LIMIT $4 OFFSET $5`,
                params
            );
        } else {
            r = await pool.query(
                `SELECT s.id, u.username, d.id AS device_id, COALESCE(d.admin_name, d.details->>'ownName', d.tv_name, d.label) AS tv,
                        s.created_at, s.last_active_at, s.ended_at, s.end_reason
                 FROM tv_sessions s
                 JOIN users u ON u.id = s.user_id
                 JOIN tv_devices d ON d.id = s.tv_device_id
                 WHERE s.created_at >= $1 AND s.created_at < $2
                   AND ($3::text IS NULL OR u.username ILIKE $3 OR COALESCE(d.admin_name, d.details->>'ownName', d.tv_name, '') ILIKE $3)
                 ORDER BY s.created_at DESC
                 LIMIT $4 OFFSET $5`,
                params
            );
        }
        const more = r.rows.length > PAGE;
        return { ok: true, kind, page, more, from, to, rows: r.rows.slice(0, PAGE) };
    }

    async _questions(ids) {
        if (!ids.length) return new Map();
        const r = await pool.query(
            `SELECT id, question_text, option_a, option_b, option_c, option_d, correct_answer, category, difficulty,
                    image_type, image_data
             FROM questions WHERE id = ANY($1::int[])`,
            [ids]
        );
        return new Map(r.rows.map(q => [Number(q.id), q]));
    }

    /** One Party game, question by question, player by player. */
    async party(roomId) {
        await tvAuth.ensureSchema();
        const room = await pool.query(
            `SELECT r.id, r.status, r.style, r.close_reason, r.categories, r.result_counted, r.join_code,
                    r.created_at, r.started_at, r.finished_at,
                    d.id AS device_id, COALESCE(d.admin_name, d.details->>'ownName', d.tv_name, d.label) AS tv, d.approx_location
             FROM tv_rooms r JOIN tv_devices d ON d.id = r.tv_device_id WHERE r.id = $1`,
            [roomId]
        );
        if (!room.rows[0]) return { ok: false, error: 'No such game' };
        const players = await pool.query(
            `SELECT p.id, p.display_name, p.avatar, u.username, p.joined_at, p.left_at, p.removed_at,
                    p.final_correct, p.final_rank,
                    (SELECT COALESCE(SUM(t.points), 0) FROM tv_points t WHERE t.tv_player_id = p.id)::int AS points
             FROM tv_players p LEFT JOIN users u ON u.id = p.user_id
             WHERE p.tv_room_id = $1
             ORDER BY COALESCE(p.final_rank, 999), p.id`,
            [roomId]
        );
        const slots = await pool.query(
            `SELECT position, question_id FROM tv_room_questions WHERE tv_room_id = $1 ORDER BY position`,
            [roomId]
        );
        const answers = await pool.query(
            `SELECT tv_player_id, position, chosen, is_correct, answer_ms, won, lag_ms
             FROM tv_answers WHERE tv_room_id = $1 ORDER BY position, answer_ms`,
            [roomId]
        );
        const bank = await this._questions(slots.rows.map(s => Number(s.question_id)));
        const questions = slots.rows.map(s => {
            const q = bank.get(Number(s.question_id)) || {};
            return {
                position: s.position, questionId: Number(s.question_id), text: q.question_text || null,
                options: { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d },
                correct: q.correct_answer || null, category: q.category || null, difficulty: q.difficulty || null,
                image: tvFlags.imageFor(q),
                answers: answers.rows.filter(a => a.position === s.position)
            };
        });
        return { ok: true, room: room.rows[0], players: players.rows, questions };
    }

    /** One Solo round, answer by answer. */
    async solo(roundId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `SELECT s.id, s.status, s.end_reason, s.reached, s.correct, s.points, s.category, s.source,
                    s.fifty_used, s.skip_used, s.question_ids, s.answers, s.started_at, s.finished_at,
                    u.username, d.id AS device_id, COALESCE(d.admin_name, d.details->>'ownName', d.tv_name, d.label) AS tv, d.approx_location
             FROM tv_solo_rounds s
             JOIN tv_devices d ON d.id = s.tv_device_id
             LEFT JOIN users u ON u.id = s.user_id
             WHERE s.id = $1`,
            [roundId]
        );
        const round = r.rows[0];
        if (!round) return { ok: false, error: 'No such round' };
        const answers = Array.isArray(round.answers) ? round.answers : [];
        const ids = [...new Set([...(round.question_ids || []).map(Number), ...answers.map(a => Number(a.q))])];
        const bank = await this._questions(ids);
        const pts = await pool.query(
            `SELECT question_number, points FROM tv_points WHERE tv_solo_round_id = $1`, [roundId]
        );
        const pointsAt = new Map(pts.rows.map(p => [Number(p.question_number), Number(p.points)]));
        const show = (id) => {
            const q = bank.get(Number(id)) || {};
            return { questionId: Number(id), text: q.question_text || null,
                     options: { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d },
                     correct: q.correct_answer || null, category: q.category || null, difficulty: q.difficulty || null,
                     image: tvFlags.imageFor(q) };
        };
        const steps = answers.length
            ? answers.map(a => ({ ...show(a.q), position: a.n, chosen: a.chosen, ms: a.ms, result: a.result,
                                  fifty: !!a.fifty, points: a.result === 'correct' ? (pointsAt.get(Number(a.n)) || 0) : 0 }))
            : (round.question_ids || []).map((id, i) => ({ ...show(id), position: null, recorded: false }));
        delete round.answers;
        return { ok: true, round, recorded: answers.length > 0, steps };
    }
}

module.exports = new TvAuditService();
module.exports.KINDS = KINDS;
module.exports.PAGE = PAGE;
