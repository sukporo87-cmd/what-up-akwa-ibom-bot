// ============================================================
// FILE: src/services/message-queue.service.js
// Redis-backed message queue for WhatsApp rate limiting
// Rate: 60 msgs/sec (with headroom under 80/sec API limit)
// ============================================================

const redis = require('../config/redis');
const { logger } = require('../utils/logger');

const QUEUE_KEY = 'mq:outbound';
const RATE_LIMIT_KEY = 'mq:rate';
const FAILED_KEY = 'mq:failed';
const STATS_KEY = 'mq:stats';

// Rate limiting config
const MAX_PER_SECOND = 60;       // Stay under WhatsApp's 80/sec limit
const RETRY_MAX = 3;              // Max retries per message
const RETRY_DELAY_BASE = 2000;    // 2s base retry delay (exponential)
const PROCESS_INTERVAL = 100;     // Process queue every 100ms
const BATCH_SIZE = 6;             // 6 messages per 100ms = 60/sec

class MessageQueueService {
    constructor() {
        this.processing = false;
        this.intervalId = null;
        this.whatsappService = null;
        this.telegramService = null;
        this.stats = { sent: 0, failed: 0, retried: 0, queued: 0 };
    }

    /**
     * Initialize the queue processor
     * Call once at server startup
     */
    start(whatsappService, telegramService) {
        this.whatsappService = whatsappService;
        this.telegramService = telegramService;

        if (this.intervalId) return; // Already started

        this.intervalId = setInterval(() => this.processBatch(), PROCESS_INTERVAL);
        logger.info('✅ Message queue started (60 msgs/sec rate limit)');
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            logger.info('🛑 Message queue stopped');
        }
    }

    /**
     * Enqueue a message for sending
     * @param {string} to - Recipient phone number or chat ID
     * @param {string} text - Message body
     * @param {string} platform - 'whatsapp' or 'telegram'
     * @param {string} type - 'text', 'image', 'audio', 'video', 'template'
     * @param {object} extra - Additional data (mediaId, templateName, etc.)
     * @param {number} priority - 0=high (game msgs), 1=normal, 2=low (notifications)
     */
    async enqueue(to, text, platform = 'whatsapp', type = 'text', extra = {}, priority = 1) {
        const message = {
            id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            to,
            text,
            platform,
            type,
            extra,
            priority,
            retries: 0,
            createdAt: Date.now()
        };

        // Use sorted set with priority + timestamp as score for ordering
        const score = priority * 1e13 + Date.now();
        await redis.zadd(QUEUE_KEY, score, JSON.stringify(message));
        this.stats.queued++;

        return message.id;
    }

    /**
     * Send a message immediately (bypass queue)
     * Use for time-critical game messages (questions, answers)
     */
    async sendImmediate(to, text, platform = 'whatsapp') {
        try {
            if (platform === 'telegram' && this.telegramService) {
                return await this.telegramService.sendMessage(to, text);
            }
            if (this.whatsappService) {
                return await this.whatsappService.sendMessage(to, text);
            }
        } catch (error) {
            logger.error(`Immediate send failed to ${to}:`, error.message);
            // Fall back to queue on failure
            await this.enqueue(to, text, platform, 'text', {}, 0);
            throw error;
        }
    }

    /**
     * Process a batch of messages from the queue
     */
    async processBatch() {
        if (this.processing) return; // Prevent overlapping
        this.processing = true;

        try {
            // Check rate limit
            const currentRate = parseInt(await redis.get(RATE_LIMIT_KEY) || '0');
            if (currentRate >= MAX_PER_SECOND) {
                this.processing = false;
                return;
            }

            const remaining = MAX_PER_SECOND - currentRate;
            const batchCount = Math.min(BATCH_SIZE, remaining);

            // Pop messages from sorted set (lowest score = highest priority)
            const messages = await redis.zpopmin(QUEUE_KEY, batchCount);

            if (!messages || messages.length === 0) {
                this.processing = false;
                return;
            }

            // messages is [member, score, member, score, ...]
            const promises = [];
            for (let i = 0; i < messages.length; i += 2) {
                const msgStr = messages[i];
                try {
                    const msg = JSON.parse(msgStr);
                    promises.push(this.sendMessage(msg));
                } catch (e) {
                    logger.error('Failed to parse queued message:', e.message);
                }
            }

            // Increment rate counter (expires in 1 second)
            const pipeline = redis.pipeline();
            pipeline.incrby(RATE_LIMIT_KEY, promises.length);
            pipeline.expire(RATE_LIMIT_KEY, 1);
            await pipeline.exec();

            await Promise.allSettled(promises);

        } catch (error) {
            logger.error('Message queue processing error:', error.message);
        } finally {
            this.processing = false;
        }
    }

    /**
     * Send a single message and handle retries
     */
    async sendMessage(msg) {
        try {
            if (msg.platform === 'telegram' && this.telegramService) {
                await this.telegramService.sendMessage(msg.to, msg.text);
            } else if (this.whatsappService) {
                if (msg.type === 'template') {
                    await this.sendTemplate(msg);
                } else {
                    await this.whatsappService.sendMessage(msg.to, msg.text);
                }
            }

            this.stats.sent++;
            
            // Update daily stats
            const today = new Date().toISOString().split('T')[0];
            await redis.hincrby(`${STATS_KEY}:${today}`, 'sent', 1);

        } catch (error) {
            const statusCode = error.response?.status;
            
            // Rate limited by WhatsApp - requeue with delay
            if (statusCode === 429) {
                msg.retries++;
                if (msg.retries <= RETRY_MAX) {
                    const delay = RETRY_DELAY_BASE * Math.pow(2, msg.retries - 1);
                    const retryScore = Date.now() + delay;
                    await redis.zadd(QUEUE_KEY, retryScore, JSON.stringify(msg));
                    this.stats.retried++;
                    logger.warn(`⚠️ Rate limited, retry ${msg.retries}/${RETRY_MAX} for ${msg.to} in ${delay}ms`);
                } else {
                    await this.handleFailedMessage(msg, error);
                }
            } else if (statusCode >= 500 || !statusCode) {
                // Server error or network - retry
                msg.retries++;
                if (msg.retries <= RETRY_MAX) {
                    const delay = RETRY_DELAY_BASE * Math.pow(2, msg.retries - 1);
                    const retryScore = Date.now() + delay;
                    await redis.zadd(QUEUE_KEY, retryScore, JSON.stringify(msg));
                    this.stats.retried++;
                } else {
                    await this.handleFailedMessage(msg, error);
                }
            } else {
                // Client error (400, 403, etc.) - don't retry
                await this.handleFailedMessage(msg, error);
            }
        }
    }

    /**
     * Send a WhatsApp template message
     */
    async sendTemplate(msg) {
        const { templateName, language, components } = msg.extra;
        const url = `${this.whatsappService.apiUrl}/${this.whatsappService.phoneNumberId}/messages`;

        await require('axios').post(url, {
            messaging_product: 'whatsapp',
            to: msg.to,
            type: 'template',
            template: {
                name: templateName,
                language: { code: language || 'en' },
                components: components || []
            }
        }, {
            headers: {
                'Authorization': `Bearer ${this.whatsappService.accessToken}`,
                'Content-Type': 'application/json'
            }
        });
    }

    /**
     * Handle permanently failed messages
     */
    async handleFailedMessage(msg, error) {
        this.stats.failed++;
        const today = new Date().toISOString().split('T')[0];
        await redis.hincrby(`${STATS_KEY}:${today}`, 'failed', 1);

        // Store failed messages for review (keep last 100)
        const failedEntry = JSON.stringify({
            ...msg,
            error: error.response?.data || error.message,
            failedAt: Date.now()
        });
        await redis.lpush(FAILED_KEY, failedEntry);
        await redis.ltrim(FAILED_KEY, 0, 99);

        logger.error(`❌ Message permanently failed to ${msg.to}: ${error.message}`);
    }

    /**
     * Get queue stats
     */
    async getStats() {
        const queueSize = await redis.zcard(QUEUE_KEY);
        const failedCount = await redis.llen(FAILED_KEY);
        const today = new Date().toISOString().split('T')[0];
        const dailyStats = await redis.hgetall(`${STATS_KEY}:${today}`) || {};

        return {
            queueSize,
            failedCount,
            todaySent: parseInt(dailyStats.sent || 0),
            todayFailed: parseInt(dailyStats.failed || 0),
            memoryStats: this.stats
        };
    }

    /**
     * Get failed messages for review
     */
    async getFailedMessages(limit = 20) {
        const messages = await redis.lrange(FAILED_KEY, 0, limit - 1);
        return messages.map(m => {
            try { return JSON.parse(m); }
            catch { return { raw: m }; }
        });
    }

    /**
     * Clear failed messages
     */
    async clearFailed() {
        await redis.del(FAILED_KEY);
    }
}

// Singleton
const messageQueueService = new MessageQueueService();
module.exports = messageQueueService;