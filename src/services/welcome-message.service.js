// ============================================
// FILE: src/services/welcome-message.service.js
// Sends a one-time welcome message to new users
// 20+ hours after their last message, if not yet sent.
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class WelcomeMessageService {
    /**
     * Find users eligible for the welcome message.
     * Criteria:
     *  - welcome_message_sent_at IS NULL  (one-time send)
     *  - last_active < NOW() - INTERVAL '20 hours'
     *  - Registered (have phone_number / full_name)
     */
    async findPendingUsers(limit = 50) {
        try {
            const result = await pool.query(`
                SELECT id, phone_number, full_name, username, platform
                FROM users
                WHERE welcome_message_sent_at IS NULL
                  AND last_active < NOW() - INTERVAL '20 hours'
                  AND full_name IS NOT NULL
                  AND username IS NOT NULL
                ORDER BY created_at ASC
                LIMIT $1
            `, [limit]);
            return result.rows;
        } catch (error) {
            logger.error('Error finding welcome-pending users:', error);
            return [];
        }
    }

    /**
     * Build the welcome message text.
     */
    buildMessage(user) {
        return `👋 Welcome, @${user.username}!\n\n` +
            `Thanks for joining *What's Up Trivia* — Nigeria's premier and most exciting trivia game with real-money prizes! 🎉\n\n` +
            `Here's what you can do:\n\n` +
            `🎮 *Classic Mode* (Available Daily)\n` +
            `Play 15-question rounds and compete for prizes of up to *₦50,000*.\n` +
            `Type *PLAY* to get started.\n\n` +
            `🏆 *Sponsored Tournaments*\n` +
            `Challenge the community for bigger prize pools in our weekly Friday tournaments and special sponsored events.\n` +
            `Type *TOURNAMENTS* to see active competitions.\n\n` +
            `📣 *Stay Connected*\n` +
            `Follow us for tournament updates, giveaways, promotions, and more:\n\n` +
            `• Instagram: @whatsuptrivia\n` +
            `• X (Twitter): @whatsuptrivia\n` +
            `• Facebook: @whatsuptrivia\n\n` +
            `📋 Type *MENU* anytime to see all available options.\n\n` +
            `Good luck, and have fun playing! 🎯\n\n` +
            `*Team What's Up Trivia* 🚀`;
    }

    /**
     * Mark welcome as sent so the user is not re-targeted.
     */
    async markSent(userId) {
        try {
            await pool.query(`
                UPDATE users SET welcome_message_sent_at = NOW() WHERE id = $1
            `, [userId]);
        } catch (error) {
            logger.error(`Error marking welcome sent for user ${userId}:`, error);
        }
    }

    /**
     * Process one batch of pending welcome messages.
     * Returns count of messages successfully sent.
     */
    async processBatch(messagingService) {
        const pending = await this.findPendingUsers(50);
        if (pending.length === 0) return 0;

        logger.info(`👋 Processing welcome messages for ${pending.length} pending user(s)...`);

        let sent = 0;
        for (const user of pending) {
            try {
                const message = this.buildMessage(user);
                await messagingService.sendMessage(user.phone_number, message);
                await this.markSent(user.id);
                sent++;
                logger.info(`👋 Welcome message sent to user ${user.id} (@${user.username})`);
            } catch (error) {
                logger.error(`Error sending welcome to user ${user.id}:`, error.message);
                // Don't mark as sent on failure — will retry next cycle
            }
        }
        return sent;
    }
}

module.exports = new WelcomeMessageService();