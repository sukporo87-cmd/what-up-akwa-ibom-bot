// ============================================================
// FILE: src/services/error-monitor.service.js
// Error monitoring: tracks errors, detects spikes, alerts admin
// ============================================================

const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const axios = require('axios');

const CONFIG = {
    ALERT_THRESHOLD: 10,         // Alert after 10 errors in 5 minutes
    ALERT_COOLDOWN: 900,         // 15 min between alerts (seconds)
    WINDOW_SECONDS: 300,         // 5-minute error windows
    MAX_RECENT_ERRORS: 50,       // Keep last 50 errors in memory
    ADMIN_PHONE: process.env.ADMIN_ALERT_PHONE || null,
    HEALTH_CHECK_INTERVAL: 60000 // Check system health every 60s
};

class ErrorMonitorService {
    constructor() {
        this.recentErrors = [];
        this.healthCheckId = null;
        this.startTime = Date.now();
    }

    /**
     * Initialize monitoring: patch logger + start health checks
     * Call once at server startup
     */
    init() {
        this.patchLogger();
        this.startHealthChecks();
        logger.info('✅ Error monitor initialized');
    }

    /**
     * Patch winston logger to intercept all error() calls
     */
    patchLogger() {
        const originalError = logger.error.bind(logger);
        
        logger.error = (...args) => {
            // Call original logger
            originalError(...args);
            
            // Track the error
            this.trackError(args);
        };
    }

    /**
     * Track an error occurrence
     */
    async trackError(args) {
        try {
            const message = args.map(a => {
                if (typeof a === 'string') return a;
                if (a instanceof Error) return `${a.message}\n${a.stack}`;
                try { return JSON.stringify(a); } catch { return String(a); }
            }).join(' ');

            const error = {
                message: message.substring(0, 500),
                timestamp: new Date().toISOString(),
                category: this.categorizeError(message)
            };

            // Store in memory (circular buffer)
            this.recentErrors.push(error);
            if (this.recentErrors.length > CONFIG.MAX_RECENT_ERRORS) {
                this.recentErrors.shift();
            }

            // Increment Redis counter for rate detection
            const windowKey = this.getWindowKey();
            const count = await redis.incr(windowKey);
            if (count === 1) {
                await redis.expire(windowKey, CONFIG.WINDOW_SECONDS);
            }

            // Increment daily counter
            const today = new Date().toISOString().split('T')[0];
            await redis.hincrby(`errors:daily:${today}`, 'total', 1);
            await redis.hincrby(`errors:daily:${today}`, error.category, 1);
            await redis.expire(`errors:daily:${today}`, 604800); // 7 days

            // Check if we should alert
            if (count >= CONFIG.ALERT_THRESHOLD) {
                await this.sendAlert(count, error);
            }

        } catch (e) {
            // Don't let monitoring errors crash the app
            console.error('Error monitor tracking failed:', e.message);
        }
    }

    /**
     * Categorize errors for grouping
     */
    categorizeError(message) {
        const lower = message.toLowerCase();
        if (lower.includes('database') || lower.includes('pool') || lower.includes('pg') || lower.includes('sql')) return 'database';
        if (lower.includes('redis') || lower.includes('ioredis')) return 'redis';
        if (lower.includes('whatsapp') || lower.includes('graph.facebook')) return 'whatsapp_api';
        if (lower.includes('telegram')) return 'telegram_api';
        if (lower.includes('paystack') || lower.includes('payment')) return 'payment';
        if (lower.includes('timeout') || lower.includes('ETIMEDOUT')) return 'timeout';
        if (lower.includes('econnrefused') || lower.includes('network')) return 'network';
        if (lower.includes('love_quest') || lower.includes('love quest')) return 'love_quest';
        return 'other';
    }

    /**
     * Get current 5-minute window key
     */
    getWindowKey() {
        const window = Math.floor(Date.now() / (CONFIG.WINDOW_SECONDS * 1000));
        return `errors:count:${window}`;
    }

    /**
     * Send alert to admin via WhatsApp
     */
    async sendAlert(errorCount, latestError) {
        // Check cooldown
        const cooldownKey = 'errors:alert_cooldown';
        const cooldownActive = await redis.get(cooldownKey);
        if (cooldownActive) return;

        // Set cooldown
        await redis.setex(cooldownKey, CONFIG.ALERT_COOLDOWN, '1');

        const alertMessage = 
            `🚨 *ERROR SPIKE ALERT* 🚨\n\n` +
            `${errorCount} errors in the last 5 minutes!\n\n` +
            `Latest: ${latestError.message.substring(0, 200)}\n` +
            `Category: ${latestError.category}\n` +
            `Time: ${latestError.timestamp}\n\n` +
            `Check admin dashboard for details.`;

        // Send via WhatsApp to admin
        if (CONFIG.ADMIN_PHONE) {
            try {
                const WhatsAppService = require('./whatsapp.service');
                const wa = new WhatsAppService();
                await wa.sendMessage(CONFIG.ADMIN_PHONE, alertMessage);
                logger.info(`🚨 Error alert sent to admin: ${CONFIG.ADMIN_PHONE}`);
            } catch (e) {
                console.error('Failed to send error alert:', e.message);
            }
        }
    }

    /**
     * Start periodic health checks
     */
    startHealthChecks() {
        this.healthCheckId = setInterval(async () => {
            try {
                await this.performHealthCheck();
            } catch (e) {
                console.error('Health check failed:', e.message);
            }
        }, CONFIG.HEALTH_CHECK_INTERVAL);
    }

    /**
     * Check system component health
     */
    async performHealthCheck() {
        const health = {
            timestamp: new Date().toISOString(),
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            components: {}
        };

        // Check database
        try {
            const pool = require('../config/database');
            const start = Date.now();
            await pool.query('SELECT 1');
            health.components.database = { status: 'ok', latency: Date.now() - start };
        } catch (e) {
            health.components.database = { status: 'error', error: e.message };
        }

        // Check Redis
        try {
            const start = Date.now();
            await redis.ping();
            health.components.redis = { status: 'ok', latency: Date.now() - start };
        } catch (e) {
            health.components.redis = { status: 'error', error: e.message };
        }

        // Store health check result
        await redis.setex('health:latest', 120, JSON.stringify(health));

        // Alert on component failure
        const failures = Object.entries(health.components)
            .filter(([, v]) => v.status === 'error')
            .map(([k]) => k);
        
        if (failures.length > 0) {
            logger.error(`Health check failures: ${failures.join(', ')}`);
        }

        return health;
    }

    /**
     * Get error stats for admin dashboard
     */
    async getStats() {
        const today = new Date().toISOString().split('T')[0];
        const dailyStats = await redis.hgetall(`errors:daily:${today}`) || {};
        
        // Get current rate
        const windowKey = this.getWindowKey();
        const currentRate = parseInt(await redis.get(windowKey) || '0');

        // Get health
        let health = null;
        try {
            const healthStr = await redis.get('health:latest');
            if (healthStr) health = JSON.parse(healthStr);
        } catch (e) {}

        return {
            today: {
                total: parseInt(dailyStats.total || 0),
                byCategory: Object.fromEntries(
                    Object.entries(dailyStats).filter(([k]) => k !== 'total')
                )
            },
            currentRate,
            alertThreshold: CONFIG.ALERT_THRESHOLD,
            recentErrors: this.recentErrors.slice(-20),
            health,
            uptime: Math.floor((Date.now() - this.startTime) / 1000)
        };
    }

    stop() {
        if (this.healthCheckId) {
            clearInterval(this.healthCheckId);
            this.healthCheckId = null;
        }
    }
}

// Singleton
const errorMonitorService = new ErrorMonitorService();
module.exports = errorMonitorService;