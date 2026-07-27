// ============================================
// FILE: src/routes/newsletter.routes.js
// Public one-click unsubscribe. No auth — the token IS the credential.
// Mount:  app.use('/newsletter', require('./routes/newsletter.routes'));
//
// Put this link in every newsletter you send:
//   https://whatsuptrivia.com.ng/newsletter/unsubscribe?t={{newsletter_token}}
// The token comes from the admin export.
// ============================================

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { logger } = require('../utils/logger');

function page({ title, heading, body, accent = '#6d28d9' }) {
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:460px;margin:60px auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:36px;text-align:center;">
    <div style="font-size:15px;font-weight:700;color:${accent};margin-bottom:24px;">🎮 What's Up Trivia</div>
    <h1 style="margin:0 0 12px;font-size:21px;color:#111827;">${heading}</h1>
    <div style="color:#4b5563;font-size:15px;line-height:1.6;">${body}</div>
  </div>
</body></html>`;
}

// GET /newsletter/unsubscribe?t=<token>
router.get('/unsubscribe', async (req, res) => {
    const token = (req.query.t || '').trim();

    if (!token) {
        return res.status(400).send(page({
            title: 'Unsubscribe',
            heading: 'Link not recognised',
            body: 'This unsubscribe link is incomplete. Please use the link exactly as it appears in the email.',
            accent: '#dc2626'
        }));
    }

    try {
        const r = await pool.query(`
            UPDATE users
            SET newsletter_opted_in = false,
                newsletter_unsubscribed_at = COALESCE(newsletter_unsubscribed_at, NOW())
            WHERE newsletter_token = $1
            RETURNING email, username
        `, [token]);

        if (r.rows.length === 0) {
            return res.status(404).send(page({
                title: 'Unsubscribe',
                heading: 'Link not recognised',
                body: 'This link has expired or is invalid. If you keep receiving emails, reply to any of them and we will remove you manually.',
                accent: '#dc2626'
            }));
        }

        logger.info(`📧 Newsletter unsubscribe: @${r.rows[0].username}`);

        return res.send(page({
            title: 'Unsubscribed',
            heading: "You're unsubscribed",
            body: `We won't email <strong>${r.rows[0].email}</strong> about tournaments and events any more.
                   <br><br>You can still play as normal — this only affects the newsletter.
                   <br><br><a href="/newsletter/resubscribe?t=${encodeURIComponent(token)}"
                      style="color:#6d28d9;font-size:14px;">Changed your mind? Resubscribe</a>`
        }));
    } catch (error) {
        logger.error('Unsubscribe error:', error);
        return res.status(500).send(page({
            title: 'Unsubscribe',
            heading: 'Something went wrong',
            body: 'Please try again in a moment.',
            accent: '#dc2626'
        }));
    }
});

// GET /newsletter/resubscribe?t=<token>
router.get('/resubscribe', async (req, res) => {
    const token = (req.query.t || '').trim();
    if (!token) return res.redirect('/newsletter/unsubscribe');

    try {
        const r = await pool.query(`
            UPDATE users
            SET newsletter_opted_in = true,
                newsletter_opted_in_at = NOW(),
                newsletter_unsubscribed_at = NULL
            WHERE newsletter_token = $1 AND email IS NOT NULL
            RETURNING email
        `, [token]);

        if (r.rows.length === 0) {
            return res.status(404).send(page({
                title: 'Resubscribe',
                heading: 'Link not recognised',
                body: 'This link has expired or is invalid.',
                accent: '#dc2626'
            }));
        }

        return res.send(page({
            title: 'Resubscribed',
            heading: "You're back on the list 🎉",
            body: `We'll email <strong>${r.rows[0].email}</strong> about upcoming tournaments, events and prizes.`
        }));
    } catch (error) {
        logger.error('Resubscribe error:', error);
        return res.status(500).send(page({
            title: 'Resubscribe',
            heading: 'Something went wrong',
            body: 'Please try again in a moment.',
            accent: '#dc2626'
        }));
    }
});

module.exports = router;