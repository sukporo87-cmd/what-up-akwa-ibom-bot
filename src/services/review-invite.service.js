// ============================================
// FILE: src/services/review-invite.service.js
// REVIEW INVITES — asks players for a review at the right moment,
// on whichever platform they play, without ever asking twice.
//
// EXPORT SHAPE: exports an INSTANCE (like activity.service.js).
//   const reviewInvites = require('./review-invite.service');
//
// WHY A TOKEN RATHER THAN JUST A LINK:
// review verification matches on email. Web players always have one;
// WhatsApp and Telegram players usually don't, so their reviews would
// forever be unverified even though we know exactly who they are. The
// invite carries a single-use token, so a review submitted through it
// is attributed to the player account directly — no email needed. That
// closes the verification asymmetry for chat players.
//
// FAILURE MODEL: like activity.service, every public method swallows
// its own errors. A review prompt must never break a game.
// ============================================

const crypto = require('crypto');
const pool = require('../config/database');
const { logger } = require('../utils/logger');

// --- policy: when we're allowed to ask ---
const GAMES_PER_PROMPT = 3;      // ask after a completed tournament entry (3 games)
const MAX_PROMPTS = 2;           // lifetime, per player
const MIN_DAYS_BETWEEN = 14;     // never nag
const TOKEN_TTL_DAYS = 30;       // an unused invite expires

const SITE = process.env.SITE_URL || 'https://whatsuptrivia.com.ng';

class ReviewInviteService {
  constructor() {
    this._schemaReady = false;
  }

  // Idempotent — mirrored in src/migrations/005-review-invites.sql
  async ensureSchema() {
    if (this._schemaReady) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS review_invites (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        platform TEXT,
        trigger TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        used_at TIMESTAMPTZ,
        review_id BIGINT
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_review_invites_user
      ON review_invites (user_id, sent_at DESC)
    `);
    this._schemaReady = true;
  }

  // --------------------------------------------
  // Has this player already reviewed us?
  // Two ways to know: an invite of theirs was redeemed, or a review
  // was matched to their account by email.
  // --------------------------------------------
  async hasReviewed(userId) {
    const result = await pool.query(
      `SELECT
         EXISTS(SELECT 1 FROM review_invites WHERE user_id = $1 AND used_at IS NOT NULL) AS via_invite,
         EXISTS(SELECT 1 FROM reviews WHERE user_id = $1) AS via_email`,
      [userId]
    );
    const r = result.rows[0];
    return r.via_invite === true || r.via_email === true;
  }

  async promptCount(userId) {
    const result = await pool.query(
      `SELECT COUNT(*) AS n, MAX(sent_at) AS last_sent
       FROM review_invites WHERE user_id = $1`,
      [userId]
    );
    return {
      count: parseInt(result.rows[0].n) || 0,
      lastSent: result.rows[0].last_sent
    };
  }

  // The whole policy in one place, so it's auditable and easy to tune.
  async shouldPrompt(userId) {
    await this.ensureSchema();

    if (await this.hasReviewed(userId)) {
      return { ok: false, reason: 'already_reviewed' };
    }

    const { count, lastSent } = await this.promptCount(userId);
    if (count >= MAX_PROMPTS) return { ok: false, reason: 'prompt_limit_reached' };

    if (lastSent) {
      const days = (Date.now() - new Date(lastSent).getTime()) / 86400000;
      if (days < MIN_DAYS_BETWEEN) return { ok: false, reason: 'too_soon' };
    }

    return { ok: true };
  }

  // --------------------------------------------
  // Create the invite and return the personalised link.
  // --------------------------------------------
  async createInvite(userId, platform, trigger) {
    await this.ensureSchema();
    const token = crypto.randomBytes(16).toString('base64url');
    await pool.query(
      `INSERT INTO review_invites (user_id, token, platform, trigger)
       VALUES ($1, $2, $3, $4)`,
      [userId, token, platform || null, trigger || null]
    );
    return { token, url: `${SITE}/reviews?r=${token}` };
  }

  // --------------------------------------------
  // Redeem: called by the public review endpoint when a submission
  // carries ?r=<token>. Returns the player this invite belongs to, so
  // the review can be marked verified without an email.
  // --------------------------------------------
  async resolveToken(token) {
    if (!token || typeof token !== 'string' || token.length > 64) return null;
    await this.ensureSchema();
    const result = await pool.query(
      `SELECT ri.id, ri.user_id, ri.used_at, ri.sent_at,
              u.username, u.platform,
              COALESCE(u.highest_question_reached, 0) AS best_q
       FROM review_invites ri
       JOIN users u ON u.id = ri.user_id
       WHERE ri.token = $1`,
      [token]
    );
    if (!result.rows.length) return null;

    const row = result.rows[0];
    if (row.used_at) return null;                       // single use
    const ageDays = (Date.now() - new Date(row.sent_at).getTime()) / 86400000;
    if (ageDays > TOKEN_TTL_DAYS) return null;          // expired

    return {
      inviteId: row.id,
      userId: row.user_id,
      username: row.username,
      platform: row.platform,
      bestQ: parseInt(row.best_q) || 0
    };
  }

  async markUsed(inviteId, reviewId) {
    try {
      await pool.query(
        `UPDATE review_invites SET used_at = NOW(), review_id = $2 WHERE id = $1`,
        [inviteId, reviewId]
      );
    } catch (error) {
      logger.warn(`Could not mark review invite ${inviteId} used: ${error.message}`);
    }
  }

  // --------------------------------------------
  // The trigger. Call after a tournament game completes; it decides
  // for itself whether this is the moment, and never throws.
  //
  //   reviewInvites.maybePrompt(user, messagingService, {
  //     gamesPlayed, tournamentName
  //   });
  // --------------------------------------------
  async maybePrompt(user, messagingService, ctx = {}) {
    try {
      if (!user || !user.id) return;

      // Only at the end of a full entry: 3 games, 6 games, and so on.
      const played = parseInt(ctx.gamesPlayed);
      if (!played || played % GAMES_PER_PROMPT !== 0) return;

      const verdict = await this.shouldPrompt(user.id);
      if (!verdict.ok) return;

      const invite = await this.createInvite(
        user.id, user.platform || null, ctx.trigger || 'tournament_entry_complete'
      );

      const name = ctx.tournamentName ? `'${ctx.tournamentName}'` : 'that tournament';
      const message =
        `⭐ You just finished your ${played} games in ${name}.\n\n` +
        `How was it? A short review helps other Nigerians decide whether ` +
        `to give What's Up Trivia a shot — and yours will show as a ` +
        `verified player:\n\n${invite.url}\n\n` +
        `Takes about a minute. Thank you 🙏`;

      // MessagingService routes by identifier, so WhatsApp, Telegram and
      // web all work through this one call.
      await messagingService.sendMessage(user.phone_number, message);

      logger.info(`Review invite sent to user ${user.id} (${user.platform || 'unknown'}) after ${played} tournament games`);
    } catch (error) {
      // A prompt must never interfere with the game that triggered it
      logger.warn(`Review invite skipped for user ${user && user.id}: ${error.message}`);
    }
  }
}

module.exports = new ReviewInviteService();
