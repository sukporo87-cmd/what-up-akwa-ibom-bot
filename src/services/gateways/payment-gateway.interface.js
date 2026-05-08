// ============================================
// FILE: src/services/gateways/payment-gateway.interface.js
// Abstract base class — all payment gateways extend this
// ============================================

class PaymentGateway {
    constructor() {
        if (this.constructor === PaymentGateway) {
            throw new Error('PaymentGateway is abstract and cannot be instantiated directly');
        }
    }

    /**
     * Unique identifier for this gateway (e.g. 'paystack', 'korapay')
     */
    getName() { throw new Error('getName() must be implemented'); }

    /**
     * Display name shown to users (e.g. 'Paystack', 'Korapay')
     */
    getDisplayName() { throw new Error('getDisplayName() must be implemented'); }

    /**
     * Whether this gateway is configured (env vars present) and enabled (toggled on in DB)
     */
    async isEnabled() { throw new Error('isEnabled() must be implemented'); }

    /**
     * Initialize a payment.
     * @param {Object} params { reference, amount (naira), email, callbackUrl, metadata }
     * @returns {Object} { authorization_url, reference, gateway }
     */
    async initialize(params) { throw new Error('initialize() must be implemented'); }

    /**
     * Verify a payment by reference.
     * @returns {Object} { success: bool, amount: number, reference: string, gateway: string }
     */
    async verify(reference) { throw new Error('verify() must be implemented'); }

    /**
     * Verify a webhook signature from raw request body.
     * @returns {boolean}
     */
    verifyWebhookSignature(rawBody, signature) { throw new Error('verifyWebhookSignature() must be implemented'); }

    /**
     * Parse a webhook payload and return normalized event.
     * @returns {Object} { reference, status, amount, raw }
     */
    parseWebhook(payload) { throw new Error('parseWebhook() must be implemented'); }
}

module.exports = PaymentGateway;