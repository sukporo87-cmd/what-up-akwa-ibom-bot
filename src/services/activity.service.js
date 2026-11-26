// ============================================
// FILE: src/services/activity.service.js
// LIVE ACTIVITY FEED — social proof for the marketing site
//
// Records small, privacy-safe events (purchase, tournament join,
// game completion, reward claim, WUT TV games) and serves the most recent ones
// to GET /api/public/activity/recent, which powers the toast
// ticker on the website.
//
// PRIVACY MODEL (founder decision, 2 Aug 2026):
//   actor = the player's USERNAME — the same public handle already
//   shown on every leaderboard. Never full_name, never phone,
//   never email. Event text never contains an amount of money a
//   specific person spent.
//
// EXPORT SHAPE: this module exports an INSTANCE (like
// game-events.service.js), not a class. It is an event sink used
// from many services; one shared instance is the point.
//   const activityService = require('./activity.service');
//
// FAILURE MODEL: record() can never throw and is fire-and-forget.
// A broken activity feed must never break a payment, a game
// completion, or a claim. Call it without await:
//   activityService.record('purchase', userId, { games: 7 });
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const reviewers = require('../utils/store-reviewers');

const CACHE_KEY = 'activity:recent';
const CACHE_TTL = 20;          // seconds — spec says 15–30s
const MAX_EVENTS_KEPT = 200;   // pruned opportunistically on write

// Ticker shows events from a rolling window, cycling continuously
const WINDOW_HOURS = 72;

class ActivityService {
  constructor() {
    this._schemaReady = false;
  }

  // Idempotent — safe to call on every write; runs the DDL once per process.
  // Mirrored as a proper migration in src/migrations/003-activity-events.sql.
  async ensureSchema() {
    if (this._schemaReady) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_events (
        id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL CHECK (event_type IN
          ('purchase','tournament_join','game_complete','reward_claim','user_join','tournament_rebuy','challenge_complete','tv_game')),
        actor TEXT NOT NULL,
        event_text TEXT NOT NULL,
        badge TEXT,
        user_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_activity_events_created
      ON activity_events (created_at DESC)
    `);

    // --- upgrades for tables created by an earlier version ---
    // A short, bold highlight rendered as a chip beside the text
    // (e.g. "Question 12"). Nullable: most events don't have one.
    await pool.query(`
      ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS badge TEXT
    `);
    // 'user_join' was added after the first release, so the original
    // CHECK constraint would reject it. Rebuild the constraint. ('tv_game',
    // WUT TV, was added on 18 Nov 2026 the same way.)
    await pool.query(`
      ALTER TABLE activity_events DROP CONSTRAINT IF EXISTS activity_events_event_type_check
    `);
    await pool.query(`
      ALTER TABLE activity_events ADD CONSTRAINT activity_events_event_type_check
      CHECK (event_type IN
        ('purchase','tournament_join','game_complete','reward_claim','user_join','tournament_rebuy','challenge_complete','tv_game'))
    `);

    this._schemaReady = true;
  }

  // --------------------------------------------
  // WRITE — fire and forget, never throws
  // --------------------------------------------
  // type: purchase | tournament_join | game_complete | reward_claim
  // userId: resolved to a username here (one small SELECT), so call
  //         sites stay one line and never join anything themselves.
  // extra: { games, tournamentId, questionNumber, grandPrize, tournamentGame }
  async record(type, userId, extra = {}) {
    try {
      await this.ensureSchema();

      const userResult = await pool.query(
        'SELECT username, city, email FROM users WHERE id = $1', [userId]
      );
      // No username, no event. We never fall back to real names.
      const username = userResult.rows[0]?.username;
      if (!username) return;
      // A store reviewer's account (utils/store-reviewers) never shows here.
      if (reviewers.isReviewer(userResult.rows[0].email)) return;

      const composed = await this._composeText(type, {
        ...extra, city: extra.city || userResult.rows[0]?.city || null
      });
      if (!composed || !composed.text) return;

      await pool.query(
        `INSERT INTO activity_events (event_type, actor, event_text, badge, user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [type, username, composed.text, composed.badge || null, userId]
      );

      // Invalidate the read cache so the next poll sees this event
      await redis.del(CACHE_KEY).catch(() => {});

      // Opportunistic prune — keeps the table tiny without a cron
      if (Math.random() < 0.02) {
        await pool.query(`
          DELETE FROM activity_events
          WHERE id NOT IN (
            SELECT id FROM activity_events ORDER BY created_at DESC LIMIT ${MAX_EVENTS_KEPT}
          )
        `);
      }
    } catch (error) {
      // Never let social proof break real functionality
      logger.warn(`Activity event dropped (${type}): ${error.message}`);
    }
  }

  // Returns { text, badge } — `badge` is an optional short highlight the
  // ticker renders as a bold chip (e.g. "Question 12").
  async _composeText(type, extra) {
    switch (type) {
      case 'user_join': {
        // "<username> from Abuja just joined What's Up Trivia"
        const city = (extra.city || '').trim();
        return { text: city
          ? `from ${city} just joined What\u2019s Up Trivia`
          : `just joined What\u2019s Up Trivia` };
      }
      case 'purchase': {
        // "<username> purchased 3 tokens"
        return { text: extra.games ? `purchased ${extra.games} tokens` : 'purchased tokens' };
      }
      case 'tournament_join': {
        // paid: "purchased '<name>' tournament entry"
        // free: "joined '<name>' tournament"
        let name = null;
        if (extra.tournamentId) {
          try {
            const t = await pool.query(
              'SELECT tournament_name FROM tournaments WHERE id = $1',
              [extra.tournamentId]
            );
            name = t.rows[0]?.tournament_name || null;
          } catch (e) { /* fall through to generic */ }
        }
        if (extra.paid) {
          return { text: name ? `purchased '${name}' tournament entry` : 'purchased a tournament entry' };
        }
        return { text: name ? `joined '${name}' tournament` : 'joined a tournament' };
      }
      case 'game_complete': {
        // "<username> completed a Classic game" + chip "Question 12"
        const q = Math.min(Math.max(parseInt(extra.questionNumber) || 1, 1), 15);
        const kind = extra.practice ? 'a practice round'
                   : extra.tournamentGame ? 'a tournament game'
                   : 'a Classic game';
        if (extra.grandPrize) {
          return { text: `completed ${kind}`, badge: 'All 15 questions \uD83C\uDFC6' };
        }
        return { text: `completed ${kind}`, badge: `Question ${q}` };
      }
      case 'tournament_rebuy': {
        // A rebuy is the strongest signal in the feed: someone liked it
        // enough to go again. Phrase it so it reads as appetite, not spend.
        let name = null;
        if (extra.tournamentId) {
          try {
            const t = await pool.query(
              'SELECT tournament_name FROM tournaments WHERE id = $1',
              [extra.tournamentId]
            );
            name = t.rows[0]?.tournament_name || null;
          } catch (e) { /* generic fallback below */ }
        }
        return {
          text: name ? `went again in '${name}'` : 'went again in a tournament',
          badge: 'Rebuy \uD83D\uDD01'
        };
      }
      case 'challenge_complete': {
        // Challenge results stay off the main leaderboard, so nothing here may
        // read as a ranking. No naira, no comparison to Classic scores, and
        // the score sits in the badge where it decorates rather than ranks.
        const size = parseInt(extra.participants) || 2;
        const placed = parseInt(extra.rank) || 0;

        const cats = extra.categories ? ` \u00b7 ${extra.categories}` : '';

        if (size <= 2) {
          // Naming the opponent is what makes this read as two people playing
          // rather than one person scoring. Both are public usernames and both
          // already appear on the shared result card, so nothing new is exposed.
          const vs = extra.opponent ? ` @${extra.opponent}` : ' a friend';
          return extra.won
            ? { text: `beat${vs} in a Challenge${cats}`,
                badge: extra.score !== undefined ? `${extra.score}/15` : 'Challenge' }
            : { text: `took on${vs} in a Challenge${cats}`,
                badge: extra.score !== undefined ? `${extra.score}/15` : 'Challenge' };
        }

        const ordinal = placed === 1 ? '1st' : placed === 2 ? '2nd' : placed === 3 ? '3rd'
                      : placed > 0 ? `${placed}th` : null;

        return {
          text: ordinal
            ? `finished ${ordinal} of ${size} in a Challenge${cats}`
            : `played a ${size}-player Challenge${cats}`,
          badge: 'Challenge'
        };
      }
      case 'tv_game': {
        // WUT TV (18 Nov 2026), signed-in players only (no username, no
        // event). One line per game at most: the Party winner, a Solo round,
        // or a top-3 place in a brand's Live Round once its results are final.
        const campaign = extra.campaign ? String(extra.campaign).slice(0, 60) : null;
        if (extra.kind === 'solo') {
          const q = Math.min(Math.max(parseInt(extra.reached) || 1, 1), 15);
          return { text: 'played Solo on WUT TV',
                   badge: extra.complete ? 'All 15 \uD83C\uDFC6' : `Question ${q}` };
        }
        if (extra.kind === 'live') {
          const n = parseInt(extra.place) || 0;
          const ord = n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
          return { text: campaign ? `placed ${ord} in ${campaign} on WUT TV` : `placed ${ord} in a Live Round on WUT TV`,
                   badge: extra.through ? 'Through \u2705' : (extra.cup ? 'Brand Cup' : 'Live Round') };
        }
        // A Party game: the winner.
        return { text: campaign ? `won a ${campaign} game on WUT TV` : 'won a Party game on WUT TV',
                 badge: extra.race ? 'Race \uD83C\uDFC1'
                      : (extra.correct != null && extra.total ? `${extra.correct}/${extra.total}` : 'Party') };
      }
      case 'reward_claim':
        return { text: 'claimed a leaderboard reward' };
      default:
        return null;
    }
  }

  // --------------------------------------------
  // READ — powers GET /api/public/activity/recent
  // --------------------------------------------
  async recent(limit = 10) {
    limit = Math.min(Math.max(parseInt(limit) || 10, 1), 20);

    // 20s cache: this will be the hottest public endpoint once the
    // ticker ships, and 20s staleness is invisible in a toast feed.
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        const events = JSON.parse(cached);
        return events.slice(0, limit);
      }
    } catch (e) { /* cache miss path below */ }

    await this.ensureSchema();
    // Rolling 72h window — the site ticker cycles through this pool
    // continuously, so old-but-recent activity keeps the feed alive.
    const result = await pool.query(`
      SELECT id, event_type, actor, event_text, badge, created_at
      FROM activity_events
      WHERE created_at > NOW() - INTERVAL '${WINDOW_HOURS} hours'
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const events = result.rows.map(r => ({
      id: `ev_${r.id}`,
      type: r.event_type,
      actor: r.actor,
      text: r.event_text,
      badge: r.badge || null,
      at: new Date(r.created_at).toISOString()
    }));

    await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(events)).catch(() => {});
    return events.slice(0, limit);
  }
}

module.exports = new ActivityService();