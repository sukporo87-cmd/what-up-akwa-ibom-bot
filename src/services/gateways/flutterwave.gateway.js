// ============================================
// FILE: src/services/gateways/flutterwave.gateway.js
// Flutterwave implementation of PaymentGateway interface
// API docs: https://developer.flutterwave.com/
// ============================================

const crypto = require('crypto');
const axios = require('axios');
const PaymentGateway = require('./payment-gateway.interface');
const { logger } = require('../../utils/logger');

class FlutterwaveGateway extends PaymentGateway {
    constructor() {
        super();
        this.secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
        this.publicKey = process.env.FLUTTERWAVE_PUBLIC_KEY;
        this.encryptionKey = process.env.FLUTTERWAVE_ENCRYPTION_KEY;
        this.secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
        this.baseUrl = 'https://api.flutterwave.com/v3';
    }

    getName() { return 'flutterwave'; }
    getDisplayName() { return 'Flutterwave'; }

    async isEnabled() {
        if (!this.secretKey) return false;
        try {
            const pool = require('../../config/database');
            const r = await pool.query(`SELECT is_enabled FROM payment_gateway_config WHERE gateway_name = 'flutterwave'`);
            if (r.rows.length === 0) return false; // default OFF until admin enables
            return r.rows[0].is_enabled === true;
        } catch (e) {
            logger.error('Error checking flutterwave enabled state:', e.message);
            return false;
        }
    }

    async initialize({ reference, amount, email, callbackUrl, metadata = {}, customerName }) {
        try {
            const payload = {
                tx_ref: reference,
                amount: Number(amount), // Flutterwave uses naira (no kobo)
                currency: 'NGN',
                redirect_url: callbackUrl,
                payment_options: 'card,banktransfer,ussd',
                customer: {
                    email,
                    name: customerName || metadata.user_name || 'Player'
                },
                customizations: {
                    title: "What's Up Trivia",
                    description: metadata.description || `Payment for ${reference}`
                },
                // Flutterwave's metadata is called "meta" and accepts arbitrary keys
                meta: {
                    user_id: String(metadata.user_id || ''),
                    tournament_id: String(metadata.tournament_id || ''),
                    package_id: String(metadata.package_id || ''),
                    is_rebuy: String(metadata.is_rebuy || ''),
                    platform: String(metadata.platform || '')
                }
            };

            const response = await axios.post(`${this.baseUrl}/payments`, payload, {
                headers: {
                    Authorization: `Bearer ${this.secretKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.data?.status !== 'success') {
                throw new Error(response.data?.message || 'Flutterwave initialization failed');
            }

            return {
                authorization_url: response.data.data.link,
                access_code: reference,
                reference,
                gateway: this.getName()
            };
        } catch (error) {
            logger.error('Flutterwave init error:', error.response?.data || error.message);
            throw new Error(`Flutterwave: ${error.response?.data?.message || error.message}`);
        }
    }

    async verify(reference) {
        try {
            // Flutterwave verify by tx_ref
            const response = await axios.get(
                `${this.baseUrl}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
                { headers: { Authorization: `Bearer ${this.secretKey}` } }
            );

            if (response.data?.status !== 'success') {
                const msg = response.data?.message || 'unknown';
                logger.warn(`Flutterwave verify failed for ${reference}: ${msg}`);
                return { success: false, status: 'error', amount: 0, reference, gateway: this.getName(), error: msg };
            }

            const data = response.data.data;
            // Flutterwave statuses: 'successful', 'failed', 'pending', 'cancelled'
            const status = data?.status;
            const success = status === 'successful';

            if (!success) {
                logger.warn(`Flutterwave verify non-success for ${reference}: status=${status}`);
            }

            return {
                success,
                status: status?.toLowerCase() === 'successful' ? 'success' : status?.toLowerCase(),
                amount: data ? Number(data.amount) : 0, // naira
                reference,
                gateway: this.getName(),
                raw: data
            };
        } catch (error) {
            const httpStatus = error.response?.status;
            const body = error.response?.data ? JSON.stringify(error.response.data) : '(no body)';
            const errMsg = error.response?.data?.message || error.message || 'unknown';
            logger.error(`Flutterwave verify error for ${reference}: HTTP ${httpStatus || '?'} — ${errMsg} — body: ${body}`);
            return { success: false, status: 'error', amount: 0, reference, gateway: this.getName(), error: errMsg };
        }
    }

    verifyWebhookSignature(rawBody, signature) {
        // Flutterwave uses a "secret hash" string that you set in the dashboard
        // and they send it back verbatim in the `verif-hash` header on every webhook.
        // Simple string comparison.
        if (!signature || !this.secretHash) return false;
        return signature === this.secretHash;
    }

    parseWebhook(payload) {
        // Flutterwave payload: { event: 'charge.completed', data: { tx_ref, status, amount, ... } }
        const data = payload?.data || {};
        return {
            reference: data.tx_ref,
            status: data.status === 'successful' ? 'success' : 'failed',
            amount: data.amount ? Number(data.amount) : 0,
            event: payload.event,
            raw: payload
        };
    }
}

module.exports = FlutterwaveGateway;