// ============================================
// FILE: src/services/contact.service.js
// One place that answers "how do I reach this user?"
//
// WhatsApp / Telegram -> messaging provider
// Web                 -> email
//
// Callers state whether a message is transactional or marketing. Marketing to
// web respects the newsletter opt-out; transactional (payouts, security, game
// state) always goes through.
// ============================================

const pool = require('../config/database');
const emailService = require('./email.service');
const { logger } = require('../utils/logger');

const APP_URL = () => process.env.WEB_APP_URL || 'https://play.whatsuptrivia.com.ng';

class ContactService {

    /** 'whatsapp' | 'telegram' | 'web' — from the identifier prefix. */
    channelOf(user) {
        const id = (typeof user === 'string' ? user : user?.phone_number) || '';
        if (id.startsWith('tg_')) return 'telegram';
        if (id.startsWith('web_')) return 'web';
        return 'whatsapp';
    }

    /** SQL fragment for filtering users by channel. Use instead of ad-hoc LIKEs. */
    sqlFilter(channel, col = 'phone_number') {
        switch (channel) {
            case 'telegram': return `${col} LIKE 'tg_%'`;
            case 'web':      return `${col} LIKE 'web_%'`;
            case 'whatsapp': return `${col} NOT LIKE 'tg_%' AND ${col} NOT LIKE 'web_%'`;
            default:         return 'TRUE';
        }
    }

    /** Can this user actually be reached right now? */
    async canReach(user) {
        const channel = this.channelOf(user);
        if (channel !== 'web') return { ok: true, channel };
        if (!user.email) return { ok: false, channel, reason: 'no email on file' };
        return { ok: true, channel };
    }

    /**
     * Deliver one message.
     * @param {object} user  full users row
     * @param {object} msg   { text, subject?, html?, kind? }  kind: 'transactional'|'marketing'
     * @returns {Promise<{sent:boolean, channel:string, reason?:string}>}
     */
    async send(user, { text, subject, html, kind = 'transactional' }) {
        const channel = this.channelOf(user);

        if (channel === 'web') {
            if (!user.email) {
                return { sent: false, channel, reason: 'no email on file' };
            }
            if (kind === 'marketing') {
                if (user.newsletter_opted_in !== true || user.newsletter_unsubscribed_at) {
                    return { sent: false, channel, reason: 'unsubscribed from marketing' };
                }
            }
            const ok = await emailService.send({
                to: user.email,
                subject: subject || "What's Up Trivia",
                text: this._strip(text),
                html: html || this._html(text, kind === 'marketing' ? user.newsletter_token : null)
            });
            return { sent: ok, channel, reason: ok ? undefined : (emailService.lastError || 'send failed') };
        }

        // Chat platforms keep their existing path untouched.
        try {
            const MessagingService = require('./messaging.service');
            const messagingService = new MessagingService();
            await messagingService.sendMessage(user.phone_number, text);
            return { sent: true, channel };
        } catch (error) {
            return { sent: false, channel, reason: error.message };
        }
    }

    /**
     * Deliver to many users, throttled. Returns a per-channel breakdown so an
     * admin sees the truth rather than an inflated "sent" count.
     */
    async sendBulk(users, msg, { pauseEvery = 20, pauseMs = 1000 } = {}) {
        const result = {
            sent: 0, failed: 0, skipped: 0,
            byChannel: { whatsapp: 0, telegram: 0, web: 0 },
            reasons: {}
        };

        let i = 0;
        for (const user of users) {
            const r = await this.send(user, msg);
            if (r.sent) {
                result.sent++;
                result.byChannel[r.channel]++;
            } else if (r.reason && /unsubscribed|no email/.test(r.reason)) {
                result.skipped++;
                result.reasons[r.reason] = (result.reasons[r.reason] || 0) + 1;
            } else {
                result.failed++;
                if (r.reason) result.reasons[r.reason] = (result.reasons[r.reason] || 0) + 1;
            }
            if (++i % pauseEvery === 0) await new Promise(r => setTimeout(r, pauseMs));
        }
        return result;
    }

    /** Convenience: fetch the full row when you only have an id. */
    async getUser(userId) {
        const r = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        return r.rows[0] || null;
    }

    // ---------- formatting ----------

    /** WhatsApp *bold* markers don't belong in a plain-text email. */
    _strip(text) {
        return (text || '').replace(/\*([^*]+)\*/g, '$1');
    }

    /** Chat text -> a readable email. Bold markers become <strong>. */
    _html(text, unsubscribeToken) {
        const body = (text || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');

        const unsub = unsubscribeToken
            ? `<div style="margin-top:26px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#9ca3af;">
                 <a href="${APP_URL().replace(/\/$/, '')}/newsletter/unsubscribe?t=${unsubscribeToken}"
                    style="color:#9ca3af;">Unsubscribe from these emails</a>
               </div>`
            : '';

        return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:34px;">
    <div style="font-size:15px;font-weight:700;color:#6d28d9;margin-bottom:22px;">🎮 What's Up Trivia</div>
    <div style="color:#374151;font-size:15px;line-height:1.65;">${body}</div>
    <a href="${APP_URL()}" style="display:inline-block;margin-top:24px;background:#6d28d9;color:#fff;
       text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">Open the game</a>
    ${unsub}
  </div>
</body></html>`;
    }
}

module.exports = new ContactService();