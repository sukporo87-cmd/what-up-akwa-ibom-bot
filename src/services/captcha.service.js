// ============================================================
// FILE: src/services/captcha.service.js
// COMPLETE FILE - READY TO PASTE AND REPLACE
// CHANGES: Added 3 new CAPTCHA types (emoji_grid, odd_one_out, 
//          emoji_sequence) with mixed noise emojis. Harder for bots.
// ============================================================

const { logger } = require('../utils/logger');
const pool = require('../config/database');

class CaptchaService {
    constructor() {
        // CAPTCHA type distribution — 7 types total
        this.captchaTypes = [
            { type: 'emoji', weight: 15 },
            { type: 'math', weight: 15 },
            { type: 'count', weight: 10 },
            { type: 'reverse', weight: 10 },
            // NEW enhanced types — harder for text-parsing bots
            { type: 'emoji_grid', weight: 20 },
            { type: 'odd_one_out', weight: 15 },
            { type: 'emoji_sequence', weight: 15 }
        ];
        
        // Emoji CAPTCHA data
        this.emojiCategories = {
            ANIMAL: ['🐘', '🦁', '🐕', '🐈', '🐟', '🦅', '🐍', '🦋', '🐢', '🐰'],
            FRUIT: ['🍎', '🍊', '🍋', '🍇', '🍓', '🍑', '🍒', '🥭', '🍍', '🍌'],
            VEHICLE: ['🚗', '🚌', '✈️', '🚂', '🚢', '🏍️', '🚁', '🚲', '🛵', '🚀'],
            FOOD: ['🍕', '🍔', '🌮', '🍜', '🍣', '🥘', '🍳', '🥗', '🍝', '🥪'],
            SPORT: ['⚽', '🏀', '🎾', '🏈', '⚾', '🏐', '🎱', '🏓', '🏸', '🥊'],
            WEATHER: ['☀️', '🌧️', '❄️', '⛈️', '🌈', '💨', '🌪️', '☁️', '⚡', '🌊'],
            MUSIC: ['🎵', '🎸', '🎹', '🥁', '🎺', '🎷', '🎻', '🪕', '🎤', '🎧'],
            BUILDING: ['🏠', '🏢', '🏥', '🏫', '🏰', '⛪', '🕌', '🏛️', '🏪', '🏨']
        };
        
        // Noise / distractor emojis (not in any category)
        this.distractorEmojis = [
            '💡', '📱', '💻', '📚', '🔑', '💎', '🎁', '🎈', '🎯', '🔔', 
            '⭐', '❤️', '🌍', '🔥', '💧', '🌸', '🍀', '🌙', '🎭', '🎪',
            '🧩', '🪄', '🧸', '📌', '🗝️', '🎀', '🧲', '🪁', '📎', '🔮'
        ];
        
        // Words for reverse CAPTCHA
        this.reverseWords = ['PLAY', 'GAME', 'QUIZ', 'CASH', 'LUCK', 'BEST', 'STAR', 'GOLD', 
                             'FAST', 'COOL', 'NICE', 'HOPE', 'LOVE', 'KING', 'HERO', 'MEGA'];
        
        // Count emojis
        this.countEmojis = ['⭐', '❤️', '🔥', '💎', '🎯', '🌟', '💫', '✨'];

        // Sequence patterns for emoji_sequence
        this.sequenceEmojis = ['🔴', '🟡', '🟢', '🔵', '🟣', '🟠', '⚫', '⚪'];
    }
    
    // ============================================
    // DETERMINE IF CAPTCHA SHOULD APPEAR
    // ============================================
    
    shouldShowCaptcha(questionNumber, shownCaptchas = []) {
        // First CAPTCHA zone: Question 6 OR 8
        if ([6, 8].includes(questionNumber) && !shownCaptchas.some(q => [6, 8].includes(q))) {
            if (questionNumber === 6) {
                return Math.random() < 0.5;
            }
            return true; // Must show at 8 if not shown at 6
        }
        
        // Second CAPTCHA zone: Question 11 OR 12
        if ([11, 12].includes(questionNumber) && !shownCaptchas.some(q => [11, 12].includes(q))) {
            if (questionNumber === 11) {
                return Math.random() < 0.5;
            }
            return true; // Must show at 12 if not shown at 11
        }
        
        return false;
    }
    
    // ============================================
    // GENERATE CAPTCHA
    // ============================================
    
    generateCaptcha() {
        const type = this.selectCaptchaType();
        
        switch (type) {
            case 'emoji':
                return this.generateEmojiCaptcha();
            case 'math':
                return this.generateMathCaptcha();
            case 'count':
                return this.generateCountCaptcha();
            case 'reverse':
                return this.generateReverseCaptcha();
            case 'emoji_grid':
                return this.generateEmojiGridCaptcha();
            case 'odd_one_out':
                return this.generateOddOneOutCaptcha();
            case 'emoji_sequence':
                return this.generateEmojiSequenceCaptcha();
            default:
                return this.generateMathCaptcha();
        }
    }
    
    selectCaptchaType() {
        const totalWeight = this.captchaTypes.reduce((sum, t) => sum + t.weight, 0);
        let random = Math.random() * totalWeight;
        
        for (const captcha of this.captchaTypes) {
            random -= captcha.weight;
            if (random <= 0) {
                return captcha.type;
            }
        }
        
        return 'math';
    }
    
    // ============================================
    // EMOJI CAPTCHA (Original)
    // ============================================
    
    generateEmojiCaptcha() {
        const categories = Object.keys(this.emojiCategories);
        const targetCategory = categories[Math.floor(Math.random() * categories.length)];
        const categoryEmojis = this.emojiCategories[targetCategory];
        
        const correctEmoji = categoryEmojis[Math.floor(Math.random() * categoryEmojis.length)];
        
        const distractors = [];
        const allOtherEmojis = [
            ...this.distractorEmojis,
            ...categories.filter(c => c !== targetCategory)
                .flatMap(c => this.emojiCategories[c])
        ];
        
        while (distractors.length < 3) {
            const emoji = allOtherEmojis[Math.floor(Math.random() * allOtherEmojis.length)];
            if (!distractors.includes(emoji) && emoji !== correctEmoji) {
                distractors.push(emoji);
            }
        }
        
        const options = this.shuffleArray([correctEmoji, ...distractors]);
        const correctIndex = options.indexOf(correctEmoji) + 1;
        
        const question = `🔐 *SECURITY CHECK* 🔐\n\n` +
                        `Which emoji is a${this.startsWithVowel(targetCategory) ? 'n' : ''} *${targetCategory}*?\n\n` +
                        `1️⃣ ${options[0]}\n` +
                        `2️⃣ ${options[1]}\n` +
                        `3️⃣ ${options[2]}\n` +
                        `4️⃣ ${options[3]}\n\n` +
                        `Reply with *1*, *2*, *3*, or *4*\n` +
                        `⏱️ _12 seconds_`;
        
        return {
            type: 'emoji',
            question,
            answer: correctIndex.toString(),
            correctAnswer: correctIndex.toString(),
            acceptedAnswers: [correctIndex.toString()],
            displayQuestion: `Which emoji is a ${targetCategory}?`,
            options: options.map((e, i) => `${i + 1}. ${e}`)
        };
    }
    
    // ============================================
    // MATH CAPTCHA (Original)
    // ============================================
    
    generateMathCaptcha() {
        const operations = ['+', '-', '×'];
        const operation = operations[Math.floor(Math.random() * operations.length)];
        
        let num1, num2, answer;
        
        switch (operation) {
            case '+':
                num1 = Math.floor(Math.random() * 15) + 3;
                num2 = Math.floor(Math.random() * 15) + 3;
                answer = num1 + num2;
                break;
            case '-':
                num1 = Math.floor(Math.random() * 15) + 10;
                num2 = Math.floor(Math.random() * num1) + 1;
                answer = num1 - num2;
                break;
            case '×':
                num1 = Math.floor(Math.random() * 9) + 2;
                num2 = Math.floor(Math.random() * 9) + 2;
                answer = num1 * num2;
                break;
        }
        
        const question = `🔐 *SECURITY CHECK* 🔐\n\n` +
                        `Solve this:\n\n` +
                        `*What is ${num1} ${operation} ${num2}?*\n\n` +
                        `Reply with the answer\n` +
                        `⏱️ _12 seconds_`;
        
        return {
            type: 'math',
            question,
            answer: answer.toString(),
            correctAnswer: answer.toString(),
            acceptedAnswers: [answer.toString()],
            displayQuestion: `What is ${num1} ${operation} ${num2}?`,
            options: null
        };
    }
    
    // ============================================
    // COUNT CAPTCHA (Original)
    // ============================================
    
    generateCountCaptcha() {
        const emoji = this.countEmojis[Math.floor(Math.random() * this.countEmojis.length)];
        const count = Math.floor(Math.random() * 7) + 3; // 3-9
        
        const emojiString = emoji.repeat(count);
        
        const question = `🔐 *SECURITY CHECK* 🔐\n\n` +
                        `Count carefully:\n\n` +
                        `${emojiString}\n\n` +
                        `*How many ${emoji} are there?*\n\n` +
                        `Reply with the number\n` +
                        `⏱️ _12 seconds_`;
        
        return {
            type: 'count',
            question,
            answer: count.toString(),
            correctAnswer: count.toString(),
            acceptedAnswers: [count.toString()],
            displayQuestion: `How many ${emoji} are there?`,
            options: null
        };
    }
    
    // ============================================
    // REVERSE CAPTCHA (Original)
    // ============================================
    
    generateReverseCaptcha() {
        const word = this.reverseWords[Math.floor(Math.random() * this.reverseWords.length)];
        const reversed = word.split('').reverse().join('');
        
        const question = `🔐 *SECURITY CHECK* 🔐\n\n` +
                        `Type this word *BACKWARDS*:\n\n` +
                        `*${word}*\n\n` +
                        `_(Hint: ${word} backwards is ${reversed.charAt(0)}...)_\n\n` +
                        `Reply with the reversed word\n` +
                        `⏱️ _12 seconds_`;
        
        return {
            type: 'reverse',
            question,
            answer: reversed,
            correctAnswer: reversed,
            acceptedAnswers: [reversed, reversed.toLowerCase()],
            displayQuestion: `Type ${word} backwards`,
            options: null
        };
    }

    // ============================================
    // NEW: EMOJI GRID CAPTCHA
    // Shows a grid of mixed emojis with noise, 
    // asks user to count a specific target emoji
    // ============================================

    generateEmojiGridCaptcha() {
        const targetEmoji = this.countEmojis[Math.floor(Math.random() * this.countEmojis.length)];
        const targetCount = Math.floor(Math.random() * 5) + 3; // 3-7

        // Build grid: target emojis + noise emojis mixed
        const noiseEmojis = this.distractorEmojis.filter(e => e !== targetEmoji);
        const noiseCount = Math.floor(Math.random() * 6) + 5; // 5-10 noise items

        const gridItems = [];
        for (let i = 0; i < targetCount; i++) {
            gridItems.push(targetEmoji);
        }
        for (let i = 0; i < noiseCount; i++) {
            gridItems.push(noiseEmojis[Math.floor(Math.random() * noiseEmojis.length)]);
        }

        // Shuffle the grid
        const shuffledGrid = this.shuffleArray(gridItems);

        // Format into rows of 5
        let gridDisplay = '';
        for (let i = 0; i < shuffledGrid.length; i++) {
            gridDisplay += shuffledGrid[i];
            if ((i + 1) % 5 === 0 && i < shuffledGrid.length - 1) {
                gridDisplay += '\n';
            }
        }

        const question = `🔐 *SECURITY CHECK* 🔐\n\n` +
                        `Count the ${targetEmoji} in this grid:\n\n` +
                        `${gridDisplay}\n\n` +
                        `*How many ${targetEmoji} are there?*\n\n` +
                        `Reply with the number\n` +
                        `⏱️ _12 seconds_`;

        return {
            type: 'emoji_grid',
            question,
            answer: targetCount.toString(),
            correctAnswer: targetCount.toString(),
            acceptedAnswers: [targetCount.toString()],
            displayQuestion: `Count ${targetEmoji} in mixed grid`,
            options: null
        };
    }

    // ============================================
    // NEW: ODD ONE OUT CAPTCHA
    // Shows a row of identical emojis with one 
    // different emoji hidden. User finds which position.
    // ============================================

    generateOddOneOutCaptcha() {
        const categories = Object.keys(this.emojiCategories);
        const category = categories[Math.floor(Math.random() * categories.length)];
        const emojis = this.emojiCategories[category];

        // Pick the majority emoji and the odd one
        const majorityEmoji = emojis[Math.floor(Math.random() * emojis.length)];
        let oddEmoji;
        do {
            oddEmoji = emojis[Math.floor(Math.random() * emojis.length)];
        } while (oddEmoji === majorityEmoji);

        // Build a row of 5-7 with one odd
        const rowLength = Math.floor(Math.random() * 3) + 5; // 5-7
        const oddPosition = Math.floor(Math.random() * rowLength) + 1; // 1-indexed

        const row = [];
        for (let i = 1; i <= rowLength; i++) {
            if (i === oddPosition) {
                row.push(oddEmoji);
            } else {
                row.push(majorityEmoji);
            }
        }

        // Number each position
        let display = '';
        for (let i = 0; i < row.length; i++) {
            display += `${i + 1}️⃣${row[i]} `;
        }

        const question = `🔐 *SECURITY CHECK* 🔐\n\n` +
                        `Find the ODD one out!\n\n` +
                        `${display.trim()}\n\n` +
                        `*Which position is different?*\n\n` +
                        `Reply with the number (1-${rowLength})\n` +
                        `⏱️ _12 seconds_`;

        return {
            type: 'odd_one_out',
            question,
            answer: oddPosition.toString(),
            correctAnswer: oddPosition.toString(),
            acceptedAnswers: [oddPosition.toString()],
            displayQuestion: `Find the odd one out (position ${oddPosition})`,
            options: null
        };
    }

    // ============================================
    // NEW: EMOJI SEQUENCE CAPTCHA
    // Shows a repeating pattern with one missing,
    // user must identify the missing emoji
    // ============================================

    generateEmojiSequenceCaptcha() {
        // Pick 2-3 emojis for the pattern
        const patternLength = Math.floor(Math.random() * 2) + 2; // 2 or 3
        const usedEmojis = [];
        while (usedEmojis.length < patternLength) {
            const emoji = this.sequenceEmojis[Math.floor(Math.random() * this.sequenceEmojis.length)];
            if (!usedEmojis.includes(emoji)) {
                usedEmojis.push(emoji);
            }
        }

        // Repeat the pattern 3 times, replace one with ❓
        const fullSequence = [];
        for (let rep = 0; rep < 3; rep++) {
            for (const emoji of usedEmojis) {
                fullSequence.push(emoji);
            }
        }

        // Pick a random position to blank out (not in first pattern cycle)
        const blankMin = patternLength; // Start from 2nd cycle
        const blankPos = Math.floor(Math.random() * (fullSequence.length - blankMin)) + blankMin;
        const correctAnswer = fullSequence[blankPos];
        fullSequence[blankPos] = '❓';

        // Build display
        let display = fullSequence.join(' ');

        // Build options (correct + 2 wrong from sequenceEmojis)
        const wrongOptions = [];
        while (wrongOptions.length < 2) {
            const e = this.sequenceEmojis[Math.floor(Math.random() * this.sequenceEmojis.length)];
            if (e !== correctAnswer && !wrongOptions.includes(e)) {
                wrongOptions.push(e);
            }
        }

        const options = this.shuffleArray([correctAnswer, ...wrongOptions]);
        const correctIndex = options.indexOf(correctAnswer) + 1;

        const question = `🔐 *SECURITY CHECK* 🔐\n\n` +
                        `What comes next in the pattern?\n\n` +
                        `${display}\n\n` +
                        `Replace the ❓:\n\n` +
                        `1️⃣ ${options[0]}\n` +
                        `2️⃣ ${options[1]}\n` +
                        `3️⃣ ${options[2]}\n\n` +
                        `Reply with *1*, *2*, or *3*\n` +
                        `⏱️ _12 seconds_`;

        return {
            type: 'emoji_sequence',
            question,
            answer: correctIndex.toString(),
            correctAnswer: correctIndex.toString(),
            acceptedAnswers: [correctIndex.toString()],
            displayQuestion: `Complete the pattern (❓ = ${correctAnswer})`,
            options: options.map((e, i) => `${i + 1}. ${e}`)
        };
    }
    
    // ============================================
    // VALIDATE CAPTCHA ANSWER
    // ============================================
    
    validateAnswer(captcha, userAnswer) {
        if (!userAnswer) return false;
        
        const normalizedAnswer = userAnswer.toString().trim().toUpperCase();
        const acceptedAnswers = captcha.acceptedAnswers.map(a => a.toUpperCase());
        
        return acceptedAnswers.includes(normalizedAnswer);
    }
    
    // ============================================
    // LOG CAPTCHA ATTEMPT
    // ============================================
    
    async logCaptchaAttempt(userId, gameSessionId, questionNumber, captcha, userAnswer, isCorrect, responseTimeMs) {
        try {
            await pool.query(`
                INSERT INTO captcha_logs 
                (user_id, game_session_id, question_number, captcha_type, captcha_question, 
                 correct_answer, user_answer, is_correct, response_time_ms)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `, [
                userId,
                gameSessionId,
                questionNumber,
                captcha.type,
                captcha.displayQuestion,
                captcha.correctAnswer || captcha.answer,
                userAnswer,
                isCorrect,
                responseTimeMs
            ]);
        } catch (error) {
            logger.error('Error logging CAPTCHA attempt:', error);
        }
    }
    
    // ============================================
    // GET USER CAPTCHA STATS
    // ============================================
    
    async getUserCaptchaStats(userId) {
        try {
            const result = await pool.query(`
                SELECT 
                    COUNT(*) as total_captchas,
                    COUNT(*) FILTER (WHERE is_correct = true) as passed,
                    COUNT(*) FILTER (WHERE is_correct = false) as failed,
                    AVG(response_time_ms) as avg_response_time,
                    MIN(response_time_ms) as min_response_time
                FROM captcha_logs
                WHERE user_id = $1
            `, [userId]);
            
            return result.rows[0];
        } catch (error) {
            logger.error('Error getting CAPTCHA stats:', error);
            return null;
        }
    }
    
    // ============================================
    // CHECK FOR SUSPICIOUS CAPTCHA PATTERNS
    // ============================================
    
    async checkSuspiciousPatterns(userId) {
        try {
            const stats = await this.getUserCaptchaStats(userId);
            
            if (!stats || stats.total_captchas < 5) {
                return { suspicious: false };
            }
            
            const passRate = stats.passed / stats.total_captchas;
            const avgTime = parseFloat(stats.avg_response_time);
            const minTime = parseFloat(stats.min_response_time);
            
            const flags = [];
            
            if (minTime < 500) {
                flags.push('captcha_too_fast');
            }
            
            if (avgTime < 1500 && stats.total_captchas > 10) {
                flags.push('captcha_consistently_fast');
            }
            
            if (passRate < 0.5 && stats.total_captchas > 10) {
                flags.push('captcha_high_failure');
            }
            
            return {
                suspicious: flags.length > 0,
                flags,
                stats: {
                    passRate: (passRate * 100).toFixed(1) + '%',
                    avgResponseTime: Math.round(avgTime) + 'ms',
                    totalAttempts: stats.total_captchas
                }
            };
        } catch (error) {
            logger.error('Error checking CAPTCHA patterns:', error);
            return { suspicious: false };
        }
    }
    
    // ============================================
    // FORMAT CAPTCHA MESSAGE
    // ============================================
    
    formatCaptchaMessage(captcha, currentScore, questionNumber) {
        return `━━━━━━━━━━━━━━━━━━━━\n` +
               `❓ QUESTION ${questionNumber} of 15\n` +
               `💰 Current: ₦${currentScore.toLocaleString()}\n` +
               `━━━━━━━━━━━━━━━━━━━━\n\n` +
               captcha.question +
               `\n━━━━━━━━━━━━━━━━━━━━`;
    }
    
    // ============================================
    // HELPER FUNCTIONS
    // ============================================
    
    shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }
    
    startsWithVowel(word) {
        return ['A', 'E', 'I', 'O', 'U'].includes(word.charAt(0).toUpperCase());
    }
}

module.exports = new CaptchaService();