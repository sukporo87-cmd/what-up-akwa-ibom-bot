// ============================================================
// FILE: src/services/love-quest.service.js
// LOVE QUEST - Personalized Valentine's Trivia Experience
// Complete service with voice note support
// ============================================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// Prize points per question (out of 1000 total)
const LOVE_POINTS = {
    5: { 1: 100, 2: 150, 3: 200, 4: 250, 5: 300 },      // Sweet: 1000 total
    10: { 1: 50, 2: 60, 3: 70, 4: 80, 5: 100, 6: 110, 7: 120, 8: 130, 9: 140, 10: 140 }, // Romantic
    15: { 1: 30, 2: 40, 3: 50, 4: 55, 5: 65, 6: 70, 7: 75, 8: 80, 9: 85, 10: 90, 11: 95, 12: 100, 13: 105, 14: 110, 15: 50 } // Ultimate/Proposal
};

class LoveQuestService {
    constructor() {
        this.uploadDir = process.env.LOVE_QUEST_UPLOAD_DIR || path.join(__dirname, '../uploads/love-quest');
        this.whatsappApiUrl = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v18.0';
        this.whatsappPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        this.whatsappAccessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        
        // Ensure upload directory exists (with error handling for read-only filesystems)
        try {
            if (!fs.existsSync(this.uploadDir)) {
                fs.mkdirSync(this.uploadDir, { recursive: true });
            }
        } catch (err) {
            console.warn(`[LoveQuest] Could not create upload directory: ${err.message}. Voice notes may not work.`);
        }
    }

    // ============================================
    // BOOKING MANAGEMENT
    // ============================================

    async createBooking(creatorPhone, playerPhone, packageCode, creatorName = null, playerName = null) {
        try {
            // Get package details
            const packageResult = await pool.query(
                'SELECT * FROM love_quest_packages WHERE package_code = $1 AND is_active = true',
                [packageCode]
            );
            
            if (packageResult.rows.length === 0) {
                throw new Error('Invalid package selected');
            }
            
            const pkg = packageResult.rows[0];
            
            // Generate unique booking code
            const codeResult = await pool.query('SELECT generate_love_quest_code() as code');
            const bookingCode = codeResult.rows[0].code;
            
            // Check if creator is a registered user
            const creatorUser = await pool.query(
                'SELECT id FROM users WHERE phone_number = $1',
                [creatorPhone]
            );
            
            // Create booking
            const result = await pool.query(`
                INSERT INTO love_quest_bookings (
                    booking_code, package, base_price, creator_phone, creator_name,
                    creator_user_id, player_phone, player_name, question_count,
                    treasure_hunt_enabled, status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
                RETURNING *
            `, [
                bookingCode,
                packageCode,
                pkg.base_price,
                creatorPhone,
                creatorName,
                creatorUser.rows[0]?.id || null,
                playerPhone,
                playerName,
                pkg.question_count,
                pkg.treasure_hunt
            ]);
            
            const booking = result.rows[0];
            
            // Create booking directory for media
            const bookingDir = path.join(this.uploadDir, bookingCode);
            if (!fs.existsSync(bookingDir)) {
                fs.mkdirSync(bookingDir, { recursive: true });
            }
            
            // Log audit event
            await this.logAuditEvent(booking.id, null, 'booking_created', {
                package: packageCode,
                price: pkg.base_price,
                creator: creatorPhone,
                player: playerPhone
            }, 'creator', creatorPhone);
            
            logger.info(`💘 Love Quest booking created: ${bookingCode}`);
            
            return booking;
        } catch (error) {
            logger.error('Error creating Love Quest booking:', error);
            throw error;
        }
    }

    async getBooking(bookingIdOrCode) {
        try {
            console.log(`[LoveQuestService] getBooking called with: ${bookingIdOrCode}`);
            const isCode = typeof bookingIdOrCode === 'string' && bookingIdOrCode.startsWith('LQ-');
            const query = isCode
                ? 'SELECT * FROM love_quest_bookings WHERE booking_code = $1'
                : 'SELECT * FROM love_quest_bookings WHERE id = $1';
            
            console.log(`[LoveQuestService] Running query: ${query}`);
            const result = await pool.query(query, [bookingIdOrCode]);
            console.log(`[LoveQuestService] Found ${result.rows.length} booking(s)`);
            return result.rows[0] || null;
        } catch (error) {
            console.error('[LoveQuestService] Error getting booking:', error);
            logger.error('Error getting booking:', error);
            return null;
        }
    }

    async getBookingByPlayerPhone(phone) {
        try {
            // Get active booking for this player
            const result = await pool.query(`
                SELECT * FROM love_quest_bookings 
                WHERE player_phone = $1 
                AND status IN ('sent', 'in_progress')
                ORDER BY created_at DESC
                LIMIT 1
            `, [phone]);
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting booking by player phone:', error);
            return null;
        }
    }

    async updateBookingStatus(bookingId, newStatus, notes = null) {
        try {
            const booking = await this.getBooking(bookingId);
            if (!booking) throw new Error('Booking not found');
            
            // Update status history
            const history = booking.status_history || [];
            history.push({
                from: booking.status,
                to: newStatus,
                at: new Date().toISOString(),
                notes
            });
            
            await pool.query(`
                UPDATE love_quest_bookings 
                SET status = $1, status_history = $2, updated_at = NOW()
                WHERE id = $3
            `, [newStatus, JSON.stringify(history), bookingId]);
            
            await this.logAuditEvent(bookingId, null, 'status_changed', {
                from: booking.status,
                to: newStatus,
                notes
            }, 'system', null);
            
            logger.info(`💘 Booking ${booking.booking_code} status: ${booking.status} → ${newStatus}`);
            
            return true;
        } catch (error) {
            logger.error('Error updating booking status:', error);
            return false;
        }
    }

    // ============================================
    // QUESTION MANAGEMENT
    // ============================================

    async addQuestion(bookingId, questionData) {
        try {
            const {
                questionNumber, questionText,
                optionA, optionB, optionC, optionD, correctAnswer,
                correctResponse, wrongResponseA, wrongResponseB, wrongResponseC, wrongResponseD,
                genericWrongResponse, milestonePrizeText, milestonePrizeCash,
                treasureClue, treasureLocationHint, hintText, customTimeoutSeconds
            } = questionData;
            
            const result = await pool.query(`
                INSERT INTO love_quest_questions (
                    booking_id, question_number, question_text,
                    option_a, option_b, option_c, option_d, correct_answer,
                    correct_response, wrong_response_a, wrong_response_b, wrong_response_c, wrong_response_d,
                    generic_wrong_response, milestone_prize_text, milestone_prize_cash,
                    treasure_clue, treasure_location_hint, hint_text, custom_timeout_seconds
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                ON CONFLICT (booking_id, question_number) DO UPDATE SET
                    question_text = EXCLUDED.question_text,
                    option_a = EXCLUDED.option_a,
                    option_b = EXCLUDED.option_b,
                    option_c = EXCLUDED.option_c,
                    option_d = EXCLUDED.option_d,
                    correct_answer = EXCLUDED.correct_answer,
                    correct_response = EXCLUDED.correct_response,
                    wrong_response_a = EXCLUDED.wrong_response_a,
                    wrong_response_b = EXCLUDED.wrong_response_b,
                    wrong_response_c = EXCLUDED.wrong_response_c,
                    wrong_response_d = EXCLUDED.wrong_response_d,
                    generic_wrong_response = EXCLUDED.generic_wrong_response,
                    milestone_prize_text = EXCLUDED.milestone_prize_text,
                    milestone_prize_cash = EXCLUDED.milestone_prize_cash,
                    treasure_clue = EXCLUDED.treasure_clue,
                    treasure_location_hint = EXCLUDED.treasure_location_hint,
                    hint_text = EXCLUDED.hint_text,
                    custom_timeout_seconds = EXCLUDED.custom_timeout_seconds,
                    updated_at = NOW()
                RETURNING *
            `, [
                bookingId, questionNumber, questionText,
                optionA, optionB, optionC || null, optionD || null, correctAnswer.toUpperCase(),
                correctResponse, wrongResponseA, wrongResponseB, wrongResponseC, wrongResponseD,
                genericWrongResponse, milestonePrizeText, milestonePrizeCash || 0,
                treasureClue, treasureLocationHint, hintText, customTimeoutSeconds
            ]);
            
            return result.rows[0];
        } catch (error) {
            logger.error('Error adding question:', error);
            throw error;
        }
    }

    async getQuestions(bookingId) {
        try {
            const result = await pool.query(
                'SELECT * FROM love_quest_questions WHERE booking_id = $1 ORDER BY question_number',
                [bookingId]
            );
            return result.rows;
        } catch (error) {
            logger.error('Error getting questions:', error);
            return [];
        }
    }

    async getQuestion(bookingId, questionNumber) {
        try {
            const result = await pool.query(
                'SELECT * FROM love_quest_questions WHERE booking_id = $1 AND question_number = $2',
                [bookingId, questionNumber]
            );
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting question:', error);
            return null;
        }
    }

    // ============================================
    // VOICE NOTE / MEDIA HANDLING
    // ============================================

    async downloadWhatsAppMedia(mediaId) {
        try {
            // Step 1: Get media URL from WhatsApp
            const urlResponse = await axios.get(
                `${this.whatsappApiUrl}/${mediaId}`,
                {
                    headers: { Authorization: `Bearer ${this.whatsappAccessToken}` }
                }
            );
            
            const mediaUrl = urlResponse.data.url;
            
            // Step 2: Download the actual media
            const mediaResponse = await axios.get(mediaUrl, {
                headers: { Authorization: `Bearer ${this.whatsappAccessToken}` },
                responseType: 'arraybuffer'
            });
            
            return {
                buffer: Buffer.from(mediaResponse.data),
                mimeType: urlResponse.data.mime_type
            };
        } catch (error) {
            logger.error('Error downloading WhatsApp media:', error);
            throw error;
        }
    }

    async saveVoiceNote(bookingCode, mediaId, purpose = 'grand_reveal') {
        try {
            const booking = await this.getBooking(bookingCode);
            if (!booking) throw new Error('Booking not found');
            
            // Download from WhatsApp
            const media = await this.downloadWhatsAppMedia(mediaId);
            
            // Determine file extension
            const ext = media.mimeType.includes('ogg') ? 'ogg' 
                      : media.mimeType.includes('mp4') ? 'm4a'
                      : media.mimeType.includes('mpeg') ? 'mp3'
                      : 'ogg';
            
            // Save file
            const filename = `${purpose}_${Date.now()}.${ext}`;
            const bookingDir = path.join(this.uploadDir, bookingCode);
            
            if (!fs.existsSync(bookingDir)) {
                fs.mkdirSync(bookingDir, { recursive: true });
            }
            
            const filePath = path.join(bookingDir, filename);
            fs.writeFileSync(filePath, media.buffer);
            
            // Get file stats
            const stats = fs.statSync(filePath);
            
            // Store in database
            await pool.query(`
                INSERT INTO love_quest_media (
                    booking_id, media_type, media_purpose, file_path, file_size, mime_type
                ) VALUES ($1, 'audio', $2, $3, $4, $5)
            `, [booking.id, purpose, filePath, stats.size, media.mimeType]);
            
            // Update booking media JSON
            const mediaJson = booking.media || {};
            mediaJson[`${purpose}_audio`] = filePath;
            
            await pool.query(
                'UPDATE love_quest_bookings SET media = $1 WHERE id = $2',
                [JSON.stringify(mediaJson), booking.id]
            );
            
            // If it's grand reveal, also update the dedicated column
            if (purpose === 'grand_reveal') {
                await pool.query(
                    'UPDATE love_quest_bookings SET grand_reveal_audio_url = $1 WHERE id = $2',
                    [filePath, booking.id]
                );
            }
            
            logger.info(`🎤 Voice note saved for ${bookingCode}: ${purpose}`);
            
            return { filePath, filename, size: stats.size };
        } catch (error) {
            logger.error('Error saving voice note:', error);
            throw error;
        }
    }

    async uploadMediaToWhatsApp(filePath, mimeType = 'audio/ogg') {
        try {
            const formData = new FormData();
            formData.append('messaging_product', 'whatsapp');
            formData.append('file', fs.createReadStream(filePath), {
                contentType: mimeType
            });

            const response = await axios.post(
                `${this.whatsappApiUrl}/${this.whatsappPhoneNumberId}/media`,
                formData,
                {
                    headers: {
                        Authorization: `Bearer ${this.whatsappAccessToken}`,
                        ...formData.getHeaders()
                    }
                }
            );

            logger.info(`📤 Media uploaded to WhatsApp: ${response.data.id}`);
            return response.data.id;
        } catch (error) {
            logger.error('Error uploading media to WhatsApp:', error);
            throw error;
        }
    }

    async sendVoiceNote(phoneNumber, filePath) {
        try {
            // Determine MIME type
            const ext = path.extname(filePath).toLowerCase();
            const mimeType = ext === '.ogg' ? 'audio/ogg; codecs=opus'
                          : ext === '.mp3' ? 'audio/mpeg'
                          : ext === '.m4a' ? 'audio/mp4'
                          : 'audio/ogg';
            
            // Upload to WhatsApp
            const mediaId = await this.uploadMediaToWhatsApp(filePath, mimeType);
            
            // Send audio message
            const response = await axios.post(
                `${this.whatsappApiUrl}/${this.whatsappPhoneNumberId}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: phoneNumber,
                    type: 'audio',
                    audio: { id: mediaId }
                },
                {
                    headers: {
                        Authorization: `Bearer ${this.whatsappAccessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            logger.info(`🎤 Voice note sent to ${phoneNumber}`);
            return response.data;
        } catch (error) {
            logger.error('Error sending voice note:', error);
            throw error;
        }
    }

    // ============================================
    // GAME SESSION MANAGEMENT
    // ============================================

    async startSession(booking, playerPhone) {
        try {
            // Generate session key
            const sessionKey = `lq_${booking.booking_code}_${Date.now()}`;
            
            // Check if player is registered user
            const playerUser = await pool.query(
                'SELECT id FROM users WHERE phone_number = $1',
                [playerPhone]
            );
            
            const result = await pool.query(`
                INSERT INTO love_quest_sessions (
                    booking_id, session_key, player_phone, player_user_id,
                    current_question, score, max_score, status
                ) VALUES ($1, $2, $3, $4, 1, 0, 1000, 'active')
                RETURNING *
            `, [
                booking.id,
                sessionKey,
                playerPhone,
                playerUser.rows[0]?.id || null
            ]);
            
            const session = result.rows[0];
            
            // Update booking status
            await this.updateBookingStatus(booking.id, 'in_progress');
            
            // Cache session in Redis
            await redis.setex(
                `love_quest:session:${playerPhone}`,
                86400, // 24 hours
                JSON.stringify({ sessionId: session.id, bookingId: booking.id, sessionKey })
            );
            
            await this.logAuditEvent(booking.id, session.id, 'game_started', {
                player: playerPhone
            }, 'player', playerPhone);
            
            logger.info(`💘 Love Quest session started: ${sessionKey}`);
            
            return session;
        } catch (error) {
            logger.error('Error starting Love Quest session:', error);
            throw error;
        }
    }

    async getActiveSession(playerPhone) {
        try {
            // Check Redis cache first
            const cached = await redis.get(`love_quest:session:${playerPhone}`);
            if (cached) {
                const { sessionId } = JSON.parse(cached);
                const result = await pool.query(
                    'SELECT * FROM love_quest_sessions WHERE id = $1 AND status = $2',
                    [sessionId, 'active']
                );
                if (result.rows[0]) return result.rows[0];
            }
            
            // Fallback to DB query
            const result = await pool.query(`
                SELECT * FROM love_quest_sessions 
                WHERE player_phone = $1 AND status = 'active'
                ORDER BY created_at DESC LIMIT 1
            `, [playerPhone]);
            
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting active session:', error);
            return null;
        }
    }

    async getSessionWithBooking(playerPhone) {
        try {
            const result = await pool.query(`
                SELECT s.*, b.booking_code, b.package, b.question_count,
                       b.timeout_seconds, b.allow_retries, b.max_retries_per_question,
                       b.treasure_hunt_enabled, b.grand_reveal_text, b.grand_reveal_audio_url,
                       b.grand_reveal_cash_prize, b.creator_name, b.player_name, b.media
                FROM love_quest_sessions s
                JOIN love_quest_bookings b ON s.booking_id = b.id
                WHERE s.player_phone = $1 AND s.status = 'active'
                ORDER BY s.created_at DESC LIMIT 1
            `, [playerPhone]);
            
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting session with booking:', error);
            return null;
        }
    }

    // ============================================
    // GAMEPLAY
    // ============================================

    async sendQuestion(session, booking, messagingService) {
        try {
            const question = await this.getQuestion(booking.id, session.current_question);
            if (!question) {
                throw new Error(`Question ${session.current_question} not found`);
            }
            
            const questionCount = booking.question_count;
            const timeout = question.custom_timeout_seconds || booking.timeout_seconds || 45;
            
            // Build question message
            let message = `💕 Question ${session.current_question} of ${questionCount}\n\n`;
            message += `${question.question_text}\n\n`;
            message += `A) ${question.option_a}\n`;
            message += `B) ${question.option_b}\n`;
            if (question.option_c) message += `C) ${question.option_c}\n`;
            if (question.option_d) message += `D) ${question.option_d}\n`;
            message += `\n⏱️ Take your time, love... (${timeout}s)`;
            
            // Add hint option if available
            if (question.hint_text) {
                message += `\n\n💡 Type HINT if you need help`;
            }
            
            await messagingService.sendMessage(session.player_phone, message);
            
            // Set timeout in Redis
            await redis.setex(
                `love_quest:timeout:${session.session_key}:q${session.current_question}`,
                timeout + 5, // Buffer
                Date.now().toString()
            );
            
            // Track question start time
            await redis.setex(
                `love_quest:qstart:${session.session_key}`,
                timeout + 60,
                Date.now().toString()
            );
            
            await this.logAuditEvent(booking.id, session.id, 'question_sent', {
                questionNumber: session.current_question,
                questionId: question.id
            }, 'system', null);
            
        } catch (error) {
            logger.error('Error sending Love Quest question:', error);
            throw error;
        }
    }

    async processAnswer(session, booking, answer, messagingService) {
        try {
            const question = await this.getQuestion(booking.id, session.current_question);
            if (!question) throw new Error('Question not found');
            
            const isCorrect = answer.toUpperCase() === question.correct_answer;
            
            // Calculate response time
            const startTime = await redis.get(`love_quest:qstart:${session.session_key}`);
            const responseTimeMs = startTime ? Date.now() - parseInt(startTime) : null;
            
            // Get retry count for this question
            const retries = session.retries_used || {};
            const currentRetries = retries[session.current_question] || 0;
            
            // Record response
            const responses = session.player_responses || [];
            responses.push({
                q: session.current_question,
                answer: answer.toUpperCase(),
                correct: isCorrect,
                retries: currentRetries,
                time_ms: responseTimeMs,
                timestamp: new Date().toISOString()
            });
            
            if (isCorrect) {
                // Calculate points
                const pointsTable = LOVE_POINTS[booking.question_count] || LOVE_POINTS[10];
                const points = pointsTable[session.current_question] || 50;
                const newScore = session.score + points;
                
                // Build correct response
                let message = question.correct_response || `✅ YES! That's right! 🎉\n\n`;
                message += `💕 Love Points: ${newScore}/1000\n`;
                
                // Check for milestone prize
                if (question.milestone_prize_text) {
                    message += `\n🎁 Prize Unlocked: ${question.milestone_prize_text}\n`;
                }
                if (question.milestone_prize_cash > 0) {
                    message += `💰 Cash: ₦${question.milestone_prize_cash.toLocaleString()}\n`;
                }
                
                await messagingService.sendMessage(session.player_phone, message);
                
                // Send milestone audio if exists
                const mediaJson = typeof booking.media === 'string' ? JSON.parse(booking.media) : (booking.media || {});
                const milestoneAudio = mediaJson[`milestone_${session.current_question}_audio`];
                if (milestoneAudio && fs.existsSync(milestoneAudio)) {
                    await this.sendVoiceNote(session.player_phone, milestoneAudio);
                }
                
                // Update session
                const nextQuestion = session.current_question + 1;
                
                if (nextQuestion > booking.question_count) {
                    // Game complete!
                    await this.completeGame(session, booking, newScore, responses, messagingService);
                } else {
                    // Continue to next question
                    await pool.query(`
                        UPDATE love_quest_sessions 
                        SET current_question = $1, score = $2, player_responses = $3, last_activity_at = NOW()
                        WHERE id = $4
                    `, [nextQuestion, newScore, JSON.stringify(responses), session.id]);
                    
                    session.current_question = nextQuestion;
                    session.score = newScore;
                    
                    // Check for treasure hunt
                    if (booking.treasure_hunt_enabled && question.treasure_clue) {
                        await this.sendTreasureClue(session, question, messagingService);
                    } else {
                        // Small delay then send next question
                        setTimeout(async () => {
                            await this.sendQuestion(session, booking, messagingService);
                        }, 2000);
                    }
                }
                
                await this.logAuditEvent(booking.id, session.id, 'answer_correct', {
                    questionNumber: session.current_question,
                    answer,
                    points,
                    newScore
                }, 'player', session.player_phone);
                
            } else {
                // Wrong answer
                const canRetry = booking.allow_retries && currentRetries < (booking.max_retries_per_question || 2);
                
                // Get appropriate wrong response
                let wrongResponse = question[`wrong_response_${answer.toLowerCase()}`] 
                    || question.generic_wrong_response
                    || this.getDefaultWrongResponse(booking.player_name || 'love');
                
                let message = wrongResponse + '\n\n';
                
                if (canRetry) {
                    message += `💪 Don't give up! Try again...\n`;
                    message += `(${booking.max_retries_per_question - currentRetries - 1} tries left)`;
                    
                    // Update retry count
                    retries[session.current_question] = currentRetries + 1;
                    await pool.query(
                        'UPDATE love_quest_sessions SET retries_used = $1, player_responses = $2 WHERE id = $3',
                        [JSON.stringify(retries), JSON.stringify(responses), session.id]
                    );
                } else {
                    // No more retries - reveal answer and continue
                    message += `The answer was: ${question.correct_answer}) `;
                    switch (question.correct_answer) {
                        case 'A': message += question.option_a; break;
                        case 'B': message += question.option_b; break;
                        case 'C': message += question.option_c; break;
                        case 'D': message += question.option_d; break;
                    }
                    message += `\n\n💕 It's okay, love conquers all! Let's continue...`;
                    
                    // Move to next question
                    const nextQuestion = session.current_question + 1;
                    
                    if (nextQuestion > booking.question_count) {
                        await messagingService.sendMessage(session.player_phone, message);
                        await this.completeGame(session, booking, session.score, responses, messagingService);
                        return;
                    }
                    
                    await pool.query(`
                        UPDATE love_quest_sessions 
                        SET current_question = $1, player_responses = $2, last_activity_at = NOW()
                        WHERE id = $3
                    `, [nextQuestion, JSON.stringify(responses), session.id]);
                    
                    session.current_question = nextQuestion;
                    
                    await messagingService.sendMessage(session.player_phone, message);
                    
                    setTimeout(async () => {
                        await this.sendQuestion(session, booking, messagingService);
                    }, 2000);
                    
                    return;
                }
                
                await messagingService.sendMessage(session.player_phone, message);
                
                await this.logAuditEvent(booking.id, session.id, 'answer_wrong', {
                    questionNumber: session.current_question,
                    answer,
                    retriesRemaining: canRetry ? booking.max_retries_per_question - currentRetries - 1 : 0
                }, 'player', session.player_phone);
            }
            
        } catch (error) {
            logger.error('Error processing Love Quest answer:', error);
            throw error;
        }
    }

    async sendTreasureClue(session, question, messagingService) {
        try {
            let message = `🗺️ TREASURE HUNT CLUE\n\n`;
            message += `${question.treasure_clue}\n\n`;
            if (question.treasure_location_hint) {
                message += `📍 Hint: ${question.treasure_location_hint}\n\n`;
            }
            message += `Reply FOUND when you get there! 💕`;
            
            await messagingService.sendMessage(session.player_phone, message);
            
            // Set waiting flag
            await pool.query(
                'UPDATE love_quest_sessions SET waiting_for_treasure_confirmation = true WHERE id = $1',
                [session.id]
            );
            
        } catch (error) {
            logger.error('Error sending treasure clue:', error);
        }
    }

    async confirmTreasureFound(session, booking, messagingService) {
        try {
            await pool.query(
                'UPDATE love_quest_sessions SET waiting_for_treasure_confirmation = false, treasure_hunt_stage = treasure_hunt_stage + 1 WHERE id = $1',
                [session.id]
            );
            
            await messagingService.sendMessage(
                session.player_phone,
                `🎉 You found it! The adventure continues...\n\nNext question coming up! 💕`
            );
            
            setTimeout(async () => {
                await this.sendQuestion(session, booking, messagingService);
            }, 2000);
            
        } catch (error) {
            logger.error('Error confirming treasure:', error);
        }
    }

    async sendHint(session, booking, messagingService) {
        try {
            const question = await this.getQuestion(booking.id, session.current_question);
            if (!question || !question.hint_text) {
                await messagingService.sendMessage(
                    session.player_phone,
                    `💭 No hint available for this one... Trust your heart! 💕`
                );
                return;
            }
            
            await messagingService.sendMessage(
                session.player_phone,
                `💡 HINT: ${question.hint_text}\n\nNow give it another shot! 💕`
            );
            
        } catch (error) {
            logger.error('Error sending hint:', error);
        }
    }

    async completeGame(session, booking, finalScore, responses, messagingService) {
        try {
            // Update session
            await pool.query(`
                UPDATE love_quest_sessions 
                SET status = 'completed', score = $1, player_responses = $2, completed_at = NOW()
                WHERE id = $3
            `, [finalScore, JSON.stringify(responses), session.id]);
            
            // Update booking
            await pool.query(`
                UPDATE love_quest_bookings 
                SET status = 'completed', completed_at = NOW()
                WHERE id = $1
            `, [booking.id]);
            
            // Clear Redis
            await redis.del(`love_quest:session:${session.player_phone}`);
            
            // Send completion message
            let message = `🎊 CONGRATULATIONS! 🎊\n\n`;
            message += `You completed the Love Quest!\n\n`;
            message += `💕 Final Score: ${finalScore}/1000 Love Points\n\n`;
            
            // Rating based on score
            if (finalScore >= 900) {
                message += `🏆 PERFECT LOVE! You know your partner inside out! 💕\n\n`;
            } else if (finalScore >= 700) {
                message += `❤️ DEEPLY IN LOVE! Your bond is strong! 💕\n\n`;
            } else if (finalScore >= 500) {
                message += `💛 GROWING LOVE! Every day brings you closer! 💕\n\n`;
            } else {
                message += `💗 LOVE IN BLOOM! Time to make more memories! 💕\n\n`;
            }
            
            await messagingService.sendMessage(session.player_phone, message);
            
            // Send grand reveal
            await this.sendGrandReveal(session, booking, messagingService);
            
            await this.logAuditEvent(booking.id, session.id, 'game_completed', {
                finalScore,
                totalQuestions: booking.question_count
            }, 'player', session.player_phone);
            
            logger.info(`💘 Love Quest completed: ${booking.booking_code} - Score: ${finalScore}`);
            
        } catch (error) {
            logger.error('Error completing Love Quest game:', error);
        }
    }

    async sendGrandReveal(session, booking, messagingService) {
        try {
            // Pause for dramatic effect
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            let message = `✨ AND NOW... ✨\n\n`;
            message += `A special message from your love...\n\n`;
            message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
            
            if (booking.grand_reveal_text) {
                message += `${booking.grand_reveal_text}\n\n`;
            }
            
            message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
            
            if (booking.grand_reveal_cash_prize > 0) {
                message += `💰 Grand Prize: ₦${booking.grand_reveal_cash_prize.toLocaleString()}!\n\n`;
            }
            
            message += `Happy Valentine's Day! 💘`;
            
            await messagingService.sendMessage(session.player_phone, message);
            
            // Send voice note if exists
            if (booking.grand_reveal_audio_url && fs.existsSync(booking.grand_reveal_audio_url)) {
                await new Promise(resolve => setTimeout(resolve, 1500));
                await this.sendVoiceNote(session.player_phone, booking.grand_reveal_audio_url);
            }
            
            await this.logAuditEvent(booking.id, session.id, 'grand_reveal_sent', {
                hasAudio: !!booking.grand_reveal_audio_url,
                hasCashPrize: booking.grand_reveal_cash_prize > 0
            }, 'system', null);
            
        } catch (error) {
            logger.error('Error sending grand reveal:', error);
        }
    }

    // ============================================
    // INVITATION
    // ============================================

    async sendInvitation(bookingId, messagingService) {
        try {
            const booking = await this.getBooking(bookingId);
            if (!booking) throw new Error('Booking not found');
            
            if (booking.status !== 'ready' && booking.status !== 'scheduled') {
                throw new Error('Booking is not ready to send');
            }
            
            const creatorName = booking.creator_name || 'Someone special';
            
            let message = `💘 *You've Been Challenged!* 💘\n\n`;
            message += `${creatorName} has created a special Love Quest just for you!\n\n`;
            message += `🎮 Answer questions about your relationship\n`;
            message += `🎁 Win prizes at every milestone\n`;
            message += `✨ A special surprise awaits at the end...\n\n`;
            message += `Are you ready to prove your love? 💕\n\n`;
            message += `Reply *START* to begin your quest!`;
            
            await messagingService.sendMessage(booking.player_phone, message);
            
            // Update booking status
            await pool.query(`
                UPDATE love_quest_bookings 
                SET status = 'sent', invitation_sent_at = NOW()
                WHERE id = $1
            `, [bookingId]);
            
            // Set expiry (48 hours to complete)
            await pool.query(`
                UPDATE love_quest_bookings 
                SET expires_at = NOW() + INTERVAL '48 hours'
                WHERE id = $1
            `, [bookingId]);
            
            await this.logAuditEvent(bookingId, null, 'invitation_sent', {
                player: booking.player_phone
            }, 'system', null);
            
            logger.info(`💘 Love Quest invitation sent: ${booking.booking_code} → ${booking.player_phone}`);
            
            return true;
        } catch (error) {
            logger.error('Error sending invitation:', error);
            throw error;
        }
    }

    // ============================================
    // HELPERS
    // ============================================

    getDefaultWrongResponse(playerName) {
        const responses = [
            `😤 ${playerName}! Really?! How could you forget that?!\n\nBut... I still love you. 💕`,
            `😢 Ouch! That wasn't it...\n\nI'm not mad, just... disappointed. 💔\n\nJust kidding! Try again, love!`,
            `🙈 Nooo! That's not right!\n\nWe need to make more memories together! 💕`,
            `😅 Wrong answer, but I'll forgive you...\n\nYou're lucky you're cute! 💕`,
            `💔 *dramatically clutches heart*\n\nHow could you?!\n\n...I'm over it. Let's continue! 😘`
        ];
        return responses[Math.floor(Math.random() * responses.length)];
    }

    async logAuditEvent(bookingId, sessionId, eventType, eventData, actorType, actorId) {
        try {
            await pool.query(`
                INSERT INTO love_quest_audit (booking_id, session_id, event_type, event_data, actor_type, actor_id)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [bookingId, sessionId, eventType, JSON.stringify(eventData), actorType, actorId]);
        } catch (error) {
            logger.error('Error logging Love Quest audit event:', error);
        }
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    async getAllBookings(status = null, limit = 50, offset = 0) {
        try {
            let query = `
                SELECT b.*, 
                       (SELECT COUNT(*) FROM love_quest_questions WHERE booking_id = b.id) as questions_added,
                       (SELECT COUNT(*) FROM love_quest_media WHERE booking_id = b.id) as media_count
                FROM love_quest_bookings b
            `;
            const params = [];
            
            if (status) {
                query += ' WHERE b.status = $1';
                params.push(status);
            }
            
            query += ' ORDER BY b.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
            params.push(limit, offset);
            
            const result = await pool.query(query, params);
            return result.rows;
        } catch (error) {
            logger.error('Error getting all bookings:', error);
            return [];
        }
    }

    async getBookingStats() {
        try {
            const result = await pool.query(`
                SELECT 
                    COUNT(*) as total_bookings,
                    COUNT(*) FILTER (WHERE status = 'pending') as pending,
                    COUNT(*) FILTER (WHERE status = 'paid') as paid,
                    COUNT(*) FILTER (WHERE status = 'curating') as curating,
                    COUNT(*) FILTER (WHERE status = 'ready') as ready,
                    COUNT(*) FILTER (WHERE status = 'sent') as sent,
                    COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
                    COUNT(*) FILTER (WHERE status = 'completed') as completed,
                    SUM(total_paid) as total_revenue,
                    SUM(prize_pool) as total_prize_pools,
                    AVG(CASE WHEN status = 'completed' THEN 
                        (SELECT score FROM love_quest_sessions WHERE booking_id = love_quest_bookings.id LIMIT 1) 
                    END) as avg_completion_score
                FROM love_quest_bookings
            `);
            return result.rows[0];
        } catch (error) {
            logger.error('Error getting booking stats:', error);
            return {};
        }
    }

    async getPackages() {
        try {
            const result = await pool.query(
                'SELECT * FROM love_quest_packages WHERE is_active = true ORDER BY display_order'
            );
            return result.rows;
        } catch (error) {
            logger.error('Error getting packages:', error);
            return [];
        }
    }
}

module.exports = new LoveQuestService();