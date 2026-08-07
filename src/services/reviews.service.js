// ============================================
// FILE: src/services/reviews.service.js
// PLAYER REVIEWS — public submission, admin moderation,
// public display. Implements API-SPEC.md §1 exactly.
//
// EXPORT SHAPE: exports a CLASS (like user.service.js /
// payout.service.js). Instantiate it:
//   const ReviewsService = require('./reviews.service');
//   const reviewsService = new ReviewsService();
//
// TRUST MODEL:
//   - Nothing is public until an admin explicitly approves it.
//   - contact_email, submitted_ip and user_agent exist ONLY for
//     verification + moderation and are never returned by any
//     public method in this file.
//   - Verified matching is email-only, exact (case-insensitive).
//     No fuzzy name matching, by design.
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

// Q → tier map for the verified achievement line. Mirrors the game's
// prize ladder (game.service.js) — update both if the ladder changes.
const PRIZE_LADDER = {
  1: 200, 2: 250, 3: 300, 4: 500, 5: 1000,
  6: 2000, 7: 3000, 8: 5000, 9: 8000, 10: 10000,
  11: 20000, 12: 25000, 13: 30000, 14: 40000, 15: 50000
};

const RATE_LIMIT_PER_HOUR = 3;        // POST submissions per IP per hour
const DUPLICATE_WINDOW_DAYS = 30;     // one review per email / IP per window

class ReviewsService {
  constructor() {
    this._schemaReady = false;
  }

  // Idempotent — mirrored in src/migrations/001-reviews.sql
  async ensureSchema() {
    if (this._schemaReady) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id BIGSERIAL PRIMARY KEY,
        display_name TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('whatsapp','telegram','web')),
        rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        title TEXT,
        body TEXT NOT NULL,
        original_body TEXT,              -- set only if an admin edited before approving
        original_title TEXT,
        contact_email TEXT,              -- never exposed publicly
        user_id BIGINT,                  -- set when verified against a player account
        verified BOOLEAN NOT NULL DEFAULT false,
        verified_achievement TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','approved','rejected')),
        featured BOOLEAN NOT NULL DEFAULT false,
        reject_reason TEXT,
        submitted_ip TEXT,               -- moderation view only
        user_agent TEXT,                 -- moderation view only
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ,
        reviewed_by BIGINT
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_reviews_status_created
      ON reviews (status, created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_reviews_email
      ON reviews (LOWER(contact_email)) WHERE contact_email IS NOT NULL
    `);
    this._schemaReady = true;
  }

  // --------------------------------------------
  // VALIDATION — returns { valid, fields } with request field names,
  // exactly as the 400 contract in API-SPEC.md expects.
  // --------------------------------------------
  validate(input) {
    const fields = {};
    const name = (input.display_name || '').trim();
    const body = (input.body || '').trim();
    const title = input.title != null ? String(input.title).trim() : null;
    const rating = parseInt(input.rating);
    const platform = input.platform;
    const email = input.contact_email != null ? String(input.contact_email).trim() : null;

    if (name.length < 2 || name.length > 40) {
      fields.display_name = 'Must be 2\u201340 characters';
    }
    if (!['whatsapp', 'telegram', 'web'].includes(platform)) {
      fields.platform = 'Must be whatsapp, telegram or web';
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      fields.rating = 'Must be 1\u20135';
    }
    if (title && title.length > 80) {
      fields.title = 'Must be 80 characters or fewer';
    }
    if (body.length < 20 || body.length > 1000) {
      fields.body = 'Must be 20\u20131000 characters';
    }
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      fields.contact_email = 'Must be a valid email address';
    }

    return {
      valid: Object.keys(fields).length === 0,
      fields,
      clean: {
        display_name: name,
        platform,
        rating,
        title: title || null,
        body,
        contact_email: email ? email.toLowerCase() : null
      }
    };
  }

  // --------------------------------------------
  // RATE LIMITING (Redis) — 3 submissions / hour / IP.
  // Tune RATE_LIMIT_PER_HOUR above; the key TTL is the window.
  // --------------------------------------------
  async checkRateLimit(ip) {
    try {
      const key = `reviews:ratelimit:${ip}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 3600);
      if (count > RATE_LIMIT_PER_HOUR) {
        const ttl = await redis.ttl(key);
        return { limited: true, retryAfter: ttl > 0 ? ttl : 3600 };
      }
      return { limited: false };
    } catch (error) {
      // Redis down ⇒ fail open (submissions are still moderated by a
      // human, so the worst case is more queue, not more public spam)
      logger.warn(`Review rate limit check failed open: ${error.message}`);
      return { limited: false };
    }
  }

  // One review per email / per IP per 30 days, any status —
  // resubmitting after a rejection needs the window to lapse.
  async isDuplicate(email, ip) {
    const result = await pool.query(
      `SELECT 1 FROM reviews
       WHERE created_at > NOW() - INTERVAL '${DUPLICATE_WINDOW_DAYS} days'
         AND (
           ($1::text IS NOT NULL AND LOWER(contact_email) = $1) OR
           ($2::text IS NOT NULL AND submitted_ip = $2)
         )
       LIMIT 1`,
      [email || null, ip || null]
    );
    return result.rows.length > 0;
  }

  // --------------------------------------------
  // SUBMIT — stores as pending; verification runs inline (it's one
  // indexed SELECT, not worth a queue).
  // --------------------------------------------
  async submit(input, ip, userAgent, invitePlayer = null) {
    await this.ensureSchema();

    const v = this.validate(input);
    if (!v.valid) return { ok: false, code: 400, fields: v.fields };

    // Invited players are identified individually, and the token is
    // single-use, so the shared-IP duplicate rule must not block them —
    // two friends in one house both getting invites is a good outcome,
    // not a duplicate.
    if (!invitePlayer && await this.isDuplicate(v.clean.contact_email, ip)) {
      return { ok: false, code: 409 };
    }

    // Two routes to a verified badge:
    //   1. an invite token (chat players — no email needed), or
    //   2. an email that matches a player account (web players).
    // The token wins when both are present: it is direct evidence.
    let match = null;
    if (invitePlayer) {
      match = {
        userId: invitePlayer.userId,
        platform: invitePlayer.platform || v.clean.platform,
        achievement: this.achievementFor(invitePlayer.bestQ)
      };
    } else if (v.clean.contact_email) {
      match = await this.matchPlayer(v.clean.contact_email);
    }

    const result = await pool.query(
      `INSERT INTO reviews
        (display_name, platform, rating, title, body, contact_email,
         user_id, verified, verified_achievement, submitted_ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        v.clean.display_name, v.clean.platform, v.clean.rating,
        v.clean.title, v.clean.body, v.clean.contact_email,
        match ? match.userId : null,
        !!match,
        match ? match.achievement : null,
        ip || null, (userAgent || '').slice(0, 500) || null
      ]
    );

    logger.info(`New review #${result.rows[0].id} pending (${v.clean.platform}, ${v.clean.rating}★, verified=${!!match})`);
    return { ok: true, id: result.rows[0].id };
  }

  // --------------------------------------------
  // VERIFICATION — email-only match against player accounts.
  //
  // Known asymmetry (also in the brief): web accounts always carry an
  // email so they verify cleanly; WhatsApp/Telegram accounts often
  // don't, so genuine chat-platform reviews will frequently be
  // unverified. The public payload therefore carries no "unverified"
  // marker of any kind — absence of the badge is the whole story.
  //
  // If several accounts share an email (legacy chat emails), prefer
  // the web account, then most recently active.
  // --------------------------------------------
  // One human-readable line, ≤ 60 chars, from the player's best result.
  achievementFor(bestQuestion) {
    const bestQ = parseInt(bestQuestion) || 0;
    const line = bestQ >= 1
      ? `Reached Q${bestQ} \u00b7 \u20A6${(PRIZE_LADDER[Math.min(bestQ, 15)] || 0).toLocaleString()} tier`
      : 'Verified player';
    return line.slice(0, 60);
  }

  async matchPlayer(email) {
    const result = await pool.query(
      `SELECT id, username, platform,
              COALESCE(highest_question_reached, 0) AS best_q
       FROM users
       WHERE LOWER(email) = LOWER($1)
       ORDER BY (platform = 'web') DESC, last_active DESC NULLS LAST
       LIMIT 1`,
      [email]
    );
    if (!result.rows.length) return null;

    const u = result.rows[0];
    return {
      userId: u.id,
      platform: u.platform || 'whatsapp',
      achievement: this.achievementFor(u.best_q)
    };
  }

  // --------------------------------------------
  // PUBLIC READS — approved only, never pending/rejected,
  // never emails/IPs/user agents.
  // --------------------------------------------
  async listApproved({ limit = 20, offset = 0, sort = 'recent' } = {}) {
    await this.ensureSchema();
    limit = Math.min(Math.max(parseInt(limit) || 20, 1), 50);
    offset = Math.max(parseInt(offset) || 0, 0);

    const order = sort === 'top'
      ? 'featured DESC, rating DESC, created_at DESC'
      : 'featured DESC, created_at DESC';

    const [rowsResult, aggregate] = await Promise.all([
      pool.query(
        `SELECT r.id, r.display_name, r.rating, r.title, r.body, r.created_at,
                r.verified, r.verified_achievement,
                -- platform: prefer the verified account's platform, else as submitted
                COALESCE(u.platform, r.platform) AS platform,
                u.platform AS account_platform
         FROM reviews r
         LEFT JOIN users u ON u.id = r.user_id
         WHERE r.status = 'approved'
         ORDER BY ${order}
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      this.aggregate()
    ]);

    const reviews = rowsResult.rows.map(r => ({
      id: r.id,
      display_name: r.display_name,
      platform: r.platform,
      rating: r.rating,
      title: r.title,
      body: r.body,
      created_at: new Date(r.created_at).toISOString(),
      verified: r.verified,
      verified_badge: r.verified ? {
        platform: r.account_platform || r.platform,
        achievement: r.verified_achievement || 'Verified player'
      } : null
    }));

    return {
      reviews,
      aggregate,
      pagination: { limit, offset, total: aggregate.total_reviews }
    };
  }

  async aggregate() {
    await this.ensureSchema();
    const result = await pool.query(
      `SELECT rating, COUNT(*) AS n
       FROM reviews WHERE status = 'approved'
       GROUP BY rating`
    );

    // COUNT(*) comes back as a string in Postgres — parse before math.
    const distribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    let total = 0, sum = 0;
    for (const row of result.rows) {
      const n = parseInt(row.n);
      distribution[String(row.rating)] = n;
      total += n;
      sum += n * row.rating;
    }

    return {
      average_rating: total > 0 ? Math.round((sum / total) * 10) / 10 : 0,
      total_reviews: total,
      distribution
    };
  }

  // --------------------------------------------
  // MODERATION — everything the queue view needs, including the
  // player context that makes approval a real decision: did they
  // play, what did they reach, are they on the fraud watchlist.
  // --------------------------------------------
  async adminList({ status = 'pending', limit = 50, offset = 0 } = {}) {
    await this.ensureSchema();
    limit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    offset = Math.max(parseInt(offset) || 0, 0);

    const statuses = ['pending', 'approved', 'rejected'].includes(status)
      ? [status] : ['pending'];

    const result = await pool.query(
      `SELECT r.*,
              u.username AS player_username,
              u.platform AS player_platform,
              COALESCE(u.total_games_played, 0) AS player_games,
              COALESCE(w.prize_total, 0) AS player_winnings,
              (fw.user_id IS NOT NULL) AS on_watchlist
       FROM reviews r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN LATERAL (
         SELECT SUM(amount) AS prize_total
         FROM transactions
         WHERE user_id = r.user_id AND transaction_type = 'prize'
       ) w ON r.user_id IS NOT NULL
       LEFT JOIN fraud_watchlist fw
         ON fw.user_id = r.user_id AND fw.is_active = true
       WHERE r.status = $1
       ORDER BY r.created_at ${statuses[0] === 'pending' ? 'ASC' : 'DESC'}
       LIMIT $2 OFFSET $3`,
      [statuses[0], limit, offset]
    );

    const countResult = await pool.query(
      `SELECT status, COUNT(*) AS n FROM reviews GROUP BY status`
    );
    const counts = { pending: 0, approved: 0, rejected: 0 };
    countResult.rows.forEach(r => { counts[r.status] = parseInt(r.n); });

    return {
      reviews: result.rows.map(r => ({
        id: r.id,
        display_name: r.display_name,
        platform: r.platform,
        rating: r.rating,
        title: r.title,
        body: r.body,
        original_body: r.original_body,
        original_title: r.original_title,
        status: r.status,
        featured: r.featured,
        reject_reason: r.reject_reason,
        created_at: r.created_at,
        reviewed_at: r.reviewed_at,
        submitted_ip: r.submitted_ip,
        user_agent: r.user_agent,
        contact_email: r.contact_email,   // moderation view only — admin routes are authenticated
        verified: r.verified,
        verified_achievement: r.verified_achievement,
        player: r.user_id ? {
          user_id: r.user_id,
          username: r.player_username,
          platform: r.player_platform,
          games_played: parseInt(r.player_games) || 0,
          total_winnings: parseInt(r.player_winnings) || 0,
          on_watchlist: r.on_watchlist === true
        } : null
      })),
      counts
    };
  }

  // Approve — optionally with light edits. Edits preserve the original
  // text so "edit then approve" stays accountable (typo fixes, not
  // changing what someone said — the original is always in the record).
  async approve(id, adminId, edits = {}) {
    await this.ensureSchema();

    const editingBody = typeof edits.body === 'string' && edits.body.trim().length >= 20;
    const editingTitle = typeof edits.title === 'string';

    const result = await pool.query(
      `UPDATE reviews SET
         original_body  = CASE WHEN $3::boolean THEN COALESCE(original_body, body) ELSE original_body END,
         body           = CASE WHEN $3::boolean THEN $4 ELSE body END,
         original_title = CASE WHEN $5::boolean THEN COALESCE(original_title, title) ELSE original_title END,
         title          = CASE WHEN $5::boolean THEN NULLIF($6, '') ELSE title END,
         status = 'approved', reject_reason = NULL,
         reviewed_at = NOW(), reviewed_by = $2
       WHERE id = $1 AND status IN ('pending','rejected','approved')
       RETURNING id`,
      [id, adminId,
       editingBody, editingBody ? edits.body.trim().slice(0, 1000) : null,
       editingTitle, editingTitle ? String(edits.title).trim().slice(0, 80) : null]
    );
    return result.rows.length > 0;
  }

  async reject(id, adminId, reason) {
    await this.ensureSchema();
    const result = await pool.query(
      `UPDATE reviews
       SET status = 'rejected', featured = false,
           reject_reason = $3, reviewed_at = NOW(), reviewed_by = $2
       WHERE id = $1
       RETURNING id`,
      [id, adminId, (reason || 'No reason recorded').slice(0, 300)]
    );
    return result.rows.length > 0;
  }

  async setFeatured(id, adminId, featured) {
    await this.ensureSchema();
    const result = await pool.query(
      `UPDATE reviews
       SET featured = $3, reviewed_by = $2
       WHERE id = $1 AND status = 'approved'
       RETURNING id`,
      [id, adminId, featured === true]
    );
    return result.rows.length > 0;
  }
}

module.exports = ReviewsService;
