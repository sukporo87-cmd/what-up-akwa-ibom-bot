// ============================================================
// FILE: src/routes/admin-insights.routes.js
// Admin data for the Advanced Analytics page:
//   * where players are (states / countries) and the review list for
//     cities the rules could not place;
//   * web app installs.
// Mounted at /admin/api/insights, before the main admin router, so
// admin.routes.js does not grow. Every route needs an admin login.
// ============================================================
'use strict';

const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const AdminAuthService = require('../services/admin-auth.service');
const locations = require('../services/location.service');
const installs = require('../services/app-install.service');

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
        logger.error(`Insights admin auth failed: ${error.message}`);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
}

router.use(requireAdmin);
router.use(express.json({ limit: '10kb' }));

const wrap = (label, fn) => async (req, res) => {
    try {
        res.json({ success: true, ...(await fn(req)) });
    } catch (error) {
        logger.error(`Insights ${label} error:`, error);
        res.status(error.message && error.message.startsWith('Choose') ? 400 : 500)
            .json({ success: false, error: error.message || 'Something went wrong' });
    }
};

// ---------------- where players are ----------------
router.get('/locations/summary', wrap('location summary', async () => locations.summary()));

router.get('/locations/review', wrap('location review', async () => ({
    items: await locations.reviewList(),
    states: locations.NIGERIAN_STATES.map(s => ({ value: s, label: locations.stateLabel(s) }))
})));

router.get('/locations/decisions', wrap('location decisions', async () => ({ items: await locations.decisions() })));

router.post('/locations/decide', wrap('location decide', async (req) => {
    const { key, country, state, city, unknown } = req.body || {};
    const who = (req.adminSession && (req.adminSession.username || req.adminSession.full_name)) || 'admin';
    return locations.decide(key, { country, state, city, unknown }, who);
}));

router.post('/locations/undo', wrap('location undo', async (req) => {
    await locations.undoDecision((req.body || {}).key);
    return {};
}));

router.post('/locations/rerun', wrap('location rerun', async () => ({ placed: await locations.rerunAll() })));

// ---------------- web app installs ----------------
router.get('/installs', wrap('installs', async () => installs.stats()));

module.exports = router;
