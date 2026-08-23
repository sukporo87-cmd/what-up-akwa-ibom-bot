// ============================================
// FILE: src/routes/web-auth.routes.js
// Web play authentication endpoints.
// Mount in server.js:  app.use('/web/auth', require('./routes/web-auth.routes'));
// ============================================

const express = require('express');
const router = express.Router();
const webAuthService = require('../services/web-auth.service');
const emailService = require('../services/email.service');
const { logger } = require('../utils/logger');

const COOKIE_NAME = 'wut_session';
const IS_PROD = process.env.NODE_ENV === 'production';

// ============================================
// HELPERS
// ============================================

function getIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress
        || null;
}

/** Reads the session token from cookie or Authorization header. */
function getToken(req) {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) return header.substring(7);

    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === COOKIE_NAME) return decodeURIComponent(v.join('='));
    }
    return null;
}

function setSessionCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        secure: IS_PROD,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 30,
        path: '/'
    });
}

/** Turns a thrown error into a response. userFacing errors keep their message. */
function fail(res, error, fallbackStatus = 500) {
    if (error?.userFacing) {
        return res.status(400).json({ success: false, error: error.message, errors: error.errors });
    }
    logger.error('Web auth error:', error);
    return res.status(fallbackStatus).json({
        success: false,
        error: 'Something went wrong. Please try again.'
    });
}

/**
 * Auth middleware. Attaches req.webUser.
 * Exported so the game API can reuse it.
 */
async function requireWebAuth(req, res, next) {
    try {
        const ctx = await webAuthService.getSessionContext(getToken(req));
        if (!ctx) {
            return res.status(401).json({ success: false, error: 'Not signed in' });
        }

        // A CHALLENGE-SCOPED SESSION IS NOT A LOGIN. It is minted from a
        // six-digit code sent over WhatsApp, which sits on a lock screen and
        // is valid for minutes. It must never reach Classic, purchases, the
        // profile or a payout claim. Challenge routes use requireChallengeAuth
        // instead, which checks the scope matches the challenge in the URL.
        if (ctx.scope) {
            return res.status(403).json({
                success: false,
                error: 'This session can only play the challenge it was created for.',
                reason: 'scoped_session'
            });
        }

        req.webUser = ctx.user;
        req.webSession = ctx;
        next();
    } catch (error) {
        return fail(res, error);
    }
}

/** Stricter variant — also requires a finished profile (for gameplay routes). */
async function requireCompleteProfile(req, res, next) {
    if (req.webUser?.profile_complete === false) {
        return res.status(403).json({
            success: false,
            error: 'Please finish setting up your profile first',
            needsProfile: true
        });
    }
    next();
}

// ============================================
// SIGNUP  (email + OTP)
// ============================================

router.post('/signup/request', async (req, res) => {
    try {
        const { email, fullName, city, username, age, referralCode, acquisitionSource, newsletterOptIn } = req.body || {};
        const result = await webAuthService.requestSignupOtp({
            email, fullName, city, username, age, referralCode, acquisitionSource,
            newsletterOptIn: newsletterOptIn !== false,   // checkbox defaults to ticked
            ip: getIp(req)
        });
        res.json({ success: true, message: 'Check your email for a 6-digit code', ...result });
    } catch (error) {
        fail(res, error);
    }
});

router.post('/signup/verify', async (req, res) => {
    try {
        const { email, code } = req.body || {};
        const { token, user } = await webAuthService.verifyOtp({
            email, code, purpose: 'signup',
            ip: getIp(req), userAgent: req.headers['user-agent']
        });
        setSessionCookie(res, token);
        res.json({ success: true, token, user });
    } catch (error) {
        fail(res, error);
    }
});

// ============================================
// LOGIN  (email + OTP)
// ============================================

router.post('/login/request', async (req, res) => {
    try {
        const { email } = req.body || {};
        const result = await webAuthService.requestLoginOtp({ email, ip: getIp(req) });
        res.json({ success: true, message: 'If that email is registered, a code is on its way', ...result });
    } catch (error) {
        fail(res, error);
    }
});

router.post('/login/verify', async (req, res) => {
    try {
        const { email, code } = req.body || {};
        const { token, user } = await webAuthService.verifyOtp({
            email, code, purpose: 'login',
            ip: getIp(req), userAgent: req.headers['user-agent']
        });
        setSessionCookie(res, token);
        res.json({ success: true, token, user });
    } catch (error) {
        fail(res, error);
    }
});

// ============================================
// GOOGLE OAUTH
// ============================================

router.get('/google', async (req, res) => {
    try {
        const { url } = await webAuthService.buildGoogleAuthUrl();
        res.redirect(url);
    } catch (error) {
        const appUrl = process.env.WEB_APP_URL || '/';
        res.redirect(`${appUrl}?auth=error&reason=${encodeURIComponent(error.message || 'unavailable')}`);
    }
});

router.get('/google/callback', async (req, res) => {
    const appUrl = process.env.WEB_APP_URL || '/';
    try {
        const { code, state, error: oauthError } = req.query;

        if (oauthError) return res.redirect(`${appUrl}?auth=cancelled`);
        if (!code) return res.redirect(`${appUrl}?auth=error&reason=missing_code`);

        const { token, needsProfile } = await webAuthService.handleGoogleCallback({
            code, state, ip: getIp(req), userAgent: req.headers['user-agent']
        });

        setSessionCookie(res, token);
        res.redirect(`${appUrl}?auth=success${needsProfile ? '&needsProfile=1' : ''}`);
    } catch (error) {
        logger.error('Google callback error:', error.message);
        res.redirect(`${appUrl}?auth=error&reason=${encodeURIComponent(error.userFacing ? error.message : 'signin_failed')}`);
    }
});

// ============================================
// PROFILE COMPLETION  (Google signups)
// ============================================

router.post('/complete-profile', requireWebAuth, async (req, res) => {
    try {
        const { username, city, age, referralCode, acquisitionSource } = req.body || {};
        const user = await webAuthService.completeProfile(req.webUser.id, { username, city, age, referralCode, acquisitionSource });
        res.json({ success: true, user });
    } catch (error) {
        fail(res, error);
    }
});

// ============================================
// SESSION
// ============================================

router.get('/me', async (req, res) => {
    try {
        const user = await webAuthService.getSessionUser(getToken(req));
        if (!user) return res.json({ success: true, authenticated: false, user: null });
        res.json({ success: true, authenticated: true, user: webAuthService.publicUser(user) });
    } catch (error) {
        fail(res, error);
    }
});

// ============================================
// POST /web/auth/device
// ============================================
// Receives raw browser components and records a device fingerprint. The
// components are hashed SERVER-SIDE — the client never sends a finished id,
// because a client-computed id could be randomised per account and the whole
// multi-account check would be decorative.
//
// Always answers 200. This is a background integrity signal; a player whose
// browser blocks canvas should notice nothing, and an error here must never
// look like a login problem.
router.post('/device', requireWebAuth, async (req, res) => {
    try {
        const deviceTrackingService = require('../services/device-tracking.service');
        const components = req.body && req.body.components;

        const result = await deviceTrackingService.recordBrowserDevice(
            req.webUser.id, components, 'web'
        );

        // Same request carries the real client IP — a browser request, unlike a
        // WhatsApp webhook, which arrives from Meta's servers. Throttled to
        // once an hour per user per IP so it cannot flood ip_logs.
        try {
            const ip = getIp(req);
            if (ip) {
                await deviceTrackingService.recordIPThrottled(
                    req.webUser.id, ip, 'web_session'
                );
            }
        } catch (ipError) {
            logger.warn(`Could not record web session IP (non-fatal): ${ipError.message}`);
        }

        if (result && result.recorded) {
            logger.info(`🔍 Device recorded for web user ${req.webUser.id}: ${result.summary}`);
        }

        res.json({ success: true });
    } catch (error) {
        logger.error('Error recording web device (non-fatal):', error.message);
        res.json({ success: true });
    }
});

router.post('/logout', async (req, res) => {
    try {
        await webAuthService.destroySession(getToken(req));
        res.clearCookie(COOKIE_NAME, { path: '/' });
        res.json({ success: true });
    } catch (error) {
        fail(res, error);
    }
});

// ============================================
// LIVE VALIDATION  (for the signup form)
// ============================================

router.get('/check-username', async (req, res) => {
    try {
        const username = (req.query.u || '').trim();
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
            return res.json({
                success: true, available: false,
                reason: '3-20 characters — letters, numbers and underscores only'
            });
        }
        const taken = await webAuthService.isUsernameTaken(username);
        res.json({ success: true, available: !taken, reason: taken ? 'Already taken' : null });
    } catch (error) {
        fail(res, error);
    }
});

router.get('/config', (req, res) => {
    res.json({
        success: true,
        googleEnabled: webAuthService.isGoogleEnabled(),
        emailProvider: emailService.provider,
        acquisitionSources: webAuthService.getAcquisitionSources(),
        minAge: 18
    });
});

module.exports = router;
module.exports.requireWebAuth = requireWebAuth;
module.exports.requireCompleteProfile = requireCompleteProfile;
module.exports.getToken = getToken;