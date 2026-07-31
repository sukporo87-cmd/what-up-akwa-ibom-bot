// ============================================
// FILE: src/services/game-state.service.js
//
// game.state — one authoritative answer to "what does the engine expect from
// the player right now?"
//
// Everything here is DERIVED, never stored. It reads the engine's own sources
// of truth (user_state in Redis, game_ready, the active session, the question
// snapshot) at the moment it's asked. That matters: the web client used to
// infer the engine's state by pattern-matching message text, and every bug in
// that approach came from a state it didn't know existed. A derived view
// cannot drift, because there is nothing to keep in sync.
//
// Division of labour with the existing events:
//   game.state      what the engine wants next  (meaning)
//   message         the engine's own words      (content)
//   question.asked  the question, structured    (content)
//
// The client pairs them: state decides how to render, text supplies the words.
// ============================================

const redis = require('../config/redis');
const { logger } = require('../utils/logger');

// ============================================
// STATE MAP
// Every state the engine can park a user in, and what the player must send to
// get out of it. Keep this in step with setUserState() calls in the engine —
// an unmapped state still works, it just falls back to a plain text field.
// ============================================

const PROMPTS = {
    // --- pick one of a numbered list ---
    SELECT_GAME_MODE:           { expects: 'choice', title: 'Choose a mode' },
    SELECT_TOURNAMENT:          { expects: 'choice', title: 'Pick a tournament' },
    SELECT_LEADERBOARD:         { expects: 'choice', title: 'Which leaderboard?' },
    SELECT_PACKAGE:             { expects: 'choice', title: 'Choose a package',       web: 'buy' },
    SELECT_PACKAGE_GATEWAY:     { expects: 'choice', title: 'How would you like to pay?', web: 'buy' },
    SELECT_TOURNAMENT_GATEWAY:  { expects: 'choice', title: 'How would you like to pay?' },
    SELECT_REBUY_GATEWAY:       { expects: 'choice', title: 'How would you like to pay?' },
    CONFIRM_TOURNAMENT_PAYMENT: { expects: 'choice', title: 'Confirm your entry' },
    CONFIRM_TOURNAMENT_REBUY:   { expects: 'choice', title: 'Buy more tokens?',
        // The engine wants the word REBUY, not a number — without these the
        // player gets a bare text box and has to guess what to type.
        actions: [
            { send: 'REBUY',  label: 'Buy more tokens', primary: true },
            { send: 'MENU',   label: 'Not now' }
        ] },
    CONFIRM_BANK_DETAILS:       { expects: 'choice', title: 'Are these details right?',
        actions: [
            { send: 'YES',    label: 'Use these details', primary: true },
            { send: 'UPDATE', label: 'Enter different details' },
            { send: 'CANCEL', label: 'Cancel this claim' }
        ] },
    TERMS_ACCEPTANCE:           { expects: 'choice', title: 'Terms and conditions',
        actions: [
            { send: 'AGREE',  label: 'I agree', primary: true },
            { send: 'CANCEL', label: 'Not now' }
        ] },
    LOVE_QUEST_PACKAGE_SELECT:  { expects: 'choice', title: 'Choose a package' },
    LOVE_QUEST_VIDEO_MENU:      { expects: 'choice', title: 'Video options' },
    LOVE_QUEST_VOICE_MENU:      { expects: 'choice', title: 'Voice options' },

    // --- type something ---
    ENTER_PROMO_CODE: { expects: 'text', title: 'Promo code',
        field: { label: 'Promo code', type: 'text', transform: 'upper', placeholder: 'Enter your code' } },
    EMAIL_COLLECT:    { expects: 'text', title: 'Your email',
        field: { label: 'Email address', type: 'email', placeholder: 'you@example.com' } },

    // --- payout details (item 3 on the roadmap gets proper form fields for free) ---
    COLLECT_BANK_NAME: { expects: 'choice', title: 'Choose your bank',
        field: { label: 'Or type your bank name', type: 'text', placeholder: 'e.g. Kuda' } },
    COLLECT_CUSTOM_BANK: { expects: 'text', title: 'Your bank',
        field: { label: 'Bank name', type: 'text', placeholder: 'Type your bank name' } },
    COLLECT_ACCOUNT_NUMBER: { expects: 'text', title: 'Account number',
        field: { label: 'Account number', type: 'tel', inputmode: 'numeric', maxLength: 10,
                 placeholder: '10 digits' } },
    COLLECT_ACCOUNT_NAME: { expects: 'text', title: 'Account name',
        field: { label: 'Name on the account', type: 'text', placeholder: 'As it appears at your bank' } },

    LOVE_QUEST_PLAYER_NAME:  { expects: 'text', title: 'Their name',
        field: { label: 'Name', type: 'text' } },
    LOVE_QUEST_PLAYER_PHONE: { expects: 'text', title: 'Their number',
        field: { label: 'Phone number', type: 'tel', inputmode: 'tel' } },
    LOVE_QUEST_VOICE_NOTE:   { expects: 'media', title: 'Voice note' },
    LOVE_QUEST_VIDEO:        { expects: 'media', title: 'Video' },

    // --- registration: web signs people up through web-auth, so these should
    //     never appear here. Mapped defensively rather than left to guesswork. ---
    REGISTRATION_NAME:     { expects: 'text', title: 'Your name',     field: { label: 'Full name', type: 'text' } },
    REGISTRATION_USERNAME: { expects: 'text', title: 'Pick a username', field: { label: 'Username', type: 'text' } },
    REGISTRATION_CITY:     { expects: 'text', title: 'Your city',     field: { label: 'City', type: 'text' } },
    REGISTRATION_AGE:      { expects: 'text', title: 'Your age',      field: { label: 'Age', type: 'number', inputmode: 'numeric' } },
    REGISTRATION_SOURCE:   { expects: 'choice', title: 'How did you hear about us?' },
    REGISTRATION_REFERRAL: { expects: 'text', title: 'Referral code', field: { label: 'Referral code', type: 'text' } }
};

const UNKNOWN = { expects: 'text', title: 'One more thing' };

class GameStateService {

    constructor() {
        this.timers = new Map();
    }

    /**
     * Work out what the engine is waiting for.
     *
     * Order matters and mirrors webhookController.routeMessage() exactly:
     * a parked user_state is checked before game input, and inside game input
     * game_ready is checked before photo verification, which is checked before
     * answers. Get this order wrong and the client offers the wrong control.
     */
    /**
     * Lazily resolved so this module can be required from messaging.service
     * without a cycle. Note user.service and game.service export CLASSES, not
     * instances — treating them as instances is what silently broke every
     * game.state emit on the first deploy of this file.
     */
    _deps() {
        if (!this._cached) {
            const UserService = require('./user.service');
            const GameService = require('./game.service');
            this._cached = {
                userService: new UserService(),
                gameService: GameService.shared,
                gameEvents: require('./game-events.service')
            };
        }
        return this._cached;
    }

    async derive(user) {
        const { userService, gameService, gameEvents } = this._deps();

        const [rawState, ready, session, postGameRaw] = await Promise.all([
            userService.getUserState(user.phone_number).catch(() => null),
            redis.get(`game_ready:${user.id}`).catch(() => null),
            gameService.getActiveSession(user.id).catch(() => null),
            redis.get(`post_game:${user.id}`).catch(() => null)
        ]);

        const base = { phase: 'idle', expects: 'nothing', canCancel: false, at: Date.now() };

        // 1. Parked in a text state — the router handles these before anything else.
        if (rawState && rawState.state) {
            const spec = PROMPTS[rawState.state];

            // The map has to track setUserState() calls in the engine. Rather
            // than trusting anyone to remember, say so the moment a real player
            // lands in something unmapped — the fallback still works, but this
            // is how you find out it happened.
            if (!spec) {
                logger.warn(
                    `game.state: engine state "${rawState.state}" is not in PROMPTS — ` +
                    `falling back to a plain text field. Add it to game-state.service.js.`
                );
            }
            const resolved = spec || UNKNOWN;
            return {
                ...base,
                phase: 'prompt',
                expects: resolved.expects,
                state: rawState.state,
                title: resolved.title,
                field: resolved.field || null,
                actions: resolved.actions || null,   // word commands as buttons
                web: resolved.web || null,  // web has a purpose-built screen for this
                mapped: !!spec,
                canCancel: true
            };
        }

        // 2. Session built, rules sent, engine wants START.
        //
        // game_ready lives for 300s. On chat nobody sits on a rules message for
        // five minutes; on web people leave tabs open constantly, and once it
        // lapses START silently does nothing. Send the remaining time so the
        // client can warn rather than let them tap a dead button.
        if (session && ready) {
            let secondsRemaining = null;
            try {
                const ttl = await redis.ttl(`game_ready:${user.id}`);
                if (ttl > 0) secondsRemaining = ttl;
            } catch (e) { /* non-fatal */ }

            return { ...base, phase: 'awaiting_start', expects: 'start',
                     sessionId: session.id, gameMode: session.game_mode,
                     secondsRemaining, canCancel: true };
        }

        if (session) {
            // 3. Photo verification blocks answering.
            let needsPhoto = false;
            try {
                needsPhoto = await gameService.hasPendingPhotoVerification(session.session_key);
            } catch (e) { /* treat as no */ }

            if (needsPhoto) {
                // Read the real deadline out of the stored payload, not the key
                // TTL — the TTL deliberately outlives the deadline by a few
                // seconds so a late arrival can be told the window closed.
                let secondsRemaining = null, expiresAt = null;
                try {
                    const raw = await redis.get(`photo_verify:${session.session_key}`);
                    const data = raw ? JSON.parse(raw) : null;
                    if (data && data.expiresAt) {
                        expiresAt = data.expiresAt;
                        secondsRemaining = Math.max(0, Math.ceil((data.expiresAt - Date.now()) / 1000));
                    }
                } catch (e) { /* non-fatal */ }

                return { ...base, phase: 'photo', expects: 'photo',
                         sessionId: session.id, title: 'Quick photo check',
                         secondsRemaining, expiresAt, canCancel: false };
            }

            // 4. Turbo mode is waiting for GO.
            let waitingGo = false;
            try {
                waitingGo = await gameService.isWaitingForTurboGo(session.session_key);
            } catch (e) { /* treat as no */ }

            if (waitingGo) {
                return { ...base, phase: 'turbo_go', expects: 'go',
                         sessionId: session.id, title: 'Ready?', canCancel: true };
            }

            // 5. Security check. Not a setUserState state, which is exactly how
            //    it slipped past the state map — it lives in its own Redis key.
            try {
                const raw = await redis.get(`captcha:${session.session_key}`);
                if (raw) {
                    let data = null;
                    try { data = JSON.parse(raw); } catch (e) { /* legacy shape */ }
                    const started = data && data.startTime ? data.startTime : null;
                    const expiresAt = started ? started + 12000 : null;
                    return {
                        ...base,
                        phase: 'captcha',
                        expects: 'captcha',
                        sessionId: session.id,
                        title: 'Security check',
                        captchaType: data ? data.type : null,
                        questionNumber: data ? data.questionNumber : null,
                        expiresAt,
                        secondsRemaining: expiresAt
                            ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : null,
                        canCancel: false
                    };
                }
            } catch (e) { /* non-fatal */ }

            // 6. Live question.
            const snap = await gameEvents.getSnapshot(user.id).catch(() => null);
            if (snap && !snap.stale) {
                return {
                    ...base,
                    phase: 'question',
                    expects: 'answer',
                    sessionId: session.id,
                    gameMode: session.game_mode,
                    questionNumber: snap.questionNumber,
                    secondsRemaining: snap.secondsRemaining,
                    lifelines: snap.lifelines || null,
                    canCancel: true
                };
            }

            // Session alive but nothing to answer yet — between questions.
            return { ...base, phase: 'between', expects: 'nothing',
                     sessionId: session.id, gameMode: session.game_mode, canCancel: true };
        }

        // 5. Game just finished; the engine accepts the follow-up menu for a while.
        if (postGameRaw) {
            let data = null;
            try { data = JSON.parse(postGameRaw); } catch (e) { /* legacy timestamp */ }
            let sharePending = false;
            try { sharePending = !!(await redis.get(`win_share_pending:${user.id}`)); }
            catch (e) { /* non-fatal */ }

            return { ...base, phase: 'post_game', expects: 'choice',
                     gameMode: data?.gameType || null, title: 'What next?',
                     sharePending };
        }

        return base;
    }

    /** Derive and push over SSE. Returns the state, or null if we can't resolve the user. */
    async emit(userOrIdentifier) {
        const { gameEvents } = this._deps();
        const user = typeof userOrIdentifier === 'object'
            ? userOrIdentifier
            : await this._load(userOrIdentifier);

        if (!user) return null;

        const state = await this.derive(user);
        gameEvents.emit(user.id, 'game.state', state);
        return state;
    }

    /**
     * Debounced emit. The engine often sends two or three messages in one turn
     * ("Classic Mode selected!", then the rules); the player only needs the
     * state it settles on, so coalesce them into a single event.
     */
    schedule(identifier, delay = 160) {
        if (!String(identifier || '').startsWith('web_')) return;

        clearTimeout(this.timers.get(identifier));
        const t = setTimeout(async () => {
            this.timers.delete(identifier);
            try {
                await this.emit(identifier);
            } catch (e) {
                // Template literal, not a second argument: winston's JSON format
                // treats a bare string as meta and drops it, which is exactly
                // how these errors logged with no message for a whole session.
                logger.error(`Could not emit game.state: ${e && e.stack ? e.stack : e}`);
            }
        }, delay);

        if (t.unref) t.unref();          // never hold the process open for this
        this.timers.set(identifier, t);
    }

    async _load(identifier) {
        try {
            const pool = require('../config/database');
            const r = await pool.query(
                'SELECT * FROM users WHERE phone_number = $1 LIMIT 1',
                [identifier]
            );
            return r.rows[0] || null;
        } catch (e) {
            logger.error(`Could not load user for game.state: ${e && e.message}`);
            return null;
        }
    }
}

module.exports = new GameStateService();
module.exports.PROMPTS = PROMPTS;   // exported so scripts/check-state-map.js can diff it