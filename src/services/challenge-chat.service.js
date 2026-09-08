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

// The lobby opens 10 minutes before the start, so a challenge scheduled closer
// than this has no lobby at all. Stated in the prompt AND enforced in the
// check, from one constant, so the two can never drift apart.
const MIN_LEAD_MINUTES = 10;

// Prize bounds. Matched to the validator in challenge.service so the chat flow
// cannot accept an amount that creation then rejects.
const PRIZE_MIN = 1000;
const PRIZE_MAX = 100000;

// How long a challenge round may sit half-finished before its Redis key stops
// answering for the player. Was two hours, which is far longer than any round
// takes and long enough for a stale key to hijack a completely different game.
const CHALLENGE_PLAY_TTL = 20 * 60;

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

    // Minutes from now, deliberately — NOT a clock time. A chat flow that asks
    // for "12:10" has to guess a timezone: the server runs UTC, the player is
    // on WAT, and a one-hour error means a lobby that opens after everyone has
    // given up. Minutes are unambiguous on both sides.
    // An ABSOLUTE clock time, in WAT. Minutes-from-now would be wrong: the
    // invitee reads the message later than it was sent, so "in 15 minutes"
    // means something different to each person. A wall-clock time is the one
    // thing everybody agrees on.
    //
    // Nigeria is WAT year-round with no daylight saving, so the conversion to
    // the server's UTC is a fixed one hour \u2014 no timezone database needed.
    // Two steps, not one. A single "date and time" box means every wrong entry
    // has two possible causes, and the player has to guess which half you
    // didn't understand.
    pickStartDate: (options) =>
        'What day?\n\n' + options + '\n\nReply with a number.',

    // The minimum is stated UP FRONT. Being told "that time has already gone"
    // about a time eight minutes in the future is both wrong and unfixable
    // from the player's side \u2014 they have no idea what to type instead.
    pickStartTime: (dayLabel, minMinutes) =>
        `What time on ${dayLabel}?\n\n` +
        'Reply with a time like *2:30pm* or *14:30*.\n' +
        'All times are West Africa Time (WAT).\n' +
        `_At least ${minMinutes} minutes from now \u2014 the lobby opens 5 minutes ` +
        'before the start._',

    badStartTime:
        "That doesn't look like a time. Try *2:30pm* or *14:30* \u2014 West Africa Time.",

    badStartDate: (options) =>
        'Pick a day by number.\n\n' + options,

    // ONE refusal, and it names the real constraint. The old pair guessed:
    // a time eight minutes ahead was reported as "already gone today", which
    // is false and leaves the player nothing to act on.
    startTimeTooSoon: (minMinutes, earliestLabel) =>
        `That is too soon. A live challenge needs at least ${minMinutes} minutes ` +
        'so people can reach the lobby.\n\n' +
        (earliestLabel ? `The earliest you can pick today is *${earliestLabel}*.\n\n` : '') +
        'Reply with a later time, or *MENU* to start again.',

    // The 1v1 price belongs HERE, next to the option it applies to. It was
    // appearing in the group band table as "2 players \u2014 \u20a6500", which is both
    // the wrong place and the wrong words: two players is a duel, not a group.
    pickFormat: (duelPrice) =>
        'Who are you challenging?\n\n' +
        `*1* \u2014 One friend${duelPrice ? ` \u2014 \u20a6${duelPrice.toLocaleString()}` : ''}\n` +
        '*2* \u2014 A group (up to 20)\n\n' +
        'Reply 1 or 2.',

    // In paid mode the size IS the price, so the bands are shown before the
    // number is chosen. Picking 6 and only then discovering it costs the same
    // as 10 is the kind of surprise that turns into a refund request.
    pickGroupSize: (bands) =>
        'How many players, including you?\n\n' +
        (bands
            ? bands + '\n\n' +
              '_You are charged for the band, not the exact number \u2014 6 players ' +
              'costs the same as 10._\n\n'
            : '') +
        'Reply with a number between 2 and 20.',

    pickPrize: () =>
        'Want to put up a cash prize for the winner?\n\n' +
        `Reply with an amount between *\u20a6${PRIZE_MIN.toLocaleString()}* and ` +
        `*\u20a6${PRIZE_MAX.toLocaleString()}*, or *NO* for no sponsored prize, ` +
        'just bragging rights.',

    badPrize: () =>
        `A prize has to be between \u20a6${PRIZE_MIN.toLocaleString()} and ` +
        `\u20a6${PRIZE_MAX.toLocaleString()}. Reply with an amount, or *NO* to skip it.`,

    // Stated the moment the amount is given, and again in the quote before
    // payment. A fee that first appears on an invoice is a surprise.
    // The full arithmetic, shown once, before anything is owed.
    //
    // Prize plus fee is only part of what they will pay \u2014 the setup charge is
    // the other part, and a message that names one without the other invites
    // "you said \u20a61,150" when the invoice reads \u20a61,650.
    prizeAccepted: (prize, fee, bps, setup) =>
        `\ud83c\udfc6 Prize: *\u20a6${prize.toLocaleString()}* for the winner.\n\n` +
        `We add a ${(bps / 100)}% administrative fee of \u20a6${fee.toLocaleString()}, so ` +
        `you'll pay *\u20a6${(prize + fee).toLocaleString()}* for the prize` +
        (setup ? ' in addition to the setup fee.\n\n' +
                 `\u20a6${(prize + fee).toLocaleString()} + \u20a6${setup.toLocaleString()} ` +
                 `= *\u20a6${(prize + fee + setup).toLocaleString()}*\n\n`
               : '.\n\n') +
        '_Setup and admin fees are non-refundable. If the challenge never ' +
        `completes, the \u20a6${prize.toLocaleString()} prize comes back to you in full._`,

    pickCategories: (list) =>
        'Pick up to 3 categories.\n\n' + list + '\n\n' +
        'Reply with the numbers, separated by commas \u2014 like *1,3*.',


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

    // TWO MESSAGES, and the split is the point.
    //
    // The first is FOR the challenger: what they made, and that it is their
    // turn. The second is a finished invite written to be FORWARDED \u2014 it names
    // the challenger, says what the game is, and carries a link for each
    // platform so the recipient taps the one they already play on.
    //
    // Before this, the only thing worth copying was a bare URL, which meant
    // every invite arrived with no branding and no explanation of what it was.
    // THE PRICE, ITEMISED, BEFORE PAYMENT.
    //
    // A total with no breakdown is where "why was I charged this?" comes from,
    // and the sponsor fee in particular has to be visible BEFORE the player
    // pays rather than discovered at refund time. Same money either way; only
    // one of them generates a complaint.
    quote: (q, seats) =>
        '\ud83d\udcb3 *Before you send it out*\n\n' +
        (q.setupCharge
            ? `Setup (${seats} players) \u2014 \u20a6${q.setupCharge.toLocaleString()}\n` : '') +
        (q.prizeAmount
            ? `Prize \u2014 \u20a6${q.prizeAmount.toLocaleString()}\n` +
              `Prize fee (${(q.prizeFeeBps / 100)}%) \u2014 \u20a6${q.prizeFee.toLocaleString()}\n`
            : '') +
        `\n*Total: \u20a6${q.total.toLocaleString()}*\n\n` +
        (q.prizeAmount
            ? `If nobody finishes, the \u20a6${q.prizeAmount.toLocaleString()} prize comes back to you ` +
              'in full. The setup charge and the fee do not \u2014 getting your ' +
              'friends to play is on you.\n\n'
            : 'Slots you don\u2019t fill are not refunded. Getting your friends in is on you.\n\n') +
        'Reply *PAY* to continue, or *MENU* to drop it.',

    // Sent when a paid challenge settles. Short: what was taken, the entry
    // code, and how to call it off. The invite follows as its own message.
    paymentConfirmed: (money, code, entryCode) =>
        '\u2705 *Payment confirmed.*\n\n' +
        (money.setup ? `Setup \u2014 \u20a6${money.setup.toLocaleString()}\n` : '') +
        (money.prize ? `Prize held \u2014 \u20a6${money.prize.toLocaleString()}\n` : '') +
        (money.fee ? `Fee \u2014 \u20a6${money.fee.toLocaleString()}\n` : '') +
        '\nYour invite message is below \u2014 send it to whoever you want to beat.\n\n' +
        (entryCode
            ? `\ud83d\udd11 *Your code to play: ${entryCode.split('').join(' ')}*\n\n` +
              'Open your challenge link, choose *Play as my WhatsApp or Telegram ' +
              'account*, then enter your username and this code.\n\n' +
              `It works only for this one challenge (${code}).\n` +
              "_Don't share this code \u2014 it isn't part of the invite._\n" +
              '_Reply *MY CODE* for a new one if it expires._\n\n'
            : '') +
        'You can cancel this challenge any time until someone joins. ' +
        'After that it\u2019s final \u2014 it runs, or it expires.\n' +
        '_Reply *CANCEL CHALLENGE* to cancel._',

    payLink: (url, total) =>
        `\ud83d\udcb3 *\u20a6${total.toLocaleString()}*\n\nPay here:\n${url}\n\n` +
        'Your invite link appears the moment the payment clears. ' +
        'Nothing is sent out before then.',

    pickGateway: (names, total) =>
        (total ? `\ud83d\udcb3 *\u20a6${total.toLocaleString()}*\n\n` : '') +
        'How would you like to pay?\n\n' +
        names.map((n, i) => `*${i + 1}* \u2014 ${n.charAt(0).toUpperCase() + n.slice(1)}`).join('\n') +
        `\n\nReply with a number.`,

    payFailed:
        "Couldn't start that payment. Reply *PAY* to try again.",

    alreadyPaid:
        'That one is already paid for. Reply *MYCHALLENGES* to find it.',

    // ONE message for the creator. Everything they need to act: what they
    // made, their entry code, and how to call it off.
    created: (categories, startLabel, code, entryCode, mode) =>
        '\u2705 *Challenge created.*\n' +
        '15 questions \u00b7 10 seconds each\n\n' +
        `${categories}\n\n` +
        (startLabel
            ? `\u23f0 Starts ${startLabel} \u00b7 everyone plays at once, in the browser\n\n`
            : '') +
        'The invite is below \u2014 forward it to whoever you want to beat.\n\n' +
        (entryCode
            ? '*You play in the browser too*\n' +
              `\ud83d\udd11 *Your code to play: ${entryCode.split('').join(' ')}*\n\n` +
              'Open your challenge link, choose *Play as my WhatsApp or Telegram ' +
              'account*, then enter your username and this code.\n\n' +
              `It works only for this one challenge (${code}) and expires in 10 minutes.\n` +
              "Don't share this code \u2014 it isn't part of the invite.\n" +
              'Reply *MY CODE* if it expires.\n\n'
            : (mode === 'live' ? '' :
               '*Reply PLAYCHALLENGE to set your score first* \u2014 whoever you invite ' +
               'races the pace you set.\n\n')) +
        'You can cancel this challenge any time until someone joins or pays. ' +
        'After that it\u2019s final \u2014 it runs, or it expires.\n\n' +
        '_Reply *CANCEL CHALLENGE* to call it off._',

    // The forwardable one. Deliberately self-contained: someone who receives
    // this with no context should understand what it is and how to play.
    // NAME FIRST, handle in brackets. Someone who has never used the platform
    // has no idea what @final_obongowo is, and an unexplained link from an
    // unknown handle reads as spam \u2014 which is exactly what gets it ignored.
    // `seats` is null for a 1v1. For a group it matters to the RECIPIENT: an
    // invite to a 10-player challenge is something you forward on to other
    // people, and an invite that does not say so gets treated as a duel.
    invite: (displayName, links, categories, startLabel, seats, prize) =>
        `\u2694\ufe0f *${displayName} has challenged you to a game of trivia!*\n\n` +
        "\ud83c\udfaf *What's Up Trivia*\n" +
        '15 questions \u00b7 10 seconds each \u00b7 highest score wins' +
        // The prize is the single strongest reason to accept, so it goes in
        // the headline rather than being discovered after signing up.
        (prize ? ` \u00b7 \ud83c\udfc6 *\u20a6${Number(prize).toLocaleString()} prize*` : '') +
        '\n\n' +
        `${categories}\n\n` +
        // Only for a group: a 1v1 does not need telling it is a 1v1, and an
        // invite to a 10-player challenge is something you forward on.
        (seats && seats > 2 ? `\ud83d\udc65 Up to *${seats} players*\n\n` : '') +
        (startLabel ? `\u23f0 Starts ${startLabel}\n\n` : '') +
        (startLabel
            // Live is browser-only, so listing a WhatsApp and a Telegram link
            // would be listing two dead ends.
            ? `\ud83c\udf10 *Play here:*\n${links.web}\n\n` +
              '_Everyone plays at once, in the browser. Open the link at least ' +
              '5 minutes before the start time to join the lobby._ ' +
              'The challenge starts right on time.\n\n'
            : '*Tap the link for the platform you play on:*\n\n' +
              `\ud83d\udcac WhatsApp: ${links.whatsapp}\n\n` +
              `\u2708\ufe0f Telegram: ${links.telegram}\n\n` +
              `\ud83c\udf10 Web: ${links.web}\n\n` +
              '_You have 48 hours to accept._\n\n') +
        // The recipient may have no account at all, and an invite that does not
        // say so reads as "this is not for me".
        "Don't have a What's Up Trivia account? Not an issue \u2014 tap the link, " +
        'sign up, and carry straight on into the challenge.',

    // ---- receiving an invite ----
    inviteFound: (from, categories, entryLine) =>
        `\u2694\ufe0f *${from} has challenged you to a game of trivia!*\n\n` +
        `${categories}\n` +
        '15 questions \u00b7 10 seconds each \u00b7 highest score wins\n' +
        `${entryLine}\n\n` +
        'Reply *ACCEPTCHALLENGE* to take it on, or *DECLINECHALLENGE* to pass.',

    entryLineFree:    'Free to enter.',
    entryLinePrepaid: 'They\u2019ve already paid your entry.',
    entryLineCredit:  'Costs one of your credits.',
    prizeLine:        (amount) => `\ud83c\udfc6 Prize: ${naira(amount)}`,

    // Mode-aware, because the two modes are played in different places and
    // telling a live player to "reply PLAY" sends them somewhere that cannot
    // run a lobby.
    accepted: (mode, link, startLabel) =>
        mode === 'live'
            ? '\u2705 You\u2019re in.\n\n' +
              (startLabel ? `Starts ${startLabel}.\n` : '') +
              `Everyone plays at once, in the browser. Open the lobby here:\n${link}\n\n` +
              'Reply *MY CODE* if you need your entry code.'
            : '\u2705 You\u2019re in. Reply *PLAYCHALLENGE* when you\u2019re ready \u2014 you have 24 hours.',

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
            'invites only last 48 hours.\n\nReply *NEW CHALLENGE* to send one back.',
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

    question: (position, text, options, ghostMs, fiftyAvailable) =>
        `*Q${position}/15*` +
        // Pace only. Never whether they got it right \u2014 that would leak the
        // answer before this player has locked in.
        (ghostMs ? `  \u00b7  _they answered in ${(ghostMs / 1000).toFixed(1)}s_` : '') +
        `\n\n${text}\n\n` +
        `*A* \u2014 ${options.A}\n*B* \u2014 ${options.B}\n` +
        `*C* \u2014 ${options.C}\n*D* \u2014 ${options.D}\n\n` +
        'Reply A, B, C or D.' +
        (fiftyAvailable ? '\n_or *5050* to remove two wrong answers._' : ''),

    fiftyFiftyDone: (a, b) =>
        `\u2702\ufe0f *50:50* \u2014 two wrong answers removed.\n\nIt is *${a}* or *${b}*.`,

    fiftyFiftyGone:
        "You've already used your 50:50 in this round. One per round.",

    fiftyFiftyTooLate:
        "You've already answered that one.",

    // \u00a72: the cancellation rule existed in cancelChallenge() and was never
    // told to anybody. A rule nobody can see is not a rule, it is a surprise.
    cancelHint:
        '_Reply *CANCEL CHALLENGE* to call it off \u2014 you can until someone joins._',

    cancelDone:
        '\u2705 Challenge cancelled. Nobody had joined, so nothing was charged.',

    cancelTooLate:
        "Someone has already joined, so this one has to run its course. It " +
        'expires on its own if nobody finishes.',

    flowMoved:
        'That challenge setup is out of date \u2014 we changed the questions since ' +
        'you started.\n\nReply *NEW CHALLENGE* to start again. Nothing was charged.',

    cancelDraft:
        'Stopped. Nothing was created, so nothing was charged.\n\n' +
        'Reply *NEW CHALLENGE* whenever you want to start one.',

    cancelNothing:
        "You don't have a challenge waiting to be cancelled.",

    badAnswer:
        'That is not one of the options. Reply *A*, *B*, *C* or *D* \u2014 ' +
        'or *5050* to remove two wrong answers.',

    answerCorrect: (letter) => `\u2705 Correct \u2014 *${letter}*.`,
    answerWrong: (chosen, correct) => `\u274c You said ${chosen}. It was *${correct}*.`,
    answerTimeout: (correct) => `\u23f0 Time\u2019s up. It was *${correct}*.`,

    roundDone: (correct, seconds) =>
        `\ud83c\udfc1 *That\u2019s all 15.*\n\n` +
        `You got *${correct}/15* in ${seconds}s.`,

    // Sent to the OTHER participants when someone finishes and the challenge
    // completes. Before this only the person who happened to finish last saw
    // any result at all \u2014 the initiator, who played first and generated the
    // ghost, was told nothing.
    opponentFinished: (who, categories) =>
        `\ud83c\udfc1 *${who} has finished your challenge.*\n\n${categories}\n\nHere is how it went:`,

    waitingForThem:
        'Now we wait for them to play. You\u2019ll get the result as soon as they finish.',

    // A SPONSORED WIN HAS TO SAY HOW TO GET THE MONEY.
    //
    // The prize transaction is created with payout_status 'pending' and waits
    // for the player to type CLAIM, exactly like a Classic or tournament
    // prize. Nothing was telling the winner that, so a challenge prize would
    // sit unclaimed until it was swept \u2014 the one outcome guaranteed to
    // produce a complaint.
    resultWon: (me, them, opponent, prize) =>
        `\ud83c\udfc6 *You won.*\n\nYou ${me} \u00b7 ${opponent} ${them}` +
        (prize
            ? `\n\n\ud83d\udcb0 *You've won \u20a6${Number(prize).toLocaleString()}.*\n` +
              'Reply *CLAIM* to collect it.'
            : ''),
    // The offer goes to the LOSER, because they are the one who wants another
    // go. It is an offer, not an automatic challenge: creating one unasked
    // produced rows nobody joined.
    resultLost: (me, them, opponent) =>
        `${opponent} took it.\n\nYou ${me} \u00b7 ${opponent} ${them}\n\n` +
        'Reply *REMATCH* to run it back \u2014 same categories, same length.',

    rematchCreated: (opponent, links) =>
        `\u2694\ufe0f *Rematch set.*\n\nSend this to ${opponent}:\n${links.web}\n\n` +
        'Reply *PLAYCHALLENGE* to set your score first.',

    rematchNothing:
        "You don't have a finished challenge to run back. Reply *NEW CHALLENGE* to start one.",

    groupPrizeWon: (prize) =>
        `\ud83d\udcb0 *You've won \u20a6${Number(prize).toLocaleString()}.*\nReply *CLAIM* to collect it.`,

    board: (rows) =>
        '\ud83d\udcca *So far*\n\n' +
        rows.map(r => `${r.position}. ${r.username} \u2014 ${r.score}/15 \u00b7 ${(r.timeMs / 1000).toFixed(1)}s`)
            .join('\n'),

    livePlayIsWeb: (link, startLabel) =>
        '\u2694\ufe0f *This is a live challenge* \u2014 everyone plays at the same time, ' +
        'in the browser.\n\n' +
        (startLabel ? `Starts ${startLabel}.\n` : '') +
        `Open the lobby here:\n${link}\n\n` +
        'Reply *MY CODE* if you need your entry code again.',

    whichChallenge: (list) =>
        'You have more than one challenge waiting.\n\n' +
        list.map(c => `\u2022 *${c.code}* \u2014 ${c.from} \u00b7 ${c.categories}`).join('\n') +
        '\n\nReply *PLAY <code>* \u2014 for example *PLAY ' + (list[0] ? list[0].code : 'ABCD1234') + '*.',

    nothingToPlay:
        "You don't have a challenge waiting. Reply *NEW CHALLENGE* to start one.",

    alreadyPlayed:
        "You've already played this one. Waiting on the others to finish.",

    playWindowClosed:
        'That challenge is over \u2014 you had 24 hours from accepting it.\n\n' +
        'Reply *NEW CHALLENGE* to start a new one.',

    noQuestions:
        "We couldn't build a question set for that challenge. Nothing was charged. " +
        'Reply *NEW CHALLENGE* to start another one.',

    noChallengeForCode:
        "You don't have a challenge running. Reply *NEW CHALLENGE* to start one.",

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
        // The person receiving this is the one who most needs the start time,
        // and they are reading it later than it was sent.
        if (challenge.mode === 'live' && challenge.scheduled_start_at) {
            lines.push(`\u23f0 Starts ${this.watLabel(challenge.scheduled_start_at)} \u2014 in the browser`);
        }
        if (challenge.prize_amount > 0) lines.push(STRINGS.prizeLine(challenge.prize_amount));

        await messagingService.sendMessage(identifier, STRINGS.inviteFound(
            challenge.creator_display || challenge.creator_username,
            lines.join('\n'), entryLine
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

        // Pin it. PLAYCHALLENGE plays THIS one, not whichever row happens to
        // sort first.
        try {
            await redis.setex(`challenge_active:${identifier}`, 48 * 3600, code);
        } catch (e) { /* the fallback is the single-pending case below */ }

        const deepLinkService = require('./deeplink.service');
        await messagingService.sendMessage(identifier, STRINGS.accepted(
            result.challenge.mode,
            deepLinkService.buildLinks(code).web,
            result.challenge.scheduled_start_at
                ? this.watLabel(result.challenge.scheduled_start_at) : null
        ));
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
    // REMATCH
    // ============================================
    // Same settings as the challenge they just played, created only when
    // somebody asks. A sponsored prize is never carried over \u2014 a rematch that
    // silently expects another \u20a650,000 is a bill, not a rematch.

    async handleRematch(identifier, user, platform) {
        const last = await pool.query(`
            SELECT c.*, me.rank AS my_rank
            FROM challenge_participants me
            JOIN challenges c ON c.id = me.challenge_id
            WHERE me.user_id = $1
              AND me.status = 'finished'
              AND c.status = 'completed'
            ORDER BY c.completed_at DESC NULLS LAST
            LIMIT 1
        `, [user.id]);

        const previous = last.rows[0];
        if (!previous) {
            await messagingService.sendMessage(identifier, STRINGS.rematchNothing);
            return true;
        }

        const opponentRow = await pool.query(`
            SELECT COALESCE(NULLIF(TRIM(u.full_name), '') || ' (@' || u.username || ')',
                            '@' || u.username) AS display
            FROM challenge_participants p
            JOIN users u ON u.id = p.user_id
            WHERE p.challenge_id = $1 AND p.user_id <> $2
            LIMIT 1
        `, [previous.id, user.id]);

        const created = await challengeService.createChallenge(user, {
            mode: previous.mode,
            format: previous.format,
            maxParticipants: previous.max_participants,
            categories: previous.categories,
            entryModel: 'free',
            rounds: 1,
            // Deliberately 0, unlike creation: a rematch that silently expected
            // another \u20a650,000 would be a bill, not a rematch. If they want a
            // prize on it they can put one up through a normal challenge.
            prizeAmount: 0,
            scheduledStartAt: null
        }, platform);

        if (!created.ok) {
            await messagingService.sendMessage(identifier,
                created.errors.join('\n') || 'Could not set up a rematch.');
            return true;
        }

        await messagingService.sendMessage(identifier, STRINGS.rematchCreated(
            opponentRow.rows[0] ? opponentRow.rows[0].display : 'them',
            created.links
        ));
        await messagingService.sendMessage(identifier, STRINGS.invite(
            this.displayName(user), created.links,
            this._categoryBlock(previous.categories), null,
            previous.max_participants
        ));
        return true;
    }

    // ============================================
    // PAY
    // ============================================
    // Continues a challenge that is waiting on money. Kept separate from
    // creation so a player who walks away and comes back later can still pay
    // for it rather than starting over.

    async handlePay(identifier, user, platform) {
        const code = await redis.get(`challenge_awaiting_payment:${identifier}`).catch(() => null);
        if (!code) return false;   // not waiting on anything; hand PAY back

        const challenge = await challengeService.getByCode(code);
        if (!challenge || challenge.creator_user_id !== user.id) {
            await redis.del(`challenge_awaiting_payment:${identifier}`).catch(() => {});
            return false;
        }

        if (challenge.status !== 'awaiting_sponsorship') {
            await redis.del(`challenge_awaiting_payment:${identifier}`).catch(() => {});
            await messagingService.sendMessage(identifier, STRINGS.alreadyPaid);
            return true;
        }

        // OFFER THE CHOICE when more than one gateway is live, exactly as
        // Classic and tournaments already do. Challenges were silently taking
        // the default, which meant a player whose card only works on one
        // provider had no way to reach it.
        const gatewayManager = require('./payment-gateway-manager');
        let choices = [];
        try {
            choices = await gatewayManager.getEnabledGatewaysForPicker();
        } catch (error) {
            logger.error('Could not list gateways for the challenge picker:', error.message);
        }

        if (choices.length > 1) {
            await userService.setUserState(identifier, `${STATE_PREFIX}:gateway`, {
                code: challenge.code,
                gateways: choices.map(g => g.getName())
            });
            await messagingService.sendMessage(identifier, STRINGS.pickGateway(
                choices.map(g => g.getName()),
                Number(challenge.total_charged) || 0
            ));
            return true;
        }

        return this._startPayment(identifier, challenge, user, platform, null);
    }

    /**
     * Opens the gateway and hands back the link. Split out so the picker and
     * the single-gateway path cannot drift apart.
     */
    async _startPayment(identifier, challenge, user, platform, gatewayName) {
        const challengeSponsorshipService = require('./challenge-sponsorship.service');
        const started = await challengeSponsorshipService.initiate(
            challenge, user, platform, gatewayName
        );

        if (!started.ok) {
            await messagingService.sendMessage(identifier, STRINGS.payFailed);
            return true;
        }

        const total = Number(challenge.total_charged) || 0;

        // WEB GETS A CHECKOUT SCREEN, NOT A CHAT LINK.
        //
        // On web a chat message renders in the transient prompt overlay and is
        // gone a few seconds later, so the payment link simply disappeared
        // before it could be tapped. play.html already has a checkout screen
        // that solves the popup-blocker problem by opening the tab from the
        // player's own tap; challenge payments go through the same one rather
        // than inventing a second.
        if (platform === 'web') {
            try {
                const gameEvents = require('./game-events.service');
                gameEvents.emit(user.id, 'challenge.payment', {
                    amount: total,
                    title: 'Challenge ' + challenge.code,
                    subtitle: Number(challenge.prize_amount) > 0
                        ? 'Setup, prize and fee' : 'Challenge setup',
                    gateway: started.gateway,
                    authorizationUrl: started.authorizationUrl,
                    note: 'Your invite link appears the moment the payment clears.'
                });
                return true;
            } catch (error) {
                logger.error('Could not push challenge.payment to web:', error.message);
                // Fall through to the text link rather than leaving them stuck.
            }
        }

        await messagingService.sendMessage(identifier, STRINGS.payLink(started.authorizationUrl, total));
        return true;
    }

    /**
     * Where the flow goes once the prize question is answered.
     *
     * Shared by both branches of that step so a live challenge cannot skip the
     * date question by taking the "no prize" path \u2014 which is exactly the kind
     * of gap that let live challenges reach validateCreation with no start
     * time and fall through to the main menu.
     */
    async _afterPrize(identifier, data, user, platform) {
        if (data.mode === 'live') {
            data.dayOptions = this.startDayOptions();
            await this._advance(identifier, 'startdate', data,
                STRINGS.pickStartDate(this._numberedDays(data.dayOptions)));
            return true;
        }
        return this._finish(identifier, data, user, platform);
    }

    // ============================================
    // CANCEL
    // ============================================

    async handleCancel(identifier, user, platform) {
        // A CHALLENGE BEING BUILT COUNTS AS ONE.
        //
        // Someone halfway through the questions who types CANCEL CHALLENGE
        // means "stop this", and answering "you have no challenge to cancel"
        // while they are visibly in the middle of making one reads as the bot
        // losing track. Clearing the flow IS the cancellation at that point:
        // no row exists yet, so there is nothing else to undo.
        const inFlight = await userService.getUserState(identifier);
        if (inFlight && String(inFlight.state || '').startsWith(STATE_PREFIX)) {
            await userService.clearUserState(identifier);
            await messagingService.sendMessage(identifier, STRINGS.cancelDraft);
            return true;
        }

        const open = await pool.query(`
            SELECT c.code
            FROM challenges c
            WHERE c.creator_user_id = $1
              AND c.status IN ('open', 'awaiting_sponsorship')
            ORDER BY c.created_at DESC
            LIMIT 1
        `, [user.id]);

        if (!open.rows[0]) {
            await messagingService.sendMessage(identifier, STRINGS.cancelNothing);
            return true;
        }

        const result = await challengeService.cancelChallenge(open.rows[0].code, user);
        await messagingService.sendMessage(identifier,
            result.ok ? STRINGS.cancelDone : STRINGS.cancelTooLate);
        return true;
    }

    // ============================================
    // CODE — reissue
    // ============================================
    // The code expires in ten minutes, which is right for a credential and
    // wrong for a person who put their phone down. This reissues for their
    // most recent open challenge rather than making them create a new one.

    async handleCodeRequest(identifier, user, platform) {
        const result = await pool.query(`
            SELECT c.*
            FROM challenge_participants p
            JOIN challenges c ON c.id = p.challenge_id
            WHERE p.user_id = $1
              AND c.status IN ('open', 'lobby', 'live')
            ORDER BY p.joined_at DESC NULLS LAST, c.created_at DESC
            LIMIT 1
        `, [user.id]);

        const challenge = result.rows[0];
        if (!challenge) {
            await messagingService.sendMessage(identifier, STRINGS.noChallengeForCode);
            return true;
        }

        const challengeAuthService = require('./challenge-auth.service');
        await challengeAuthService.issueCode(challenge, user);
        return true;
    }

    // ============================================
    // CREATION STATE MACHINE
    // ============================================
    // Six steps, each one message. Deliberately short: every extra question is
    // an acceptor lost between "challenge a friend" and a link they can send.

    async start(identifier, platform) {
        const enabled = restrictionsService.isModeEnabled('challenge', platform);
        logger.info(`\u2694\ufe0f CHALLENGE-START platform=${platform} modeEnabled=${enabled}`);

        if (!enabled) {
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

        // ESCAPE HATCHES. This hook sits ABOVE the RESET handler in
        // routeMessage, so without listing RESET here a player stuck
        // mid-creation could not use the one command that is supposed to work
        // from anywhere. PLAY is here for the same reason: on web-play it
        // opens Classic, and a half-finished challenge must not hold the whole
        // app hostage.
        //
        // Every one of these clears the state and returns FALSE, so normal
        // routing handles the word exactly as it would have.
        if (['MENU', 'CANCEL', 'RESET', 'RESTART', 'PLAY', 'STOP', 'HELP'].includes(input)) {
            await userService.clearUserState(identifier);
            return false;
        }

        switch (step) {
            case 'mode':
                if (!['1', '2'].includes(input)) {
                    await messagingService.sendMessage(identifier, STRINGS.pickMode);
                    return true;
                }
                data.mode = input === '1' ? 'async' : 'live';
                await this._advance(identifier, 'format', data,
                    STRINGS.pickFormat(await this._duelPrice()));
                return true;

            case 'format':
                if (!['1', '2'].includes(input)) {
                    await messagingService.sendMessage(identifier,
                        STRINGS.pickFormat(await this._duelPrice()));
                    return true;
                }
                if (input === '1') {
                    data.format = 'direct';
                    data.maxParticipants = 2;
                    return this._askCategories(identifier, data);
                }
                data.format = 'group';
                await this._advance(identifier, 'size', data,
                    STRINGS.pickGroupSize(await this._bandTable()));
                return true;

            case 'size': {
                const size = parseInt(input, 10);
                if (!(size >= 2 && size <= 20)) {
                    await messagingService.sendMessage(identifier,
                        STRINGS.pickGroupSize(await this._bandTable()));
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
                // Entry model is gone: a challenge is free or paid globally
                // now, and asking a creator to choose between three funding
                // models they no longer control was asking about a decision
                // that had already been made for them.
                await this._advance(identifier, 'prize', data, STRINGS.pickPrize());
                return true;
            }

            case 'gateway': {
                const list = data.gateways || [];
                const pick = parseInt(input, 10);
                if (!(pick >= 1 && pick <= list.length)) {
                    await messagingService.sendMessage(identifier,
                        STRINGS.pickGateway(list, 0));
                    return true;
                }
                await userService.clearUserState(identifier);
                const challengeForPay = await challengeService.getByCode(data.code);
                if (!challengeForPay) {
                    await messagingService.sendMessage(identifier, STRINGS.payFailed);
                    return true;
                }
                return this._startPayment(
                    identifier, challengeForPay, user, platform, list[pick - 1]
                );
            }

            case 'prize': {
                const raw = input.replace(/[,\s\u20a6]/g, '');

                // NO is the common answer, so it is the cheapest to type.
                if (/^(NO|NONE|SKIP|0)$/i.test(raw)) {
                    data.prizeAmount = 0;
                    return this._afterPrize(identifier, data, user, platform);
                }

                const amount = parseInt(raw, 10);
                if (!Number.isFinite(amount) || amount < PRIZE_MIN || amount > PRIZE_MAX) {
                    await messagingService.sendMessage(identifier, STRINGS.badPrize());
                    return true;
                }

                data.prizeAmount = amount;

                // THE FEE IS SHOWN HERE, before anything is owed, and again in
                // the quote before payment. A sponsor fee that first appears
                // on an invoice is a surprise; one stated twice before payment
                // is a price.
                const challengePricingService = require('./challenge-pricing.service');
                const pricingNow = await challengePricingService.getPricing();
                const fee = challengePricingService.prizeFeeFor(amount, pricingNow);

                // The setup charge for the seats they already chose, so the
                // total shown here is the total they will actually be asked
                // for.
                const setupNow = pricingNow.mode === 'paid'
                    ? challengePricingService.setupChargeFor(
                        data.maxParticipants || 2, pricingNow)
                    : 0;

                await messagingService.sendMessage(identifier, STRINGS.prizeAccepted(
                    amount, fee, pricingNow.prizeFeeBps, setupNow
                ));

                return this._afterPrize(identifier, data, user, platform);
            }

            case 'startdate': {
                const options = data.dayOptions || this.startDayOptions();
                const choice = parseInt(input, 10);

                if (!(choice >= 1 && choice <= options.length)) {
                    await messagingService.sendMessage(identifier,
                        STRINGS.badStartDate(this._numberedDays(options)));
                    return true;
                }

                data.startDayOffset = options[choice - 1].offset;
                data.startDayLabel = options[choice - 1].label;
                await this._advance(identifier, 'starttime', data,
                    STRINGS.pickStartTime(data.startDayLabel, MIN_LEAD_MINUTES));
                return true;
            }

            case 'starttime': {
                const when = this.parseWatTimeOnDay(input, data.startDayOffset);

                if (!when) {
                    await messagingService.sendMessage(identifier, STRINGS.badStartTime);
                    return true;
                }

                const leadMs = when.getTime() - Date.now();
                // The lobby opens 10 minutes before the start, so anything
                // closer than that has no lobby at all.
                if (leadMs < MIN_LEAD_MINUTES * 60000) {
                    // Say what WOULD work, rounded up to the next five minutes.
                    // A refusal that does not tell you what to type instead is
                    // a dead end.
                    const earliest = new Date(Date.now() + MIN_LEAD_MINUTES * 60000);
                    earliest.setUTCSeconds(0, 0);
                    earliest.setUTCMinutes(Math.ceil(earliest.getUTCMinutes() / 5) * 5);

                    await messagingService.sendMessage(identifier,
                        STRINGS.startTimeTooSoon(
                            MIN_LEAD_MINUTES,
                            data.startDayOffset === 0 ? this.watLabel(earliest) : null
                        ));
                    return true;
                }

                data.scheduledStartAt = when.toISOString();
                return this._finish(identifier, data, user, platform);
            }

            default:
                // A STEP THAT NO LONGER EXISTS.
                //
                // Anyone halfway through creating a challenge when a deploy
                // lands is holding a state name the new code has never heard
                // of \u2014 'entry' after that step was removed, for instance.
                // Silently clearing it dropped them at the main menu with no
                // idea what happened. Say so and offer the way back.
                logger.info(`Challenge flow state "${state}" no longer exists; restarting`);
                await userService.clearUserState(identifier);
                await messagingService.sendMessage(identifier, STRINGS.flowMoved);
                return true;
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
            // No participant spends a token in either mode: paid is covered by
            // the setup charge, free is free. Passed explicitly rather than
            // relying on the validator's default so the two cannot disagree.
            entryModel: 'free',
            scheduledStartAt: data.scheduledStartAt || null,
            rounds: 1,
            // THE PRIZE THE CREATOR ACTUALLY ENTERED.
            //
            // This was hardcoded to 0 from when prizes were unreachable, and
            // adding the prize step did not change it \u2014 so the amount was
            // collected, confirmed back to the player with the full \u20a61,650
            // arithmetic, and then thrown away. The quote and the payment link
            // both came out at the setup charge alone.
            prizeAmount: data.prizeAmount || 0
        }, platform);

        if (!result.ok) {
            await messagingService.sendMessage(identifier,
                result.errors.join('\n') || 'Could not create that challenge.');
            return true;
        }

        const startLabel = data.scheduledStartAt
            ? this.watLabel(data.scheduledStartAt)
            : null;

        const categoryLabel = this._categoryBlock(data.categories);

        // ANYTHING OWED HOLDS THE INVITE BACK.
        //
        // The challenge exists but is 'awaiting_sponsorship' until the gateway
        // confirms, so the link would 404 for whoever it was sent to. Showing
        // the itemised price and stopping here is the whole point: the webhook
        // is the receipt, exactly as it already was for sponsored prizes.
        if (result.quote && result.quote.total > 0) {
            await messagingService.sendMessage(identifier,
                STRINGS.quote(result.quote, data.maxParticipants || 2));
            await redis.setex(
                `challenge_awaiting_payment:${identifier}`, 3600, result.challenge.code
            );
            return true;
        }

        // TWO MESSAGES, NOT FOUR.
        //
        // Everything the CREATOR needs \u2014 what they made, their entry code, how
        // to cancel \u2014 is one message. The invite is the second, and it stays
        // separate for one reason: it is built to be forwarded, and the entry
        // code must never travel inside a forwarded message.
        //
        // The code is issued BEFORE the first message so it can be printed in
        // it rather than arriving separately a moment later.
        let initiatorCode = null;
        if (!String(identifier).startsWith('web_')) {
            try {
                const challengeAuthService = require('./challenge-auth.service');
                const issued = await challengeAuthService.issueCode(
                    result.challenge, user, { deliver: false }
                );
                if (issued.ok) initiatorCode = issued.code;
            } catch (error) {
                logger.error('Could not issue initiator challenge code:', error.message);
            }
        }

        await messagingService.sendMessage(identifier, STRINGS.created(
            categoryLabel, startLabel, result.challenge.code, initiatorCode, data.mode
        ));

        await messagingService.sendMessage(identifier,
            STRINGS.invite(this.displayName(user), result.links, categoryLabel, startLabel,
                           result.challenge.max_participants, result.challenge.prize_amount));

        // WEB NEEDS THE INVITE AS DATA, not as chat text.
        //
        // On WhatsApp the invite is a message you long-press and forward. On
        // web it arrived as transient chat bubbles with nothing to copy, so a
        // web player could create a challenge and then had no way to send it.
        // This pushes the real thing \u2014 links and text \u2014 to the client, which
        // renders a share screen with Copy and Share buttons.
        if (platform === 'web') {
            try {
                const gameEvents = require('./game-events.service');
                gameEvents.emit(user.id, 'challenge.created', {
                    code: result.challenge.code,
                    links: result.links,
                    categories: categoryLabel,
                    startLabel,
                    inviteText: STRINGS.invite(
                        this.displayName(user), result.links, categoryLabel, startLabel,
                        result.challenge.max_participants, result.challenge.prize_amount
                    ),
                    shareable: result.shareable
                });
            } catch (error) {
                logger.error('Could not push challenge.created to web:', error.message);
            }
        }

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

    // PLAY IS A SHARED KEYWORD. web-play's startMode() sends it to open
    // Classic, Practice and Tournaments, so this method owns exactly one
    // outcome: an async round it can start RIGHT NOW. Every other case returns
    // false and hands the word back to normal routing.
    //
    // Twice now a branch here has consumed PLAY and taken the whole web
    // platform down with it \u2014 first "you don't have a challenge waiting", then
    // "that challenge is over". The rule is the fix, not another special case:
    // if it is not starting a round, it does not get to reply.

    async handlePlay(identifier, user, platform, wantedCode = null) {
        const pending = await pool.query(`
            SELECT c.*, p.id AS participant_id, p.play_expires_at, p.status AS participant_status,
                   creator.username AS creator_username,
                   COALESCE(NULLIF(TRIM(creator.full_name), '') || ' (@' || creator.username || ')',
                            '@' || creator.username) AS creator_display
            FROM challenge_participants p
            JOIN challenges c ON c.id = p.challenge_id
            JOIN users creator ON creator.id = c.creator_user_id
            WHERE p.user_id = $1
              AND p.status IN ('joined','playing')
              AND c.status IN ('open','live')
              -- A LAPSED play window must not match. A participant row whose
              -- 24 hours ran out is never swept to 'expired' by anything the
              -- player does, so without this it matched forever and blocked
              -- PLAY permanently.
              AND (p.play_expires_at IS NULL OR p.play_expires_at > NOW())
              -- Live challenges are played in the browser. There is no lobby,
              -- no shared clock and no reveal in a chat thread.
              AND c.mode = 'async'
            ORDER BY p.joined_at DESC NULLS LAST
            LIMIT 5
        `, [user.id]);

        // Never start a challenge round on top of a live Classic, Practice or
        // tournament game. The player would then have two games and one set of
        // A/B/C/D keys between them.
        try {
            // game.service exports the CLASS with a shared instance on
            // .shared \u2014 the same singleton webhook.controller uses. Building a
            // second GameService here would give it its own in-process timer
            // map, which is exactly the kind of thing that only shows up as a
            // missed timeout weeks later.
            const GameService = require('./game.service');
            const active = await GameService.shared.getActiveSession(user.id);
            if (active) return false;
        } catch (error) {
            logger.error('Could not check for an active session:', error.message);
            return false;
        }

        let challenge = pending.rows[0];

        // WHICH challenge? Picking "whichever you joined last" is how two
        // players ended up in DIFFERENT challenges during testing: each got a
        // different question set, and neither challenge ever reached the two
        // finishers it needs to complete. So the one they most recently
        // accepted wins, and it is remembered explicitly.
        const activeCode = wantedCode ||
            await redis.get(`challenge_active:${identifier}`).catch(() => null);
        if (activeCode) {
            const chosen = pending.rows.find(r => r.code === activeCode);
            if (chosen) challenge = chosen;
        }

        // More than one waiting and nothing pinned? Ask instead of guessing.
        if (!activeCode && pending.rows.length > 1) {
            await messagingService.sendMessage(identifier,
                STRINGS.whichChallenge(pending.rows.map(r => ({
                    code: r.code,
                    from: r.creator_display || ('@' + r.creator_username),
                    categories: this._categoryList(r.categories)
                }))));
            return true;
        }

        if (!challenge) {
            // Nothing startable. Sweep any dead rows so they stop being
            // considered, then hand the keyword back untouched.
            await this._expireLapsedRounds(user.id);
            return false;
        }

        const started = await challengeRoundService.startRound(
            challenge, { id: challenge.participant_id }, user, { platform }
        );

        if (!started.ok) {
            // The last branch that could still swallow PLAY. It is a narrow
            // case \u2014 a race, or a bank that cannot fill a set \u2014 but "narrow"
            // is what the previous two looked like too. Log it and hand the
            // keyword back; the hub explains the state properly, and Classic
            // stays reachable no matter what happens here.
            logger.warn(
                `Challenge round would not start for user ${user.id} ` +
                `on ${challenge.code}: ${started.reason}`
            );
            return false;
        }

        const ghost = await challengeRoundService.loadGhost(challenge, 1);

        await redis.setex(this._playKey(identifier), CHALLENGE_PLAY_TTL, JSON.stringify({
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

    /**
     * Marks a player's lapsed async rounds as expired.
     *
     * The hourly sweeper does this globally, but a player typing PLAY should
     * not have to wait for it: until the row is cleared it keeps matching, and
     * every stale row is one more chance to swallow a shared keyword.
     */
    async _expireLapsedRounds(userId) {
        try {
            await pool.query(`
                UPDATE challenge_participants
                SET status = 'expired'
                WHERE user_id = $1
                  AND status IN ('joined','playing')
                  AND play_expires_at IS NOT NULL
                  AND play_expires_at < NOW()
            `, [userId]);
        } catch (error) {
            logger.error('Could not expire lapsed challenge rounds:', error.message);
        }
    }

    async _serveQuestion(identifier, challenge, round, position, ghost) {
        const question = await challengeRoundService.getQuestion(challenge, round, position);
        if (!question) {
            await messagingService.sendMessage(identifier, STRINGS.noQuestions);
            await redis.del(this._playKey(identifier));
            return;
        }

        await messagingService.sendMessage(identifier, STRINGS.question(
            position, question.text, question.options, ghost ? ghost[position] : null,
            question.fiftyFiftyAvailable
        ));
    }

    // A, B, C and D BELONG TO EVERY GAME MODE.
    //
    // This hook sits above Classic's answer path, so it must consume a letter
    // only when a challenge round is genuinely in progress. A stale Redis key
    // \u2014 left by any abandoned round, and living for two hours \u2014 was enough to
    // hijack a tournament: the player's answer was scored against a challenge
    // question, they were told "time's up", and the tournament clock ran out
    // untouched beside it.
    //
    // Two guards, and the first is the decisive one: if the player has an
    // ACTIVE game session that is not a challenge, they are playing Classic,
    // Practice or a tournament, and this hook has no business here.

    async handleAnswer(identifier, message, user, platform) {
        let state_correction_wanted = false;
        const raw = await redis.get(this._playKey(identifier));
        if (!raw) return false;

        const letter = String(message || '').trim().toUpperCase();
        const isFifty = letter === '5050' || letter === '50:50' || letter === '50';

        // A player mid-round who fat-fingers "F" was being dropped into the
        // main menu, which looks like the game crashed. Correct them instead \u2014
        // but ONLY for input that is obviously an attempted answer, so real
        // commands still reach their handlers.
        const looksLikeAnAnswer = /^[A-Z]$/.test(letter) || /^\d{1,4}$/.test(letter);
        if (!isFifty && !['A', 'B', 'C', 'D'].includes(letter)) {
            if (!looksLikeAnAnswer) return false;
            // Guards below still run first; this only fires once we know a
            // round is genuinely in progress.
            state_correction_wanted = true;
        }

        // GUARD 1 \u2014 another mode owns this player right now.
        // getActiveSession() already filters challenge_id IS NULL, so a row
        // here means Classic, Practice or a tournament is mid-game.
        try {
            // game.service exports the CLASS with a shared instance on
            // .shared \u2014 the same singleton webhook.controller uses. Building a
            // second GameService here would give it its own in-process timer
            // map, which is exactly the kind of thing that only shows up as a
            // missed timeout weeks later.
            const GameService = require('./game.service');
            const active = await GameService.shared.getActiveSession(user.id);
            if (active) {
                logger.warn(
                    `Challenge answer hook stood down for user ${user.id}: ` +
                    `session ${active.id} (${active.game_type}) is active`
                );
                return false;
            }
        } catch (error) {
            // If we cannot tell, do NOT consume. Handing the letter back costs
            // a challenge answer; taking it wrongly costs someone's tournament.
            logger.error('Could not check for an active session:', error.message);
            return false;
        }

        const state = JSON.parse(raw);

        const context = await pool.query(`
            SELECT c.*, r.id AS round_id, r.round_no, r.session_key, r.game_session_id,
                   r.status AS round_status,
                   p.id AS participant_id
            FROM challenge_rounds r
            JOIN challenges c ON c.id = r.challenge_id
            JOIN challenge_participants p ON p.id = r.participant_id
            WHERE r.id = $1
        `, [state.roundId]);

        const ctx = context.rows[0];
        if (!ctx) { await redis.del(this._playKey(identifier)); return false; }

        // GUARD 2 \u2014 the round must still be playable. An abandoned or finished
        // round leaves the key behind; without this it keeps answering for the
        // rest of its TTL.
        if (ctx.round_status !== 'playing' ||
            !['open', 'live'].includes(ctx.status)) {
            await redis.del(this._playKey(identifier));
            logger.info(
                `Cleared a stale challenge play key for user ${user.id} ` +
                `(round ${ctx.round_status}, challenge ${ctx.status})`
            );
            return false;
        }

        const round = {
            id: ctx.round_id, round_no: ctx.round_no,
            session_key: ctx.session_key, game_session_id: ctx.game_session_id,
            // user_id is not optional: audit.logQuestionAsked writes it into
            // game_audit_logs, which is NOT NULL. Omitting it threw 23502 on
            // every single question served in chat.
            user_id: user.id
        };

        if (state_correction_wanted) {
            await messagingService.sendMessage(identifier, STRINGS.badAnswer);
            return true;
        }

        if (isFifty) {
            const fifty = await challengeRoundService.useFiftyFifty(
                ctx, round, state.position, user
            );
            await messagingService.sendMessage(identifier,
                fifty.ok ? STRINGS.fiftyFiftyDone(fifty.remaining[0], fifty.remaining[1])
              : fifty.reason === 'already_used' ? STRINGS.fiftyFiftyGone
              : fifty.reason === 'already_answered' ? STRINGS.fiftyFiftyTooLate
              : STRINGS.fiftyFiftyGone);
            // The clock keeps running. Everyone pays the same seconds for
            // using it, which is what keeps the race fair.
            return true;
        }

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
        await redis.setex(this._playKey(identifier), CHALLENGE_PLAY_TTL, JSON.stringify(state));

        const ghost = await challengeRoundService.loadGhost(ctx, ctx.round_no);
        await this._serveQuestion(identifier, ctx, round, state.position, ghost);
        return true;
    }

    async _finishRound(identifier, challenge, round, user, platform) {
        await redis.del(this._playKey(identifier));
        await redis.del(`challenge_active:${identifier}`).catch(() => {});

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
            // The group winner needs the same instruction the 1v1 winner gets.
            const top = board[0];
            if (Number(challenge.prize_amount) > 0 && top && top.username === user.username) {
                await messagingService.sendMessage(identifier,
                    STRINGS.groupPrizeWon(challenge.prize_amount));
            }
        } else if (mine && theirs) {
            const fmt = (r) => `${r.score}/15 \u00b7 ${(r.timeMs / 1000).toFixed(1)}s`;
            const won = mine.position < theirs.position;
            await messagingService.sendMessage(identifier, won
                ? STRINGS.resultWon(fmt(mine), fmt(theirs), theirs.username, challenge.prize_amount)
                : STRINGS.resultLost(fmt(mine), fmt(theirs), theirs.username));
        }

        // The card goes to BOTH players, not just the winner. The person most
        // likely to post it into the group chat is the one who lost, and the
        // card is written so they can.
        await this._sendCard(identifier, challenge);

        // The others are notified by challengeRoundService.finishRound, which
        // fires for web play too. Doing it here as well would send the card
        // twice whenever the last finisher happened to be on chat.
        return true;
    }

    /**
     * Messages every OTHER finished participant on a chat platform.
     *
     * Web participants are skipped: they have no chat identifier, and their
     * result is already on screen. `phone_number` starting with `web_` is how
     * this codebase marks a web account.
     */
    /**
     * Tells every OTHER finished participant that the challenge is done.
     *
     * PUBLIC and surface-agnostic on purpose. It used to be called only from
     * the chat _finishRound, so when the last player finished on WEB nobody
     * else heard anything \u2014 the challenger sat on "we wait for them to play"
     * forever while the other player collected the card.
     */
    async notifyCompletion(challenge, finisherUserId) {
        try {
            const finisher = await pool.query(
                `SELECT id, username FROM users WHERE id = $1`, [finisherUserId]
            );
            if (!finisher.rows[0]) return;

            const challengeRoundService = require('./challenge-round.service');
            const board = await challengeRoundService.getBoard(challenge);

            await this._notifyOtherParticipants(challenge, finisher.rows[0], board);
        } catch (error) {
            logger.error('Could not notify challenge completion:', error.message);
        }
    }

    async _notifyOtherParticipants(challenge, finisher, board) {
        try {
            const others = await pool.query(`
                SELECT u.id, u.phone_number, u.username
                FROM challenge_participants p
                JOIN users u ON u.id = p.user_id
                WHERE p.challenge_id = $1
                  AND p.status = 'finished'
                  AND p.user_id <> $2
            `, [challenge.id, finisher.id]);

            const categories = this._categoryList(challenge.categories);

            for (const other of others.rows) {
                if (!other.phone_number || other.phone_number.startsWith('web_')) continue;

                try {
                    await messagingService.sendMessage(other.phone_number,
                        STRINGS.opponentFinished('@' + finisher.username, categories));

                    if (challenge.format === 'group') {
                        await messagingService.sendMessage(other.phone_number, STRINGS.board(board));
                    } else {
                        const theirs = board.find(r => r.username === other.username);
                        const them = board.find(r => r.username !== other.username);
                        if (theirs && them) {
                            const fmt = (r) => `${r.score}/15 \u00b7 ${(r.timeMs / 1000).toFixed(1)}s`;
                            await messagingService.sendMessage(other.phone_number,
                                theirs.position < them.position
                                    ? STRINGS.resultWon(fmt(theirs), fmt(them), them.username, challenge.prize_amount)
                                    : STRINGS.resultLost(fmt(theirs), fmt(them), them.username));
                        }
                    }

                    await this._sendCard(other.phone_number, challenge);
                } catch (perUser) {
                    // One unreachable player must not stop the rest being told.
                    logger.error(`Could not notify participant ${other.id}:`, perUser.message);
                }
            }
        } catch (error) {
            logger.error('Could not notify other challenge participants:', error.message);
        }
    }

    async _sendCard(identifier, challenge) {
        try {
            const challengeCardService = require('./challenge-card.service');
            const winner = await challengeService.getWinner(challenge.id);
            if (!winner) return;

            const card = await challengeCardService.generate(challenge, winner.user_id);
            if (!card.ok) return;

            // A PATH, not a Buffer. whatsapp.service.uploadMedia streams from
            // disk; passing the bytes threw ERR_INVALID_ARG_VALUE and the card
            // silently never arrived.
            const data = card.data || await challengeCardService.getCardData(challenge);
            const caption = challengeCardService.caption(data, card.rematchUrl);

            let filePath = card.filePath;
            if (!filePath) {
                // Served from the Redis cache, so there is no file on disk any
                // more. Write the cached bytes back out for the upload.
                const fs = require('fs');
                const os = require('os');
                const path = require('path');
                filePath = path.join(os.tmpdir(), `challenge_${challenge.code}_${Date.now()}.png`);
                fs.writeFileSync(filePath, card.buffer);
            }

            await messagingService.sendImage(identifier, filePath, caption);
        } catch (error) {
            // A card that fails to render must never swallow the result. The
            // player has already been told their score.
            logger.error('Could not send challenge card:', error.message);
        }
    }

    // ============================================
    // WAT TIME
    // ============================================
    // Nigeria is West Africa Time, UTC+1, ALL YEAR. There is no daylight
    // saving, so the offset is a constant rather than a timezone-database
    // lookup. That is why this is fifteen lines and not a dependency.
    //
    // The server runs UTC. A player typing "2:30pm" means 2:30pm WAT, which is
    // 13:30 UTC. Storing the wall-clock time unconverted would start every
    // live challenge an hour late.

    _WAT_OFFSET_MS = 60 * 60 * 1000;

    // The window a challenge may be scheduled inside. Bounded on purpose: a
    // date picker offering any day means someone eventually schedules one for
    // next March and it sits in the sweeper for six months.
    _MAX_DAYS_AHEAD = 7;

    /**
     * The days a player may pick, as a numbered list rather than free text.
     * Offset 0 is today IN WAT, not the server's today \u2014 at 00:30 WAT the
     * server is still on the previous UTC day.
     */
    startDayOptions(now = new Date()) {
        const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const nowWat = new Date(now.getTime() + this._WAT_OFFSET_MS);

        const options = [];
        for (let offset = 0; offset < this._MAX_DAYS_AHEAD; offset++) {
            const d = new Date(Date.UTC(
                nowWat.getUTCFullYear(), nowWat.getUTCMonth(), nowWat.getUTCDate() + offset
            ));
            const label = offset === 0 ? 'today'
                        : offset === 1 ? 'tomorrow'
                        : `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
            options.push({ offset, label });
        }
        return options;
    }

    _numberedDays(options) {
        return options.map((o, i) => `*${i + 1}* \u2014 ${o.label}`).join('\n');
    }

    /**
     * A time, on a day already chosen. Returns a Date in UTC, or null.
     *
     * Nigeria is WAT, UTC+1, ALL YEAR \u2014 no daylight saving \u2014 so the conversion
     * is a constant rather than a timezone-database lookup. The server runs
     * UTC: "2:30pm" means 13:30Z, and storing the wall-clock time unconverted
     * would start every live challenge an hour late.
     */
    parseWatTimeOnDay(text, dayOffset = 0, now = new Date()) {
        const raw = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
        const m = raw.match(/^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm)?$/);
        if (!m) return null;

        let hour = parseInt(m[1], 10);
        const minute = m[2] ? parseInt(m[2], 10) : 0;
        const meridiem = m[3];
        if (minute > 59) return null;

        if (meridiem) {
            if (hour < 1 || hour > 12) return null;
            if (meridiem === 'pm' && hour !== 12) hour += 12;
            if (meridiem === 'am' && hour === 12) hour = 0;
        } else if (hour > 23) {
            return null;
        }

        const nowWat = new Date(now.getTime() + this._WAT_OFFSET_MS);
        const utcMs = Date.UTC(
            nowWat.getUTCFullYear(), nowWat.getUTCMonth(),
            nowWat.getUTCDate() + (parseInt(dayOffset, 10) || 0),
            hour, minute, 0, 0
        ) - this._WAT_OFFSET_MS;

        // The day was chosen explicitly, so a time already gone is a mistake to
        // reject rather than a day to silently add.
        if (utcMs <= now.getTime()) return null;

        return new Date(utcMs);
    }

    /**
     * A Date -> "2:30pm WAT" for today, "tomorrow 2:30pm WAT", or
     * "Tue 25 Aug, 2:30pm WAT" beyond that.
     *
     * The day matters as much as the time here: whoever receives the invite
     * reads it later, possibly on a different day, and "2:30pm" alone would be
     * read as today by someone opening it tomorrow morning.
     */
    watLabel(date, now = new Date()) {
        const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

        const wat = new Date(new Date(date).getTime() + this._WAT_OFFSET_MS);
        const nowWat = new Date(now.getTime() + this._WAT_OFFSET_MS);

        const minute = String(wat.getUTCMinutes()).padStart(2, '0');
        const suffix = wat.getUTCHours() >= 12 ? 'pm' : 'am';
        const hour = wat.getUTCHours() % 12 || 12;
        const clock = `${hour}:${minute}${suffix} WAT`;

        const dayKey = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        const daysApart = Math.round((dayKey(wat) - dayKey(nowWat)) / 86400000);

        if (daysApart === 0) return clock;
        if (daysApart === 1) return `tomorrow ${clock}`;
        return `${DAYS[wat.getUTCDay()]} ${wat.getUTCDate()} ${MONTHS[wat.getUTCMonth()]}, ${clock}`;
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

    /**
     * The same categories as a numbered block:
     *
     *   Categories:
     *   1. Nigerian History
     *   2. Word Power
     *
     * Used wherever the list is the point rather than an aside. Three
     * categories on one comma-separated line is fine in a sentence and hard to
     * scan at the top of an invite, which is where a recipient decides in two
     * seconds whether this is for them.
     */
    _categoryBlock(categories) {
        const list = categories || [];
        if (list.length === 0) return '';
        if (list.length === 1) return `Category: ${this._label(list[0])}`;
        return 'Categories:\n' +
            list.map((c, i) => `${i + 1}. ${this._label(c)}`).join('\n');
    }

    /**
     * "Edidiong Ukporo (@final_obongowo)", or just the handle if we have no
     * name on file. An invite from a bare handle reads as spam to anyone who
     * has never used the platform.
     */
    displayName(user) {
        const handle = user.username ? `@${user.username}` : 'A player';
        const full = (user.full_name || '').trim();
        return full ? `${full} (${handle})` : handle;
    }

    /**
     * The price bands as a readable list, or null in free mode.
     *
     * Built from the live price list rather than hard-coded, so an admin who
     * changes a band does not leave the chat flow quoting the old number \u2014
     * which is the sort of mismatch nobody notices until a player screenshots
     * it.
     */
    /**
     * The 1v1 setup charge, or null in free mode.
     *
     * Read live rather than hard-coded so an admin changing the 2-seat band
     * does not leave the format step quoting the old number.
     */
    async _duelPrice() {
        try {
            const challengePricingService = require('./challenge-pricing.service');
            const pricing = await challengePricingService.getPricing();
            if (pricing.mode !== 'paid') return null;
            return challengePricingService.setupChargeFor(2, pricing);
        } catch (error) {
            logger.error('Could not read the duel price:', error.message);
            return null;
        }
    }

    async _bandTable() {
        try {
            const challengePricingService = require('./challenge-pricing.service');
            const pricing = await challengePricingService.getPricing();
            if (pricing.mode !== 'paid') return null;

            // The 2-seat band is skipped: it is the duel price, and it is shown
            // at the format step next to "One friend" where it belongs.
            let previous = 2;
            return pricing.bands
                .filter(band => band.upTo > 2)
                .map(band => {
                    const range = `${previous + 1}\u2013${band.upTo} players`;
                    previous = band.upTo;
                    return `\u2022 ${range} \u2014 \u20a6${band.charge.toLocaleString()}`;
                }).join('\n');
        } catch (error) {
            // Never block creation on the price list. The quote before payment
            // is the authoritative figure anyway.
            logger.error('Could not build the band table:', error.message);
            return null;
        }
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