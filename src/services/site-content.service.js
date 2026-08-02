// ============================================
// FILE: src/services/site-content.service.js
// EDITABLE SITE CONTENT — key-value store for the marketing site.
// Implements API-SPEC.md §2. Deliberately narrow: keys and values,
// an editor, one cached public read. Not a page builder — adding
// pages or restructuring sections stays a developer job, on purpose.
//
// EXPORT SHAPE: exports a CLASS. Instantiate it:
//   const SiteContentService = require('./site-content.service');
//   const siteContentService = new SiteContentService();
//
// SAFETY MODEL: the site bakes every string in and merges fetched
// values over the defaults. A missing key, an unknown key, or a
// dead endpoint can therefore never blank the site. Values are
// plain text — the frontend sets textContent, so HTML would render
// literally. Nothing here needs to sanitize for that reason, but
// values are length-capped as a seatbelt.
// ============================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');

const CACHE_KEY = 'site-content:all';
const CACHE_TTL = 300;              // matches Cache-Control max-age=300
const MAX_VALUE_LENGTH = 4000;
const KEY_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/i;   // dot-notation keys only

class SiteContentService {
  constructor() {
    this._schemaReady = false;
  }

  // Idempotent — mirrored in src/migrations/002-site-content.sql
  async ensureSchema() {
    if (this._schemaReady) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_content (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT
      )
    `);
    this._schemaReady = true;
  }

  // --------------------------------------------
  // PUBLIC READ — flat map, cached. prefix/keys filtering happens
  // after the (single, cached) full read: the whole store is a few
  // KB of marketing copy, so one cache entry beats N.
  // --------------------------------------------
  async getContent({ prefix = null, keys = null } = {}) {
    await this.ensureSchema();

    let all = null;
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) all = JSON.parse(cached);
    } catch (e) { /* fall through to DB */ }

    if (!all) {
      const result = await pool.query(
        'SELECT key, value, updated_at FROM site_content'
      );
      let latest = 0;
      const content = {};
      for (const row of result.rows) {
        content[row.key] = row.value;
        const t = new Date(row.updated_at).getTime();
        if (t > latest) latest = t;
      }
      all = { content, updated_at: latest ? new Date(latest).toISOString() : null, version: Math.floor(latest / 1000) || 0 };
      await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(all)).catch(() => {});
    }

    let content = all.content;
    if (prefix) {
      content = Object.fromEntries(
        Object.entries(content).filter(([k]) => k.startsWith(prefix))
      );
    }
    if (keys) {
      const wanted = new Set(String(keys).split(',').map(k => k.trim()).filter(Boolean));
      content = Object.fromEntries(
        Object.entries(content).filter(([k]) => wanted.has(k))
      );
    }

    return { content, version: all.version, updated_at: all.updated_at };
  }

  // --------------------------------------------
  // ADMIN — list with grouping metadata, upsert, delete.
  // --------------------------------------------
  async adminList() {
    await this.ensureSchema();
    const result = await pool.query(
      'SELECT key, value, updated_at, updated_by FROM site_content ORDER BY key'
    );
    return result.rows.map(r => ({
      key: r.key,
      value: r.value,
      updated_at: r.updated_at,
      updated_by: r.updated_by,
      // Derived, human description: "home.hero.badge" →
      // page "home", section "hero", field "badge". The dot paths are
      // the documentation (full list ships in CONTENT-KEYS.md).
      page: r.key.split('.')[0],
      section: r.key.split('.')[1] || '',
      field: r.key.split('.').slice(2).join('.') || r.key.split('.')[1] || ''
    }));
  }

  validateKey(key) {
    return typeof key === 'string' && key.length <= 120 && KEY_PATTERN.test(key);
  }

  async upsert(key, value, adminUsername) {
    await this.ensureSchema();
    if (!this.validateKey(key)) {
      return { ok: false, error: 'Key must be dot-notation like home.hero.badge' };
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE_LENGTH) {
      return { ok: false, error: `Value must be 1\u2013${MAX_VALUE_LENGTH} characters of plain text` };
    }

    await pool.query(
      `INSERT INTO site_content (key, value, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (key)
       DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
      [key, value, adminUsername || null]
    );
    await redis.del(CACHE_KEY).catch(() => {});
    logger.info(`Site content updated: ${key} by ${adminUsername || 'unknown'}`);
    return { ok: true };
  }

  async remove(key, adminUsername) {
    await this.ensureSchema();
    const result = await pool.query(
      'DELETE FROM site_content WHERE key = $1 RETURNING key', [key]
    );
    await redis.del(CACHE_KEY).catch(() => {});
    if (result.rows.length) {
      logger.info(`Site content key deleted: ${key} by ${adminUsername || 'unknown'} (site falls back to baked default)`);
    }
    return result.rows.length > 0;
  }
}

module.exports = SiteContentService;
