// ============================================
// FILE: src/services/captcha.service.js
// Handles: CAPTCHA generation and validation
// Types: Emoji, Math, Count, Reverse
// ============================================

const { logger } = require('../utils/logger');
const pool = require('../config/database');

class CaptchaService {
    constructor() {
        // CAPTCHA type distribution
        this.captchaTypes = [
            { type: 'emoji', weight: 30 },
            { type: 'math', weight: 25 },
            { type: 'count', weight: 25 },
            { type: 'reverse', weight: 20 }
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
        
        // Non-category emojis for distractors
        this.distractorEmojis = ['💡', '📱', '💻', '📚', '🔑', '💎', '🎁', '🎈', '🎯', '🔔', 
                                  '⭐', '❤️', '🌍', '🔥', '💧', '🌸', '🍀', '🌙', '🎭', '🎪'];
        
        // Words for reverse CAPTCHA
        this.reverseWords = ['PLAY', 'GAME', 'QUIZ', 'CASH', 'LUCK', 'BEST', 'STAR', 'GOLD', 
                             'FAST', 'COOL', 'NICE', 'HOPE', 'LOVE', 'KING', 'HERO', 'MEGA'];
        
        // Count emojis
        this.countEmojis = ['⭐', '❤️', '🔥', '💎', '🎯', '🌟', '💫', '✨'];
    }
    
    // ============================================
    // DETERMINE IF CAPTCHA SHOULD APPEAR
    // ============================================
    
    shouldShowCaptcha(questionNumber, shownCaptchas = []) {
        // First CAPTCHA zone: Question 6 OR 8
        if ([6, 8].includes(questionNumber) && !shownCaptchas.some(q => [6, 8].includes(q))) {
            // 50% chance at 6, guaranteed at 8 if not shown at 6
            if (questionNumber === 6) {
                return Math.random() < 0.5;
            }
            return true; // Must show at 8 if not shown at 6
        }
        
        // Second CAPTCHA zone: Question 11 OR 12
        if ([11, 12].includes(questionNumber) && !shownCaptchas.some(q => [11, 12].includes(q))) {
            // 50% chance at 11, guaranteed at 12 if not shown at 11
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
            default:
                return this.generateMathCaptcha(); // Fallback
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
        
        return 'math'; // Fallback
    }
    
    // ============================================
    // EMOJI CAPTCHA
    // ============================================
    
    generateEmojiCaptcha() {
        const categories = Object.keys(this.emojiCategories);
        const targetCategory = categories[Math.floor(Math.random() * categories.length)];
        const categoryEmojis = this.emojiCategories[targetCategory];
        
        // Pick correct answer from category
        const correctEmoji = categoryEmojis[Math.floor(Math.random() * categoryEmojis.length)];
        
        // Pick 3 distractors (not from target category)
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
        
        // Shuffle options
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
            correctAnswer: correctIndex.toString(),
            acceptedAnswers: [correctIndex.toString()],
            displayQuestion: `Which emoji is a ${targetCategory}?`,
            options: options.map((e, i) => `${i + 1}. ${e}`)
        };
    }
    
    // ============================================
    // MATH CAPTCHA
    // ============================================
    
    generateMathCaptcha() {
        const operations = ['+', '-', '×'];
        const operation = operations[Math.floor(Math.random() * operations.length)];
        
        let num1, num2, answer;
        
        switch (operation) {
            case '+':
                num1 = Math.floor(Math.random() * 15) + 3; // 3-17
                num2 = Math.floor(Math.random() * 15) + 3; // 3-17
                answer = num1 + num2;
                break;
            case '-':
                num1 = Math.floor(Math.random() * 15) + 10; // 10-24
                num2 = Math.floor(Math.random() * num1) + 1; // 1 to num1
                answer = num1 - num2;
                break;
            case '×':
                num1 = Math.floor(Math.random() * 9) + 2; // 2-10
                num2 = Math.floor(Math.random() * 9) + 2; // 2-10
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
            correctAnswer: answer.toString(),
            acceptedAnswers: [answer.toString()],
            displayQuestion: `What is ${num1} ${operation} ${num2}?`,
            options: null
        };
    }
    
    // ============================================
    // COUNT CAPTCHA
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
            correctAnswer: count.toString(),
            acceptedAnswers: [count.toString()],
            displayQuestion: `How many ${emoji} are there?`,
            options: null
        };
    }
    
    // ============================================
    // REVERSE CAPTCHA
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
            correctAnswer: reversed,
            acceptedAnswers: [reversed, reversed.toLowerCase()],
            displayQuestion: `Type ${word} backwards`,
            options: null
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
                captcha.correctAnswer,
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
            
            // Too fast responses (possible bot)
            if (minTime < 500) {
                flags.push('captcha_too_fast');
            }
            
            // Consistently very fast (possible automation)
            if (avgTime < 1500 && stats.total_captchas > 10) {
                flags.push('captcha_consistently_fast');
            }
            
            // Too many failures (possible human struggling with bot)
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