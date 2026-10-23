// ============================================
// FILE: src/services/gateways/bachs.gateway.js
// Bachs implementation of PaymentGateway interface
// API docs: https://docs.bachs.io
// ============================================
//
// HOW BACHS DIFFERS FROM THE OTHER FOUR — read this before changing anything.
//
// 1. It is looked up by ITS id, not ours. Every other gateway verifies by our
//    reference. Bachs verifies by checkout_id (GET /v1/checkout-sessions/{id}),
//    so initialize() records reference → checkout_id in Redis, and verify()
//    reads it back. If that record is gone, verify() searches recent payments
//    for our reference instead, so a flushed Redis delays nothing.
//
// 2. "Paid" is decided here, strictly. The token-credit path trusts
//    verify().success and does not compare amounts. A bank transfer on Bachs
//    can be UNDERPAID, and an underpayment can be "accepted" by Bachs as the
//    final outcome. So success means: a fulfilled status AND at least the
//    amount we asked for, in the currency we asked for. Nothing less.
//
// 3. The webhook is signed over the EXACT raw bytes:
//    HMAC-SHA256(secret, `${timestamp}.${rawBody}`), hex. A body that has been
//    parsed and re-stringified will not match. server.js keeps the raw bytes
//    for /payment/bachs-webhook only — see req.rawBody there.
//
// 4. Amounts are decimal strings in whole currency units: "500.00" is ₦500.
//    No kobo.
//
// Environment:
//   BACHS_SECRET_KEY      sk_sandbox_… (test) or sk_live_… (real money).
//                         The prefix picks the API host.
//   BACHS_WEBHOOK_SECRET  whsec_… from the Bachs developer portal (NOT the API key).
//   BACHS_PAYMENT_METHODS optional, comma-separated, e.g. NGN_CARD,NGN_BANK_TRANSFER.
//                         Defaults per currency below.
//   BACHS_BASE_URL        optional override of the API host. Leave unset.
// ============================================

const crypto = require('crypto');
const axios = require('axios');
const PaymentGateway = require('./payment-gateway.interface');
const { logger } = require('../../utils/logger');

const HOSTS = {
    sandbox: 'https://sandbox-api.bachs.io',
    production: 'https://api.bachs.io'
};

// Kept well past any checkout's life (max 24h) and any webhook retry (~80 min),
// so a late callback or an admin re-check still finds its checkout.
const MAP_TTL_SECONDS = 60 * 60 * 24 * 30;

// Bachs status words for a charge that has been paid. Lowercase on the API
// objects; the webhook sends them uppercase, so everything is lowercased first.
const PAID = ['succeeded', 'overpaid', 'accepted'];
// Still able to complete. Reported as 'pending' so callers treat it as
// transient (verifyPayment does not mark it failed).
const WAITING = ['open', 'created', 'processing', 'pending'];

// The payment methods offered per currency. Restricting a naira checkout to
// naira methods matters: Bachs can otherwise let a buyer pay in another
// currency, and the charge then comes back in that currency.
const DEFAULT_METHODS = {
    NGN: ['NGN_CARD', 'NGN_BANK_TRANSFER'],
    USD: ['USD_CARD']
};

class BachsGateway extends PaymentGateway {
    constructor() {
        super();
        this.secretKey = process.env.BACHS_SECRET_KEY;
        this.webhookSecret = process.env.BACHS_WEBHOOK_SECRET;

        const env = String(this.secretKey || '').startsWith('sk_live_') ? 'production' : 'sandbox';
        this.environment = env;
        this.baseUrl = (process.env.BACHS_BASE_URL || HOSTS[env]).replace(/\/$/, '');
    }

    getName() { return 'bachs'; }
    getDisplayName() { return 'Bachs'; }

    async isEnabled() {
        if (!this.secretKey) return false;
        try {
            const pool = require('../../config/database');
            const r = await pool.query(`SELECT is_enabled FROM payment_gateway_config WHERE gateway_name = 'bachs'`);
            if (r.rows.length === 0) return false; // default OFF until admin enables
            return r.rows[0].is_enabled === true;
        } catch (e) {
            logger.error('Error checking bachs enabled state:', e.message);
            return false;
        }
    }

    _headers(extra = {}) {
        return {
            Authorization: `Bearer ${this.secretKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...extra
        };
    }

    _redis() { return require('../../config/redis'); }

    // Bachs errors look like { status_code, error_code, detail, errors }.
    _errorText(error) {
        const d = error && error.response && error.response.data;
        if (d && typeof d === 'object') {
            const field = Array.isArray(d.errors) && d.errors.length
                ? ` (${d.errors.map(e => [e.field || e.loc, e.message || e.msg].filter(Boolean).join(': ')).join('; ')})`
                : '';
            return `${d.detail || d.error_code || 'request failed'}${field}`;
        }
        return (error && error.message) || 'unknown error';
    }

    _methods(currency) {
        const fromEnv = String(process.env.BACHS_PAYMENT_METHODS || '')
            .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        if (fromEnv.length) {
            // Never offer another currency's method on this checkout.
            const own = fromEnv.filter(m => m.startsWith(currency + '_'));
            if (own.length) return own;
        }
        return DEFAULT_METHODS[currency] || null;
    }

    // ============================================
    // INITIALIZE
    // ============================================
    // A product-free checkout: the amount alone, no catalog product needed.
    async initialize({ reference, amount, email, callbackUrl, metadata = {}, customerName, currency = 'NGN' }) {
        const cur = String(currency || 'NGN').toUpperCase();
        try {
            if (!this.secretKey) throw new Error('BACHS_SECRET_KEY is not set');

            const value = Number(amount);
            if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid amount ${amount}`);
            const money = value.toFixed(2);

            // Our reference rides on the return URL, so every callback page
            // works unchanged. Bachs adds ?checkout_id=… to the success URL;
            // paymentReferenceOf() tolerates it being glued on with a second "?".
            const sep = String(callbackUrl).includes('?') ? '&' : '?';
            const returnUrl = `${callbackUrl}${sep}reference=${encodeURIComponent(reference)}`;

            // Up to 20 keys, returned in webhooks. Strings only, empties dropped.
            const meta = {};
            for (const k of ['user_id', 'tournament_id', 'package_id', 'is_rebuy', 'platform',
                             'tv_room_id', 'tv_prize_id', 'description']) {
                const v = metadata[k];
                if (v !== undefined && v !== null && v !== '') meta[k] = String(v).slice(0, 200);
            }
            meta.wut_reference = reference;

            const payload = {
                pricing: { currency: cur, amount: money },
                // Bachs requires email and name together.
                customer: {
                    email,
                    name: String(customerName || metadata.user_name || 'Player').slice(0, 120)
                },
                customer_creation: 'if_required',
                success_url: returnUrl,
                cancel_url: returnUrl,
                reference,
                metadata: meta
            };
            const methods = this._methods(cur);
            if (methods) payload.payment_method_types = methods;

            const response = await axios.post(`${this.baseUrl}/v1/checkout-sessions`, payload, {
                headers: this._headers({ 'Idempotency-Key': reference }),
                timeout: 20000
            });

            const data = response.data || {};
            if (!data.checkout_url || !data.checkout_id) {
                throw new Error('Bachs did not return a checkout link');
            }

            // Recorded before the player can possibly pay, so the webhook and
            // every verify() find it.
            try {
                const redis = this._redis();
                await redis.setex(`bachs_checkout:${reference}`, MAP_TTL_SECONDS, JSON.stringify({
                    checkoutId: data.checkout_id, amount: money, currency: cur
                }));
                await redis.setex(`bachs_reference:${data.checkout_id}`, MAP_TTL_SECONDS, reference);
            } catch (e) {
                // Not fatal: verify() falls back to searching payments by reference.
                logger.error(`Bachs: could not record checkout for ${reference}: ${e.message}`);
            }

            logger.info(`Bachs checkout created (${this.environment}): ${reference} → ${data.checkout_id}, ${cur} ${money}`);

            return {
                authorization_url: data.checkout_url,
                access_code: data.checkout_id,
                reference,
                gateway: this.getName()
            };
        } catch (error) {
            const msg = this._errorText(error);
            logger.error(`Bachs init error for ${reference}: HTTP ${error.response?.status || '?'} — ${msg}`);
            throw new Error(`Bachs: ${msg}`);
        }
    }

    // ============================================
    // VERIFY
    // ============================================
    async verify(reference) {
        const fail = (status, error, extra = {}) => ({
            success: false, status, amount: 0, reference, gateway: this.getName(), error, ...extra
        });
        try {
            let record = null;
            try {
                const raw = await this._redis().get(`bachs_checkout:${reference}`);
                if (raw) record = JSON.parse(raw);
            } catch (e) { /* fall through to the search */ }

            let charge = null;          // { status, amount, amount_paid, currency, ... }
            let expected = record ? { amount: Number(record.amount), currency: record.currency } : null;
            let raw = null;

            if (record && record.checkoutId) {
                const r = await axios.get(
                    `${this.baseUrl}/v1/checkout-sessions/${encodeURIComponent(record.checkoutId)}`,
                    { headers: this._headers(), timeout: 15000 });
                const s = r.data || {};
                raw = s;
                // The checkout's own reference must be ours. A mismatch means
                // the record points at somebody else's checkout.
                if (s.reference && s.reference !== reference) {
                    logger.error(`Bachs verify ${reference}: checkout ${record.checkoutId} carries reference ${s.reference}`);
                    return fail('error', 'reference mismatch');
                }
                if (!expected && s.amount) expected = { amount: Number(s.amount), currency: s.currency };
                if (s.charge) {
                    charge = s.charge;
                } else {
                    // No charge yet: the buyer has not paid, or the session ended.
                    const st = String(s.status || '').toLowerCase();
                    if (['expired', 'incomplete', 'cancelled', 'canceled', 'failed'].includes(st)) {
                        return fail('failed', `checkout ${st}`, { raw: s });
                    }
                    return fail('pending', null, { raw: s });
                }
            } else {
                // No record (Redis lost it, or it was never written). Search the
                // most recent payments for our reference.
                const r = await axios.get(`${this.baseUrl}/v1/payments`, {
                    headers: this._headers(), params: { limit: 100 }, timeout: 15000
                });
                const items = (r.data && r.data.items) || [];
                charge = items.find(p => p && p.reference === reference) || null;
                raw = charge;
                if (!charge) return fail('pending', 'no Bachs payment found for this reference yet');
            }

            const status = String(charge.status || '').toLowerCase();
            const currency = charge.currency ? String(charge.currency).toUpperCase() : null;
            // amount_paid is what actually arrived; amount is what was due.
            const paid = Number(charge.amount_paid != null && charge.amount_paid !== '' ? charge.amount_paid : charge.amount) || 0;

            if (WAITING.includes(status)) return fail('pending', null, { amount: paid, currency, raw });
            if (!PAID.includes(status)) {
                // underpaid, failed, incomplete, refunded, …
                return fail(status || 'failed', `Bachs status ${status || 'unknown'}`, { amount: paid, currency, raw });
            }

            // Paid in full, in the currency we charged in. "accepted" can be an
            // underpayment Bachs accepted — not good enough for us.
            if (expected && expected.currency && currency && currency !== String(expected.currency).toUpperCase()) {
                logger.error(`Bachs verify ${reference}: paid in ${currency}, expected ${expected.currency}`);
                return fail('wrong_currency', `paid in ${currency}`, { amount: paid, currency, raw });
            }
            if (expected && Number.isFinite(expected.amount) && paid + 0.009 < expected.amount) {
                logger.error(`Bachs verify ${reference}: paid ${paid}, expected ${expected.amount}`);
                return fail('underpaid', `paid ${paid} of ${expected.amount}`, { amount: paid, currency, raw });
            }
            // Always, even with nothing recorded: what arrived against what
            // the charge itself says was due.
            const due = Number(charge.amount);
            if (Number.isFinite(due) && due > 0 && paid + 0.009 < due) {
                logger.error(`Bachs verify ${reference}: charge shows ${paid} paid of ${due} due`);
                return fail('underpaid', `paid ${paid} of ${due}`, { amount: paid, currency, raw });
            }

            return {
                success: true,
                status: 'success',
                amount: paid,                   // whole units of `currency`
                currency,
                reference,
                gateway: this.getName(),
                raw: {
                    ...charge,
                    // What payment.service stores: the gateway's own id and channel.
                    reference: charge.payment_id || charge.id || (raw && raw.checkout_id) || reference,
                    channel: charge.payment_method || null,
                    paid_at: charge.completed_at || null
                }
            };
        } catch (error) {
            const msg = this._errorText(error);
            logger.error(`Bachs verify error for ${reference}: HTTP ${error.response?.status || '?'} — ${msg}`);
            return fail('error', msg);
        }
    }

    /**
     * Our reference for a Bachs checkout id. Used when a redirect arrives with
     * only ?checkout_id=… and when a webhook carries no reference.
     */
    async referenceForCheckout(checkoutId) {
        if (!checkoutId) return null;
        try {
            const cached = await this._redis().get(`bachs_reference:${checkoutId}`);
            if (cached) return cached;
        } catch (e) { /* ask Bachs */ }
        try {
            const r = await axios.get(
                `${this.baseUrl}/v1/checkout-sessions/${encodeURIComponent(checkoutId)}`,
                { headers: this._headers(), timeout: 15000 });
            return (r.data && r.data.reference) || null;
        } catch (error) {
            logger.error(`Bachs: could not read checkout ${checkoutId}: ${this._errorText(error)}`);
            return null;
        }
    }

    // ============================================
    // WEBHOOK
    // ============================================
    /**
     * @param {Buffer|string} rawBody  the exact bytes received, before parsing
     * @param {object} headers         req.headers
     * Accepts X-Bachs-Signature-V2 ("t=…,v1=…[,v1=…]") and falls back to the
     * older X-Bachs-Signature + X-Bachs-Timestamp pair, as the official SDK
     * does. Rejects anything older or newer than 5 minutes.
     */
    verifyWebhookSignature(rawBody, headers) {
        if (!this.webhookSecret || rawBody == null || !headers) return false;
        try {
            const h = (name) => {
                const v = headers[name.toLowerCase()];
                return Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v;
            };

            let timestamp, signatures;
            const v2 = h('x-bachs-signature-v2');
            if (v2 !== undefined) {
                const parts = String(v2).split(',').map(p => p.trim());
                const ts = parts.filter(p => p.startsWith('t='));
                if (ts.length !== 1) return false;
                timestamp = ts[0].slice(2);
                signatures = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
            } else {
                timestamp = h('x-bachs-timestamp');
                const sig = h('x-bachs-signature');
                signatures = sig ? [String(sig)] : [];
            }

            if (!timestamp || !/^\d+$/.test(String(timestamp))) return false;
            if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
                logger.warn('Bachs webhook timestamp outside the 5-minute window');
                return false;
            }

            const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
            const expected = crypto.createHmac('sha256', this.webhookSecret)
                .update(String(timestamp) + '.', 'utf8').update(bytes).digest();

            return signatures.some(s => /^[a-fA-F0-9]{64}$/.test(s)
                && crypto.timingSafeEqual(expected, Buffer.from(s, 'hex')));
        } catch (e) {
            logger.error('Bachs signature check error:', e.message);
            return false;
        }
    }

    parseWebhook(payload) {
        // { id: 'evt_…', type: 'collection.succeeded', created_at, organization_id,
        //   data: { reference, checkout_id, charge_id, status: 'SUCCEEDED', amount, currency, metadata } }
        const data = (payload && payload.data) || {};
        const status = String(data.status || '').toLowerCase();
        return {
            reference: data.reference || (data.metadata && data.metadata.wut_reference) || null,
            checkoutId: data.checkout_id || null,
            status: PAID.includes(status) ? 'success' : (status || 'failed'),
            amount: data.amount ? Number(data.amount) : 0,
            event: payload && payload.type,
            eventId: payload && payload.id,
            raw: payload
        };
    }
}

module.exports = BachsGateway;
