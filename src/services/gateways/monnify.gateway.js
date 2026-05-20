// ============================================
// FILE: src/services/gateways/monnify.gateway.js
// Monnify implementation of PaymentGateway interface
// API docs: https://developers.monnify.com/
// ============================================

const crypto = require('crypto');
const axios = require('axios');
const PaymentGateway = require('./payment-gateway.interface');
const { logger } = require('../../utils/logger');

class MonnifyGateway extends PaymentGateway {
    constructor() {
        super();
        this.apiKey = process.env.MONNIFY_API_KEY;
        this.secretKey = process.env.MONNIFY_SECRET_KEY;
        this.contractCode = process.env.MONNIFY_CONTRACT_CODE;
        // Default to live; set MONNIFY_ENV=sandbox to use test
        this.baseUrl = (process.env.MONNIFY_ENV === 'sandbox')
            ? 'https://sandbox.monnify.com'
            : 'https://api.monnify.com';
        
        // Token caching (Monnify tokens expire after ~1hr)
        this._token = null;
        this._tokenExpiresAt = 0;
    }

    getName() { return 'monnify'; }
    getDisplayName() { return 'Monnify'; }

    async isEnabled() {
        if (!this.apiKey || !this.secretKey || !this.contractCode) return false;
        try {
            const pool = require('../../config/database');
            const r = await pool.query(`SELECT is_enabled FROM payment_gateway_config WHERE gateway_name = 'monnify'`);
            if (r.rows.length === 0) return false; // default OFF until admin enables
            return r.rows[0].is_enabled === true;
        } catch (e) {
            logger.error('Error checking monnify enabled state:', e.message);
            return false;
        }
    }

    /**
     * Get a fresh OAuth bearer token. Cached for ~50 minutes to avoid hammering the auth endpoint.
     */
    async _getAuthToken() {
        if (this._token && Date.now() < this._tokenExpiresAt) {
            return this._token;
        }

        try {
            const credentials = Buffer.from(`${this.apiKey}:${this.secretKey}`).toString('base64');
            const response = await axios.post(`${this.baseUrl}/api/v1/auth/login`, {}, {
                headers: { Authorization: `Basic ${credentials}` }
            });

            if (!response.data?.requestSuccessful) {
                throw new Error(response.data?.responseMessage || 'Monnify auth failed');
            }

            this._token = response.data.responseBody.accessToken;
            // Tokens last ~1hr, cache for 50 minutes to be safe
            this._tokenExpiresAt = Date.now() + (50 * 60 * 1000);
            return this._token;
        } catch (error) {
            logger.error('Monnify auth error:', error.response?.data || error.message);
            throw new Error(`Monnify auth: ${error.response?.data?.responseMessage || error.message}`);
        }
    }

    async initialize({ reference, amount, email, callbackUrl, metadata = {}, customerName }) {
        try {
            const token = await this._getAuthToken();
            
            const payload = {
                amount: Number(amount), // Monnify uses naira (no kobo)
                customerName: customerName || metadata.user_name || 'Player',
                customerEmail: email,
                paymentReference: reference,
                paymentDescription: metadata.description || `Payment ${reference}`,
                currencyCode: 'NGN',
                contractCode: this.contractCode,
                redirectUrl: callbackUrl,
                paymentMethods: ['CARD', 'ACCOUNT_TRANSFER'],
                metadata: {
                    user_id: String(metadata.user_id || ''),
                    tournament_id: String(metadata.tournament_id || ''),
                    package_id: String(metadata.package_id || ''),
                    platform: String(metadata.platform || '')
                }
            };

            const response = await axios.post(
                `${this.baseUrl}/api/v1/merchant/transactions/init-transaction`,
                payload,
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
            );

            if (!response.data?.requestSuccessful) {
                throw new Error(response.data?.responseMessage || 'Monnify initialization failed');
            }

            const body = response.data.responseBody;
            return {
                authorization_url: body.checkoutUrl,
                access_code: body.transactionReference, // Monnify's internal ref
                reference,
                gateway: this.getName()
            };
        } catch (error) {
            logger.error('Monnify init error:', error.response?.data || error.message);
            throw new Error(`Monnify: ${error.response?.data?.responseMessage || error.message}`);
        }
    }

    async verify(reference) {
        try {
            const token = await this._getAuthToken();
            
            // Monnify verify uses paymentReference (our ref). URL-encoded.
            const response = await axios.get(
                `${this.baseUrl}/api/v2/transactions/${encodeURIComponent(reference)}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );

            if (!response.data?.requestSuccessful) {
                logger.warn(`Monnify verify failed for ${reference}: ${response.data?.responseMessage}`);
                return { success: false, status: 'error', amount: 0, reference, gateway: this.getName(), error: response.data?.responseMessage };
            }

            const data = response.data.responseBody;
            // Monnify paymentStatus: PAID, OVERPAID, PARTIALLY_PAID, PENDING, FAILED, EXPIRED
            const status = data?.paymentStatus;
            const success = status === 'PAID' || status === 'OVERPAID';
            
            if (!success) {
                logger.warn(`Monnify verify non-success for ${reference}: status=${status}`);
            }

            return {
                success,
                status: status?.toLowerCase(),
                amount: data ? Number(data.amountPaid) : 0,
                reference,
                gateway: this.getName(),
                raw: data
            };
        } catch (error) {
            logger.error('Monnify verify error:', JSON.stringify(error.response?.data) || error.message);
            return { success: false, status: 'error', amount: 0, reference, gateway: this.getName(), error: error.response?.data?.responseMessage || error.message };
        }
    }

    verifyWebhookSignature(rawBody, signature) {
        // Monnify: HMAC-SHA512 of the raw request body, keyed by client secret
        // Header: monnify-signature
        if (!signature || !this.secretKey) return false;
        try {
            const hash = crypto
                .createHmac('sha512', this.secretKey)
                .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
                .digest('hex');
            return hash === signature;
        } catch (e) {
            logger.error('Monnify signature parse error:', e.message);
            return false;
        }
    }

    parseWebhook(payload) {
        // Monnify payload: { eventType: 'SUCCESSFUL_TRANSACTION', eventData: { paymentReference, paymentStatus, amountPaid, ... } }
        const data = payload?.eventData || {};
        const status = data.paymentStatus;
        return {
            reference: data.paymentReference,
            status: (status === 'PAID' || status === 'OVERPAID') ? 'success' : 'failed',
            amount: data.amountPaid ? Number(data.amountPaid) : 0,
            event: payload.eventType,
            raw: payload
        };
    }
}

module.exports = MonnifyGateway;