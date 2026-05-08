// ============================================
// FILE: src/services/gateways/korapay.gateway.js
// Korapay implementation of PaymentGateway interface
// API docs: https://developers.korapay.com/
// ============================================

const crypto = require('crypto');
const axios = require('axios');
const PaymentGateway = require('./payment-gateway.interface');
const { logger } = require('../../utils/logger');

class KorapayGateway extends PaymentGateway {
    constructor() {
        super();
        this.secretKey = process.env.KORAPAY_SECRET_KEY;
        this.publicKey = process.env.KORAPAY_PUBLIC_KEY;
        this.encryptionKey = process.env.KORAPAY_ENCRYPTION_KEY;
        this.baseUrl = 'https://api.korapay.com/merchant/api/v1';
    }

    getName() { return 'korapay'; }
    getDisplayName() { return 'Korapay'; }

    async isEnabled() {
        if (!this.secretKey) return false;
        try {
            const pool = require('../../config/database');
            const r = await pool.query(`SELECT is_enabled FROM payment_gateway_config WHERE gateway_name = 'korapay'`);
            if (r.rows.length === 0) return false; // default OFF until admin enables
            return r.rows[0].is_enabled === true;
        } catch (e) {
            logger.error('Error checking korapay enabled state:', e.message);
            return false;
        }
    }

    async initialize({ reference, amount, email, callbackUrl, metadata = {}, customerName }) {
        try {
            const payload = {
                amount: Number(amount), // Korapay uses naira (no kobo conversion)
                redirect_url: callbackUrl,
                currency: 'NGN',
                reference,
                notification_url: `${process.env.APP_URL}/payment/korapay-webhook`,
                narration: metadata.description || `Payment for ${reference}`,
                channels: ['card', 'bank_transfer'],
                customer: {
                    name: customerName || metadata.user_name || 'Player',
                    email
                },
                metadata
            };

            const response = await axios.post(`${this.baseUrl}/charges/initialize`, payload, {
                headers: {
                    Authorization: `Bearer ${this.secretKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.data?.status) {
                throw new Error(response.data?.message || 'Korapay initialization failed');
            }

            return {
                authorization_url: response.data.data.checkout_url,
                access_code: response.data.data.reference,
                reference,
                gateway: this.getName()
            };
        } catch (error) {
            logger.error('Korapay init error:', error.response?.data || error.message);
            throw new Error(`Korapay: ${error.response?.data?.message || error.message}`);
        }
    }

    async verify(reference) {
        try {
            const response = await axios.get(`${this.baseUrl}/charges/${reference}`, {
                headers: { Authorization: `Bearer ${this.secretKey}` }
            });

            const data = response.data?.data;
            // Korapay status values: 'success', 'failed', 'processing', 'pending'
            const success = data?.status === 'success';

            return {
                success,
                amount: data ? Number(data.amount) : 0, // naira
                reference,
                gateway: this.getName(),
                raw: data
            };
        } catch (error) {
            logger.error('Korapay verify error:', error.response?.data || error.message);
            return { success: false, amount: 0, reference, gateway: this.getName(), error: error.message };
        }
    }

    verifyWebhookSignature(rawBody, signature) {
        // Korapay sends x-korapay-signature header
        // Signature = HMAC-SHA256 of the `data` object stringified, using secret key
        if (!signature || !this.secretKey) return false;
        try {
            const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
            const dataStr = JSON.stringify(parsed.data);
            const hash = crypto.createHmac('sha256', this.secretKey).update(dataStr).digest('hex');
            return hash === signature;
        } catch (e) {
            logger.error('Korapay signature parse error:', e.message);
            return false;
        }
    }

    parseWebhook(payload) {
        // Korapay payload: { event: 'charge.success', data: { reference, status, amount, ... } }
        const data = payload?.data || {};
        return {
            reference: data.reference,
            status: data.status === 'success' ? 'success' : 'failed',
            amount: data.amount ? Number(data.amount) : 0,
            event: payload.event,
            raw: payload
        };
    }
}

module.exports = KorapayGateway;