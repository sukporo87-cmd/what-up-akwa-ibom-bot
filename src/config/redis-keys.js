// ============================================================
// FILE: src/config/redis-keys.js
// Centralized Redis key registry
// Documents all key patterns, TTLs, and ownership
// ============================================================

/**
 * Redis Key Registry
 * 
 * Every Redis key used in the app should be documented here.
 * Format: KEY_NAME: { pattern, ttl, owner, description }
 * 
 * TTL values in seconds. null = no auto-expiry.
 */
const REDIS_KEYS = {
    // ========================
    // GAME SESSION KEYS
    // ========================
    SESSION: {
        pattern: 'session:{sessionKey}',
        build: (sessionKey) => `session:${sessionKey}`,
        ttl: 3600,          // 1 hour
        owner: 'game.service',
        description: 'Active game session data (questions, score, state)'
    },
    GAME_READY: {
        pattern: 'game_ready:{userId}',
        build: (userId) => `game_ready:${userId}`,
        ttl: 300,            // 5 minutes
        owner: 'game.service',
        description: 'Session key for game ready to start'
    },
    ASKED_QUESTIONS: {
        pattern: 'asked_questions:{sessionKey}',
        build: (sessionKey) => `asked_questions:${sessionKey}`,
        ttl: 3600,           // 1 hour
        owner: 'game.service',
        description: 'List of question IDs already asked in this session'
    },
    POST_GAME: {
        pattern: 'post_game:{userId}',
        build: (userId) => `post_game:${userId}`,
        ttl: 300,            // 5 minutes
        owner: 'game.service',
        description: 'Post-game menu state (game type, score, etc.)'
    },
    WIN_SHARE_PENDING: {
        pattern: 'win_share_pending:{userId}',
        build: (userId) => `win_share_pending:${userId}`,
        ttl: 86400,          // 24 hours
        owner: 'game.service',
        description: 'Victory card share data awaiting user confirmation'
    },

    // ========================
    // TIMEOUT & ANSWER KEYS
    // ========================
    TIMEOUT: {
        pattern: 'timeout:{sessionKey}:{questionNumber}',
        build: (sessionKey, qNum) => `timeout:${sessionKey}:${qNum}`,
        ttl: 35,             // ~30s question + 5s buffer
        owner: 'game.service',
        description: 'Question timeout deadline timestamp'
    },
    ANSWER_LOCK: {
        pattern: 'answer_lock:{sessionKey}:{questionNumber}',
        build: (sessionKey, qNum) => `answer_lock:${sessionKey}:${qNum}`,
        ttl: 3,              // 3 seconds
        owner: 'game.service',
        description: 'Prevents duplicate answer processing (NX lock)'
    },
    TIMEOUT_LOCK: {
        pattern: 'timeout_lock:{sessionKey}:{questionNumber}',
        build: (sessionKey, qNum) => `timeout_lock:${sessionKey}:${qNum}`,
        ttl: 10,             // 10 seconds
        owner: 'game.service',
        description: 'Prevents duplicate timeout processing (NX lock)'
    },
    COMPLETION_LOCK: {
        pattern: 'completion_lock:{sessionKey}',
        build: (sessionKey) => `completion_lock:${sessionKey}`,
        ttl: 10,             // 10 seconds
        owner: 'game.service',
        description: 'Prevents duplicate game completion processing'
    },

    // ========================
    // ANTI-CHEAT KEYS
    // ========================
    CAPTCHA: {
        pattern: 'captcha:{sessionKey}',
        build: (sessionKey) => `captcha:${sessionKey}`,
        ttl: 30,             // 30 seconds
        owner: 'game.service',
        description: 'Active CAPTCHA challenge data'
    },
    TURBO_TRACKING: {
        pattern: 'turbo_track:{userId}',
        build: (userId) => `turbo_track:${userId}`,
        ttl: 3600,           // 1 hour
        owner: 'anti-fraud.service',
        description: 'Turbo mode detection tracking data'
    },
    TURBO_GO_WAIT: {
        pattern: 'turbo_go_wait:{userId}',
        build: (userId) => `turbo_go_wait:${userId}`,
        ttl: 35,             // ~question timeout
        owner: 'anti-fraud.service',
        description: 'Turbo GO detection waiting state'
    },
    PHOTO_DETECTION: {
        pattern: 'photo_detect:{sessionKey}',
        build: (sessionKey) => `photo_detect:${sessionKey}`,
        ttl: 25,
        owner: 'anti-fraud.service',
        description: 'Photo-based cheating detection state'
    },

    // ========================
    // AUDIT KEYS
    // ========================
    AUDIT_Q_START: {
        pattern: 'audit_q_start:{sessionId}:{questionNumber}',
        build: (sessionId, qNum) => `audit_q_start:${sessionId}:${qNum}`,
        ttl: 60,             // 1 minute
        owner: 'audit.service',
        description: 'Question start timestamp for audit timing'
    },
    AUDIT_CAPTCHA_START: {
        pattern: 'audit_captcha_start:{sessionId}:{questionNumber}',
        build: (sessionId, qNum) => `audit_captcha_start:${sessionId}:${qNum}`,
        ttl: 60,
        owner: 'audit.service',
        description: 'CAPTCHA start timestamp for audit timing'
    },

    // ========================
    // USER STATE KEYS
    // ========================
    USER_STATE: {
        pattern: 'user_state:{phone}',
        build: (phone) => `user_state:${phone}`,
        ttl: 1800,           // 30 minutes
        owner: 'user.service',
        description: 'User conversation state (registration, menus, etc.)'
    },

    // ========================
    // RATE LIMITING KEYS
    // ========================
    RATE_LIMIT_GAME: {
        pattern: 'rate_limit:games:{userId}',
        build: (userId) => `rate_limit:games:${userId}`,
        ttl: 3600,           // 1 hour
        owner: 'anti-fraud.service',
        description: 'Game start rate limit counter (15/hour)'
    },

    // ========================
    // LOVE QUEST KEYS
    // ========================
    LOVE_QUEST_SESSION: {
        pattern: 'love_quest:session:{playerPhone}',
        build: (phone) => `love_quest:session:${phone}`,
        ttl: 3600,
        owner: 'love-quest.service',
        description: 'Active Love Quest session reference'
    },
    LOVE_QUEST_Q_START: {
        pattern: 'love_quest:qstart:{sessionKey}',
        build: (sessionKey) => `love_quest:qstart:${sessionKey}`,
        ttl: 120,
        owner: 'love-quest.service',
        description: 'Love Quest question start timestamp'
    },

    // ========================
    // MESSAGE QUEUE KEYS
    // ========================
    MQ_OUTBOUND: {
        pattern: 'mq:outbound',
        build: () => 'mq:outbound',
        ttl: null,
        owner: 'message-queue.service',
        description: 'Outbound message queue (sorted set)'
    },
    MQ_RATE: {
        pattern: 'mq:rate',
        build: () => 'mq:rate',
        ttl: 1,
        owner: 'message-queue.service',
        description: 'Current second rate counter'
    },
    MQ_FAILED: {
        pattern: 'mq:failed',
        build: () => 'mq:failed',
        ttl: null,
        owner: 'message-queue.service',
        description: 'Failed message queue (list, max 100)'
    },
    MQ_STATS: {
        pattern: 'mq:stats:{date}',
        build: (date) => `mq:stats:${date}`,
        ttl: 604800,         // 7 days
        owner: 'message-queue.service',
        description: 'Daily message send/fail stats'
    },

    // ========================
    // ERROR MONITORING KEYS
    // ========================
    ERROR_COUNTER: {
        pattern: 'errors:count:{window}',
        build: (window) => `errors:count:${window}`,
        ttl: 300,            // 5 minutes
        owner: 'error-monitor.service',
        description: 'Error count per 5-minute window'
    },
    ERROR_ALERT_COOLDOWN: {
        pattern: 'errors:alert_cooldown',
        build: () => 'errors:alert_cooldown',
        ttl: 900,            // 15 minutes
        owner: 'error-monitor.service',
        description: 'Prevents spam alerts (1 per 15 min)'
    }
};

/**
 * Run cleanup: scan for orphaned keys that match known patterns but have no TTL
 * Safe to run periodically (e.g., every hour)
 */
async function cleanupOrphanedKeys(redis) {
    let cursor = '0';
    let cleaned = 0;
    const protectedPrefixes = ['mq:outbound', 'mq:failed']; // Don't touch queues

    do {
        const [newCursor, keys] = await redis.scan(cursor, 'COUNT', 100);
        cursor = newCursor;

        for (const key of keys) {
            // Skip protected keys
            if (protectedPrefixes.some(p => key.startsWith(p))) continue;

            const ttl = await redis.ttl(key);
            // ttl === -1 means no expiry set (orphaned if it should have one)
            // ttl === -2 means key doesn't exist
            if (ttl === -1) {
                // Check if this matches a known pattern that should have a TTL
                const shouldHaveTTL = Object.values(REDIS_KEYS).some(k => {
                    if (!k.ttl) return false; // Some keys intentionally have no TTL
                    // Match prefix
                    const prefix = k.pattern.split('{')[0];
                    return key.startsWith(prefix);
                });

                if (shouldHaveTTL) {
                    // Set a generous TTL so it expires naturally
                    await redis.expire(key, 3600);
                    cleaned++;
                }
            }
        }
    } while (cursor !== '0');

    return cleaned;
}

/**
 * Get all Redis key stats for admin dashboard
 */
async function getKeyStats(redis) {
    const stats = {};
    
    for (const [name, config] of Object.entries(REDIS_KEYS)) {
        const prefix = config.pattern.split('{')[0];
        let cursor = '0';
        let count = 0;

        // For fixed keys (no pattern variable), just check existence
        if (!config.pattern.includes('{')) {
            const exists = await redis.exists(config.build ? config.build() : prefix);
            stats[name] = { count: exists, ttl: config.ttl, owner: config.owner };
            continue;
        }

        // Scan for pattern matches
        do {
            const [newCursor, keys] = await redis.scan(cursor, 'MATCH', prefix + '*', 'COUNT', 100);
            cursor = newCursor;
            count += keys.length;
        } while (cursor !== '0');

        stats[name] = { count, ttl: config.ttl, owner: config.owner, description: config.description };
    }

    return stats;
}

module.exports = {
    REDIS_KEYS,
    cleanupOrphanedKeys,
    getKeyStats
};