// ============================================
// FILE: src/services/tv-prize.service.js
// WUT TV, phase 5 — a prize on a Party game, paid for by the host, and what
// WUT TV then owes: the winner's prize, or the host's refund.
//
// WHO. The host adds the prize from their phone, playing as their own
// account (18 or over, as for a Challenge prize), and pays the prize and
// WUT TV's fee in one payment.
// Anyone who plays can win it, guest or signed in (026). Standard and Race
// games alike.
//
// THE PRICE (decided Oct 19): the prize plus WUT TV's own fee of 15% of the
// prize, rounded up to the naira. No setup charge and no seats to choose:
// those are Challenge's, for the service Challenge gives, and nothing here
// reads Challenge's price list or its settings. The fee is written onto the
// prize row when the prize is added, so a later change never alters what an
// earlier game owes or returns. setup_charge is kept on the row, always 0,
// and seats records the room's size when the prize was added.
//
// SETTLED, NOT INITIATED. A prize counts only once the payment gateway says
// the money arrived, for at least the amount charged. settle() asks the
// gateway itself; it is called by the payment webhook and by the page the
// gateway sends the host back to, and is safe to call any number of times.
// Until then the game cannot start.
//
// WHO WINS, decided from the database after the game, so a restart cannot
// lose it (resolveRoom):
//   * whoever finished first, provided at least two players finished (the
//     Challenge rule)
//   * fewer than two: the prize goes back to the host; the fee does not
//     (the Challenge rule)
//   * a GUEST winner has 24 hours to collect it, by signing in (or making an
//     account and signing in) on the phone they played on, or with the claim
//     code that phone showed. After that it cannot be claimed. The host is
//     then told and has 48 hours to ask for it back with one tap; a prize not
//     asked for in that time is forfeited. Both rules are shown to the host
//     before paying and to every player when the prize is announced.
//   * a prize game ended after it started: whoever was ahead wins, so a host
//     who is losing cannot end the game to get their prize back
//   * a room closed before the game started: the prize goes back to the host,
//     the fee does not
//   * a room that closed before the payment cleared, or a prize the host
//     cancelled whose payment cleared anyway: everything goes back, fees too,
//     because nothing was delivered
// Never more is paid out than came in.
//
// ITS OWN PAYOUT QUEUE (tv_payouts), apart from the Classic and Challenge
// payouts in transactions, so that it can be made automatic: a payout with
// checked bank details is 'ready', and 'sending' / 'failed' wait for an
// automatic transfer. Today an admin pays it and marks it paid on the WUT TV
// admin page. A winner with bank details already saved on their account has
// them used at once, and can change them until they are paid.
//
// NOTHING OUTSIDE THE TV TABLES IS WRITTEN. users and payout_details are read.
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const tvAuth = require('./tv-auth.service');
const store = require('./tv-room-store.service');
const tvSettings = require('./tv-settings.service');

const PREFIX = 'TVP-';
// 13 and over play; 18 and over put up a prize (the Challenge rule). An age
// that is not recorded is not taken as adult.
const SPONSOR_MIN_AGE = 18;
// WUT TV's fee on a prize: 15% (1,500 basis points), its own, whatever
// Challenge charges.
const FEE_BPS = 1500;
const ATTEMPTS_PER_HOUR = 10;
const BANK_CHECKS_PER_HOUR = 10;
// A payment left waiting is asked about after this long, and given up on after the next.
const ASK_PENDING_AFTER_MS = 20 * 60 * 1000;
const FAIL_PENDING_AFTER_MS = 6 * 60 * 60 * 1000;
const OPEN_PAYOUT = ['awaiting_details', 'ready', 'held', 'sending', 'failed'];
// A guest winner's time to collect, and then the host's time to ask for it back.
const CLAIM_HOURS = 24;
const HOST_ASK_HOURS = 48;
// The claim code: 8 letters and digits, none that look alike, shown as XXXX-XXXX.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CLAIMS_PER_HOUR = 10;
// Prizes still waiting on someone: the game, a guest winner, or the host.
const UNRESOLVED = ['settled', 'claiming', 'unclaimed'];

class TvPrizeService {

    // ============================================
    // HELPERS
    // ============================================

    isPrizeReference(reference) {
        return typeof reference === 'string' && reference.startsWith(PREFIX);
    }

    async _config() {
        return (await tvSettings.values())['prizes.config'];
    }

    async _overLimit(key, limit) {
        try {
            const n = await redis.incr(key);
            if (n === 1) await redis.expire(key, 3600);
            return n > limit;
        } catch (e) { return false; }
    }

    /** The prize, WUT TV's fee and the total. Whole naira; the fee rounds up. */
    price(prizeAmount) {
        const prize = Number(prizeAmount);
        const fee = Math.ceil((prize * FEE_BPS) / 10000);
        return { prize, setupCharge: 0, prizeFee: fee, prizeFeeBps: FEE_BPS, total: prize + fee };
    }
    _gateways() { return require('./payment-gateway-manager'); }

    _activeIds(state) {
        return (state.order || []).filter(pid => {
            const p = state.players[pid];
            return p && !p.leftAt && !p.removedAt;
        });
    }

    /** What the TV and the phones are shown about a prize. Never who paid what, beyond the prize itself. */
    view(row) {
        if (!row) return null;
        return {
            id: Number(row.id),
            status: row.status,
            amount: Number(row.prize_amount),
            seats: Number(row.seats),
            sponsorPlayerId: row.sponsor_player_id ? Number(row.sponsor_player_id) : null,
            winnerPlayerId: row.winner_player_id ? Number(row.winner_player_id) : null,
            outcome: row.outcome_reason || null,
            claimExpiresAt: row.claim_expires_at ? new Date(row.claim_expires_at).toISOString() : null
        };
    }

    _newCode() {
        const bytes = require('crypto').randomBytes(8);
        let out = '';
        for (let i = 0; i < 8; i++) out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
        return out;
    }

    /** As typed: spaces, dashes and case ignored. */
    _normalCode(code) {
        return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    _showCode(code) { return code ? `${code.slice(0, 4)}-${code.slice(4)}` : null; }

    _lagos(t) {
        try {
            return new Date(t).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric',
                                                         month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
        } catch (e) { return new Date(t).toISOString(); }
    }

    async _restoreRoomSize(roomId) {
        const max = (await tvSettings.values())['rooms.max_players'];
        await pool.query(`UPDATE tv_rooms SET max_players = $2 WHERE id = $1`, [roomId, max]);
        return max;
    }

    /** Tells the TV and every phone in the room what the prize now is. */
    async _announce(roomId, view, { restoreSize = false, claimFor = null } = {}) {
        const max = restoreSize ? await this._restoreRoomSize(roomId) : null;
        await store.withRoom(roomId, async (state, tx) => {
            if (!state) return;
            // Taken off, given up on, or handed back while the room is still
            // in its lobby: the room has no prize, and the host may add one.
            const gone = !view || ['cancelled', 'failed'].includes(view.status) ||
                         (view.status === 'refunded' && state.status === 'lobby');
            state.prize = gone ? null : view;
            if (max != null && state.status === 'lobby') state.maxPlayers = max;
            tx.dirty = true;
            tx.tv('room.prize', { prize: state.prize, maxPlayers: state.maxPlayers });
            for (const pid of this._activeIds(state)) {
                const ev = { prize: state.prize, maxPlayers: state.maxPlayers,
                             youWon: !!(state.prize && state.prize.winnerPlayerId === pid) };
                // The claim code goes to the winning phone alone.
                if (claimFor && claimFor.pid === pid) ev.claimCode = this._showCode(claimFor.code);
                tx.player(pid, 'player.prize', ev);
            }
        }).catch(e => logger.error(`TV room ${roomId}: prize not announced — ${e.message}`));
    }

    // ============================================
    // THE PRICE, BEFORE ANYTHING IS PAID
    // ============================================

    async _checkAmount(amount) {
        const cfg = await this._config();
        if (!cfg.on) return { ok: false, reason: 'prizes_off' };
        const amt = Number(amount);
        if (!Number.isInteger(amt) || amt <= 0) return { ok: false, reason: 'bad_amount', min: cfg.min, max: cfg.max };
        if (amt < cfg.min || amt > cfg.max) return { ok: false, reason: 'prize_out_of_range', min: cfg.min, max: cfg.max };
        return { ok: true, amount: amt, cfg };
    }

    /** What the host would pay, itemised. Changes nothing. */
    async quote(roomId, pid, amount) {
        const checked = await this._checkAmount(amount);
        const state = await store.load(roomId);
        if (!state || state.status !== 'lobby') return { ok: false, reason: 'not_in_lobby' };
        if (state.hostPlayerId !== pid) return { ok: false, reason: 'not_host' };
        if (!checked.ok) return checked;
        return { ok: true, min: checked.cfg.min, max: checked.cfg.max, quote: this.price(checked.amount) };
    }

    /** The limits for the host's form, before an amount is typed. */
    async options(roomId, pid) {
        const cfg = await this._config();
        const state = await store.load(roomId);
        if (!state) return { ok: false, reason: 'no_room' };
        return {
            ok: true, on: cfg.on, min: cfg.min, max: cfg.max, feeBps: FEE_BPS,
            prize: state.prize || null, youAreHost: state.hostPlayerId === pid
        };
    }

    // ============================================
    // ADDING A PRIZE — the host, from their phone
    // ============================================

    /**
     * @param account  the signed-in web account on the host's phone (route-checked)
     * @returns { ok, authorizationUrl, reference, quote } — the phone goes to authorizationUrl to pay
     */
    async add(roomId, pid, account, { amount } = {}, platform = 'web') {
        await tvAuth.ensureSchema();
        const checked = await this._checkAmount(amount);
        if (!checked.ok) return checked;
        const u = await pool.query(
            `SELECT id, username, email, phone_number, full_name, is_suspended, age FROM users WHERE id = $1`, [account.id]
        );
        const user = u.rows[0];
        if (!user || user.is_suspended === true) return { ok: false, reason: 'account_unavailable' };
        const age = parseInt(user.age, 10);
        if (!Number.isFinite(age) || age < SPONSOR_MIN_AGE) return { ok: false, reason: 'sponsor_too_young' };
        if (await this._overLimit(`tv_rate:prize:${account.id}`, ATTEMPTS_PER_HOUR)) {
            return { ok: false, reason: 'too_many_attempts' };
        }

        const q = this.price(checked.amount);
        const reference = `${PREFIX}${Number(roomId)}-${user.id}-${Date.now()}`;

        // Reserve the prize on the room first, in one step with the checks,
        // so two taps cannot add two prizes. The payment page is opened after.
        const reserved = await store.withRoom(roomId, async (state, tx) => {
            if (!state || state.status !== 'lobby') return { ok: false, reason: 'not_in_lobby' };
            if (state.hostPlayerId !== pid) return { ok: false, reason: 'not_host' };
            const me = state.players[pid];
            if (!me || me.userId !== user.id) return { ok: false, reason: 'host_not_signed_in' };
            if (state.prize) return { ok: false, reason: 'prize_already_added' };
            // No seats are bought: the row records the room's size, as it is.
            const n = Math.min(20, Math.max(2, Number(state.maxPlayers) || 20));

            let row;
            try {
                const ins = await pool.query(
                    `INSERT INTO tv_prizes (tv_room_id, sponsor_user_id, sponsor_player_id, seats, prize_amount,
                                            setup_charge, prize_fee, total_charged, payment_reference)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
                    [state.id, user.id, pid, n, q.prize, q.setupCharge, q.prizeFee, q.total, reference]
                );
                row = ins.rows[0];
            } catch (e) {
                if (e.code === '23505') return { ok: false, reason: 'prize_already_added' };
                throw e;
            }
            state.prize = this.view(row);
            tx.dirty = true;
            tx.tv('room.prize', { prize: state.prize, maxPlayers: state.maxPlayers });
            for (const x of this._activeIds(state)) tx.player(x, 'player.prize', { prize: state.prize, maxPlayers: state.maxPlayers, youWon: false });
            return { ok: true, row };
        });
        if (!reserved.ok) return reserved;

        // Now the payment page. If it cannot be opened, the prize comes off.
        try {
            const gm = this._gateways();
            const gateway = await gm.getDefaultGateway();
            const init = await gateway.initialize({
                reference,
                amount: q.total,
                email: user.email || `${user.phone_number}@whatsuptrivia.com`,
                callbackUrl: `${process.env.APP_URL || 'https://play.whatsuptrivia.com.ng'}/payment/callback`,
                customerName: user.full_name || user.username,
                metadata: {
                    user_id: user.id, tv_room_id: Number(roomId), tv_prize_id: reserved.row.id,
                    prize_amount: q.prize, prize_fee: q.prizeFee,
                    total_charged: q.total, platform, description: `WUT TV prize, room ${roomId}`
                }
            });
            await pool.query(`UPDATE tv_prizes SET gateway = $2 WHERE id = $1`, [reserved.row.id, gateway.getName()]);
            logger.info(`📺💰 TV room ${roomId}: prize of ₦${q.prize} added by user ${user.id}, ${reference} via ${gateway.getName()}`);
            return {
                ok: true, reference, authorizationUrl: init.authorization_url,
                quote: q
            };
        } catch (e) {
            logger.error(`TV room ${roomId}: payment page not opened for ${reference} — ${e.message}`);
            await pool.query(`UPDATE tv_prizes SET status = 'failed', outcome_reason = 'payment_not_started' WHERE id = $1 AND status = 'pending'`, [reserved.row.id]);
            await this._announce(roomId, { ...this.view(reserved.row), status: 'failed' }, { restoreSize: true });
            return { ok: false, reason: 'payment_unavailable' };
        }
    }

    /** The host takes off a prize that has not been paid. A paid prize cannot be taken off; closing the room refunds it. */
    async cancel(roomId, pid) {
        const out = await store.withRoom(roomId, async (state) => {
            if (!state || state.status !== 'lobby') return { ok: false, reason: 'not_in_lobby' };
            if (state.hostPlayerId !== pid) return { ok: false, reason: 'not_host' };
            if (!state.prize) return { ok: false, reason: 'no_prize' };
            if (state.prize.status !== 'pending') return { ok: false, reason: 'prize_paid' };
            const r = await pool.query(
                `UPDATE tv_prizes SET status = 'cancelled', outcome_reason = 'cancelled_by_host'
                 WHERE id = $1 AND status = 'pending' RETURNING *`,
                [state.prize.id]
            );
            if (!r.rows[0]) return { ok: false, reason: 'prize_paid' };
            return { ok: true, row: r.rows[0] };
        });
        if (!out.ok) return out;
        await this._announce(roomId, this.view(out.row), { restoreSize: true });
        return { ok: true };
    }

    // ============================================
    // SETTLE — the money arrived (webhook, or the host's return from paying)
    // ============================================

    async settle(reference) {
        await tvAuth.ensureSchema();
        if (!this.isPrizeReference(reference)) return { ok: false, reason: 'unknown_reference' };
        const r = await pool.query(`SELECT * FROM tv_prizes WHERE payment_reference = $1`, [reference]);
        const row = r.rows[0];
        if (!row) {
            logger.error(`TV prize payment for unknown reference: ${reference}`);
            return { ok: false, reason: 'unknown_reference' };
        }
        if (['settled', 'awarded', 'refunded', 'claiming', 'unclaimed', 'forfeited'].includes(row.status)) return { ok: true, already: true, prize: this.view(row) };
        if (!row.gateway) return { ok: false, reason: 'not_paid', pending: true };

        // Ask the gateway that took it, never the request that told us.
        let v;
        try { v = await this._gateways().getGateway(row.gateway).verify(reference); }
        catch (e) { logger.error(`TV prize ${reference}: could not verify — ${e.message}`); return { ok: false, reason: 'not_paid', pending: true }; }
        if (!v || !v.success) return { ok: false, reason: 'not_paid', pending: true };
        if (v.currency && v.currency !== 'NGN') {
            logger.error(`TV prize ${reference}: paid in ${v.currency}, expected NGN`);
            return { ok: false, reason: 'wrong_currency' };
        }
        const paid = Number(v.amount) || 0;
        if (paid + 0.009 < Number(row.total_charged)) {
            logger.error(`TV prize ${reference}: paid ₦${paid}, expected ₦${row.total_charged} — left for an admin`);
            return { ok: false, reason: 'short_payment' };
        }

        // Paid after the host took it off, or after its payment was given up
        // on: all of it goes back. Straight to refunded, never through
        // 'settled': the room may already have a new prize waiting, and a
        // room has only one live prize.
        if (row.status !== 'pending') {
            const back = await pool.query(
                `UPDATE tv_prizes SET status = 'refunded', settled_at = NOW(), paid_amount = $2, retained_amount = 0,
                        outcome_reason = 'paid_after_cancel', resolved_at = NOW()
                 WHERE id = $1 AND status IN ('cancelled','failed') RETURNING *`,
                [row.id, paid]
            );
            const done = back.rows[0];
            if (!done) return { ok: true, already: true };
            const amount = this._cap(done, Number(done.total_charged));
            await this._payout(done, 'refund', Number(done.sponsor_user_id), amount);
            logger.info(`📺💰 TV prize ${reference} paid after it was taken off: ₦${amount} all back to user ${done.sponsor_user_id}`);
            await this._tell(Number(done.sponsor_user_id),
                `Your What's Up Trivia TV prize payment of ₦${amount.toLocaleString()} cleared after you took the prize off, so all of it is coming back to you.`,
                `Add or check your bank details here: ${this._prizesUrl()}`,
                `Your WUT TV prize payment is being refunded`);
            return { ok: true, refunded: true };
        }

        const upd = await pool.query(
            `UPDATE tv_prizes SET status = 'settled', settled_at = NOW(), paid_amount = $2
             WHERE id = $1 AND status = 'pending' RETURNING *`,
            [row.id, paid]
        );
        const settled = upd.rows[0];
        if (!settled) return { ok: true, already: true };
        logger.info(`📺💰 TV prize ${reference} settled: ₦${paid} (prize ₦${row.prize_amount})`);
        const room = await pool.query(`SELECT status FROM tv_rooms WHERE id = $1`, [row.tv_room_id]);
        if (!room.rows[0] || room.rows[0].status !== 'lobby') {
            // The room closed while the host was paying: nothing was delivered.
            await this._refund(settled, 'room_closed_before_payment', { full: true });
            return { ok: true, refunded: true };
        }
        await this._announce(row.tv_room_id, this.view(settled));
        return { ok: true, settled: true, prize: this.view(settled), roomId: Number(row.tv_room_id) };
    }

    /** For the page the gateway sends the host back to: where the payment has got to, and the room's code. */
    async status(reference) {
        const r = await pool.query(
            `SELECT p.status, p.prize_amount, r.join_code FROM tv_prizes p JOIN tv_rooms r ON r.id = p.tv_room_id
             WHERE p.payment_reference = $1`,
            [reference]
        );
        return r.rows[0] || null;
    }

    // ============================================
    // AFTER THE GAME — who gets the money
    // ============================================

    /** Idempotent: the first call settles it, any later one finds nothing to do. */
    async resolveRoom(roomId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(`SELECT * FROM tv_prizes WHERE tv_room_id = $1 AND status = 'settled'`, [roomId]);
        const prize = r.rows[0];
        if (!prize) return { ok: true, nothing: true };
        const room = await pool.query(`SELECT id, status, started_at FROM tv_rooms WHERE id = $1`, [roomId]);
        const rm = room.rows[0];
        if (!rm) return { ok: false, reason: 'no_room' };
        if (rm.status === 'lobby' || rm.status === 'playing') return { ok: true, live: true };
        if (!rm.started_at) return this._refund(prize, 'not_played');

        // Placed finishers, guests and accounts alike, best first. A game
        // ended early has its places written when it ended (tv-party closeRoom).
        const placed = await pool.query(
            `SELECT id, user_id, final_rank FROM tv_players
             WHERE tv_room_id = $1 AND final_rank IS NOT NULL AND removed_at IS NULL
             ORDER BY final_rank, id`,
            [roomId]
        );
        if (placed.rows.length < 2) {
            // Ended before a single question was revealed: nobody has a place.
            if (rm.status === 'closed' && placed.rows.length === 0) return this._refund(prize, 'ended_before_a_result');
            return this._refund(prize, 'too_few_finished');
        }
        const winner = placed.rows[0];
        return winner.user_id ? this._award(prize, winner) : this._openClaim(prize, winner);
    }

    // ============================================
    // A GUEST WINNER — 24 hours to collect
    // ============================================

    /** A guest finished first: the prize waits 24 hours for them to sign in and collect it. */
    async _openClaim(prize, winner) {
        const code = this._newCode();
        const upd = await pool.query(
            `UPDATE tv_prizes SET status = 'claiming', winner_player_id = $2, claim_code_hash = $3,
                    claim_expires_at = NOW() + INTERVAL '${CLAIM_HOURS} hours',
                    retained_amount = setup_charge + prize_fee, outcome_reason = 'awaiting_claim'
             WHERE id = $1 AND status = 'settled' RETURNING *`,
            [prize.id, winner.id, tvAuth.hash(code)]
        );
        const row = upd.rows[0];
        if (!row) return { ok: true, already: true };
        // Kept so the winning phone can be shown its code again; only the hash is in the database.
        try { await redis.set(`tv_claim_code:${row.id}`, code, 'EX', (CLAIM_HOURS + 1) * 3600); }
        catch (e) { logger.error(`TV prize ${row.id}: claim code not kept — ${e.message}`); }
        logger.info(`📺💰 TV prize ${row.id}: won by guest player ${winner.id}; ${CLAIM_HOURS} hours to collect`);
        await this._announce(row.tv_room_id, this.view(row), { claimFor: { pid: Number(winner.id), code } });
        await this._tell(Number(row.sponsor_user_id),
            `A guest won your ₦${Number(row.prize_amount).toLocaleString()} What's Up Trivia TV prize. They have ${CLAIM_HOURS} hours to sign in and collect it.`,
            `If nobody collects it, we'll message you, and you'll then have ${HOST_ASK_HOURS} hours to ask for it back.`,
            `A guest won your WUT TV prize`);
        return { ok: true, claiming: true, playerId: Number(winner.id), claimExpiresAt: row.claim_expires_at };
    }

    /** For the winning phone: the prize, and its claim code while it can still be collected. */
    async claimInfo(roomId, playerToken) {
        const p = await this._playerFromToken(roomId, playerToken);
        if (!p.ok) return p;
        const r = await pool.query(`SELECT * FROM tv_prizes WHERE tv_room_id = $1 AND winner_player_id = $2 ORDER BY id DESC LIMIT 1`,
                                   [roomId, p.player.id]);
        const row = r.rows[0];
        if (!row) return { ok: true, prize: null, youWon: false };
        let code = null;
        if (row.status === 'claiming') {
            try { code = await redis.get(`tv_claim_code:${row.id}`); } catch (e) { code = null; }
        }
        return { ok: true, prize: this.view(row), youWon: true, claimCode: this._showCode(code) };
    }

    async _playerFromToken(roomId, playerToken) {
        const parsed = tvAuth.parsePlayerToken(playerToken);
        if (!parsed || parsed.roomId !== roomId) return { ok: false, reason: 'bad_player_token' };
        await tvAuth.ensureSchema();
        const pr = await pool.query(
            `SELECT id, user_id, phone_token_hash, removed_at FROM tv_players WHERE id = $1 AND tv_room_id = $2`,
            [parsed.playerId, roomId]
        );
        const p = pr.rows[0];
        if (!p || !tvAuth.sameHash(p.phone_token_hash, tvAuth.hash(playerToken))) return { ok: false, reason: 'bad_player_token' };
        if (p.removed_at) return { ok: false, reason: 'removed' };
        return { ok: true, player: p };
    }

    /** The guest winner collects on the phone they played on, now signed in. */
    async claim(roomId, playerToken, account) {
        const p = await this._playerFromToken(roomId, playerToken);
        if (!p.ok) return p;
        const r = await pool.query(`SELECT * FROM tv_prizes WHERE tv_room_id = $1 AND winner_player_id = $2 ORDER BY id DESC LIMIT 1`,
                                   [roomId, p.player.id]);
        if (!r.rows[0]) return { ok: false, reason: 'not_the_winner' };
        return this._claim(r.rows[0], account);
    }

    /** The guest winner collects with the code their phone showed, from any device, signed in. */
    async claimByCode(code, account) {
        await tvAuth.ensureSchema();
        const c = this._normalCode(code);
        if (c.length !== 8) return { ok: false, reason: 'bad_claim_code' };
        if (await this._overLimit(`tv_rate:claim:${account.id}`, CLAIMS_PER_HOUR)) return { ok: false, reason: 'too_many_attempts' };
        const r = await pool.query(`SELECT * FROM tv_prizes WHERE claim_code_hash = $1`, [tvAuth.hash(c)]);
        if (!r.rows[0]) return { ok: false, reason: 'bad_claim_code' };
        return this._claim(r.rows[0], account);
    }

    async _claim(prize, account) {
        if (prize.status === 'awarded') return { ok: false, reason: 'already_claimed' };
        if (prize.status !== 'claiming' || new Date(prize.claim_expires_at).getTime() <= Date.now()) {
            return { ok: false, reason: 'claim_expired' };
        }
        const u = await pool.query(`SELECT id, username, is_suspended FROM users WHERE id = $1`, [account.id]);
        const user = u.rows[0];
        if (!user || user.is_suspended === true) return { ok: false, reason: 'account_unavailable' };
        // One person, one share of a room: an account that played in it, or
        // kept points from another phone in it, cannot also collect its prize.
        const inRoom = await pool.query(
            `SELECT 1 FROM tv_players WHERE tv_room_id = $1 AND user_id = $2 LIMIT 1`, [prize.tv_room_id, user.id]
        );
        const other = await pool.query(
            `SELECT 1 FROM tv_points WHERE tv_room_id = $1 AND user_id = $2 AND tv_player_id <> $3 LIMIT 1`,
            [prize.tv_room_id, user.id, prize.winner_player_id]
        );
        if (inRoom.rows[0] || other.rows[0]) return { ok: false, reason: 'account_in_room' };

        // In one step, and only while the 24 hours last: two accounts racing get one prize.
        const upd = await pool.query(
            `UPDATE tv_prizes SET status = 'awarded', winner_user_id = $2, claimed_at = NOW(), claim_code_hash = NULL,
                    outcome_reason = 'claimed', resolved_at = NOW()
             WHERE id = $1 AND status = 'claiming' AND claim_expires_at > NOW() RETURNING *`,
            [prize.id, user.id]
        );
        const row = upd.rows[0];
        if (!row) {
            // Someone else collected it a moment ago, or the 24 hours ran out.
            const now = await pool.query(`SELECT * FROM tv_prizes WHERE id = $1`, [prize.id]);
            return { ok: false, reason: now.rows[0] && now.rows[0].status === 'awarded' ? 'already_claimed' : 'claim_expired' };
        }
        try { await redis.del(`tv_claim_code:${row.id}`); } catch (e) { /* it expires anyway */ }
        // The winner's points from that game go to the account too.
        const moved = await pool.query(
            `UPDATE tv_points SET user_id = $1, claimed_at = NOW() WHERE tv_player_id = $2 AND user_id IS NULL RETURNING points`,
            [user.id, row.winner_player_id]
        );
        const kept = moved.rows.reduce((a, x) => a + Number(x.points), 0);
        const amount = this._cap(row, Number(row.prize_amount));
        const payout = await this._payout(row, 'prize', Number(user.id), amount);
        logger.info(`📺💰 TV prize ${row.id}: ₦${amount} collected by user ${user.id} (guest player ${row.winner_player_id}), payout ${payout && payout.id}`);
        await this._announce(row.tv_room_id, this.view(row));
        await this._tell(Number(user.id),
            `🏆 You collected ₦${amount.toLocaleString()} from a What's Up Trivia TV game!`,
            `To get paid, add or check your bank details here: ${this._prizesUrl()}`,
            `You won ₦${amount.toLocaleString()} on What's Up Trivia TV`);
        return { ok: true, claimed: true, amount, kept, username: user.username, payoutId: payout && payout.id };
    }

    // ============================================
    // NOT COLLECTED — the host has 48 hours to ask for it back
    // ============================================

    /** One tap from the host's prizes page. The fee is not returned. */
    async askBack(userId, prizeId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(`SELECT * FROM tv_prizes WHERE id = $1`, [prizeId]);
        const row = r.rows[0];
        if (!row || Number(row.sponsor_user_id) !== Number(userId)) return { ok: false, reason: 'not_yours' };
        if (row.status !== 'unclaimed' || row.host_asked_at) return { ok: false, reason: 'too_late' };
        const asked = await pool.query(
            `UPDATE tv_prizes SET host_asked_at = NOW()
             WHERE id = $1 AND status = 'unclaimed' AND host_asked_at IS NULL AND host_window_ends_at > NOW() RETURNING *`,
            [row.id]
        );
        if (!asked.rows[0]) return { ok: false, reason: 'too_late' };
        logger.info(`📺💰 TV prize ${row.id}: host ${userId} asked for the unclaimed prize back`);
        return this._refund(asked.rows[0], 'unclaimed_host_asked', { from: ['unclaimed'] });
    }

    async _savedDetails(userId) {
        try {
            const r = await pool.query(
                `SELECT account_name, account_number, bank_name, bank_code, verified FROM payout_details
                 WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [userId]
            );
            const d = r.rows[0];
            if (!d || !/^\d{10}$/.test(String(d.account_number || '')) || !d.bank_code) return null;
            return d;
        } catch (e) { return null; }
    }

    async _payout(prize, kind, userId, amount) {
        const saved = await this._savedDetails(userId);
        const ins = await pool.query(
            `INSERT INTO tv_payouts (tv_prize_id, kind, user_id, amount, status, bank_name, bank_code,
                                     account_number, account_name, details_verified, details_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (tv_prize_id, kind) DO NOTHING
             RETURNING id, status`,
            [prize.id, kind, userId, amount, saved ? 'ready' : 'awaiting_details',
             saved ? saved.bank_name : null, saved ? String(saved.bank_code) : null,
             saved ? String(saved.account_number) : null, saved ? saved.account_name : null,
             !!(saved && saved.verified === true), saved ? new Date() : null]
        );
        return ins.rows[0] || null;
    }

    /** Never more out than came in. */
    _cap(prize, amount) {
        const paid = prize.paid_amount == null ? Number(prize.total_charged) : Math.floor(Number(prize.paid_amount));
        return Math.max(0, Math.min(amount, paid));
    }

    async _award(prize, winner) {
        const upd = await pool.query(
            `UPDATE tv_prizes SET status = 'awarded', winner_user_id = $2, winner_player_id = $3,
                    retained_amount = setup_charge + prize_fee, outcome_reason = 'won', resolved_at = NOW()
             WHERE id = $1 AND status = 'settled' RETURNING *`,
            [prize.id, winner.user_id, winner.id]
        );
        const row = upd.rows[0];
        if (!row) return { ok: true, already: true };
        const amount = this._cap(row, Number(row.prize_amount));
        const payout = await this._payout(row, 'prize', Number(winner.user_id), amount);
        logger.info(`📺💰 TV prize ${row.id}: ₦${amount} won by user ${winner.user_id} (player ${winner.id}), payout ${payout && payout.id}`);
        await this._announce(row.tv_room_id, this.view(row));
        await this._tell(Number(winner.user_id),
            `🏆 You won ₦${amount.toLocaleString()} in a What's Up Trivia TV game!`,
            `To get paid, add or check your bank details here: ${this._prizesUrl()}`,
            `You won ₦${amount.toLocaleString()} on What's Up Trivia TV`);
        return { ok: true, awarded: true, amount, winnerUserId: Number(winner.user_id), payoutId: payout && payout.id };
    }

    async _refund(prize, reason, { full = false, from = ['settled'] } = {}) {
        const retained = full ? 0 : Number(prize.setup_charge) + Number(prize.prize_fee);
        const upd = await pool.query(
            `UPDATE tv_prizes SET status = 'refunded', retained_amount = $2, outcome_reason = $3, forfeited_amount = NULL,
                    claim_code_hash = NULL, resolved_at = NOW()
             WHERE id = $1 AND status = ANY($4::text[]) RETURNING *`,
            [prize.id, retained, reason, from]
        );
        const row = upd.rows[0];
        if (!row) return { ok: true, already: true };
        const amount = this._cap(row, full ? Number(row.total_charged) : Number(row.prize_amount));
        const payout = amount > 0 ? await this._payout(row, 'refund', Number(row.sponsor_user_id), amount) : null;
        logger.info(`📺💰 TV prize ${row.id} refunded (${reason}): ₦${amount} back to user ${row.sponsor_user_id}, ₦${retained} kept`);
        await this._announce(row.tv_room_id, this.view(row));
        const why = {
            not_played: 'the game never started',
            ended_before_a_result: 'the game ended before any question was answered',
            too_few_signed_in: 'fewer than two signed-in players finished',
            too_few_finished: 'fewer than two players finished',
            unclaimed_host_asked: 'you asked for it back after nobody collected it',
            returned_by_admin: 'our team returned it to you',
            room_closed_before_payment: 'the game had already closed when your payment cleared',
            paid_after_cancel: 'you had taken the prize off before your payment cleared'
        }[reason] || 'the game did not produce a winner';
        await this._tell(Number(row.sponsor_user_id),
            `Your What's Up Trivia TV prize is coming back to you: ₦${amount.toLocaleString()}, because ${why}.`,
            `Add or check your bank details here: ${this._prizesUrl()}`,
            `Your WUT TV prize is being refunded`);
        return { ok: true, refunded: true, amount, retained, reason, payoutId: payout && payout.id };
    }

    _prizesUrl() {
        return `${process.env.WEB_PLAY_URL || 'https://play.whatsuptrivia.com.ng'}/tv/prizes`;
    }

    /** A message in the person's usual channel. Never fails the money step. */
    async _tell(userId, line1, line2, subject) {
        try {
            const r = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
            if (!r.rows[0]) return;
            await require('./contact.service').send(r.rows[0], { text: `${line1}\n\n${line2}`, subject, kind: 'transactional' });
        } catch (e) { logger.error(`TV prize: could not tell user ${userId} — ${e.message}`); }
    }

    // ============================================
    // GETTING PAID — the winner (or refunded host), signed in
    // ============================================

    /** Everything WUT TV owes this account, and the bank account saved on it, if any. */
    async mine(userId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `SELECT po.id, po.kind, po.amount, po.status, po.bank_name, po.account_name,
                    RIGHT(po.account_number, 4) AS last4, po.details_verified, po.created_at, po.paid_at,
                    po.paid_reference, po.received_at, po.not_received_at,
                    pr.tv_room_id, pr.prize_amount, pr.outcome_reason
             FROM tv_payouts po JOIN tv_prizes pr ON pr.id = po.tv_prize_id
             WHERE po.user_id = $1
             ORDER BY po.created_at DESC
             LIMIT 50`,
            [userId]
        );
        const saved = await this._savedDetails(userId);
        // Prizes this host put up that nobody collected, still in time to ask for.
        const asks = await pool.query(
            `SELECT id, prize_amount, host_window_ends_at FROM tv_prizes
             WHERE sponsor_user_id = $1 AND status = 'unclaimed' AND host_asked_at IS NULL AND host_window_ends_at > NOW()
             ORDER BY id DESC`,
            [userId]
        );
        return {
            ok: true,
            asks: asks.rows.map(x => ({ id: Number(x.id), amount: Number(x.prize_amount), until: x.host_window_ends_at })),
            payouts: r.rows.map(x => ({ ...x, amount: Number(x.amount), prize_amount: Number(x.prize_amount) })),
            saved: saved ? { bankName: saved.bank_name, accountName: saved.account_name, last4: String(saved.account_number).slice(-4) } : null
        };
    }

    async banks() {
        const BankService = require('./bank.service');
        const list = await new BankService().getBankList();
        return { ok: true, banks: list.map(b => ({ name: b.name, code: b.code })) };
    }

    /**
     * Where to send the money. The account name comes from the bank (the same
     * check Classic payouts use), never from what was typed. Changeable until
     * the payout is held, being sent, or paid.
     */
    async submitDetails(userId, payoutId, body = {}) {
        await tvAuth.ensureSchema();
        const r = await pool.query(`SELECT id, user_id, status FROM tv_payouts WHERE id = $1`, [payoutId]);
        const po = r.rows[0];
        if (!po || Number(po.user_id) !== Number(userId)) return { ok: false, reason: 'not_yours' };
        if (!['awaiting_details', 'ready', 'failed'].includes(po.status)) return { ok: false, reason: 'too_late' };

        let d;
        if (body.useSaved === true) {
            const saved = await this._savedDetails(userId);
            if (!saved) return { ok: false, reason: 'no_saved_details' };
            d = { bank_name: saved.bank_name, bank_code: String(saved.bank_code), account_number: String(saved.account_number),
                  account_name: saved.account_name, verified: saved.verified === true };
        } else {
            const number = String(body.accountNumber || '').replace(/\s+/g, '');
            const code = String(body.bankCode || '').trim();
            if (!/^\d{10}$/.test(number)) return { ok: false, reason: 'bad_account_number' };
            if (!code) return { ok: false, reason: 'pick_a_bank' };
            if (await this._overLimit(`tv_rate:bank:${userId}`, BANK_CHECKS_PER_HOUR)) return { ok: false, reason: 'too_many_attempts' };
            const BankService = require('./bank.service');
            const bank = new BankService();
            const list = await bank.getBankList();
            const named = list.find(b => String(b.code) === code);
            if (!named) return { ok: false, reason: 'pick_a_bank' };
            const v = await bank.verifyBankAccount(number, code, named.name);
            if (!v || !v.verified) return { ok: false, reason: 'account_not_verified' };
            d = { bank_name: named.name, bank_code: String(v.bankCode || code), account_number: String(v.accountNumber || number),
                  account_name: v.accountName, verified: true };
        }
        const upd = await pool.query(
            `UPDATE tv_payouts SET bank_name = $2, bank_code = $3, account_number = $4, account_name = $5,
                    details_verified = $6, details_at = NOW(), status = 'ready'
             WHERE id = $1 AND status IN ('awaiting_details','ready','failed')
             RETURNING id, status, bank_name, account_name, RIGHT(account_number, 4) AS last4`,
            [po.id, d.bank_name, d.bank_code, d.account_number, d.account_name, d.verified]
        );
        if (!upd.rows[0]) return { ok: false, reason: 'too_late' };
        return { ok: true, payout: upd.rows[0] };
    }

    // ============================================
    // HOUSEKEEPING — run by the Party sweep
    // ============================================

    async sweep() {
        await tvAuth.ensureSchema();
        // A payment left waiting: asked about once it is twenty minutes old,
        // given up on after six hours, with the room's prize taken off.
        const pend = await pool.query(
            `SELECT * FROM tv_prizes WHERE status = 'pending' AND created_at < NOW() - INTERVAL '20 minutes' ORDER BY id LIMIT 50`
        );
        for (const p of pend.rows) {
            const out = await this.settle(p.payment_reference).catch(() => ({ ok: false }));
            if (out.ok) continue;
            if (Date.now() - new Date(p.created_at).getTime() > FAIL_PENDING_AFTER_MS) {
                const f = await pool.query(
                    `UPDATE tv_prizes SET status = 'failed', outcome_reason = 'payment_not_completed'
                     WHERE id = $1 AND status = 'pending' RETURNING *`,
                    [p.id]
                );
                if (f.rows[0]) await this._announce(p.tv_room_id, this.view(f.rows[0]), { restoreSize: true });
            }
        }
        // A paid prize whose room has ended without being settled (a restart
        // at the wrong moment): settled now.
        const open = await pool.query(
            `SELECT p.tv_room_id FROM tv_prizes p JOIN tv_rooms r ON r.id = p.tv_room_id
             WHERE p.status = 'settled' AND r.status IN ('finished','closed') LIMIT 50`
        );
        for (const x of open.rows) await this.resolveRoom(x.tv_room_id).catch(e => logger.error(`TV prize sweep: ${e.message}`));
        const lapsed = await this._sweepClaims().catch(e => { logger.error(`TV prize sweep, claims: ${e.message}`); return {}; });
        return { asked: pend.rows.length, resolved: open.rows.length, ...lapsed };
    }

    /** The 24 hours to collect run out, then the host's 48 hours to ask. */
    async _sweepClaims() {
        const due = await pool.query(
            `SELECT id FROM tv_prizes WHERE status = 'claiming' AND claim_expires_at <= NOW() ORDER BY id LIMIT 50`
        );
        let unclaimed = 0, forfeited = 0;
        for (const x of due.rows) {
            const u = await pool.query(
                `UPDATE tv_prizes SET status = 'unclaimed', claim_code_hash = NULL, outcome_reason = 'not_claimed',
                        host_window_ends_at = NOW() + INTERVAL '${HOST_ASK_HOURS} hours'
                 WHERE id = $1 AND status = 'claiming' AND claim_expires_at <= NOW() RETURNING *`,
                [x.id]
            );
            const row = u.rows[0];
            if (!row) continue;
            unclaimed++;
            try { await redis.del(`tv_claim_code:${row.id}`); } catch (e) { /* it expires anyway */ }
            logger.info(`📺💰 TV prize ${row.id}: not collected; host ${row.sponsor_user_id} has ${HOST_ASK_HOURS} hours to ask for it back`);
            await this._announce(row.tv_room_id, this.view(row));
            await this._tell(Number(row.sponsor_user_id),
                `Nobody collected the ₦${Number(row.prize_amount).toLocaleString()} prize from your What's Up Trivia TV game in time.`,
                `You can ask for it back until ${this._lagos(row.host_window_ends_at)} (Lagos time). Tap "Ask for my prize back" here: ${this._prizesUrl()}\n` +
                `The fee is not returned. If you don't ask by then, the prize is forfeited.`,
                `Your WUT TV prize was not collected: ask for it back within ${HOST_ASK_HOURS} hours`);
        }
        const over = await pool.query(
            `SELECT id FROM tv_prizes WHERE status = 'unclaimed' AND host_asked_at IS NULL AND host_window_ends_at <= NOW() ORDER BY id LIMIT 50`
        );
        for (const x of over.rows) {
            const cur = await pool.query(`SELECT * FROM tv_prizes WHERE id = $1`, [x.id]);
            if (!cur.rows[0]) continue;
            const f = await pool.query(
                `UPDATE tv_prizes SET status = 'forfeited', forfeited_amount = $2, outcome_reason = 'forfeited', resolved_at = NOW()
                 WHERE id = $1 AND status = 'unclaimed' AND host_asked_at IS NULL AND host_window_ends_at <= NOW() RETURNING *`,
                [x.id, this._cap(cur.rows[0], Number(cur.rows[0].prize_amount))]
            );
            const row = f.rows[0];
            if (!row) continue;
            forfeited++;
            logger.info(`📺💰 TV prize ${row.id}: forfeited (₦${row.forfeited_amount}); the host did not ask for it back`);
            await this._tell(Number(row.sponsor_user_id),
                `Your ₦${Number(row.prize_amount).toLocaleString()} What's Up Trivia TV prize has been forfeited.`,
                `Nobody collected it within ${CLAIM_HOURS} hours, and it was not asked back within the ${HOST_ASK_HOURS} hours after. ` +
                `If you think this is a mistake, contact What's Up Trivia support.`,
                `Your WUT TV prize has been forfeited`);
        }
        return { unclaimed, forfeited };
    }

    // ============================================
    // THE ADMIN PAGE — Super Admin and Finance Officer only (the route checks)
    // ============================================

    async adminOverview() {
        await tvAuth.ensureSchema();
        const prizes = await pool.query(
            `SELECT p.id, p.tv_room_id, p.seats, p.prize_amount, p.setup_charge, p.prize_fee, p.total_charged,
                    p.paid_amount, p.status, p.outcome_reason, p.retained_amount, p.gateway, p.payment_reference,
                    p.created_at, p.settled_at, p.resolved_at, p.claim_expires_at, p.claimed_at, p.host_window_ends_at,
                    p.host_asked_at, p.forfeited_amount, s.username AS sponsor, w.username AS winner, wp.display_name AS winner_name
             FROM tv_prizes p
             JOIN users s ON s.id = p.sponsor_user_id
             LEFT JOIN users w ON w.id = p.winner_user_id
             LEFT JOIN tv_players wp ON wp.id = p.winner_player_id
             ORDER BY p.created_at DESC
             LIMIT 100`
        );
        const payouts = await pool.query(
            `SELECT po.id, po.tv_prize_id, po.kind, po.amount, po.status, po.hold_reason, po.bank_name, po.bank_code,
                    po.account_number, po.account_name, po.details_verified, po.details_at, po.paid_at,
                    po.paid_reference, po.paid_by, po.created_at, po.received_at, po.not_received_at, u.username, pr.tv_room_id
             FROM tv_payouts po
             JOIN users u ON u.id = po.user_id
             JOIN tv_prizes pr ON pr.id = po.tv_prize_id
             ORDER BY (po.status IN ('awaiting_details','ready','held','sending','failed')) DESC, po.created_at DESC
             LIMIT 200`
        );
        return {
            ok: true,
            config: await this._config(),
            summary: await this.financials(),
            prizes: prizes.rows,
            payouts: payouts.rows
        };
    }

    /** An admin hands an unclaimed or forfeited prize back to the host, after the host got in touch. */
    async returnToHost(prizeId, admin) {
        await tvAuth.ensureSchema();
        const r = await pool.query(`SELECT * FROM tv_prizes WHERE id = $1`, [prizeId]);
        const row = r.rows[0];
        if (!row) return { ok: false, error: 'No such prize' };
        if (!['unclaimed', 'forfeited'].includes(row.status)) return { ok: false, error: 'Only an unclaimed or forfeited prize can be returned' };
        logger.info(`📺💰 TV prize ${row.id}: returned to host ${row.sponsor_user_id} by ${admin || 'admin'}`);
        const out = await this._refund(row, 'returned_by_admin', { from: ['unclaimed', 'forfeited'] });
        if (out.already) return { ok: false, error: 'That prize has just changed; refresh and look again' };
        return { ok: true, amount: out.amount, payoutId: out.payoutId };
    }

    async referenceOf(prizeId) {
        const r = await pool.query(`SELECT payment_reference FROM tv_prizes WHERE id = $1`, [prizeId]);
        return r.rows[0] ? r.rows[0].payment_reference : null;
    }

    async _setPayout(payoutId, fromStatuses, sets, params) {
        const r = await pool.query(
            `UPDATE tv_payouts SET ${sets} WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
            [payoutId, fromStatuses, ...params]
        );
        return r.rows[0] || null;
    }

    /** Recorded as paid, with the bank transfer's reference. The money is sent outside the app, for now. */
    async markPaid(payoutId, reference, admin) {
        const ref = String(reference || '').trim().slice(0, 100);
        if (!ref) return { ok: false, error: 'The transfer reference is needed' };
        const cur = await pool.query(`SELECT status, account_number FROM tv_payouts WHERE id = $1`, [payoutId]);
        if (!cur.rows[0]) return { ok: false, error: 'No such payout' };
        if (!cur.rows[0].account_number) return { ok: false, error: 'There are no bank details yet' };
        const row = await this._setPayout(payoutId, ['ready', 'failed'],
            `status = 'paid', paid_at = NOW(), paid_reference = $3, paid_by = $4`, [ref, admin || 'admin']);
        if (!row) return { ok: false, error: `Cannot mark a ${cur.rows[0].status.replace('_', ' ')} payout as paid` };
        logger.info(`📺💰 TV payout ${payoutId} (₦${row.amount}) marked paid by ${admin}, ref ${ref}`);
        // As Classic does: the winner is told what was sent, where, and the
        // reference, and asked to confirm it arrived.
        await this._tell(Number(row.user_id),
            `✅ Payment sent: ₦${Number(row.amount).toLocaleString()} from What's Up Trivia TV has been sent to ` +
            `${row.account_name || 'your account'}, ${row.bank_name || 'your bank'} ••${String(row.account_number || '').slice(-4)}.\n` +
            `Transfer reference: ${ref}`,
            `Please check your account, then confirm it arrived, or tell us it hasn't, here: ${this._prizesUrl()}`,
            `Your ₦${Number(row.amount).toLocaleString()} WUT TV prize has been sent`);
        return { ok: true, payout: row };
    }

    /** The winner (or refunded host) says the money arrived. Only for their own payout, once it is marked paid. */
    async confirmReceived(userId, payoutId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `UPDATE tv_payouts SET received_at = NOW(), not_received_at = NULL
             WHERE id = $1 AND user_id = $2 AND status = 'paid' AND received_at IS NULL
             RETURNING id, received_at`,
            [payoutId, userId]
        );
        if (!r.rows[0]) return this._whyNot(userId, payoutId, 'already_confirmed');
        logger.info(`📺💰 TV payout ${payoutId}: user ${userId} confirmed it arrived`);
        return { ok: true, receivedAt: r.rows[0].received_at };
    }

    /** The winner says it has not arrived: flagged on the admin page. They can still confirm it later. */
    async reportNotReceived(userId, payoutId) {
        await tvAuth.ensureSchema();
        const r = await pool.query(
            `UPDATE tv_payouts SET not_received_at = NOW()
             WHERE id = $1 AND user_id = $2 AND status = 'paid' AND received_at IS NULL
             RETURNING id, not_received_at`,
            [payoutId, userId]
        );
        if (!r.rows[0]) return this._whyNot(userId, payoutId, 'already_confirmed');
        logger.warn(`📺💰 TV payout ${payoutId}: user ${userId} says it has NOT arrived`);
        return { ok: true, notReceivedAt: r.rows[0].not_received_at };
    }

    async _whyNot(userId, payoutId, fallback) {
        const c = await pool.query(`SELECT id, user_id, status FROM tv_payouts WHERE id = $1`, [payoutId]);
        const po = c.rows[0];
        if (!po || Number(po.user_id) !== Number(userId)) return { ok: false, reason: 'not_yours' };
        if (po.status !== 'paid') return { ok: false, reason: 'not_paid_yet' };
        return { ok: false, reason: fallback };
    }

    async hold(payoutId, reason) {
        const why = String(reason || '').trim().slice(0, 200) || 'Held for review';
        const row = await this._setPayout(payoutId, ['awaiting_details', 'ready', 'failed'],
            `status = 'held', hold_reason = $3`, [why]);
        if (!row) return { ok: false, error: 'Only an unpaid payout can be held' };
        return { ok: true, payout: row };
    }

    async release(payoutId) {
        const row = await this._setPayout(payoutId, ['held'],
            `status = CASE WHEN account_number IS NULL THEN 'awaiting_details' ELSE 'ready' END, hold_reason = NULL`, []);
        if (!row) return { ok: false, error: 'That payout is not held' };
        return { ok: true, payout: row };
    }

    /**
     * For Financials and the Prizes tab. Revenue is the setup charges and fees
     * kept: counted once a payment has settled, and not at all when every
     * naira went back. A prize is not revenue: it is the host's money passing
     * through, shown apart. A forfeited prize is kept, but shown on its own
     * line, never mixed into the fees.
     */
    async financials(startDate = null, endDate = null) {
        await tvAuth.ensureSchema();
        const params = [];
        let when = '';
        if (startDate) { params.push(startDate); when += ` AND p.settled_at >= $${params.length}`; }
        if (endDate) { params.push(endDate); when += ` AND p.settled_at <= $${params.length}`; }
        const r = await pool.query(
            `SELECT
                COALESCE(SUM(COALESCE(p.retained_amount, p.setup_charge + p.prize_fee)), 0)::int AS revenue,
                COALESCE(SUM(CASE WHEN p.retained_amount IS NULL OR p.retained_amount > 0 THEN p.setup_charge ELSE 0 END), 0)::int AS setup_revenue,
                COALESCE(SUM(CASE WHEN p.retained_amount IS NULL OR p.retained_amount > 0 THEN p.prize_fee ELSE 0 END), 0)::int AS fee_revenue,
                COUNT(*)::int AS paid_prizes,
                COALESCE(SUM(p.prize_amount), 0)::int AS prize_collected,
                COALESCE(SUM(p.prize_amount) FILTER (WHERE p.status = 'awarded'), 0)::int AS prize_awarded,
                COALESCE(SUM(p.prize_amount) FILTER (WHERE p.status IN ('settled','claiming','unclaimed')), 0)::int AS prize_unresolved,
                COALESCE(SUM(p.forfeited_amount) FILTER (WHERE p.status = 'forfeited'), 0)::int AS forfeited,
                COUNT(*) FILTER (WHERE p.status = 'forfeited')::int AS forfeited_count
             FROM tv_prizes p
             WHERE p.status IN ('settled','awarded','refunded','claiming','unclaimed','forfeited')${when}`,
            params
        );
        // Paid out in the period asked for; owed is what is owed now, whatever the period.
        const pp = [];
        let paidWhen = '';
        if (startDate) { pp.push(startDate); paidWhen += ` AND paid_at >= $${pp.length}`; }
        if (endDate) { pp.push(endDate); paidWhen += ` AND paid_at <= $${pp.length}`; }
        const po = await pool.query(
            `SELECT
                COALESCE(SUM(amount) FILTER (WHERE status = 'paid'${paidWhen}), 0)::int AS paid_out,
                COUNT(*) FILTER (WHERE status = 'paid'${paidWhen})::int AS paid_count,
                COALESCE(SUM(amount) FILTER (WHERE status IN ('awaiting_details','ready','held','sending','failed')), 0)::int AS owed,
                COUNT(*) FILTER (WHERE status IN ('awaiting_details','ready','held','sending','failed'))::int AS owed_count,
                COUNT(*) FILTER (WHERE status = 'paid' AND received_at IS NULL AND not_received_at IS NOT NULL)::int AS not_received_count,
                COALESCE(SUM(amount) FILTER (WHERE kind = 'refund' AND status = 'paid'${paidWhen}), 0)::int AS refunded
             FROM tv_payouts`,
            pp
        );
        const a = r.rows[0] || {};
        const b = po.rows[0] || {};
        return {
            revenue: Number(a.revenue) || 0,
            setup_revenue: Number(a.setup_revenue) || 0,
            fee_revenue: Number(a.fee_revenue) || 0,
            paid_prizes: Number(a.paid_prizes) || 0,
            prize_collected: Number(a.prize_collected) || 0,
            prize_awarded: Number(a.prize_awarded) || 0,
            forfeited: Number(a.forfeited) || 0,
            forfeited_count: Number(a.forfeited_count) || 0,
            // Still ours to hand over: prizes waiting for a result, a guest winner
            // or the host, and payouts not yet sent.
            held: (Number(a.prize_unresolved) || 0) + (Number(b.owed) || 0),
            paid_out: Number(b.paid_out) || 0,
            paid_count: Number(b.paid_count) || 0,
            owed: Number(b.owed) || 0,
            owed_count: Number(b.owed_count) || 0,
            not_received_count: Number(b.not_received_count) || 0,
            refunded: Number(b.refunded) || 0
        };
    }
}

module.exports = new TvPrizeService();
module.exports.PREFIX = PREFIX;
module.exports.SPONSOR_MIN_AGE = SPONSOR_MIN_AGE;
module.exports.FEE_BPS = FEE_BPS;
module.exports.OPEN_PAYOUT = OPEN_PAYOUT;
module.exports.ASK_PENDING_AFTER_MS = ASK_PENDING_AFTER_MS;
module.exports.FAIL_PENDING_AFTER_MS = FAIL_PENDING_AFTER_MS;
module.exports.CLAIM_HOURS = CLAIM_HOURS;
module.exports.HOST_ASK_HOURS = HOST_ASK_HOURS;
module.exports.UNRESOLVED = UNRESOLVED;
