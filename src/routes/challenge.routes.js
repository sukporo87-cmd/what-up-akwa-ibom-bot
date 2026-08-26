// ============================================
// FILE: src/routes/challenge.routes.js
// Mount in server.js:  app.use('/challenge', require('./routes/challenge.routes'));
//
// Route names checked against every existing router before writing: nothing
// registers /challenge, and `challenge` appears elsewhere in the codebase only
// inside photo_verifications.challenge_type, which is a different thing
// entirely. Express matches the first registration, and a duplicate has
// already silently served the wrong payload on this project once.
// ============================================

const express = require('express');
const router = express.Router();

const challengeService = require('../services/challenge.service');
const webAuthService = require('../services/web-auth.service');
const challengeRoundService = require('../services/challenge-round.service');
const challengeCardService = require('../services/challenge-card.service');
const challengeSponsorshipService = require('../services/challenge-sponsorship.service');
const challengeArenaService = require('../services/challenge-arena.service');
const deepLinkService = require('../services/deeplink.service');
const restrictionsService = require('../services/restrictions.service');
const { logger } = require('../utils/logger');

const webAuthRoutes = require('./web-auth.routes');
const { requireWebAuth, requireCompleteProfile, getToken } = webAuthRoutes;
const challengeAuthService = require('../services/challenge-auth.service');

// ============================================
// requireChallengeAuth
// ============================================
// Accepts EITHER a normal web login OR a challenge-scoped session — and a
// scoped session only on the challenge it was minted for.
//
// The scope check compares against req.params.code, so a code obtained for one
// challenge cannot be replayed against another. That was the explicit ruling:
// a chat user with several invites uses each link with its own code.
async function requireChallengeAuth(req, res, next) {
    try {
        const ctx = await webAuthService.getSessionContext(getToken(req));
        if (!ctx) {
            return res.status(401).json({ success: false, error: 'Not signed in' });
        }

        if (ctx.scope) {
            const wanted = String(req.params.code || '').toUpperCase();
            if (ctx.scope.type !== 'challenge' || String(ctx.scope.code).toUpperCase() !== wanted) {
                return res.status(403).json({
                    success: false,
                    reason: 'wrong_challenge',
                    error: 'That code was for a different challenge.'
                });
            }
        }

        req.webUser = ctx.user;
        req.webSession = ctx;
        next();
    } catch (error) {
        logger.error('Challenge auth middleware failed:', error);
        return res.status(500).json({ success: false, error: 'Could not verify that session' });
    }
}

function clientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress
        || null;
}

// The kill switch. `challenge` is a real mode in system_toggles, so the whole
// feature can be taken down per platform from /admin/toggles with no deploy —
// which is also how it stays off until the question bank clears the readiness
// gate.
function requireChallengesEnabled(req, res, next) {
    if (!restrictionsService.isModeEnabled('challenge', 'web')) {
        // Uses the same accessor every other mode uses, so an admin who writes
        // a message against the toggle sees it here too rather than a generic
        // string this file invented.
        return res.status(503).json({
            success: false,
            error: restrictionsService.getModeDisabledMessage('challenge', 'web')
        });
    }
    next();
}

// ============================================
// POST /challenge  — create
// ============================================
router.post('/', requireWebAuth, requireCompleteProfile, requireChallengesEnabled, async (req, res) => {
    try {
        const result = await challengeService.createChallenge(req.webUser, req.body || {}, 'web');

        if (!result.ok) {
            return res.status(400).json({ success: false, errors: result.errors });
        }

        res.json({
            success: true,
            code: result.challenge.code,
            status: result.challenge.status,
            links: result.links,
            // False while a sponsorship is still settling. The client must not
            // show a link that would be dead for whoever it is sent to.
            shareable: result.shareable,
            inviteExpiresAt: result.challenge.invite_expires_at
        });
    } catch (error) {
        logger.error('Error creating challenge:', error);
        res.status(500).json({ success: false, error: 'Could not create that challenge' });
    }
});

// ============================================
// GET /challenge/:code  — what a link resolves to
// ============================================
// Deliberately NOT behind requireWebAuth: this is what a first-time invitee
// hits before they have an account, and it has to tell them what they were
// invited to. It returns nothing that is not already in the invite message.
// ============================================
// GET /challenge/mine  — the player's own challenges
// ============================================
// Registered BEFORE /:code. Express matches the first registration, so with
// the order reversed this would be read as a challenge whose code is "mine".
router.get('/mine', requireWebAuth, async (req, res) => {
    try {
        const challenges = await challengeService.listForUser(req.webUser.id);
        res.json({
            success: true,
            challenges,
            // Surfaced separately so the hub can badge the tab without the
            // client re-deriving the rule.
            waitingForYou: challenges.filter(c => c.waitingForYou).length
        });
    } catch (error) {
        logger.error('Error listing challenges for user:', error);
        res.status(500).json({ success: false, error: 'Could not load your challenges' });
    }
});

router.get('/:code', async (req, res) => {
    try {
        const code = String(req.params.code || '').toUpperCase();
        if (!deepLinkService.isValidCode(code)) {
            return res.status(404).json({ success: false, error: 'not_found' });
        }

        const challenge = await challengeService.getByCode(code);
        if (!challenge) {
            return res.status(404).json({ success: false, error: 'not_found' });
        }

        const expired = new Date(challenge.invite_expires_at).getTime() < Date.now();

        // Optional auth. This endpoint stays open — a first-time invitee has no
        // account yet and still needs to see what they were invited to — but if
        // a token happens to be present we can tell them whether they have
        // already joined, so the button reads "Play now" instead of "Accept".
        let joined = false;
        let isInitiator = false;
        try {
            const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            if (token) {
                // getSessionUser() is the method requireWebAuth itself uses
                // (web-auth.routes.js:68) and returns the user directly.
                const sessionUser = await webAuthService.getSessionUser(token);
                if (sessionUser && sessionUser.id) {
                    joined = !!(await challengeService.getParticipant(challenge.id, sessionUser.id));
                    isInitiator = sessionUser.id === challenge.creator_user_id;
                }
            }
        } catch (e) {
            // An invalid token must not turn a public page into an error.
        }

        res.json({
            success: true,
            challenge: {
                code: challenge.code,
                createdBy: challenge.creator_username,
                mode: challenge.mode,
                format: challenge.format,
                rounds: challenge.rounds,
                categories: challenge.categories,
                entryModel: challenge.entry_model,
                prizeAmount: challenge.prize_amount,
                participants: challenge.participant_count,
                maxParticipants: challenge.max_participants,
                scheduledStartAt: challenge.scheduled_start_at,
                inviteExpiresAt: challenge.invite_expires_at,
                // 'awaiting_sponsorship' is deliberately surfaced as its own
                // state so the client can say "not ready yet" rather than
                // "expired", which would be a lie.
                joined,
                isInitiator,
                status: expired && challenge.status === 'open' ? 'expired' : challenge.status
            }
        });
    } catch (error) {
        logger.error('Error loading challenge:', error);
        res.status(500).json({ success: false, error: 'Could not load that challenge' });
    }
});

// ============================================
// POST /challenge/:code/join
// ============================================
router.post('/:code/join', requireChallengeAuth, requireChallengesEnabled, async (req, res) => {
    try {
        const code = String(req.params.code || '').toUpperCase();

        const result = await challengeService.joinChallenge(code, req.webUser, {
            platform: 'web',
            ip: clientIp(req),
            deviceId: req.webUser.primary_device_id || null
        });

        if (!result.ok) {
            // Every refusal names itself. "You cannot join" with no reason is
            // the most annoying thing an invite link can do.
            const status = result.reason === 'not_found' ? 404
                         : result.reason === 'no_credits' ? 402
                         : 409;
            return res.status(status).json({ success: false, reason: result.reason });
        }

        res.json({
            success: true,
            code,
            entryMethod: result.entryMethod,
            creditUsed: result.creditConsumed
        });
    } catch (error) {
        logger.error('Error joining challenge:', error);
        res.status(500).json({ success: false, error: 'Could not join that challenge' });
    }
});

// ============================================
// POST /challenge/:code/start  — begin a round
// ============================================
// The question set is materialised on the FIRST start, not at creation, so the
// second player cannot read the answers early.
router.post('/:code/start', requireChallengeAuth, requireChallengesEnabled, async (req, res) => {
    try {
        const code = String(req.params.code || '').toUpperCase();
        const challenge = await challengeService.getByCode(code);
        if (!challenge) return res.status(404).json({ success: false, reason: 'not_found' });

        const participant = await challengeService.getParticipant(challenge.id, req.webUser.id);
        if (!participant) return res.status(403).json({ success: false, reason: 'not_a_participant' });

        const started = await challengeRoundService.startRound(challenge, participant, req.webUser, {
            platform: 'web',
            ip: clientIp(req),
            deviceId: req.webUser.primary_device_id || null
        });

        if (!started.ok) {
            return res.status(409).json({ success: false, reason: started.reason });
        }

        const question = await challengeRoundService.getQuestion(challenge, started.round, 1);
        const ghost = await challengeRoundService.loadGhost(challenge, started.round.round_no);

        res.json({
            success: true,
            resumed: started.resumed,
            totalQuestions: 15,
            question: {
                position: question.position,
                text: question.text,
                options: question.options,
                timeoutMs: question.timeoutMs,
                // Pace only, never correctness — a ghost that shows whether they
                // were right is a ghost that leaks the answer.
                ghostMs: ghost ? (ghost[1] || null) : null
            }
        });
    } catch (error) {
        logger.error('Error starting challenge round:', error);
        res.status(500).json({ success: false, error: 'Could not start that round' });
    }
});

// ============================================
// POST /challenge/:code/answer
// ============================================
router.post('/:code/answer', requireChallengeAuth, requireChallengesEnabled, async (req, res) => {
    try {
        const code = String(req.params.code || '').toUpperCase();
        const position = parseInt(req.body && req.body.position, 10);
        const chosen = String((req.body && req.body.answer) || '').toUpperCase();

        if (!(position >= 1 && position <= 15)) {
            return res.status(400).json({ success: false, reason: 'bad_position' });
        }

        const challenge = await challengeService.getByCode(code);
        if (!challenge) return res.status(404).json({ success: false, reason: 'not_found' });

        const round = await challengeService.getRoundFor(challenge.id, req.webUser.id);
        if (!round) return res.status(409).json({ success: false, reason: 'no_round' });

        const result = await challengeRoundService.submitAnswer(
            challenge, round, position, chosen, req.webUser
        );
        if (!result.ok) return res.status(409).json({ success: false, reason: result.reason });

        if (result.isLastQuestion) {
            const participant = await challengeService.getParticipant(challenge.id, req.webUser.id);
            const finished = await challengeRoundService.finishRound(
                challenge, round, participant, req.webUser, { platform: 'web' }
            );
            return res.json({
                success: true,
                isCorrect: result.isCorrect,
                timedOut: result.timedOut,
                correctAnswer: result.correctAnswer,
                finished: true,
                score: finished.ok ? finished.correct : null,
                totalMs: finished.ok ? finished.totalMs : null,
                challengeComplete: finished.ok ? finished.completion.complete : false
            });
        }

        const next = await challengeRoundService.getQuestion(challenge, round, position + 1);
        const ghost = await challengeRoundService.loadGhost(challenge, round.round_no);

        res.json({
            success: true,
            isCorrect: result.isCorrect,
            timedOut: result.timedOut,
            correctAnswer: result.correctAnswer,
            finished: false,
            question: next ? {
                position: next.position,
                text: next.text,
                options: next.options,
                timeoutMs: next.timeoutMs,
                ghostMs: ghost ? (ghost[next.position] || null) : null
            } : null
        });
    } catch (error) {
        logger.error('Error submitting challenge answer:', error);
        res.status(500).json({ success: false, error: 'Could not record that answer' });
    }
});

// ============================================
// GET /challenge/:code/board
// ============================================
// The running leaderboard for group async: everyone who has FINISHED, not the
// leader's ghost. Racing the leader from fifth place is demoralising and gives
// different players a different experience of the same challenge.
router.get('/:code/board', async (req, res) => {
    try {
        const code = String(req.params.code || '').toUpperCase();
        const challenge = await challengeService.getByCode(code);
        if (!challenge) return res.status(404).json({ success: false, reason: 'not_found' });

        res.json({ success: true, board: await challengeRoundService.getBoard(challenge) });
    } catch (error) {
        logger.error('Error loading challenge board:', error);
        res.status(500).json({ success: false, error: 'Could not load the leaderboard' });
    }
});

// ============================================
// GET /challenge/:code/card  — the result card as a PNG
// ============================================
// Open, like GET /:code. A card is meant to be shared, and requiring a login
// to view one would break the only link in the growth loop that reaches people
// who have never played.
router.get('/:code/card', async (req, res) => {
    try {
        const code = String(req.params.code || '').toUpperCase();
        const challenge = await challengeService.getByCode(code);
        if (!challenge) return res.status(404).json({ success: false, reason: 'not_found' });

        const winner = await challengeService.getWinner(challenge.id);
        if (!winner) return res.status(409).json({ success: false, reason: 'not_complete' });

        const card = await challengeCardService.generate(challenge, winner.user_id);
        if (!card.ok) return res.status(409).json({ success: false, reason: card.reason });

        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(card.buffer);
    } catch (error) {
        logger.error('Error generating challenge card:', error);
        res.status(500).json({ success: false, error: 'Could not build that card' });
    }
});

// ============================================
// POST /challenge/:code/sponsor
// ============================================
// Starts the payment for a sponsored prize. It does NOT open the challenge —
// only the gateway webhook does that. The client polls or waits for the
// message, exactly like credit tokens.
router.post('/:code/sponsor', requireWebAuth, requireChallengesEnabled, async (req, res) => {
    try {
        const code = String(req.params.code || '').toUpperCase();
        const challenge = await challengeService.getByCode(code);
        if (!challenge) return res.status(404).json({ success: false, reason: 'not_found' });

        const result = await challengeSponsorshipService.initiate(
            challenge, req.webUser, 'web',
            req.body ? req.body.gateway : null
        );

        if (!result.ok) {
            return res.status(409).json({ success: false, reason: result.reason });
        }

        res.json({
            success: true,
            reference: result.reference,
            authorizationUrl: result.authorizationUrl,
            gateway: result.gateway
        });
    } catch (error) {
        logger.error('Error initiating challenge sponsorship:', error);
        res.status(500).json({ success: false, error: 'Could not start that payment' });
    }
});

// ============================================
// LIVE ARENA
// ============================================
// All of this rides the EXISTING SSE stream at /web/game/stream. No new
// connection, no WebSockets. These endpoints only push players into a room and
// take their answers; everything the client renders arrives as SSE events.

router.post('/:code/lobby', requireChallengeAuth, requireChallengesEnabled, async (req, res) => {
    try {
        const code = String(req.params.code || '').toUpperCase();
        const challenge = await challengeService.getByCode(code);
        if (!challenge) return res.status(404).json({ success: false, reason: 'not_found' });

        const participant = await challengeService.getParticipant(challenge.id, req.webUser.id);
        if (!participant) return res.status(403).json({ success: false, reason: 'not_a_participant' });

        const result = await challengeArenaService.joinLobby(challenge, req.webUser);
        if (!result.ok) return res.status(409).json({ success: false, ...result });

        // startsAt is an absolute epoch time, sent ONCE. The browser counts
        // down locally — a per-second frame would be 600 frames per player in
        // a ten-minute lobby.
        res.json({ success: true, startsAt: result.startsAt, present: result.present });
    } catch (error) {
        logger.error('Error joining challenge lobby:', error);
        res.status(500).json({ success: false, error: 'Could not join that lobby' });
    }
});

router.post('/:code/lobby/leave', requireChallengeAuth, async (req, res) => {
    try {
        const challenge = await challengeService.getByCode(String(req.params.code || '').toUpperCase());
        if (challenge) challengeArenaService.leaveLobby(challenge.id, req.webUser.id);
        res.json({ success: true });
    } catch (error) {
        res.json({ success: true });   // leaving must never fail loudly
    }
});

// The initiator's "wait +5 min or start now" decision. If they never answer,
// the match auto-starts after the grace period — nineteen people must not be
// held up by one dead battery.
router.post('/:code/lobby/extend', requireChallengeAuth, requireChallengesEnabled, async (req, res) => {
    try {
        const challenge = await challengeService.getByCode(String(req.params.code || '').toUpperCase());
        if (!challenge) return res.status(404).json({ success: false, reason: 'not_found' });

        const result = await challengeArenaService.extend(challenge, req.webUser.id);
        if (!result.ok) return res.status(409).json({ success: false, reason: result.reason });

        res.json({ success: true, startsAt: result.startsAt });
    } catch (error) {
        logger.error('Error extending challenge lobby:', error);
        res.status(500).json({ success: false, error: 'Could not extend' });
    }
});

router.post('/:code/lobby/start', requireChallengeAuth, requireChallengesEnabled, async (req, res) => {
    try {
        const challenge = await challengeService.getByCode(String(req.params.code || '').toUpperCase());
        if (!challenge) return res.status(404).json({ success: false, reason: 'not_found' });
        if (challenge.creator_user_id !== req.webUser.id) {
            return res.status(403).json({ success: false, reason: 'not_yours' });
        }

        const result = await challengeArenaService.startMatch(challenge);
        res.json({ success: !!result.ok, reason: result.reason });
    } catch (error) {
        logger.error('Error starting live challenge:', error);
        res.status(500).json({ success: false, error: 'Could not start' });
    }
});

// The answer lands here and goes NOWHERE ELSE. It is never broadcast — the
// player is told their answer is in, and the correct answer arrives for
// everyone at once in the reveal frame.
router.post('/:code/arena/answer', requireChallengeAuth, requireChallengesEnabled, async (req, res) => {
    try {
        const challenge = await challengeService.getByCode(String(req.params.code || '').toUpperCase());
        if (!challenge) return res.status(404).json({ success: false, reason: 'not_found' });

        const position = parseInt(req.body && req.body.position, 10);
        const chosen = String((req.body && req.body.answer) || '').toUpperCase();

        const result = await challengeArenaService.submitAnswer(
            challenge, req.webUser, position, chosen
        );

        if (!result.ok) return res.status(409).json({ success: false, reason: result.reason });
        res.json({ success: true, locked: true });
    } catch (error) {
        logger.error('Error submitting arena answer:', error);
        res.status(500).json({ success: false, error: 'Could not record that answer' });
    }
});

// ============================================
// CHALLENGE-SCOPED AUTH
// ============================================
// Play on web as your WhatsApp or Telegram account, without creating a web
// account. The username identifies; a code sent to that chat account proves
// ownership. The session it mints works on THIS challenge and nothing else.

router.post('/:code/auth/request', requireChallengesEnabled, async (req, res) => {
    try {
        const code = String(req.params.code || '').toUpperCase();
        const challenge = await challengeService.getByCode(code);
        if (!challenge) return res.status(404).json({ success: false, reason: 'not_found' });

        const result = await challengeAuthService.requestCode(
            challenge, req.body && req.body.username, clientIp(req)
        );

        if (!result.ok) return res.status(429).json({ success: false, reason: result.reason });

        // The SAME response whether the username exists or not. Anything else
        // turns this into a way to test which usernames are real — and
        // usernames are printed on every result card.
        res.json({
            success: true,
            sent: true,
            hint: result.hint || null,
            alreadyJoined: result.alreadyJoined || false
        });
    } catch (error) {
        logger.error('Error requesting challenge code:', error);
        res.status(500).json({ success: false, error: 'Could not send a code' });
    }
});

router.post('/:code/auth/verify', requireChallengesEnabled, async (req, res) => {
    try {
        const code = String(req.params.code || '').toUpperCase();
        const challenge = await challengeService.getByCode(code);
        if (!challenge) return res.status(404).json({ success: false, reason: 'not_found' });

        const result = await challengeAuthService.verifyCode(
            challenge,
            req.body && req.body.username,
            req.body && req.body.code,
            { ip: clientIp(req), userAgent: req.headers['user-agent'] }
        );

        if (!result.ok) {
            return res.status(401).json({
                success: false,
                reason: result.reason,
                attemptsLeft: result.attemptsLeft
            });
        }

        res.json({
            success: true,
            token: result.token,
            user: result.user,
            scopedTo: result.scopedTo
        });
    } catch (error) {
        logger.error('Error verifying challenge code:', error);
        res.status(500).json({ success: false, error: 'Could not verify that code' });
    }
});

// ============================================
// POST /challenge/:code/cancel
// ============================================
router.post('/:code/cancel', requireWebAuth, async (req, res) => {
    try {
        const code = String(req.params.code || '').toUpperCase();
        const result = await challengeService.cancelChallenge(code, req.webUser);

        if (!result.ok) {
            return res.status(result.reason === 'not_found' ? 404 : 409)
                      .json({ success: false, reason: result.reason });
        }

        res.json({ success: true });
    } catch (error) {
        logger.error('Error cancelling challenge:', error);
        res.status(500).json({ success: false, error: 'Could not cancel that challenge' });
    }
});

module.exports = router;