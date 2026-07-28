// ============================================
// FILE: src/utils/platform.js
// The one place platform is derived, server-side.
//
// Mirrors the derive_platform() SQL function exactly. Prefer reading
// users.platform where you have the row; use this when you only have an
// identifier, or when writing a platform value onto another table.
// ============================================

const CHANNELS = ['whatsapp', 'telegram', 'web'];

/** 'whatsapp' | 'telegram' | 'web' from an identifier or a user row. */
function platformOf(userOrIdentifier) {
    if (userOrIdentifier && typeof userOrIdentifier === 'object') {
        if (userOrIdentifier.platform && CHANNELS.includes(userOrIdentifier.platform)) {
            return userOrIdentifier.platform;           // trust the column
        }
        return platformOf(userOrIdentifier.phone_number);
    }
    const id = String(userOrIdentifier || '');
    if (id.startsWith('tg_')) return 'telegram';
    if (id.startsWith('web_')) return 'web';
    return 'whatsapp';
}

/**
 * What an admin should SEE for this user. Web accounts are identified by
 * email — 'web_d53ca8cd868e' is meaningless to a human.
 */
function displayId(user) {
    if (!user) return '—';
    const p = platformOf(user);
    if (p === 'web') return user.email || '—';
    if (p === 'telegram') return String(user.phone_number || '').replace(/^tg_/, '');
    return user.phone_number || '—';
}

function label(platform) {
    return { whatsapp: 'WhatsApp', telegram: 'Telegram', web: 'Web App' }[platform] || 'WhatsApp';
}

/** SQL predicate for filtering by channel. */
function sqlFilter(platform, col = 'platform') {
    return CHANNELS.includes(platform) ? `${col} = '${platform}'` : 'TRUE';
}

module.exports = { CHANNELS, platformOf, displayId, label, sqlFilter };