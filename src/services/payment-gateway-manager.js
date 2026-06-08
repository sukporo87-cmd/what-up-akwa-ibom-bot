// ============================================
// FILE: src/services/payment-gateway-manager.js
// Central registry for all payment gateways
// ============================================

const PaystackGateway = require('./gateways/paystack.gateway');
const KorapayGateway = require('./gateways/korapay.gateway');
const MonnifyGateway = require('./gateways/monnify.gateway');
const FlutterwaveGateway = require('./gateways/flutterwave.gateway');
const pool = require('../config/database');
const { logger } = require('../utils/logger');

class PaymentGatewayManager {
    constructor() {
        // Register all available gateways here
        this.gateways = {
            paystack: new PaystackGateway(),
            korapay: new KorapayGateway(),
            monnify: new MonnifyGateway(),
            flutterwave: new FlutterwaveGateway(),
        };
    }

    /**
     * Get a gateway instance by name
     */
    getGateway(name) {
        const gateway = this.gateways[name];
        if (!gateway) throw new Error(`Unknown payment gateway: ${name}`);
        return gateway;
    }

    /**
     * Detect gateway from a payment reference (uses DB lookup or prefix)
     */
    async getGatewayForReference(reference) {
        // Try DB lookup first — most reliable
        try {
            const r = await pool.query(`
                SELECT gateway_used FROM payment_transactions WHERE reference = $1
                UNION ALL
                SELECT gateway_used FROM tournament_entry_payments WHERE payment_reference = $1
                LIMIT 1
            `, [reference]);
            
            if (r.rows.length > 0 && r.rows[0].gateway_used) {
                return this.getGateway(r.rows[0].gateway_used);
            }
        } catch (e) {
            logger.error('Error looking up gateway for reference:', e.message);
        }
        
        // Fallback: assume paystack (legacy refs without gateway_used column)
        return this.getGateway('paystack');
    }

    /**
     * Get all enabled gateways (filtered by env vars + DB toggle)
     */
    async getEnabledGateways() {
        const enabled = [];
        for (const [name, gw] of Object.entries(this.gateways)) {
            if (await gw.isEnabled()) {
                enabled.push(gw);
            }
        }
        return enabled;
    }

    /**
     * Get the default gateway (first enabled, or one marked as default in DB)
     */
    async getDefaultGateway() {
        try {
            const r = await pool.query(`
                SELECT gateway_name FROM payment_gateway_config 
                WHERE is_enabled = true AND is_default = true
                LIMIT 1
            `);
            if (r.rows.length > 0) {
                const gw = this.gateways[r.rows[0].gateway_name];
                if (gw && await gw.isEnabled()) return gw;
            }
        } catch (e) {
            logger.error('Error getting default gateway:', e.message);
        }
        
        const enabled = await this.getEnabledGateways();
        if (enabled.length === 0) throw new Error('No payment gateways are enabled');
        return enabled[0];
    }

    /**
     * Get gateway by name, but verify it's enabled
     */
    async getEnabledGatewayByName(name) {
        const gw = this.gateways[name];
        if (!gw) throw new Error(`Unknown gateway: ${name}`);
        if (!(await gw.isEnabled())) throw new Error(`Gateway ${name} is not enabled`);
        return gw;
    }

    /**
     * Get enabled gateways formatted for a user picker.
     * Returns array sorted with default first.
     */
    async getEnabledGatewaysForPicker() {
        const enabled = await this.getEnabledGateways();
        if (enabled.length === 0) return [];
        
        // Get default gateway name from DB
        let defaultName = null;
        try {
            const r = await pool.query(`SELECT gateway_name FROM payment_gateway_config WHERE is_default = true LIMIT 1`);
            defaultName = r.rows[0]?.gateway_name;
        } catch (e) {}
        
        // Sort: default first, then alphabetical
        return enabled.sort((a, b) => {
            if (a.getName() === defaultName) return -1;
            if (b.getName() === defaultName) return 1;
            return a.getName().localeCompare(b.getName());
        });
    }

    /**
     * Get full gateway status for admin dashboard
     */
    async getGatewayStatuses() {
        const statuses = [];
        for (const [name, gw] of Object.entries(this.gateways)) {
            const r = await pool.query(`SELECT * FROM payment_gateway_config WHERE gateway_name = $1`, [name]);
            const config = r.rows[0] || {};
            const credsConfigured = !!gw.secretKey;
            statuses.push({
                name,
                display_name: gw.getDisplayName(),
                credentials_configured: credsConfigured,
                is_enabled: config.is_enabled === true && credsConfigured,
                is_default: config.is_default === true,
                last_updated: config.updated_at || null
            });
        }
        return statuses;
    }

    /**
     * Toggle a gateway on/off
     */
    async setEnabled(name, enabled, adminId = null) {
        if (!this.gateways[name]) throw new Error(`Unknown gateway: ${name}`);
        await pool.query(`
            INSERT INTO payment_gateway_config (gateway_name, is_enabled, updated_by_admin_id, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (gateway_name) 
            DO UPDATE SET is_enabled = $2, updated_by_admin_id = $3, updated_at = NOW()
        `, [name, enabled, adminId]);
        logger.info(`Payment gateway ${name} ${enabled ? 'ENABLED' : 'DISABLED'} by admin ${adminId}`);
    }

    /**
     * Set the default gateway (only one can be default at a time)
     */
    async setDefault(name, adminId = null) {
        if (!this.gateways[name]) throw new Error(`Unknown gateway: ${name}`);
        await pool.query(`UPDATE payment_gateway_config SET is_default = false`);
        await pool.query(`
            INSERT INTO payment_gateway_config (gateway_name, is_default, is_enabled, updated_by_admin_id, updated_at)
            VALUES ($1, true, true, $2, NOW())
            ON CONFLICT (gateway_name) 
            DO UPDATE SET is_default = true, is_enabled = true, updated_by_admin_id = $2, updated_at = NOW()
        `, [name, adminId]);
        logger.info(`Payment gateway ${name} set as DEFAULT by admin ${adminId}`);
    }
}

module.exports = new PaymentGatewayManager();