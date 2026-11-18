// ============================================
// FILE: src/utils/client-ip.js
// The address a request really came from: for the limits that count per
// network (sign-in codes, admin sign-in, joining a TV game), for fraud
// checks on payments, and for the audit trail. One place, so every route
// reads it the same way.
//
// WHY NOT THE FIRST X-Forwarded-For ADDRESS. Every route used to take it. A
// client can send that header itself, and the proxies in front of this
// server add to it rather than replace it, so the first address is whatever
// the caller chose: one fake header and every per-network limit is gone,
// and the logs show an address that was never there.
//
// WHAT IS TRUSTED INSTEAD. Render serves every request through Cloudflare,
// which sets CF-Connecting-IP to the address that actually connected to it,
// replacing any value a client sent. That address is used when it is there
// and well formed. Where it is not there (a local run, the tests), the old
// reading is kept, so nothing is worse than before anywhere.
//
// GET /tv/ip-check shows any caller what the server sees for them, so this
// can be confirmed on the live server (Nov 18, 2026).
// ============================================
'use strict';
const net = require('net');

/** An address if it is one (IPv4 or IPv6, "::ffff:" taken off), else null. */
function clean(v) {
    const s = String(v == null ? '' : v).trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
    return s && net.isIP(s) ? s : null;
}

/** The client's address, or null. */
function clientIp(req) {
    const h = (req && req.headers) || {};
    const cf = clean(h['cf-connecting-ip']);
    if (cf) return cf;
    const first = clean(String(h['x-forwarded-for'] || '').split(',')[0]);
    if (first) return first;
    return clean(req && req.socket && req.socket.remoteAddress);
}

/** What /tv/ip-check shows the caller about their own request. */
function describe(req) {
    const h = (req && req.headers) || {};
    const chain = String(h['x-forwarded-for'] || '').slice(0, 300);
    return {
        used: clientIp(req),
        from: clean(h['cf-connecting-ip']) ? 'cf-connecting-ip' : (chain ? 'x-forwarded-for (first)' : 'connection'),
        cfConnectingIp: h['cf-connecting-ip'] ? String(h['cf-connecting-ip']).slice(0, 60) : null,
        trueClientIp: h['true-client-ip'] ? String(h['true-client-ip']).slice(0, 60) : null,
        xForwardedFor: chain || null
    };
}

module.exports = { clientIp, describe, clean };
