// ============================================
// FILE: src/services/gateways/paystack.gateway.js
// Paystack implementation of PaymentGateway interface
// ============================================

const crypto = require('crypto');
const axios = require('axios');
const PaymentGateway = require('./payment-gateway.interface');
const { logger } = require('../../utils/logger');

class PaystackGateway extends PaymentGateway {
    constructor() {
        super();
        this.secretKey = process.env.PAYSTACK_SECRET_KEY;
        this.publicKey = process.env.PAYSTACK_PUBLIC_KEY;
        this.baseUrl = 'https://api.paystack.co';
    }

    getName() { return 'paystack'; }
    getDisplayName() { return 'Paystack'; }

    async isEnabled() {
        if (!this.secretKey) return false;
        try {
            const pool = require('../../config/database');
            const r = await pool.query(`SELECT is_enabled FROM payment_gateway_config WHERE gateway_name = 'paystack'`);
            // Default ON if no row exists yet (backward compat)
            if (r.rows.length === 0) return true;
            return r.rows[0].is_enabled === true;
        } catch (e) {
            logger.error('Error checking paystack enabled state:', e.message);
            return false;
        }
    }

    async initialize({ reference, amount, email, callbackUrl, metadata = {} }) {
        try {
            const response = await axios.post(`${this.baseUrl}/transaction/initialize`, {
                email,
                amount: Math.round(amount * 100), // Paystack uses kobo
                reference,
                callback_url: callbackUrl,
                metadata,
                channels: ['card', 'bank', 'ussd', 'mobile_money']
            }, {
                headers: {
                    Authorization: `Bearer ${this.secretKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.data?.status) {
                throw new Error(response.data?.message || 'Paystack initialization failed');
            }

            return {
                authorization_url: response.data.data.authorization_url,
                access_code: response.data.data.access_code,
                reference,
                gateway: this.getName()
            };
        } catch (error) {
            logger.error('Paystack init error:', error.response?.data || error.message);
            throw new Error(`Paystack: ${error.response?.data?.message || error.message}`);
        }
    }

    async verify(reference) {
        try {
            const response = await axios.get(`${this.baseUrl}/transaction/verify/${reference}`, {
                headers: { Authorization: `Bearer ${this.secretKey}` }
            });

            const data = response.data?.data;
            const success = data?.status === 'success';

            return {
                success,
                amount: data ? data.amount / 100 : 0, // back to naira
                reference,
                gateway: this.getName(),
                raw: data
            };
        } catch (error) {
            logger.error('Paystack verify error:', error.response?.data || error.message);
            return { success: false, amount: 0, reference, gateway: this.getName(), error: error.message };
        }
    }

    verifyWebhookSignature(rawBody, signature) {
        if (!signature || !this.secretKey) return false;
        const hash = crypto.createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
        return hash === signature;
    }

    parseWebhook(payload) {
        // Paystack payload: { event, data: { reference, status, amount, ... } }
        const data = payload?.data || {};
        return {
            reference: data.reference,
            status: data.status === 'success' ? 'success' : 'failed',
            amount: data.amount ? data.amount / 100 : 0,
            event: payload.event,
            raw: payload
        };
    }
}

module.exports = PaystackGateway;