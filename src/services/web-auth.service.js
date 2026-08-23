// ============================================
// FILE: src/services/web-auth.service.js
// Web play authentication: email OTP + Google OAuth + sessions.
//
// Web accounts live in the same `users` table but are identified by a
// `web_<id>` value in phone_number, matching the existing `tg_` convention.
// They are separate accounts from WhatsApp/Telegram by design.
// ============================================

const crypto = require('crypto');
const axios = require('axios');
const pool = require('../config/database');
const redis = require('../config/redis');
const emailService = require('./email.service');
const { logger } = require('../utils/logger');
const activityService = require('./activity.service');

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;   // 30 days
const OTP_PER_EMAIL_PER_HOUR = 5;
const OTP_PER_IP_PER_HOUR = 15;
// 13 platform-wide, matching the chat registration flow
// (webhook.controller.js) and the published legal pages. Web was the odd one
// out at 18. Putting money UP for a sponsored challenge prize still requires
// 18+ — that check lives at challenge creation, not here.
const MIN_AGE = 13;

// Must match the slugs used by the WhatsApp/Telegram registration flow,
// otherwise web signups fragment the acquisition-source reporting.
const ACQUISITION_SOURCES = [
    { value: 'instagram',     label: 'Instagram' },
    { value: 'facebook',      label: 'Facebook' },
    { value: 'twitter',       label: 'X (Twitter)' },
    { value: 'youtube',       label: 'YouTube' },
    { value: 'google',        label: 'Google' },
    { value: 'friends',       label: 'Friends' },
    { value: 'word_of_mouth', label: 'Word of mouth' },
    { value: 'live_event',    label: 'Live event' },
    { value: 'other',         label: 'Other' }
];
const ACQUISITION_VALUES = ACQUISITION_SOURCES.map(s => s.value);

class WebAuthService {

    // ============================================
    // VALIDATION
    // ============================================

    getAcquisitionSources() { return ACQUISITION_SOURCES; }

    validateSignupInput({ email, fullName, city, username, age, acquisitionSource }) {
        const errors = [];

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
            errors.push('Enter a valid email address');
        }
        if (!fullName || fullName.trim().length < 2 || fullName.trim().length > 100) {
            errors.push('Full name must be between 2 and 100 characters');
        }
        if (!city || city.trim().length < 2 || city.trim().length > 100) {
            errors.push('Enter your city');
        }
        if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username.trim())) {
            errors.push('Username must be 3-20 characters — letters, numbers and underscores only');
        }
        const parsedAge = parseInt(age, 10);
        if (isNaN(parsedAge) || parsedAge < MIN_AGE || parsedAge > 120) {
            errors.push(`You must be at least ${MIN_AGE} to play`);
        }
        if (!acquisitionSource || !ACQUISITION_VALUES.includes(acquisitionSource)) {
            errors.push('Tell us how you heard about us');
        }

        return errors;
    }

    async isEmailTaken(email) {
        // Scoped to web accounts. Chat-platform users may carry legacy emails
        // (KYC, payouts) which are NOT login credentials and must be ignored here.
        const r = await pool.query(
            "SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND platform = 'web' LIMIT 1",
            [email.trim()]
        );
        return r.rows.length > 0;
    }

    async isUsernameTaken(username) {
        const r = await pool.query(
            'SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1',
            [username.trim()]
        );
        return r.rows.length > 0;
    }

    /** Resolve a referral code to a referrer id. Returns null if blank, throws if invalid. */
    async resolveReferralCode(code) {
        if (!code || !code.trim()) return null;
        const r = await pool.query(
            'SELECT id FROM users WHERE UPPER(referral_code) = UPPER($1) LIMIT 1',
            [code.trim()]
        );
        if (r.rows.length === 0) {
            const err = new Error('That referral code is not valid');
            err.userFacing = true;
            throw err;
        }
        return r.rows[0].id;
    }

    // ============================================
    // RATE LIMITING
    // ============================================

    async _checkRateLimit(email, ip) {
        const emailKey = `otp_rl:email:${email.toLowerCase()}`;
        const ipKey = `otp_rl:ip:${ip || 'unknown'}`;

        const emailCount = await redis.incr(emailKey);
        if (emailCount === 1) await redis.expire(emailKey, 3600);

        const ipCount = await redis.incr(ipKey);
        if (ipCount === 1) await redis.expire(ipKey, 3600);

        if (emailCount > OTP_PER_EMAIL_PER_HOUR) {
            const err = new Error('Too many codes requested for this email. Please try again in an hour.');
            err.userFacing = true;
            throw err;
        }
        if (ipCount > OTP_PER_IP_PER_HOUR) {
            const err = new Error('Too many attempts from this connection. Please try again later.');
            err.userFacing = true;
            throw err;
        }
    }

    // ============================================
    // OTP
    // ============================================

    _generateOtp() {
        // 6 digits, cryptographically random, no leading-zero bias
        return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    }

    _hashOtp(code) {
        return crypto.createHash('sha256').update(code).digest('hex');
    }

    async _issueOtp({ email, purpose, signupPayload = null, ip }) {
        const code = this._generateOtp();
        const codeHash = this._hashOtp(code);
        // ISO-8601 with explicit Z. Avoids relying on the Node process timezone
        // when the driver serialises a Date into a timestamp column.
        const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

        // Invalidate any outstanding codes for this email+purpose
        await pool.query(`
            UPDATE email_otps SET consumed_at = NOW()
            WHERE LOWER(email) = LOWER($1) AND purpose = $2 AND consumed_at IS NULL
        `, [email, purpose]);

        await pool.query(`
            INSERT INTO email_otps (email, code_hash, purpose, signup_payload, expires_at, ip_address)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [email.trim(), codeHash, purpose, signupPayload ? JSON.stringify(signupPayload) : null, expiresAt, ip || null]);

        const sent = await emailService.sendOtp(email.trim(), code, purpose);
        if (!sent) {
            // Set EMAIL_DEBUG=true in Render to surface the provider's reason in
            // the API response while you're configuring email. Turn it off after.
            const detail = (process.env.EMAIL_DEBUG === 'true' && emailService.lastError)
                ? ` [${emailService.provider}: ${emailService.lastError}]`
                : '';
            const err = new Error(`We couldn't send the email right now. Please try again shortly.${detail}`);
            err.userFacing = true;
            throw err;
        }

        logger.info(`🔑 OTP issued (${purpose}) for ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
        return { expiresInMinutes: OTP_TTL_MINUTES };
    }

    /** Step 1 of signup — validates everything, holds the payload, emails a code. */
    async requestSignupOtp({ email, fullName, city, username, age, referralCode, acquisitionSource, newsletterOptIn = true, ip }) {
        const errors = this.validateSignupInput({ email, fullName, city, username, age, acquisitionSource });
        if (errors.length) {
            const err = new Error(errors[0]);
            err.userFacing = true;
            err.errors = errors;
            throw err;
        }

        if (await this.isEmailTaken(email)) {
            const err = new Error('An account with that email already exists. Try signing in instead.');
            err.userFacing = true;
            throw err;
        }
        if (await this.isUsernameTaken(username)) {
            const err = new Error('That username is taken. Please pick another.');
            err.userFacing = true;
            throw err;
        }

        // Validate the referral code now so the user finds out before verifying
        const referrerId = await this.resolveReferralCode(referralCode);

        await this._checkRateLimit(email, ip);

        return this._issueOtp({
            email,
            purpose: 'signup',
            ip,
            signupPayload: {
                fullName: fullName.trim(),
                city: city.trim(),
                username: username.trim(),
                age: parseInt(age, 10),
                referrerId,
                acquisitionSource,
                newsletterOptIn: newsletterOptIn !== false
            }
        });
    }

    /** Step 1 of login — emails a code to an existing account. */
    async requestLoginOtp({ email, ip }) {
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
            const err = new Error('Enter a valid email address');
            err.userFacing = true;
            throw err;
        }

        await this._checkRateLimit(email, ip);

        const exists = await this.isEmailTaken(email);
        if (!exists) {
            // Don't confirm or deny whether the account exists — that leaks
            // which emails are registered. Return success either way.
            logger.info(`Login OTP requested for unknown email ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} — no email sent`);
            return { expiresInMinutes: OTP_TTL_MINUTES };
        }

        return this._issueOtp({ email, purpose: 'login', ip });
    }

    /** Step 2 — verify the code. Creates the account on signup, returns a session token. */
    async verifyOtp({ email, code, purpose, ip, userAgent }) {
        if (!email || !code || !/^\d{6}$/.test(String(code).trim())) {
            const err = new Error('Enter the 6-digit code from your email');
            err.userFacing = true;
            throw err;
        }

        // Fetch the latest code for this email+purpose regardless of state, so we
        // can tell the user WHY it failed. Expiry is evaluated by Postgres, not JS,
        // so it can't be thrown off by a timezone mismatch between app and database.
        const r = await pool.query(`
            SELECT *, (expires_at <= NOW()) AS is_expired
            FROM email_otps
            WHERE LOWER(email) = LOWER($1) AND purpose = $2
            ORDER BY created_at DESC LIMIT 1
        `, [email.trim(), purpose]);

        const masked = email.replace(/(.{2}).*(@.*)/, '$1***$2');

        if (r.rows.length === 0) {
            logger.warn(`OTP verify failed [no_code_issued] ${masked} purpose=${purpose}`);
            const err = new Error('No code was sent to that email address. Check the address is correct and request a new code.');
            err.userFacing = true;
            throw err;
        }

        const otp = r.rows[0];

        if (otp.consumed_at) {
            logger.warn(`OTP verify failed [already_used] ${masked} purpose=${purpose} otp_id=${otp.id}`);
            const err = new Error('That code has already been used, or a newer code was sent. Please use the most recent code, or request a new one.');
            err.userFacing = true;
            throw err;
        }

        if (otp.is_expired) {
            logger.warn(`OTP verify failed [expired] ${masked} purpose=${purpose} otp_id=${otp.id} expires_at=${otp.expires_at}`);
            await pool.query('UPDATE email_otps SET consumed_at = NOW() WHERE id = $1', [otp.id]);
            const err = new Error(`That code has expired — codes last ${OTP_TTL_MINUTES} minutes. Please request a new one.`);
            err.userFacing = true;
            throw err;
        }

        if (otp.attempts >= OTP_MAX_ATTEMPTS) {
            await pool.query('UPDATE email_otps SET consumed_at = NOW() WHERE id = $1', [otp.id]);
            const err = new Error('Too many incorrect attempts. Please request a new code.');
            err.userFacing = true;
            throw err;
        }

        if (this._hashOtp(String(code).trim()) !== otp.code_hash) {
            await pool.query('UPDATE email_otps SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
            const remaining = OTP_MAX_ATTEMPTS - (otp.attempts + 1);
            const err = new Error(
                remaining > 0
                    ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
                    : 'Incorrect code. Please request a new one.'
            );
            err.userFacing = true;
            throw err;
        }

        // Correct — burn the code
        await pool.query('UPDATE email_otps SET consumed_at = NOW() WHERE id = $1', [otp.id]);

        let user;
        if (purpose === 'signup') {
            const payload = typeof otp.signup_payload === 'string'
                ? JSON.parse(otp.signup_payload)
                : otp.signup_payload;

            // Re-check uniqueness — someone may have claimed it while the code sat unused
            if (await this.isEmailTaken(email)) {
                const err = new Error('An account with that email already exists. Try signing in.');
                err.userFacing = true;
                throw err;
            }
            if (await this.isUsernameTaken(payload.username)) {
                const err = new Error('That username was just taken. Please sign up again with a different one.');
                err.userFacing = true;
                throw err;
            }

            user = await this.createWebUser({
                email: email.trim(),
                fullName: payload.fullName,
                city: payload.city,
                username: payload.username,
                age: payload.age,
                referrerId: payload.referrerId,
                authProvider: 'email',
                acquisitionSource: payload.acquisitionSource,
                newsletterOptIn: payload.newsletterOptIn !== false
            });

            emailService.sendWelcome(user.email, user.username).catch(() => {});
        } else {
            const ur = await pool.query(
                "SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND platform = 'web' LIMIT 1",
                [email.trim()]
            );
            if (ur.rows.length === 0) {
                const err = new Error('No account found for that email.');
                err.userFacing = true;
                throw err;
            }
            user = ur.rows[0];
        }

        await pool.query(
            'UPDATE users SET email_verified = true, web_last_login = NOW(), last_active = NOW() WHERE id = $1',
            [user.id]
        );

        const token = await this.createSession(user.id, ip, userAgent);
        return { token, user: this.publicUser(user) };
    }

    // ============================================
    // USER CREATION
    // ============================================

    /**
     * Creates a web-platform user. Mirrors userService.createUser but adds email
     * fields and uses the `web_` identifier prefix. Kept separate so the live
     * WhatsApp/Telegram registration path is untouched.
     */
    async createWebUser({ email, fullName, city, username, age, referrerId = null, authProvider = 'email', googleId = null, profileComplete = true, newsletterOptIn = true, acquisitionSource = null }) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const referralCode = this._generateReferralCode();
            // users.phone_number is varchar(20). 'web_' + 12 hex = 16 chars, which
            // fits with room to spare. 48 bits of entropy, and the column's unique
            // constraint is the real backstop.
            const identifier = `web_${crypto.randomBytes(6).toString('hex')}`;

            const userResult = await client.query(`
                INSERT INTO users (
                    phone_number, full_name, city, username, age,
                    referral_code, referred_by, platform,
                    email, email_verified, auth_provider, google_id, profile_complete,
                    terms_accepted, privacy_accepted, consent_timestamp, consent_platform,
                    acquisition_source, web_last_login,
                    newsletter_opted_in, newsletter_opted_in_at, newsletter_source, newsletter_token
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,'web',$8,true,$9,$10,$11,true,true,NOW(),'web',$12,NOW(),
                        $13, CASE WHEN $13 THEN NOW() ELSE NULL END, CASE WHEN $13 THEN 'web' ELSE NULL END, $14)
                RETURNING *
            `, [
                identifier, fullName, city, username, age,
                referralCode, referrerId,
                email ? email.toLowerCase() : null, authProvider, googleId, profileComplete,
                acquisitionSource || null,
                newsletterOptIn !== false,
                crypto.randomBytes(16).toString('hex')
            ]);

            const user = userResult.rows[0];

            if (referrerId) {
                const referrerResult = await client.query(
                    'SELECT referral_code, phone_number FROM users WHERE id = $1',
                    [referrerId]
                );
                if (referrerResult.rows.length > 0) {
                    const ref = referrerResult.rows[0];
                    const referrerPlatform = ref.phone_number.startsWith('tg_') ? 'telegram'
                        : ref.phone_number.startsWith('web_') ? 'web' : 'whatsapp';

                    await client.query(`
                        INSERT INTO referrals (
                            referrer_id, referred_user_id, referral_code,
                            referrer_platform, referee_platform
                        ) VALUES ($1, $2, $3, $4, 'web')
                    `, [referrerId, user.id, ref.referral_code, referrerPlatform]);

                    logger.info(`Referral created: web user ${user.id} referred by ${referrerId} (${referrerPlatform})`);
                }
            }

            await client.query('COMMIT');
            logger.info(`✅ New WEB user: @${username} (${fullName}) from ${city}, age ${age}. Ref code: ${referralCode}`);

            // Social proof event (site ticker) — fire-and-forget, never awaited
            activityService.record('user_join', user.id, { city });

            return user;

        } catch (error) {
            await client.query('ROLLBACK');
            logger.error(`Error creating web user: ${error.message} [code=${error.code}]`);
            if (error.code === '23505') {
                const err = new Error('That email or username is already registered.');
                err.userFacing = true;
                throw err;
            }
            throw error;
        } finally {
            client.release();
        }
    }

    _generateReferralCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
        return code;
    }

    // ============================================
    // GOOGLE OAUTH
    // ============================================

    isGoogleEnabled() {
        return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    }

    _googleRedirectUri() {
        return process.env.GOOGLE_REDIRECT_URI
            || `${process.env.APP_URL}/web/auth/google/callback`;
    }

    /** Returns { url, state }. Caller should send the user to `url`. */
    async buildGoogleAuthUrl() {
        if (!this.isGoogleEnabled()) {
            const err = new Error('Google sign-in is not available right now.');
            err.userFacing = true;
            throw err;
        }

        const state = crypto.randomBytes(16).toString('hex');
        await redis.setex(`goauth_state:${state}`, 600, '1');

        const params = new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID,
            redirect_uri: this._googleRedirectUri(),
            response_type: 'code',
            scope: 'openid email profile',
            state,
            access_type: 'online',
            prompt: 'select_account'
        });

        return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, state };
    }

    /**
     * Exchanges the OAuth code and signs the user in (creating the account if new).
     * Returns { token, user, needsProfile }.
     */
    async handleGoogleCallback({ code, state, ip, userAgent }) {
        if (!state || !(await redis.get(`goauth_state:${state}`))) {
            const err = new Error('That sign-in link expired. Please try again.');
            err.userFacing = true;
            throw err;
        }
        await redis.del(`goauth_state:${state}`);

        let profile;
        try {
            const tokenRes = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
                code,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: this._googleRedirectUri(),
                grant_type: 'authorization_code'
            }).toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 15000
            });

            const infoRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
                timeout: 15000
            });
            profile = infoRes.data;
        } catch (error) {
            logger.error('Google OAuth exchange failed:', error.response?.data || error.message);
            const err = new Error("We couldn't complete Google sign-in. Please try again.");
            err.userFacing = true;
            throw err;
        }

        if (!profile.email || !profile.email_verified) {
            const err = new Error('Your Google account needs a verified email to sign in.');
            err.userFacing = true;
            throw err;
        }

        // Existing account by google_id, then by email
        let userRes = await pool.query(
            "SELECT * FROM users WHERE google_id = $1 AND platform = 'web' LIMIT 1",
            [profile.sub]
        );
        if (userRes.rows.length === 0) {
            userRes = await pool.query(
                "SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND platform = 'web' LIMIT 1",
                [profile.email]
            );
            if (userRes.rows.length > 0) {
                await pool.query(
                    'UPDATE users SET google_id = $1, auth_provider = $2, email_verified = true WHERE id = $3',
                    [profile.sub, 'google', userRes.rows[0].id]
                );
            }
        }

        let user;
        if (userRes.rows.length > 0) {
            user = userRes.rows[0];
        } else {
            // New account. Google gives us name + email but not username, city or age,
            // so the account is created incomplete and the frontend collects the rest.
            const username = await this._deriveUniqueUsername(profile.email);
            user = await this.createWebUser({
                email: profile.email,
                fullName: profile.name || profile.email.split('@')[0],
                city: null,
                username,
                age: null,
                authProvider: 'google',
                googleId: profile.sub,
                profileComplete: false
            });
        }

        await pool.query(
            'UPDATE users SET web_last_login = NOW(), last_active = NOW() WHERE id = $1',
            [user.id]
        );

        const token = await this.createSession(user.id, ip, userAgent);
        return { token, user: this.publicUser(user), needsProfile: user.profile_complete === false };
    }

    async _deriveUniqueUsername(email) {
        let base = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 15);
        if (base.length < 3) base = `player${base}`;

        if (!(await this.isUsernameTaken(base))) return base;
        for (let i = 0; i < 25; i++) {
            const candidate = `${base.slice(0, 15)}${crypto.randomInt(100, 9999)}`;
            if (!(await this.isUsernameTaken(candidate))) return candidate;
        }
        return `player${crypto.randomBytes(4).toString('hex')}`;
    }

    /** Finishes a Google signup by collecting the fields Google can't provide. */
    async completeProfile(userId, { username, city, age, referralCode, acquisitionSource }) {
        const errors = [];
        if (!acquisitionSource || !ACQUISITION_VALUES.includes(acquisitionSource)) {
            errors.push('Tell us how you heard about us');
        }
        if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username.trim())) {
            errors.push('Username must be 3-20 characters — letters, numbers and underscores only');
        }
        if (!city || city.trim().length < 2) errors.push('Enter your city');
        const parsedAge = parseInt(age, 10);
        if (isNaN(parsedAge) || parsedAge < MIN_AGE || parsedAge > 120) {
            errors.push(`You must be at least ${MIN_AGE} to play`);
        }
        if (errors.length) {
            const err = new Error(errors[0]);
            err.userFacing = true;
            err.errors = errors;
            throw err;
        }

        const current = await pool.query('SELECT username, referred_by FROM users WHERE id = $1', [userId]);
        if (current.rows.length === 0) throw new Error('User not found');

        if (current.rows[0].username?.toLowerCase() !== username.trim().toLowerCase()
            && await this.isUsernameTaken(username)) {
            const err = new Error('That username is taken. Please pick another.');
            err.userFacing = true;
            throw err;
        }

        // Referral only applies if they weren't already referred
        let referrerId = current.rows[0].referred_by;
        if (!referrerId && referralCode) {
            referrerId = await this.resolveReferralCode(referralCode);
            if (referrerId === userId) {
                const err = new Error("You can't use your own referral code.");
                err.userFacing = true;
                throw err;
            }
        }

        const updated = await pool.query(`
            UPDATE users
            SET username = $1, city = $2, age = $3, referred_by = COALESCE(referred_by, $4),
                acquisition_source = COALESCE(acquisition_source, $5),
                profile_complete = true
            WHERE id = $6
            RETURNING *
        `, [username.trim(), city.trim(), parsedAge, referrerId, acquisitionSource, userId]);

        // Record the referral link if one was just applied
        if (referrerId && !current.rows[0].referred_by) {
            try {
                const ref = await pool.query('SELECT referral_code, phone_number FROM users WHERE id = $1', [referrerId]);
                if (ref.rows.length > 0) {
                    const referrerPlatform = ref.rows[0].phone_number.startsWith('tg_') ? 'telegram'
                        : ref.rows[0].phone_number.startsWith('web_') ? 'web' : 'whatsapp';
                    await pool.query(`
                        INSERT INTO referrals (referrer_id, referred_user_id, referral_code, referrer_platform, referee_platform)
                        VALUES ($1, $2, $3, $4, 'web')
                    `, [referrerId, userId, ref.rows[0].referral_code, referrerPlatform]);
                }
            } catch (e) {
                logger.error('Could not record referral on profile completion:', e.message);
            }
        }

        logger.info(`✅ Web profile completed for user ${userId} (@${username})`);
        return this.publicUser(updated.rows[0]);
    }

    // ============================================
    // SESSIONS  (Redis-backed opaque tokens)
    // ============================================

    // `scope` is null for a normal login. A challenge code produces a SCOPED
    // session instead: it resolves to the same user, but requireWebAuth
    // refuses it everywhere except that one challenge. A code arriving over
    // WhatsApp must not be a way into credits, payout history or bank details.
    async createSession(userId, ip, userAgent, scope = null, ttlSeconds = null) {
        const token = crypto.randomBytes(32).toString('hex');
        await redis.setex(`web_sess:${token}`, ttlSeconds || SESSION_TTL_SECONDS, JSON.stringify({
            userId,
            ip: ip || null,
            userAgent: (userAgent || '').slice(0, 200),
            scope: scope || null,
            createdAt: Date.now()
        }));
        return token;
    }

    /**
     * The user AND the session's scope. getSessionUser() returns only the user
     * and therefore cannot tell a full login from a scoped one \u2014 anything
     * making an authorisation decision must use this.
     */
    async getSessionContext(token) {
        if (!token) return null;
        try {
            const raw = await redis.get(`web_sess:${token}`);
            if (!raw) return null;

            const sess = JSON.parse(raw);
            await redis.expire(`web_sess:${token}`, SESSION_TTL_SECONDS);

            const r = await pool.query('SELECT * FROM users WHERE id = $1', [sess.userId]);
            if (!r.rows[0]) return null;

            return { user: r.rows[0], scope: sess.scope || null };
        } catch (error) {
            logger.error('Error resolving web session context:', error.message);
            return null;
        }
    }

    /** Returns the full user row, or null. Slides the session TTL on each use. */
    async getSessionUser(token) {
        if (!token) return null;
        try {
            const raw = await redis.get(`web_sess:${token}`);
            if (!raw) return null;

            const sess = JSON.parse(raw);
            await redis.expire(`web_sess:${token}`, SESSION_TTL_SECONDS);

            const r = await pool.query('SELECT * FROM users WHERE id = $1', [sess.userId]);
            return r.rows[0] || null;
        } catch (error) {
            logger.error('Error resolving web session:', error.message);
            return null;
        }
    }

    async destroySession(token) {
        if (token) await redis.del(`web_sess:${token}`);
    }

    // ============================================
    // SHAPING
    // ============================================

    /** Strips anything that shouldn't reach the browser. */
    publicUser(user) {
        if (!user) return null;
        return {
            id: user.id,
            username: user.username,
            fullName: user.full_name,
            city: user.city,
            email: user.email,
            age: user.age,
            referralCode: user.referral_code,
            gamesRemaining: user.games_remaining ?? 0,
            totalGamesPurchased: user.total_games_purchased ?? 0,
            // /web/game/state queries these and spread them in — but the
            // whitelist below dropped them on the floor, which is why the
            // lobby showed 0 streak and 0 best for every player, always.
            currentStreak: user.current_streak ?? 0,
            longestStreak: user.longest_streak ?? 0,
            profileComplete: user.profile_complete !== false,
            authProvider: user.auth_provider,
            createdAt: user.created_at
        };
    }
}

module.exports = new WebAuthService();