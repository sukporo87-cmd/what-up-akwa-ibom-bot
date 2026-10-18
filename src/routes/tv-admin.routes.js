// ============================================
// FILE: src/routes/tv-admin.routes.js
// WUT TV — the admin page. Mounted at /admin/tv, before the main admin
// router, so nothing in admin.routes.js changes.
//
//   GET  /admin/tv                        the page
//   GET  /admin/tv/api/overview           rooms, TVs, sign-ins
//   GET  /admin/tv/api/rooms/:id          one room and its players
//   POST /admin/tv/api/rooms/:id/close    close a live room
//   POST /admin/tv/api/devices/:id/block  { blocked, reason }
//   POST /admin/tv/api/sessions/:id/end   sign someone out of a TV
//   GET  /admin/tv/api/settings           settings, categories, Play Now source
//   PUT  /admin/tv/api/settings           { key, value }
//   DELETE /admin/tv/api/settings/:key    back to the default
//   PUT  /admin/tv/api/categories         { category, on }
//   PUT  /admin/tv/api/play-now           { bank, categories }
//   GET  /admin/tv/api/devices/:id        one TV in full, for the details pop-up
//   PUT  /admin/tv/api/devices/:id        { adminName, adminNotes }
//   GET  /admin/tv/api/audit/search       Audit Trail: { kind, q, from, to, page }
//   GET  /admin/tv/api/audit/party/:id    Audit Trail: one Party game in full
//   GET  /admin/tv/api/audit/solo/:id     Audit Trail: one Solo round in full
//
// Every API route needs an admin session, checked exactly as the main admin
// router checks it (admin-auth.service validateSession), and every change is
// written to the admin activity log, so the Audit Trail can answer who
// changed the TV clock, or closed a room, and when.
// ============================================

const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const AdminAuthService = require('../services/admin-auth.service');
const tvAdmin = require('../services/tv-admin.service');
const tvSettings = require('../services/tv-settings.service');
const tvAudit = require('../services/tv-audit.service');

const adminAuth = new AdminAuthService();

async function requireAdmin(req, res, next) {
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.substring(7).trim() : null;
        if (!token) return res.status(401).json({ success: false, error: 'Unauthorized - No token provided' });
        const v = await adminAuth.validateSession(token);
        if (!v.valid) return res.status(401).json({ success: false, error: 'Unauthorized - ' + v.reason });
        req.adminSession = v.session;
        next();
    } catch (error) {
        logger.error(`TV admin auth failed: ${error.message}`);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
}

function ip(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
}

async function log(req, action, details) {
    try {
        await adminAuth.logActivity(req.adminSession.admin_id, action, details, ip(req), req.headers['user-agent']);
    } catch (e) { logger.error(`TV admin: could not log ${action}: ${e.message}`); }
}

function send(res, out) {
    if (out && out.ok) {
        const { ok, ...rest } = out;
        return res.json({ success: true, ...rest });
    }
    return res.status(400).json({ success: false, error: (out && out.error) || 'Failed' });
}

function fail(res, label, error) {
    logger.error(`TV admin ${label} failed: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Server error' });
}

const who = req => (req.adminSession && req.adminSession.username) || 'admin';

// ---- the page (it signs itself in from the admin session in the browser) ----
router.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile('admin-tv.html', { root: './src/views' });
});

// ---- reads ----
router.get('/api/overview', requireAdmin, async (req, res) => {
    try { return send(res, await tvAdmin.overview()); } catch (e) { return fail(res, 'overview', e); }
});

router.get('/api/rooms/:id(\\d+)', requireAdmin, async (req, res) => {
    try { return send(res, await tvAdmin.room(Number(req.params.id))); } catch (e) { return fail(res, 'room', e); }
});

router.get('/api/settings', requireAdmin, async (req, res) => {
    try { return send(res, await tvAdmin.settings()); } catch (e) { return fail(res, 'settings', e); }
});

router.get('/api/devices/:id(\\d+)', requireAdmin, async (req, res) => {
    try { return send(res, await tvAdmin.device(Number(req.params.id))); } catch (e) { return fail(res, 'device', e); }
});

// ---- the Audit Trail's WUT TV section (read only) ----
router.get('/api/audit/search', requireAdmin, async (req, res) => {
    try {
        const q = req.query || {};
        return send(res, await tvAudit.search({ kind: q.kind, q: q.q, from: q.from, to: q.to, page: q.page }));
    } catch (e) { return fail(res, 'audit search', e); }
});

router.get('/api/audit/party/:id(\\d+)', requireAdmin, async (req, res) => {
    try { return send(res, await tvAudit.party(Number(req.params.id))); } catch (e) { return fail(res, 'audit party', e); }
});

router.get('/api/audit/solo/:id(\\d+)', requireAdmin, async (req, res) => {
    try { return send(res, await tvAudit.solo(Number(req.params.id))); } catch (e) { return fail(res, 'audit solo', e); }
});

// ---- actions ----
router.put('/api/devices/:id(\\d+)', requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const body = req.body || {};
        const out = await tvAdmin.nameDevice(id, body.adminName, body.adminNotes);
        if (out.ok) await log(req, 'tv_device_named', { deviceId: id, adminName: out.adminName, notes: !!out.adminNotes });
        return send(res, out);
    } catch (e) { return fail(res, 'name device', e); }
});

router.post('/api/rooms/:id(\\d+)/close', requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const out = await tvAdmin.closeRoom(id);
        if (out.ok) await log(req, 'tv_room_closed', { roomId: id });
        return send(res, out);
    } catch (e) { return fail(res, 'close room', e); }
});

router.post('/api/devices/:id(\\d+)/block', requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const body = req.body || {};
        const out = await tvAdmin.setBlocked(id, body.blocked === true, body.reason);
        if (out.ok) await log(req, out.blocked ? 'tv_device_blocked' : 'tv_device_unblocked', { deviceId: id, reason: body.reason || null });
        return send(res, out);
    } catch (e) { return fail(res, 'block', e); }
});

router.post('/api/sessions/:id(\\d+)/end', requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const out = await tvAdmin.endSession(id);
        if (out.ok) await log(req, 'tv_signin_ended', { sessionId: id });
        return send(res, out);
    } catch (e) { return fail(res, 'end sign-in', e); }
});

router.put('/api/settings', requireAdmin, async (req, res) => {
    try {
        const { key, value } = req.body || {};
        const out = await tvSettings.setNumber(String(key || ''), value, who(req));
        if (out.ok) await log(req, 'tv_setting_set', { key: out.key, value: out.value });
        return send(res, out);
    } catch (e) { return fail(res, 'set setting', e); }
});

router.delete('/api/settings/:key([a-z_]+\\.[a-z0-9_]+)', requireAdmin, async (req, res) => {
    try {
        const out = await tvSettings.reset(req.params.key, who(req));
        if (out.ok) await log(req, 'tv_setting_reset', { key: out.key });
        return send(res, out);
    } catch (e) { return fail(res, 'reset setting', e); }
});

router.put('/api/categories', requireAdmin, async (req, res) => {
    try {
        const { category, on } = req.body || {};
        const out = await tvAdmin.setCategory(category, on === true, who(req));
        if (out.ok) await log(req, 'tv_category_set', { category: out.category, on: out.on });
        return send(res, out);
    } catch (e) { return fail(res, 'set category', e); }
});

router.put('/api/play-now', requireAdmin, async (req, res) => {
    try {
        const { bank, categories } = req.body || {};
        const out = await tvAdmin.setPlayNowSource(String(bank || ''), categories, who(req));
        if (out.ok) await log(req, 'tv_play_now_source_set', { bank: out.bank, categories: out.categories });
        return send(res, out);
    } catch (e) { return fail(res, 'set Play Now source', e); }
});

module.exports = router;
