// ============================================
// FILE: src/utils/tv-names.js
// Names, colours and emoji for WUT TV Party players.
//
// A Party name is shown on a TV in a public room — a bar, a lounge, an event.
// It is filtered BEFORE it can reach the screen, never moderated afterwards.
//
// Pure and synchronous, so every rule is testable without a database.
// ============================================

const MIN_LEN = 2;
const MAX_LEN = 20;

// Letters (any script, with their accents), spaces and a few joining symbols.
// Nigerian names carry diacritics (Ọlá, Ẹ̀mẹ́kà), so this is Unicode letters,
// not A-Z. Digits are refused: "David 2" is something the server assigns, not
// something a player types, and digit names are how a screen fills with
// "6969".
const ALLOWED = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;

// ============================================
// BLOCKLIST
// ============================================
// A starting list, meant to be extended. Two kinds, because substring
// matching on short words is how "Cassandra" and "Dickson" get refused —
// and Dickson is a common Nigerian name.
//
//   STEMS  are matched anywhere in the squashed name (letters only, leetspeak
//          undone). Only words that do not sit inside common names belong
//          here: "nazi" is a WORD because of Nazir, "gbola" is absent because
//          of Gbolahan, "mumuni" because it is a name.
//   WORDS  are matched only as whole words.
const STEMS = [
    'fuck', 'motherf', 'cunt', 'nigger', 'nigga', 'faggot', 'whore', 'bitch',
    'bastard', 'asshole', 'arsehole', 'wanker', 'pussy', 'shithead', 'bullshit',
    'dickhead', 'cocksuck', 'blowjob', 'handjob', 'rapist', 'retard', 'slut',
    'porn', 'penis', 'vagina', 'dildo', 'hitler', 'ashawo', 'ashewo', 'olosho',
    'kpekus', 'kpekwus', 'onyeoshi', 'oloriburuku', 'dindinrin'
];

const WORDS = [
    'ass', 'arse', 'dick', 'cock', 'tit', 'tits', 'boob', 'boobs', 'cum', 'fag',
    'fags', 'fuk', 'shit', 'sex', 'sexy', 'rape', 'kill', 'nude', 'nudes', 'hoe',
    'hoes', 'pimp', 'thot', 'twat', 'prick', 'tranny', 'homo', 'lesbo', 'nazi',
    'isis', 'boko', 'mumu', 'ode', 'oloshi', 'oponu', 'werey', 'nyash', 'toto'
];

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i' };

function _plain(text) {
    return String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
        .replace(/[0134578@$!]/g, c => LEET[c] || c);
}

// Each letter of a listed word may repeat ("fuuuck"), but a double letter in
// the word must stay double. Collapsing repeats instead would turn "nigger"
// into "niger" and refuse every "Niger Delta" and "Nigerian" in the country.
const _pattern = w => w.split('').map(c => c + '+').join('');
const STEM_RES = STEMS.map(s => new RegExp(_pattern(s)));
const WORD_RES = WORDS.map(w => new RegExp('^' + _pattern(w) + '$'));

function isAbusive(name) {
    const plain = _plain(name);
    const squashed = plain.replace(/[^a-z]/g, '');
    if (squashed && STEM_RES.some(re => re.test(squashed))) return true;
    const words = plain.split(/[^a-z]+/).filter(Boolean);
    return words.some(w => WORD_RES.some(re => re.test(w)));
}

/**
 * Returns { ok, name, key } or { ok: false, reason }.
 * `name` is what the TV shows; `key` is what duplicate checks compare.
 */
function validateName(raw) {
    if (typeof raw !== 'string') return { ok: false, reason: 'name_required' };
    const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!name) return { ok: false, reason: 'name_required' };
    const length = [...name].length;
    if (length < MIN_LEN) return { ok: false, reason: 'name_too_short' };
    if (length > MAX_LEN) return { ok: false, reason: 'name_too_long' };
    if (!ALLOWED.test(name)) return { ok: false, reason: 'name_characters' };
    const letters = (name.match(/\p{L}/gu) || []).length;
    if (letters < MIN_LEN) return { ok: false, reason: 'name_too_short' };
    if (isAbusive(name)) return { ok: false, reason: 'name_not_allowed' };
    return { ok: true, name, key: nameKey(name) };
}

// Web usernames: 3 to 20 of letters, digits and underscore (web-auth.service).
const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

/**
 * The name a signed-in player shows on the TV: their username, as it is.
 * Falls back to "Player" only if it is missing, malformed, or abusive.
 */
function accountName(username) {
    const u = String(username || '').trim();
    if (!USERNAME.test(u)) return 'Player';
    if (isAbusive(u.replace(/_/g, ' '))) return 'Player';
    return u;
}

function nameKey(name) {
    return String(name || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * "David" is taken. The player is offered an initial first; only if they
 * decline does a number go on the end. Returns the first free "David N".
 */
function numberedName(name, takenKeys) {
    const taken = new Set(takenKeys);
    for (let n = 2; n <= 99; n++) {
        const candidate = `${name} ${n}`;
        if (!taken.has(nameKey(candidate))) return candidate;
    }
    return null;
}

// ============================================
// COLOUR AND AVATAR
// ============================================
// Twenty colours for a twenty-player room, so no two players ever share one.
// Colours are always assigned: picked to stay distinct on a TV across a room.
const COLOURS = [
    '#E53935', '#1E88E5', '#43A047', '#FDD835', '#8E24AA',
    '#FB8C00', '#00ACC1', '#D81B60', '#7CB342', '#5E35B1',
    '#F4511E', '#039BE5', '#C0CA33', '#6D4C41', '#3949AB',
    '#00897B', '#FFB300', '#EC407A', '#546E7A', '#26A69A'
];

// Thirty-two avatars, so a twentieth player still has twelve to choose from.
// Twenty animals, then vehicles and people. A player picks one or skips, and
// a skip gets the first free one — an animal, since they come first.
//
// Every one of these is in Unicode Emoji 5.0 or earlier, so it draws as one
// picture on Android 8.1 and later (older Android TVs included), not as two
// glyphs side by side. That is why the people are the gendered forms (2016)
// and not the newer gender-neutral ones, and why there is no parrot or
// flamingo. Two need the U+FE0F selector to draw in colour: the racing car
// and the aeroplane.
const AVATARS = [
    '\u{1F981}', '\u{1F418}', '\u{1F992}', '\u{1F406}', '\u{1F993}',   // lion elephant giraffe leopard zebra
    '\u{1F422}', '\u{1F989}', '\u{1F41D}', '\u{1F98B}', '\u{1F419}',   // turtle owl bee butterfly octopus
    '\u{1F98A}', '\u{1F43C}', '\u{1F428}', '\u{1F438}', '\u{1F984}',   // fox panda koala frog unicorn
    '\u{1F427}', '\u{1F433}', '\u{1F42C}', '\u{1F985}', '\u{1F40A}',   // penguin whale dolphin eagle crocodile
    '\u{1F680}', '\u{1F3CE}\u{FE0F}', '\u{1F697}', '\u{1F681}',          // rocket racing-car car helicopter
    '\u{2708}\u{FE0F}', '\u{26F5}', '\u{26BD}', '\u{1F3B8}',             // aeroplane sailboat football guitar
    '\u{1F469}\u{200D}\u{1F52C}', '\u{1F468}\u{200D}\u{1F680}',           // scientist astronaut
    '\u{1F469}\u{200D}\u{1F3A4}', '\u{1F468}\u{200D}\u{1F373}'            // singer chef
];
const ANIMALS = 20;

// Kept for anything that still says EMOJI.
const EMOJI = AVATARS;

/** First colour, and first avatar, that nobody active in the room is using. */
function assignLook(used = []) {
    const usedColours = new Set(used.map(u => u.colour));
    const usedAvatars = new Set(used.map(u => u.avatar));
    const colour = COLOURS.find(c => !usedColours.has(c)) || COLOURS[used.length % COLOURS.length];
    const avatar = AVATARS.find(e => !usedAvatars.has(e)) || AVATARS[used.length % AVATARS.length];
    return { colour, avatar };
}

function isAvatar(a) {
    return typeof a === 'string' && AVATARS.includes(a);
}

module.exports = {
    validateName,
    accountName,
    nameKey,
    numberedName,
    isAbusive,
    assignLook,
    isAvatar,
    COLOURS,
    AVATARS,
    ANIMALS,
    EMOJI,
    MIN_LEN,
    MAX_LEN
};
