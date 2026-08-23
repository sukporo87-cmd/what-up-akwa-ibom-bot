// ============================================
// FILE: src/services/device-fingerprint.service.js
// Turns raw browser components into a stable device id.
//
// WHY THIS EXISTS
// device-tracking.service.js builds its fingerprint from
// `platform | phone_number`, which is a per-ACCOUNT value by construction.
// Two accounts on one handset produce two different hashes, so
// checkMultiAccountByDevice() has never been able to fire for the exploit it
// was written to catch. This module supplies the missing input: components
// that describe the MACHINE, not the account.
//
// TWO RULES THAT MATTER
//
// 1. The server hashes, never the client. The browser sends raw components;
//    this file turns them into an id. If the client sent a finished id, a
//    cheater would send a fresh random one per account and the whole check
//    would be decorative.
//
// 2. A weak sample is not a device. If a browser blocks canvas and WebGL, the
//    remaining components are shared by thousands of people, and hashing them
//    would link strangers to each other as "the same device" — mass false
//    positives that poison account_links and the watchlist. Below MIN_STRONG
//    we still record the sample for history, but we mark it low_entropy and
//    the caller must not link on it.
// ============================================

const crypto = require('crypto');

// STRONG components describe the hardware and survive a new browser profile,
// an incognito window, or a switch from Chrome to Edge on the same machine.
// That is exactly the exploit in scope: one person, one device, two accounts.
const STRONG = ['canvas', 'webgl', 'screen', 'hardware'];

// WEAK components add entropy but are shared far too widely to identify a
// machine on their own. They join the hash; they do not qualify a sample.
const WEAK = ['timezone', 'languages', 'platform', 'touch'];

const ALL = [...STRONG, ...WEAK];

// Two strong components is the floor. One is a coincidence.
const MIN_STRONG = 2;

// A component longer than this is either a bug or someone probing. Canvas and
// WebGL arrive pre-hashed by the client, so nothing legitimate is long.
const MAX_COMPONENT_LENGTH = 512;

class DeviceFingerprintService {

    // ============================================
    // NORMALISE
    // ============================================
    // Trims, caps length, drops anything that is not a usable string. Returns
    // only the keys we recognise, so an attacker cannot pad the payload with
    // junk keys to change the hash between sessions.

    normalise(raw) {
        const clean = {};
        if (!raw || typeof raw !== 'object') return clean;

        for (const key of ALL) {
            const value = raw[key];
            if (value === undefined || value === null) continue;

            const asString = String(value).trim();
            if (!asString) continue;
            if (asString.length > MAX_COMPONENT_LENGTH) continue;

            clean[key] = asString;
        }

        return clean;
    }

    // ============================================
    // HASH
    // ============================================
    // Keys are sorted before joining so the hash does not depend on the order
    // the browser happened to serialise them in. Same 32-char width as the
    // existing fingerprints, so device_fingerprints.device_id stays uniform.

    hash(components) {
        const parts = Object.keys(components)
            .sort()
            .map(key => `${key}=${components[key]}`);

        return crypto
            .createHash('sha256')
            .update(parts.join('|'))
            .digest('hex')
            .substring(0, 32);
    }

    // ============================================
    // FROM BROWSER
    // ============================================
    // The entry point. Returns null when there is nothing usable at all —
    // callers treat null as "no device information this session" and carry on.

    fromBrowser(raw) {
        const components = this.normalise(raw);
        const present = Object.keys(components);

        if (present.length === 0) return null;

        const strongCount = STRONG.filter(k => components[k]).length;
        const quality = strongCount >= MIN_STRONG ? 'strong' : 'low_entropy';

        return {
            deviceId: this.hash(components),
            quality,
            strongCount,
            // Stored on device_fingerprints.device_info. Deliberately records
            // WHICH components were present rather than their values: enough
            // for an admin to see why a match happened, without keeping a
            // second copy of the raw fingerprint in a jsonb column.
            info: {
                source: 'browser',
                quality,
                components: present.sort(),
                strongCount
            }
        };
    }

    // ============================================
    // IS LINKABLE
    // ============================================
    // The single question every caller actually wants answered: may I use this
    // to link two accounts together? Kept here so the rule lives in one place
    // rather than being re-derived at each call site.

    isLinkable(info) {
        if (!info || typeof info !== 'object') return false;
        return info.source === 'browser' && info.quality === 'strong';
    }

    // ============================================
    // SUMMARISE (for logs)
    // ============================================

    describe(result) {
        if (!result) return 'no usable components';
        return `${result.quality} (${result.strongCount}/${STRONG.length} strong, ` +
               `${result.info.components.length} total)`;
    }
}

module.exports = new DeviceFingerprintService();
module.exports.STRONG = STRONG;
module.exports.WEAK = WEAK;
module.exports.MIN_STRONG = MIN_STRONG;
