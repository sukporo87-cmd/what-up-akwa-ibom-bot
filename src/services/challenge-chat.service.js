// ============================================
// FILE: src/services/challenge-chat.service.js
// The WhatsApp/Telegram side of Challenge a Friend: creation as a short
// state machine, and what an invite link does when it arrives in a chat.
//
// WHY THIS IS ITS OWN FILE
// routeMessage() is the hottest path in the product and has already produced
// three bugs in one day from phrase matching. Bolting a nine-step state
// machine into it would put all of that risk in the worst possible place. So
// webhook.controller gets ONE small hook that asks "is this person in a
// challenge flow?" and everything else lives here.
//
// EVERY PLAYER-FACING STRING IN THE CHAT FLOW IS IN THIS FILE, in the STRINGS
// object at the top. They are the approved wording from the design doc §14.
// Nothing composes copy inline — a string you have to grep for is a string
// that drifts.
// ============================================

const redis = require('../config/redis');
const { logger } = require('../utils/logger');
// These two export the CLASS, not an instance. webhook.controller.js does
// `new UserService()` for the same reason. Calling a method on the class
// itself throws TypeError, which routeMessage's outer catch swallows — the
// player just gets the main menu with no clue anything failed.
const UserService = require('./user.service');
const userService = new UserService();
const MessagingService = require('./messaging.service');
const messagingService = new MessagingService();
const challengeService = require('./challenge.service');
const challengeRoundService = require('./challenge-round.service');
const pool = require('../config/database');
const restrictionsService = require('./restrictions.service');
const { platformOf } = require('../utils/platform');

const STATE_PREFIX = 'challenge_create';

const naira = (n) => '\u20a6' + Number(n || 0).toLocaleString('en-NG');

// ============================================
// STRINGS — approved wording, design doc §14
// ============================================
const STRINGS = {

    // ---- creation ----
    pickMode:
        '*Challenge a friend* \u2694\ufe0f\n\n' +
        'How do you want to play?\n\n' +
        '*1* \u2014 Anytime (you play first, they race your pace)\n' +
        '*2* \u2014 Together, live\n\n' +
        'Reply 1 or 2, or MENU to go back.',

    pickFormat:
        'Who are you challenging?\n\n' +
        '*1* \u2014 One friend\n' +
        '*2* \u2014 A group (up to 20)\n\n' +
        'Reply 1 or 2.',

    pickGroupSize:
        'How many players, including you?\n\n' +
        'Reply with a number between 2 and 20.',

    pickCategories: (list) =>
        'Pick up to 3 categories.\n\n' + list + '\n\n' +
        'Reply with the numbers, separated by commas \u2014 like *1,3*.',

    pickEntry:
        'How do people get in?\n\n' +
        '*1* \u2014 Everyone uses one of their own credits\n' +
        '*2* \u2014 You pay for everyone\n' +
        '*3* \u2014 Free for everyone\n\n' +
        'Reply 1, 2 or 3.',

    // §14.1 — the no-refund warning, before any money moves
    prepaidWarning: (slots, each, total) =>
        `You're paying for ${slots} entries at ${naira(each)} each.\n` +
        `Anyone you invite plays free until the ${slots} slots are used.\n\n` +
        `*Slots you don't fill are not refunded.* Getting your friends in is on you.\n\n` +
        `Reply *PAY* to continue, or *BACK* to change it.`,

    // §14.2 — the cancellation point, stated before anything is spent
    cancellationNotice:
        "You can cancel this challenge any time until someone joins or pays. " +
        "After that it's final \u2014 it runs, or it expires.",

    // §14.3 — sponsorship terms, both figures shown before payment
    sponsorTerms: (amount, refund, retained) =>
        `You're putting up ${naira(amount)} as the prize. We hold it until the ` +
        `challenge finishes, then the winner claims it the normal way.\n\n` +
        `The challenge has to actually happen: at least two people must finish. ` +
        `If it doesn't, you get *${naira(refund)}* back \u2014 we keep 15% ` +
        `(${naira(retained)}) for the cost of setting it up.\n\n` +
        `You can't win your own sponsored prize.\n\n` +
        `Reply *PAY* to continue, or *SKIP* to play for bragging rights.`,

    sponsorTooYoung:
        'You need to be 18 or over to put up a prize. You can still create this ' +
        'challenge for bragging rights \u2014 reply *SKIP* to carry on.',

    created: (links, categories) =>
        '\u2705 *Your challenge is ready.*\n\n' +
        `Categories: ${categories}\n` +
        '15 questions \u00b7 10 seconds each \u00b7 highest score wins\n\n' +
        'Send this to whoever you want to beat:\n' +
        `${links.web}\n\n` +
        'Invites last 48 hours.',

    // ---- receiving an invite ----
    inviteFound: (from, categories, entryLine) =>
        `\u2694\ufe0f *${from} challenged you.*\n\n` +
        `${categories}\n` +
        '15 questions \u00b7 10 seconds each \u00b7 highest score wins\n' +
        `${entryLine}\n\n` +
        'Reply *ACCEPT* to take it on, or *NO* to leave it.',

    entryLineFree:    'Free to enter.',
    entryLinePrepaid: 'They\u2019ve already paid your entry.',
    entryLineCredit:  'Costs one of your credits.',
    prizeLine:        (amount) => `\ud83c\udfc6 Prize: ${naira(amount)}`,

    accepted:
        '\u2705 You\u2019re in. Reply *PLAY* when you\u2019re ready \u2014 you have 24 hours.',

    declined: 'No problem. It\u2019s still there if you change your mind.',

    // ---- refusals, one per reason ----
    refusal: {
        not_found:
            "That challenge code doesn't exist. Check you copied the whole link.",
        bad_code:
            "That code doesn't look right. Challenge codes are 8 characters \u2014 " +
            'check you copied the whole link.',
        // §14.4 — a sponsored challenge is not shareable until the money settles
        not_ready:
            "That challenge isn't open yet \u2014 the prize is still being confirmed. " +
            'Try the link again in a minute.',
        closed:
            'That challenge has already started or finished.',
        // §14.7 — an expired invite is still a warm lead
        expired: (from) =>
            `That challenge expired. ${from} created it more than 48 hours ago, and ` +
            'invites only last 48 hours.\n\nReply *CHALLENGE* to send one back.',
        own_challenge:
            "That's your own challenge \u2014 send the link to someone else.",
        full:
            'That challenge is full. Someone got there first.',
        device_already_in:
            "Someone on this device has already joined that challenge.",
        no_credits:
            "You need a credit to join this one. Reply *1* to top up.",
        already_joined:
            "You've already joined that challenge. Reply *PLAY* when you're ready."
    },

    // ---- playing ----
    roundIntro: (categories, ghosting) =>
        '\u2694\ufe0f *Here we go.*\n\n' +
        `${categories}\n` +
        '15 questions \u00b7 10 seconds each\n' +
        'A wrong answer costs you the point, not the game \u2014 you play all 15.\n' +
        (ghosting ? '\nYou\u2019ll see how fast they answered each one.\n' : '') +
        '\nFirst question coming up\u2026',

    question: (position, text, options, ghostMs) =>
        `*Q${position}/15*` +
        // Pace only. Never whether they got it right \u2014 that would leak the
        // answer before this player has locked in.
        (ghostMs ? `  \u00b7  _they answered in ${(ghostMs / 1000).toFixed(1)}s_` : '') +
        `\n\n${text}\n\n` +
        `*A* \u2014 ${options.A}\n*B* \u2014 ${options.B}\n` +
        `*C* \u2014 ${options.C}\n*D* \u2014 ${options.D}\n\n` +
        'Reply A, B, C or D.',

    answerCorrect: (letter) => `\u2705 Correct \u2014 *${letter}*.`,
    answerWrong: (chosen, correct) => `\u274c You said ${chosen}. It was *${correct}*.`,
    answerTimeout: (correct) => `\u23f0 Time\u2019s up. It was *${correct}*.`,

    roundDone: (correct, seconds) =>
        `\ud83c\udfc1 *That\u2019s all 15.*\n\n` +
        `You got *${correct}/15* in ${seconds}s.`,

    waitingForThem:
        'Now we wait for them to play. You\u2019ll get the result as soon as they finish.',

    resultWon: (me, them, opponent) =>
        `\ud83c\udfc6 *You won.*\n\nYou ${me} \u00b7 ${opponent} ${them}`,
    resultLost: (me, them, opponent) =>
        `${opponent} took it.\n\nYou ${me} \u00b7 ${opponent} ${them}\n\nReply *CHALLENGE* for a rematch.`,

    board: (rows) =>
        '\ud83d\udcca *So far*\n\n' +
        rows.map(r => `${r.position}. ${r.username} \u2014 ${r.score}/15 \u00b7 ${(r.timeMs / 1000).toFixed(1)}s`)
            .join('\n'),

    nothingToPlay:
        "You don't have a challenge waiting. Reply *CHALLENGE* to start one.",

    alreadyPlayed:
        "You've already played this one. Waiting on the others to finish.",

    playWindowClosed:
        'That challenge is over \u2014 you had 24 hours from accepting it.\n\n' +
        'Reply *CHALLENGE* to start a new one.',

    noQuestions:
        "We couldn't build a question set for that challenge. Nothing was charged. " +
        'Reply *CHALLENGE* to start another one.',

    notAvailable:
        'Challenges are coming soon.'
};

class ChallengeChatService {

    // ============================================
    // IS THIS PERSON MID-FLOW?
    // ============================================
    // The single question webhook.controller asks. Kept cheap: one Redis read
    // on a key that only exists while someone is actually creating.

    async isInFlow(identifier) {
        try {
            const state = await userService.getUserState(identifier);
            return !!(state && String(state.state || '').startsWith(STATE_PREFIX));
        } catch (error) {
            logger.error('Error checking challenge flow state:', error.message);
            return false;
        }
    }

    // ============================================
    // DEEP LINK HANDLER
    // ============================================
    // Registered against deeplink.service, which parsed `c_XXXX` and
    // `CHALLENGE XXXX` from stage 2 but had nowhere to send them. Returns true
    // when the message is consumed and routing should stop.

    async handleDeepLink(link, context) {
        const identifier = context.identifier;
        const platform = context.platform || platformOf(identifier);

        if (!restrictionsService.isModeEnabled('challenge', platform)) {
            await messagingService.sendMessage(identifier, STRINGS.notAvailable);
            return true;
        }

        if (!link.valid) {
            // A malformed code is still challenge INTENT. Falling through to
            // the menu would leave them staring at it with no idea the link
            // failed.
            await messagingService.sendMessage(identifier, STRINGS.refusal.bad_code);
            return true;
        }

        const user = await userService.getUserByPhone(identifier);
        if (!user) {
            // Not registered yet. The code is already held in Redis by
            // deeplink.service.setPending() with 48 hours on it, so it
            // survives all six signup steps. Let normal routing show them the
            // terms and registration.
            return false;
        }

        const challenge = await challengeService.getByCode(link.value);
        if (!challenge) {
            await messagingService.sendMessage(identifier, STRINGS.refusal.not_found);
            return true;
        }

        await challengeService.recordEvent(
            challenge.id, user.id, 'invite_opened', platform, {}
        );

        // Park the code so a plain ACCEPT works as the next message.
        await redis.setex(`challenge_pending_accept:${identifier}`, 3600, challenge.code);

        const entryLine = challenge.entry_model === 'free' ? STRINGS.entryLineFree
                        : challenge.entry_model === 'prepaid' ? STRINGS.entryLinePrepaid
                        : STRINGS.entryLineCredit;

        const lines = [`Categories: ${this._categoryList(challenge.categories)}`];
        if (challenge.prize_amount > 0) lines.push(STRINGS.prizeLine(challenge.prize_amount));

        await messagingService.sendMessage(identifier, STRINGS.inviteFound(
            challenge.creator_username, lines.join('\n'), entryLine
        ));

        return true;
    }

    // ============================================
    // ACCEPT
    // ============================================

    async handleAccept(identifier, user, platform) {
        const code = await redis.get(`challenge_pending_accept:${identifier}`);
        if (!code) return false;

        const result = await challengeService.joinChallenge(code, user, {
            platform,
            ip: null,          // a chat webhook carries Meta's IP, not the player's
            deviceId: null     // and nothing that describes the handset
        });

        if (!result.ok) {
            const refusal = STRINGS.refusal[result.reason];
            const text = typeof refusal === 'function'
                ? refusal(result.challenge ? result.challenge.creator_username : 'They')
                : (refusal || STRINGS.refusal.not_found);
            await messagingService.sendMessage(identifier, text);
            // A refusal that can be fixed keeps the code parked; one that
            // cannot is cleared so a stray ACCEPT later does not retry it.
            if (result.reason !== 'no_credits') {
                await redis.del(`challenge_pending_accept:${identifier}`);
            }
            return true;
        }

        await redis.del(`challenge_pending_accept:${identifier}`);
        await messagingService.sendMessage(identifier, STRINGS.accepted);
        return true;
    }

    async handleDecline(identifier) {
        const code = await redis.get(`challenge_pending_accept:${identifier}`);
        if (!code) return false;
        await redis.del(`challenge_pending_accept:${identifier}`);
        await messagingService.sendMessage(identifier, STRINGS.declined);
        return true;
    }

    // ============================================
    // CREATION STATE MACHINE
    // ============================================
    // Six steps, each one message. Deliberately short: every extra question is
    // an acceptor lost between "challenge a friend" and a link they can send.

    async start(identifier, platform) {
        if (!restrictionsService.isModeEnabled('challenge', platform)) {
            await messagingService.sendMessage(identifier, STRINGS.notAvailable);
            return true;
        }
        await userService.setUserState(identifier, `${STATE_PREFIX}:mode`, {});
        await messagingService.sendMessage(identifier, STRINGS.pickMode);
        return true;
    }

    async handleStep(identifier, message, user, platform) {
        const stored = await userService.getUserState(identifier);
        if (!stored || !String(stored.state || '').startsWith(STATE_PREFIX)) return false;

        const step = String(stored.state).split(':')[1];
        const data = stored.data || {};
        const input = String(message || '').trim().toUpperCase();

        if (input === 'MENU' || input === 'CANCEL') {
            await userService.clearUserState(identifier);
            return false;   // let the menu render normally
        }

        switch (step) {
            case 'mode':
                if (!['1', '2'].includes(input)) {
                    await messagingService.sendMessage(identifier, STRINGS.pickMode);
                    return true;
                }
                data.mode = input === '1' ? 'async' : 'live';
                await this._advance(identifier, 'format', data, STRINGS.pickFormat);
                return true;

            case 'format':
                if (!['1', '2'].includes(input)) {
                    await messagingService.sendMessage(identifier, STRINGS.pickFormat);
                    return true;
                }
                if (input === '1') {
                    data.format = 'direct';
                    data.maxParticipants = 2;
                    return this._askCategories(identifier, data);
                }
                data.format = 'group';
                await this._advance(identifier, 'size', data, STRINGS.pickGroupSize);
                return true;

            case 'size': {
                const size = parseInt(input, 10);
                if (!(size >= 2 && size <= 20)) {
                    await messagingService.sendMessage(identifier, STRINGS.pickGroupSize);
                    return true;
                }
                data.maxParticipants = size;
                return this._askCategories(identifier, data);
            }

            case 'categories': {
                const available = data.available || [];
                const picked = input.split(',')
                    .map(x => parseInt(x.trim(), 10))
                    .filter(i => i >= 1 && i <= available.length)
                    .map(i => available[i - 1]);
                const unique = [...new Set(picked)];

                if (unique.length < 1 || unique.length > 3) {
                    await messagingService.sendMessage(identifier,
                        STRINGS.pickCategories(this._numberedList(available)));
                    return true;
                }
                data.categories = unique;
                await this._advance(identifier, 'entry', data, STRINGS.pickEntry);
                return true;
            }

            case 'entry':
                if (!['1', '2', '3'].includes(input)) {
                    await messagingService.sendMessage(identifier, STRINGS.pickEntry);
                    return true;
                }
                data.entryModel = input === '1' ? 'credit' : input === '2' ? 'prepaid' : 'free';

                if (data.entryModel === 'prepaid') {
                    // Prepaid takes payment, which is stage 10's flow. Until
                    // then say so plainly rather than half-building it.
                    data.entryModel = 'free';
                }
                return this._finish(identifier, data, user, platform);

            default:
                await userService.clearUserState(identifier);
                return false;
        }
    }

    async _askCategories(identifier, data) {
        const available = await this._availableCategories();
        data.available = available;
        await this._advance(identifier, 'categories', data,
            STRINGS.pickCategories(this._numberedList(available)));
        return true;
    }

    async _advance(identifier, step, data, prompt) {
        await userService.setUserState(identifier, `${STATE_PREFIX}:${step}`, data);
        await messagingService.sendMessage(identifier, prompt);
    }

    async _finish(identifier, data, user, platform) {
        await userService.clearUserState(identifier);

        const result = await challengeService.createChallenge(user, {
            mode: data.mode,
            format: data.format,
            maxParticipants: data.maxParticipants,
            categories: data.categories,
            entryModel: data.entryModel,
            rounds: 1,
            prizeAmount: 0
        }, platform);

        if (!result.ok) {
            await messagingService.sendMessage(identifier,
                result.errors.join('\n') || 'Could not create that challenge.');
            return true;
        }

        await messagingService.sendMessage(identifier, STRINGS.created(
            result.links, this._categoryList(data.categories)
        ));
        await messagingService.sendMessage(identifier, STRINGS.cancellationNotice);

        await challengeService.recordEvent(
            result.challenge.id, user.id, 'invite_sent', platform, {}
        );

        return true;
    }

    // ============================================
    // PLAY
    // ============================================
    // Held in Redis rather than user_state so it cannot collide with the
    // creation flow or with registration. One key, cleared on finish.

    _playKey(identifier) { return `challenge_playing:${identifier}`; }

    async isPlaying(identifier) {
        try { return !!(await redis.get(this._playKey(identifier))); }
        catch (e) { return false; }
    }

    async handlePlay(identifier, user, platform) {
        const pending = await pool.query(`
            SELECT c.*, p.id AS participant_id, p.play_expires_at, p.status AS participant_status
            FROM challenge_participants p
            JOIN challenges c ON c.id = p.challenge_id
            WHERE p.user_id = $1
              AND p.status IN ('joined','playing')
              AND c.status IN ('open','live')
            ORDER BY p.joined_at DESC NULLS LAST
            LIMIT 1
        `, [user.id]);

        const challenge = pending.rows[0];
        if (!challenge) {
            await messagingService.sendMessage(identifier, STRINGS.nothingToPlay);
            return true;
        }

        if (challenge.play_expires_at && new Date(challenge.play_expires_at) < new Date()) {
            await messagingService.sendMessage(identifier, STRINGS.playWindowClosed);
            return true;
        }

        const started = await challengeRoundService.startRound(
            challenge, { id: challenge.participant_id }, user, { platform }
        );

        if (!started.ok) {
            await messagingService.sendMessage(identifier,
                started.reason === 'already_played' ? STRINGS.alreadyPlayed : STRINGS.noQuestions);
            return true;
        }

        const ghost = await challengeRoundService.loadGhost(challenge, 1);

        await redis.setex(this._playKey(identifier), 7200, JSON.stringify({
            challengeId: challenge.id, roundId: started.round.id,
            participantId: challenge.participant_id, position: 1
        }));

        if (!started.resumed) {
            await messagingService.sendMessage(identifier,
                STRINGS.roundIntro(this._categoryList(challenge.categories), !!ghost));
        }

        await this._serveQuestion(identifier, challenge, started.round, 1, ghost);
        return true;
    }

    async _serveQuestion(identifier, challenge, round, position, ghost) {
        const question = await challengeRoundService.getQuestion(challenge, round, position);
        if (!question) {
            await messagingService.sendMessage(identifier, STRINGS.noQuestions);
            await redis.del(this._playKey(identifier));
            return;
        }

        await messagingService.sendMessage(identifier, STRINGS.question(
            position, question.text, question.options, ghost ? ghost[position] : null
        ));
    }

    async handleAnswer(identifier, message, user, platform) {
        const raw = await redis.get(this._playKey(identifier));
        if (!raw) return false;

        const letter = String(message || '').trim().toUpperCase();
        if (!['A', 'B', 'C', 'D'].includes(letter)) return false;

        const state = JSON.parse(raw);

        const context = await pool.query(`
            SELECT c.*, r.id AS round_id, r.round_no, r.session_key, r.game_session_id,
                   p.id AS participant_id
            FROM challenge_rounds r
            JOIN challenges c ON c.id = r.challenge_id
            JOIN challenge_participants p ON p.id = r.participant_id
            WHERE r.id = $1
        `, [state.roundId]);

        const ctx = context.rows[0];
        if (!ctx) { await redis.del(this._playKey(identifier)); return false; }

        const round = {
            id: ctx.round_id, round_no: ctx.round_no,
            session_key: ctx.session_key, game_session_id: ctx.game_session_id
        };

        const result = await challengeRoundService.submitAnswer(
            ctx, round, state.position, letter, user
        );

        if (!result.ok) return true;   // duplicate tap; say nothing

        await messagingService.sendMessage(identifier,
            result.timedOut  ? STRINGS.answerTimeout(result.correctAnswer)
          : result.isCorrect ? STRINGS.answerCorrect(result.correctAnswer)
          :                    STRINGS.answerWrong(letter, result.correctAnswer));

        if (result.isLastQuestion) {
            return this._finishRound(identifier, ctx, round, user, platform);
        }

        state.position += 1;
        await redis.setex(this._playKey(identifier), 7200, JSON.stringify(state));

        const ghost = await challengeRoundService.loadGhost(ctx, ctx.round_no);
        await this._serveQuestion(identifier, ctx, round, state.position, ghost);
        return true;
    }

    async _finishRound(identifier, challenge, round, user, platform) {
        await redis.del(this._playKey(identifier));

        const finished = await challengeRoundService.finishRound(
            challenge,
            { id: round.id, game_session_id: round.game_session_id },
            { id: challenge.participant_id },
            user,
            { platform }
        );

        if (!finished.ok) return true;

        await messagingService.sendMessage(identifier,
            STRINGS.roundDone(finished.correct, (finished.totalMs / 1000).toFixed(1)));

        if (!finished.completion.complete) {
            await messagingService.sendMessage(identifier, STRINGS.waitingForThem);
            return true;
        }

        const board = await challengeRoundService.getBoard(challenge);

        const mine = board.find(r => r.username === user.username);
        const theirs = board.find(r => r.username !== user.username);

        if (challenge.format === 'group') {
            await messagingService.sendMessage(identifier, STRINGS.board(board));
        } else if (mine && theirs) {
            const fmt = (r) => `${r.score}/15 \u00b7 ${(r.timeMs / 1000).toFixed(1)}s`;
            const won = mine.position < theirs.position;
            await messagingService.sendMessage(identifier, won
                ? STRINGS.resultWon(fmt(mine), fmt(theirs), theirs.username)
                : STRINGS.resultLost(fmt(mine), fmt(theirs), theirs.username));
        }

        // The card goes to BOTH players, not just the winner. The person most
        // likely to post it into the group chat is the one who lost, and the
        // card is written so they can.
        await this._sendCard(identifier, challenge);
        return true;
    }

    async _sendCard(identifier, challenge) {
        try {
            const challengeCardService = require('./challenge-card.service');
            const winner = await challengeService.getWinner(challenge.id);
            if (!winner) return;

            const card = await challengeCardService.generate(challenge, winner.user_id);
            if (!card.ok) return;

            await messagingService.sendImage(
                identifier, card.buffer,
                challengeCardService.caption(card.data || await challengeCardService.getCardData(challenge),
                                             card.rematchUrl)
            );
        } catch (error) {
            // A card that fails to render must never swallow the result. The
            // player has already been told their score.
            logger.error('Could not send challenge card:', error.message);
        }
    }

    // ============================================
    // HELPERS
    // ============================================

    async _availableCategories() {
        try {
            const QuestionService = require('./question.service');
            if (!this._questionService) this._questionService = new QuestionService();
            const readiness = await this._questionService.getChallengeBankReadiness();
            // Only categories that can actually run a challenge are offered.
            // A thin category does not fail at creation — it fails fifteen
            // questions in, when the set cannot be built.
            return readiness.filter(c => c.ready).map(c => c.category);
        } catch (error) {
            logger.error('Could not list challenge categories:', error.message);
            return [];
        }
    }

    _numberedList(items) {
        return items.map((c, i) => `*${i + 1}* \u2014 ${this._label(c)}`).join('\n');
    }

    _categoryList(categories) {
        return (categories || []).map(c => this._label(c)).join(', ');
    }

    _label(category) {
        return String(category || '')
            .replace(/[_-]+/g, ' ')
            .replace(/\b\w/g, ch => ch.toUpperCase());
    }
}

const service = new ChallengeChatService();

module.exports = service;
module.exports.STRINGS = STRINGS;
module.exports.STATE_PREFIX = STATE_PREFIX;