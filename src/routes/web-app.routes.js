// ============================================================
// FILE: src/routes/web-app.routes.js
// POST /web/app/install-event — the web app reports install steps it can
// see (see services/app-install.service.js for what each one means).
//
// Open to signed-out visitors on purpose: the home-screen icon can be opened
// before anyone signs in. A signed-in player is linked to the event. Kept
// cheap and hard to flood: tiny body, a per-address limit, and at most one
// row per device, per event, per day.
// ============================================================
'use strict';

const express = require('express');
const router = express.Router();
const installs = require('../services/app-install.service');
const webAuthService = require('../services/web-auth.service');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 40;
const hits = new Map();
setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [ip, v] of hits) if (v.start < cutoff) hits.delete(ip);
}, WINDOW_MS).unref();

function tooMany(ip) {
    const now = Date.now();
    const v = hits.get(ip);
    if (!v || now - v.start > WINDOW_MS) { hits.set(ip, { start: now, n: 1 }); return false; }
    v.n += 1;
    return v.n > MAX_PER_WINDOW;
}

router.post('/install-event', express.json({ limit: '1kb' }), async (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    if (tooMany(ip)) return res.status(429).json({ success: false });

    let userId = null;
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.substring(7) : null;
        if (token) {
            const ctx = await webAuthService.getSessionContext(token);
            if (ctx && ctx.user && !ctx.scope) userId = ctx.user.id;
        }
    } catch (e) { /* signed out is fine */ }

    const body = req.body || {};
    const r = await installs.record({
        deviceId: body.device, event: body.event, outcome: body.outcome,
        userId, userAgent: req.headers['user-agent']
    });
    res.status(r.ok ? 200 : 400).json({ success: r.ok });
});

module.exports = router;
