// ============================================================
// FILE: src/utils/store-reviewers.js
// App store reviewers (LG Content Store, Google Play), Nov 26, 2026.
//
// Reviewers can't receive our sign-in emails, so each reviewer account gets
// a fixed 6-digit code instead. Both live only in one Render setting, never
// in the code or on GitHub:
//
//   REVIEW_LOGINS = usertest1@sisystems.ng=123456;usertest2@sisystems.ng=654321
//
// Empty or missing: no reviewer accounts, and sign-in works exactly as before.
// A line that isn't an email and a 6-digit code is ignored. Only accounts that
// already exist can sign in this way; nothing here creates one.
//
// Reviewer accounts are also kept off the public TV leaderboard and the
// website's activity ticker, so testing never shows to real players.
// ============================================================
'use strict';

const crypto = require('crypto');

const EMAIL = /^[^\s@=;]+@[^\s@=;]+\.[^\s@=;]{2,}$/;

/** email (lower case) -> code, read fresh from the setting each time. */
function logins() {
    const map = new Map();
    for (const part of String(process.env.REVIEW_LOGINS || '').split(/[;\n,]+/)) {
        const i = part.lastIndexOf('=');
        if (i < 1) continue;
        const email = part.slice(0, i).trim().toLowerCase();
        const code = part.slice(i + 1).trim();
        if (EMAIL.test(email) && /^\d{6}$/.test(code)) map.set(email, code);
    }
    return map;
}

function isReviewer(email) {
    return !!email && logins().has(String(email).trim().toLowerCase());
}

/** The reviewer emails, lower case, for excluding them in SQL. */
function emails() {
    return [...logins().keys()];
}

/** True only for a reviewer email and its own code (compared in constant time). */
function codeMatches(email, code) {
    const want = logins().get(String(email || '').trim().toLowerCase());
    const got = String(code || '').trim();
    if (!want || got.length !== want.length) return false;
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** For logs: us***@sisystems.ng */
function mask(email) {
    return String(email || '').replace(/(.{2}).*(@.*)/, '$1***$2');
}

module.exports = { isReviewer, emails, codeMatches, mask, logins };
