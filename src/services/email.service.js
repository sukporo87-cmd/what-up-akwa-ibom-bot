// ============================================
// FILE: src/services/email.service.js
// Transactional email for web play (OTP codes, welcome).
//
// Provider is chosen automatically from env vars:
//   1. RESEND_API_KEY  -> Resend HTTP API (recommended, no npm install needed)
//   2. SMTP_HOST       -> nodemailer  (requires: npm i nodemailer)
//   3. neither         -> logs to console (local dev only)
// ============================================

const axios = require('axios');
const { logger } = require('../utils/logger');

const FROM_NAME = process.env.EMAIL_FROM_NAME || "What's Up Trivia";
const FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'noreply@whatsuptrivia.com.ng';

class EmailService {
    constructor() {
        this.provider = 'console';

        if (process.env.RESEND_API_KEY) {
            this.provider = 'resend';
        } else if (process.env.SMTP_HOST) {
            try {
                const nodemailer = require('nodemailer');
                this.transporter = nodemailer.createTransport({
                    host: process.env.SMTP_HOST,
                    port: parseInt(process.env.SMTP_PORT || '587'),
                    secure: process.env.SMTP_SECURE === 'true',
                    auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASS
                    }
                });
                this.provider = 'smtp';
            } catch (e) {
                logger.error('nodemailer not installed — falling back to console email:', e.message);
            }
        }

        logger.info(`📧 EmailService ready (provider: ${this.provider})`);
    }

    /**
     * Low-level send. Returns true on success, false on failure.
     * Never throws — callers decide how to handle a failed send.
     */
    async send({ to, subject, html, text }) {
        try {
            if (this.provider === 'resend') {
                await axios.post('https://api.resend.com/emails', {
                    from: `${FROM_NAME} <${FROM_ADDRESS}>`,
                    to: [to],
                    subject,
                    html,
                    text
                }, {
                    headers: {
                        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 15000
                });
                logger.info(`📧 Email sent via Resend to ${this._mask(to)}: ${subject}`);
                return true;
            }

            if (this.provider === 'smtp') {
                await this.transporter.sendMail({
                    from: `"${FROM_NAME}" <${FROM_ADDRESS}>`,
                    to, subject, html, text
                });
                logger.info(`📧 Email sent via SMTP to ${this._mask(to)}: ${subject}`);
                return true;
            }

            // Console fallback — dev only
            logger.warn(`📧 [NO EMAIL PROVIDER CONFIGURED] To: ${to} | ${subject}\n${text}`);
            return true;

        } catch (error) {
            const detail = error.response?.data
                ? JSON.stringify(error.response.data)
                : error.message;
            logger.error(`📧 Email send failed to ${this._mask(to)} (${this.provider}): ${detail}`);
            return false;
        }
    }

    async sendOtp(to, code, purpose = 'login') {
        const heading = purpose === 'signup' ? 'Confirm your email' : 'Your login code';
        const blurb = purpose === 'signup'
            ? 'Use this code to finish creating your What\'s Up Trivia account.'
            : 'Use this code to sign in to What\'s Up Trivia.';

        return this.send({
            to,
            subject: `${code} — ${heading}`,
            text: `${blurb}\n\nYour code is: ${code}\n\nIt expires in 10 minutes.\n\nIf you didn't request this, you can ignore this email.`,
            html: this._wrap(`
                <h1 style="margin:0 0 8px;font-size:22px;color:#111827;">${heading}</h1>
                <p style="margin:0 0 24px;color:#4b5563;font-size:15px;line-height:1.6;">${blurb}</p>
                <div style="background:#f3f4f6;border-radius:12px;padding:22px;text-align:center;margin-bottom:24px;">
                  <div style="font-size:34px;font-weight:700;letter-spacing:10px;color:#111827;font-family:monospace;">${code}</div>
                </div>
                <p style="margin:0 0 6px;color:#6b7280;font-size:13px;">This code expires in 10 minutes.</p>
                <p style="margin:0;color:#6b7280;font-size:13px;">If you didn't request it, you can safely ignore this email.</p>
            `)
        });
    }

    async sendWelcome(to, username) {
        return this.send({
            to,
            subject: "Welcome to What's Up Trivia 🎉",
            text: `Welcome, @${username}! Your account is ready. Head to ${process.env.WEB_APP_URL || 'https://whatsuptrivia.com.ng'} to start playing.`,
            html: this._wrap(`
                <h1 style="margin:0 0 8px;font-size:22px;color:#111827;">Welcome, @${username} 🎉</h1>
                <p style="margin:0 0 20px;color:#4b5563;font-size:15px;line-height:1.6;">
                  Your account is ready. Answer 15 questions, climb the prize ladder, and play for real cash prizes.
                </p>
                <a href="${process.env.WEB_APP_URL || 'https://whatsuptrivia.com.ng'}"
                   style="display:inline-block;background:#6d28d9;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:600;font-size:15px;">
                  Start playing
                </a>
            `)
        });
    }

    _wrap(inner) {
        return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:16px;padding:36px;border:1px solid #e5e7eb;">
    <div style="font-size:15px;font-weight:700;color:#6d28d9;margin-bottom:26px;">🎮 What's Up Trivia</div>
    ${inner}
    <div style="margin-top:34px;padding-top:18px;border-top:1px solid #f3f4f6;color:#9ca3af;font-size:12px;">
      What's Up Trivia · Abuja, Nigeria
    </div>
  </div>
</body></html>`;
    }

    _mask(email) {
        if (!email || !email.includes('@')) return 'unknown';
        const [local, domain] = email.split('@');
        return `${local.substring(0, 2)}***@${domain}`;
    }
}

module.exports = new EmailService();