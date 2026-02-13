// ============================================================
// FILE: src/services/love-quest.service.js
// LOVE QUEST - Personalized Valentine's Trivia Experience
// Complete service with voice note support
// ============================================================

const pool = require('../config/database');
const redis = require('../config/redis');
const { logger } = require('../utils/logger');
const { getTranslations } = require('../config/love-quest-i18n');
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

    // Helper to normalize phone numbers
    normalizePhone(phone, isInternational = false) {
        if (!phone) return phone;
        
        // Remove +, spaces, dashes, parentheses
        let normalized = phone.replace(/[\s\-\+\(\)]/g, '');
        
        // Skip normalization for international package (don't add 234)
        if (isInternational) {
            return normalized;
        }
        
        // If starts with 0, assume Nigeria and add 234
        if (normalized.startsWith('0')) {
            normalized = '234' + normalized.substring(1);
        }
        
        // If it's 10 digits (missing country code), add 234
        if (normalized.length === 10 && /^\d+$/.test(normalized)) {
            normalized = '234' + normalized;
        }
        
        return normalized;
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
            
            // Normalize phone numbers (skip for international packages)
            const isInternational = packageCode === 'international' || packageCode === 'international_es';
            const normalizedCreatorPhone = this.normalizePhone(creatorPhone, isInternational);
            const normalizedPlayerPhone = this.normalizePhone(playerPhone, isInternational);
            
            logger.info(`📞 Phone normalization: creator ${creatorPhone} → ${normalizedCreatorPhone}, player ${playerPhone} → ${normalizedPlayerPhone}`);
            
            // Generate unique booking code
            const codeResult = await pool.query('SELECT generate_love_quest_code() as code');
            const bookingCode = codeResult.rows[0].code;
            
            // Check if creator is a registered user
            const creatorUser = await pool.query(
                'SELECT id FROM users WHERE phone_number = $1',
                [normalizedCreatorPhone]
            );
            
            // Determine language from package
            const language = pkg.language || 'en';
            
            // Create booking with normalized phone numbers
            const result = await pool.query(`
                INSERT INTO love_quest_bookings (
                    booking_code, package, base_price, creator_phone, creator_name,
                    creator_user_id, player_phone, player_name, question_count,
                    treasure_hunt_enabled, status, language
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)
                RETURNING *
            `, [
                bookingCode,
                packageCode,
                pkg.base_price,
                normalizedCreatorPhone,
                creatorName,
                creatorUser.rows[0]?.id || null,
                normalizedPlayerPhone,
                playerName,
                pkg.question_count,
                pkg.treasure_hunt,
                language
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
            // Detect if it's a numeric ID or a booking code string
            const isNumericId = !isNaN(bookingIdOrCode) && Number.isInteger(Number(bookingIdOrCode));
            const query = isNumericId
                ? 'SELECT * FROM love_quest_bookings WHERE id = $1'
                : 'SELECT * FROM love_quest_bookings WHERE booking_code = $1';
            
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
            
            // Store in database (UPSERT - update if exists)
            await pool.query(`
                INSERT INTO love_quest_media (
                    booking_id, media_type, media_purpose, file_path, file_size, mime_type
                ) VALUES ($1, 'audio', $2, $3, $4, $5)
                ON CONFLICT (booking_id, media_type, media_purpose) 
                DO UPDATE SET 
                    file_path = EXCLUDED.file_path,
                    file_size = EXCLUDED.file_size,
                    mime_type = EXCLUDED.mime_type,
                    uploaded_at = NOW()
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
                ORDER BY started_at DESC LIMIT 1
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
                SELECT s.*, b.id as id, b.booking_code, b.package, b.question_count,
                       b.timeout_seconds, b.allow_retries, b.max_retries_per_question,
                       b.treasure_hunt_enabled, b.grand_reveal_text, b.grand_reveal_audio_url,
                       b.grand_reveal_cash_prize, b.creator_name, b.creator_phone, 
                       b.player_name, b.media, b.intro_video_url
                FROM love_quest_sessions s
                JOIN love_quest_bookings b ON s.booking_id = b.id
                WHERE s.player_phone = $1 AND s.status = 'active'
                ORDER BY s.started_at DESC LIMIT 1
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
            const t = getTranslations(booking.language);
            
            // Build question message
            let message = `${t.question_header(session.current_question, questionCount)}\n\n`;
            message += `${question.question_text}\n\n`;
            message += `A) ${question.option_a}\n`;
            message += `B) ${question.option_b}\n`;
            if (question.option_c) message += `C) ${question.option_c}\n`;
            if (question.option_d) message += `D) ${question.option_d}\n`;
            message += `\n${t.question_timer(timeout)}`;
            
            // Add hint option if available
            if (question.hint_text) {
                message += `\n\n${t.question_hint}`;
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
            // booking might be sessionWithBooking which has booking_id, not id
            const bookingId = booking.id || session.booking_id || booking.booking_id;
            const question = await this.getQuestion(bookingId, session.current_question);
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
                const newScore = Math.min(session.score + points, 1000); // Cap at 1000
                const t = getTranslations(booking.language);
                
                // Build correct response
                let message = question.correct_response || t.correct_default;
                message += `${t.love_points(newScore)}\n`;
                
                // Check for milestone prize
                if (question.milestone_prize_text) {
                    message += `\n${t.prize_unlocked(question.milestone_prize_text)}\n`;
                }
                if (question.milestone_prize_cash > 0) {
                    const cashDisplay = booking.language === 'es' 
                        ? `$${question.milestone_prize_cash.toLocaleString()}`
                        : `₦${question.milestone_prize_cash.toLocaleString()}`;
                    message += `💰 ${cashDisplay}\n`;
                }
                
                await messagingService.sendMessage(session.player_phone, message);
                
                // Update session FIRST
                const nextQuestion = session.current_question + 1;
                const isComplete = nextQuestion > booking.question_count;
                const currentQ = session.current_question; // Question we just answered
                
                if (!isComplete) {
                    await pool.query(`
                        UPDATE love_quest_sessions 
                        SET current_question = $1, score = $2, player_responses = $3, last_activity_at = NOW()
                        WHERE id = $4
                    `, [nextQuestion, newScore, JSON.stringify(responses), session.id]);
                    
                    session.current_question = nextQuestion;
                    session.score = newScore;
                }
                
                // Check for milestone media (Q5 or Q10) - from database table
                const isMilestoneQ5 = currentQ === 5;
                const isMilestoneQ10 = currentQ === 10 && booking.question_count >= 10;
                
                if (isMilestoneQ5 || isMilestoneQ10) {
                    const milestonePurpose = isMilestoneQ5 ? 'milestone_5' : 'milestone_10';
                    logger.info(`🎁 Checking milestone media: bookingId=${bookingId}, purpose=${milestonePurpose}`);
                    
                    let milestoneMedia = await this.getMediaByPurpose(bookingId, milestonePurpose);
                    
                    // Also check for generic 'milestone' purpose as fallback
                    if (!milestoneMedia && isMilestoneQ5) {
                        milestoneMedia = await this.getMediaByPurpose(bookingId, 'milestone');
                    }
                    
                    logger.info(`🎁 Milestone media result: ${milestoneMedia ? milestoneMedia.file_path : 'none'}`);
                    
                    if (milestoneMedia && milestoneMedia.file_path && fs.existsSync(milestoneMedia.file_path)) {
                        await new Promise(r => setTimeout(r, 1500));
                        await messagingService.sendMessage(session.player_phone, 
                            t.milestone_reached(currentQ, booking.creator_name || (booking.language === 'es' ? 'Tu amor' : 'Your love'))
                        );
                        await new Promise(r => setTimeout(r, 1000));
                        
                        if (milestoneMedia.media_type === 'video') {
                            await this.sendVideo(session.player_phone, milestoneMedia.file_path);
                        } else {
                            await this.sendVoiceNote(session.player_phone, milestoneMedia.file_path);
                        }
                        
                        // Wait then prompt to continue (not for last question)
                        if (!isComplete) {
                            await new Promise(r => setTimeout(r, 3000));
                            await messagingService.sendMessage(session.player_phone, 
                                t.milestone_continue
                            );
                            
                            // Set waiting state
                            await pool.query(
                                'UPDATE love_quest_sessions SET waiting_for_continue = true WHERE id = $1',
                                [session.id]
                            );
                            
                            await this.logAuditEvent(bookingId, session.id, 'answer_correct', {
                                questionNumber: currentQ,
                                answer,
                                points,
                                newScore,
                                waitingForContinue: true
                            }, 'player', session.player_phone);
                            
                            return; // Don't auto-send next question
                        }
                    }
                }
                
                if (isComplete) {
                    // Game complete!
                    await this.completeGame(session, booking, newScore, responses, messagingService);
                } else {
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
                    questionNumber: currentQ,
                    answer,
                    points,
                    newScore
                }, 'player', session.player_phone);
                
            } else {
                // Wrong answer
                const canRetry = booking.allow_retries && currentRetries < (booking.max_retries_per_question || 2);
                const t = getTranslations(booking.language);
                
                // Get appropriate wrong response
                let wrongResponse = question[`wrong_response_${answer.toLowerCase()}`] 
                    || question.generic_wrong_response
                    || this.getDefaultWrongResponse(booking.player_name || (booking.language === 'es' ? 'amor' : 'love'), booking.language);
                
                let message = wrongResponse + '\n\n';
                
                if (canRetry) {
                    message += `${t.wrong_retry}\n`;
                    message += t.wrong_tries_left(booking.max_retries_per_question - currentRetries - 1);
                    
                    // Update retry count
                    retries[session.current_question] = currentRetries + 1;
                    await pool.query(
                        'UPDATE love_quest_sessions SET retries_used = $1, player_responses = $2 WHERE id = $3',
                        [JSON.stringify(retries), JSON.stringify(responses), session.id]
                    );
                } else {
                    // No more retries - reveal answer and continue
                    message += `${t.wrong_answer_was} ${question.correct_answer}) `;
                    switch (question.correct_answer) {
                        case 'A': message += question.option_a; break;
                        case 'B': message += question.option_b; break;
                        case 'C': message += question.option_c; break;
                        case 'D': message += question.option_d; break;
                    }
                    message += `\n\n${t.wrong_continue}`;
                    
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
            // Note: booking not passed here, so we default to English for treasure hunts
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
            const t = getTranslations(booking.language);
            if (!question || !question.hint_text) {
                await messagingService.sendMessage(session.player_phone, t.no_hint);
                return;
            }
            
            await messagingService.sendMessage(session.player_phone, t.hint_prefix(question.hint_text));
            
        } catch (error) {
            logger.error('Error sending hint:', error);
        }
    }

    async completeGame(session, booking, finalScore, responses, messagingService) {
        try {
            // Cap score at 1000
            const cappedScore = Math.min(finalScore, 1000);
            
            // Update session with capped score
            await pool.query(`
                UPDATE love_quest_sessions 
                SET status = 'completed', score = $1, player_responses = $2, completed_at = NOW()
                WHERE id = $3
            `, [cappedScore, JSON.stringify(responses), session.id]);
            
            // Update booking
            await pool.query(`
                UPDATE love_quest_bookings 
                SET status = 'completed', completed_at = NOW()
                WHERE id = $1
            `, [booking.id]);
            
            // Clear Redis
            await redis.del(`love_quest:session:${session.player_phone}`);
            
            // Update session.score for grand reveal
            session.score = cappedScore;
            
            // Send completion message
            const t = getTranslations(booking.language);
            let message = `${t.completion_title}\n\n`;
            message += `${t.completion_body}\n\n`;
            message += `${t.completion_score(cappedScore)}\n\n`;
            
            // Rating based on score
            if (cappedScore >= 900) {
                message += `${t.rating_perfect}\n\n`;
            } else if (cappedScore >= 700) {
                message += `${t.rating_deep}\n\n`;
            } else if (cappedScore >= 500) {
                message += `${t.rating_growing}\n\n`;
            } else {
                message += `${t.rating_bloom}\n\n`;
            }
            
            await messagingService.sendMessage(session.player_phone, message);
            
            // Send grand reveal
            await this.sendGrandReveal(session, booking, messagingService);
            
            await this.logAuditEvent(booking.id, session.id, 'game_completed', {
                finalScore: cappedScore,
                totalQuestions: booking.question_count
            }, 'player', session.player_phone);
            
            logger.info(`💘 Love Quest completed: ${booking.booking_code} - Score: ${cappedScore}`);
            
        } catch (error) {
            logger.error('Error completing Love Quest game:', error);
        }
    }

    async sendGrandReveal(session, booking, messagingService) {
        try {
            const playerName = booking.player_name || (booking.language === 'es' ? 'Mi Amor' : 'My Love');
            const creatorName = booking.creator_name || (booking.language === 'es' ? 'Tu Persona Especial' : 'Your Special Someone');
            const finalScore = Math.min(session.score || 0, 1000); // Cap at 1000
            const t = getTranslations(booking.language);
            
            // Pause for dramatic effect
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Part 1: Build anticipation
            await messagingService.sendMessage(session.player_phone, 
                t.grand_reveal_anticipation
            );
            
            await new Promise(resolve => setTimeout(resolve, 2500));
            
            // Part 2: Romantic poem based on score
            const poem = this.generateLovePoem(playerName, creatorName, finalScore, booking.language);
            await messagingService.sendMessage(session.player_phone, poem);
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Part 3: Personal message from creator
            if (booking.grand_reveal_text) {
                let personalMsg = `${t.grand_reveal_personal(creatorName)}\n\n`;
                personalMsg += `┏━━━━━━━━━━━━━━━━━━━┓\n\n`;
                personalMsg += `"${booking.grand_reveal_text}"\n\n`;
                personalMsg += `┗━━━━━━━━━━━━━━━━━━━┛`;
                
                await messagingService.sendMessage(session.player_phone, personalMsg);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            // Part 4: Voice note (the most personal touch)
            if (booking.grand_reveal_audio_url && fs.existsSync(booking.grand_reveal_audio_url)) {
                await messagingService.sendMessage(session.player_phone, 
                    t.voice_special(creatorName)
                );
                await new Promise(resolve => setTimeout(resolve, 1500));
                await this.sendVoiceNote(session.player_phone, booking.grand_reveal_audio_url);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            
            // Part 5: Cash prize announcement & claiming
            if (booking.grand_reveal_cash_prize > 0) {
                await this.handleCashPrizeReveal(session, booking, messagingService);
            }
            
            // Part 6: Final celebration message
            let finalMsg = `${t.grand_reveal_final_title}\n\n`;
            finalMsg += `${t.grand_reveal_final_body(finalScore, creatorName, playerName)}\n\n`;
            finalMsg += t.grand_reveal_footer;
            
            await messagingService.sendMessage(session.player_phone, finalMsg);
            
            // Notify creator that quest is complete
            await this.notifyCreatorOfCompletion(session, booking, messagingService);
            
            await this.logAuditEvent(booking.id, session.id, 'grand_reveal_sent', {
                hasAudio: !!booking.grand_reveal_audio_url,
                hasCashPrize: booking.grand_reveal_cash_prize > 0,
                finalScore
            }, 'system', null);
            
        } catch (error) {
            logger.error('Error sending grand reveal:', error);
        }
    }

    generateLovePoem(playerName, creatorName, score, language = 'en') {
        const t = getTranslations(language);
        if (score >= 900) return t.poem_perfect(playerName, creatorName);
        if (score >= 700) return t.poem_deep(playerName);
        if (score >= 500) return t.poem_growing(playerName);
        return t.poem_bloom(playerName);
    }

    async handleCashPrizeReveal(session, booking, messagingService) {
        try {
            const amount = parseFloat(booking.grand_reveal_cash_prize);
            
            let prizeMsg = `\n💰✨ *GRAND PRIZE UNLOCKED!* ✨💰\n\n`;
            prizeMsg += `${booking.creator_name || 'Your love'} has gifted you:\n\n`;
            prizeMsg += `💵 *₦${amount.toLocaleString()}*\n\n`;
            
            // Check if player has a registered account with bank details
            const playerResult = await pool.query(
                'SELECT id, bank_name, account_number FROM users WHERE phone_number = $1',
                [session.player_phone]
            );
            
            if (playerResult.rows[0]?.bank_name && playerResult.rows[0]?.account_number) {
                // Player has bank details - credit to their wallet
                const playerId = playerResult.rows[0].id;
                
                // Add to player's wallet
                await pool.query(
                    'UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2',
                    [amount, playerId]
                );
                
                // Record transaction
                await pool.query(`
                    INSERT INTO transactions (user_id, amount, transaction_type, status, notes)
                    VALUES ($1, $2, 'love_quest_prize', 'confirmed', $3)
                `, [playerId, amount, `Love Quest prize from booking ${booking.booking_code}`]);
                
                prizeMsg += `✅ *Added to your What's Up Trivia wallet!*\n`;
                prizeMsg += `You can claim it anytime by sending CLAIM.\n\n`;
                
                await this.logAuditEvent(booking.id, session.id, 'cash_prize_credited', {
                    amount, playerId, method: 'wallet'
                }, 'system', null);
                
            } else {
                // Player doesn't have account - give instructions
                prizeMsg += `To claim your prize:\n`;
                prizeMsg += `1️⃣ Register on What's Up Trivia (send "Hello")\n`;
                prizeMsg += `2️⃣ Add your bank details\n`;
                prizeMsg += `3️⃣ Send CLAIM to withdraw\n\n`;
                prizeMsg += `Or contact us with code: *${booking.booking_code}*\n`;
                
                // Store unclaimed prize
                await pool.query(`
                    INSERT INTO love_quest_audit (booking_id, session_id, event_type, event_data, actor_type)
                    VALUES ($1, $2, 'cash_prize_pending', $3, 'system')
                `, [booking.id, session.id, JSON.stringify({ amount, playerPhone: session.player_phone })]);
            }
            
            await messagingService.sendMessage(session.player_phone, prizeMsg);
            
        } catch (error) {
            logger.error('Error handling cash prize reveal:', error);
        }
    }

    async notifyCreatorOfCompletion(session, booking, messagingService) {
        try {
            const playerName = booking.player_name || 'Your partner';
            const score = Math.min(session.score || 0, 1000); // Cap at 1000
            
            let msg = `💘 *Love Quest Complete!* 💘\n\n`;
            msg += `${playerName} just finished your Love Quest!\n\n`;
            msg += `📊 *Results:*\n`;
            msg += `Score: ${score}/1000 Love Points\n`;
            
            if (score >= 900) {
                msg += `Rating: 🏆 PERFECT LOVE!\n\n`;
                msg += `They know you inside out! 💕`;
            } else if (score >= 700) {
                msg += `Rating: ❤️ DEEPLY IN LOVE!\n\n`;
                msg += `Your bond is strong! 💕`;
            } else if (score >= 500) {
                msg += `Rating: 💛 GROWING LOVE!\n\n`;
                msg += `Room to make more memories! 💕`;
            } else {
                msg += `Rating: 💗 LOVE IN BLOOM!\n\n`;
                msg += `Time for more adventures together! 💕`;
            }
            
            msg += `\n\n_Thank you for choosing What's Up Trivia!_`;
            
            await messagingService.sendMessage(booking.creator_phone, msg);
            
        } catch (error) {
            logger.error('Error notifying creator:', error);
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
            
            // Normalize phone number for WhatsApp
            let playerPhone = booking.player_phone;
            
            // Log original phone for debugging
            logger.info(`📞 Original player phone: ${playerPhone}`);
            
            // Normalize: remove +, spaces, dashes
            playerPhone = playerPhone.replace(/[\s\-\+]/g, '');
            
            // If starts with 0, assume Nigeria and add 234
            if (playerPhone.startsWith('0')) {
                playerPhone = '234' + playerPhone.substring(1);
            }
            
            // If it's too short (missing country code), add 234
            if (playerPhone.length === 10) {
                playerPhone = '234' + playerPhone;
            }
            
            logger.info(`📞 Normalized player phone: ${playerPhone}`);
            
            const creatorName = booking.creator_name || (booking.language === 'es' ? 'Alguien especial' : 'Someone special');
            const t = getTranslations(booking.language);
            
            let message = `${t.invitation_title}\n\n`;
            message += `${t.invitation_body(creatorName)}\n\n`;
            message += `${t.invitation_features}\n\n`;
            message += t.invitation_cta;
            
            const sendResult = await messagingService.sendMessage(playerPhone, message);
            logger.info(`📤 Invitation send result:`, sendResult);
            
            // Update booking status and normalize phone in DB
            await pool.query(`
                UPDATE love_quest_bookings 
                SET status = 'sent', invitation_sent_at = NOW(), player_phone = $1
                WHERE id = $2
            `, [playerPhone, bookingId]);
            
            // Set expiry (48 hours to complete)
            await pool.query(`
                UPDATE love_quest_bookings 
                SET expires_at = NOW() + INTERVAL '48 hours'
                WHERE id = $1
            `, [bookingId]);
            
            await this.logAuditEvent(bookingId, null, 'invitation_sent', {
                player: playerPhone,
                originalPhone: booking.player_phone
            }, 'system', null);
            
            logger.info(`💘 Love Quest invitation sent: ${booking.booking_code} → ${playerPhone}`);
            
            return true;
        } catch (error) {
            logger.error('Error sending invitation:', error);
            throw error;
        }
    }

    // ============================================
    // HELPERS
    // ============================================

    getDefaultWrongResponse(playerName, language = 'en') {
        const t = getTranslations(language);
        const responses = t.wrong_responses(playerName);
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

    // Get active booking by creator phone (for voice note auto-detection)
    async getActiveBookingByCreator(phone) {
        try {
            const result = await pool.query(`
                SELECT * FROM love_quest_bookings 
                WHERE creator_phone = $1 
                AND status IN ('paid', 'curating')
                ORDER BY created_at DESC
                LIMIT 1
            `, [phone]);
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting active booking by creator:', error);
            return null;
        }
    }

    // Generate Paystack payment link
    async generatePaystackLink(bookingId, email, amount) {
        try {
            const booking = await this.getBooking(bookingId);
            if (!booking) throw new Error('Booking not found');
            
            // Use PaymentService's Paystack instance (same as token purchases)
            const PaymentService = require('./payment.service');
            const paymentService = new PaymentService();
            
            // Use booking code as reference
            const reference = `LQ-${booking.booking_code}-${Date.now()}`;
            
            logger.info(`💳 Generating Paystack link for booking ${booking.booking_code}, amount: ${amount}`);
            
            // Initialize Paystack transaction using PaymentService's paystack instance
            const response = await paymentService.paystack.transaction.initialize({
                email: email || `${booking.creator_phone}@lovequest.whatsuptrivia.com`,
                amount: Math.round(amount * 100), // Paystack uses kobo
                reference,
                callback_url: `${process.env.APP_URL || 'https://whatsuptrivia.com.ng'}/payment/callback`,
                metadata: {
                    booking_id: bookingId,
                    booking_code: booking.booking_code,
                    type: 'love_quest',
                    creator_phone: booking.creator_phone,
                    custom_fields: [
                        {
                            display_name: "Booking Code",
                            variable_name: "booking_code",
                            value: booking.booking_code
                        },
                        {
                            display_name: "Package",
                            variable_name: "package",
                            value: booking.package
                        }
                    ]
                },
                channels: ['card', 'bank', 'ussd', 'mobile_money']
            });
            
            logger.info(`💳 Paystack response:`, JSON.stringify(response?.data || response));
            
            if (response?.data?.authorization_url) {
                await pool.query(`
                    UPDATE love_quest_bookings 
                    SET paystack_reference = $1, paystack_access_code = $2
                    WHERE id = $3
                `, [reference, response.data.access_code, bookingId]);
                
                logger.info(`💳 Paystack link generated for Love Quest ${booking.booking_code}: ${response.data.authorization_url}`);
                
                return response.data.authorization_url;
            }
            
            logger.error(`💳 Paystack returned no authorization_url:`, response);
            return null;
        } catch (error) {
            logger.error('Error generating Paystack link:', error);
            return null;
        }
    }

    // Verify Paystack payment
    async verifyPaystackPayment(reference) {
        try {
            const PaymentService = require('./payment.service');
            const paymentService = new PaymentService();
            
            const verification = await paymentService.verifyPaystackTransaction(reference);
            
            if (verification?.data?.status === 'success') {
                const metadata = verification.data.metadata;
                const bookingId = metadata?.booking_id;
                
                if (bookingId) {
                    // Update booking as paid
                    await pool.query(`
                        UPDATE love_quest_bookings 
                        SET total_paid = $1, status = 'paid', payment_method = 'paystack', payment_reference = $2
                        WHERE id = $3
                    `, [verification.data.amount / 100, reference, bookingId]);
                    
                    // Record payment
                    await pool.query(`
                        INSERT INTO love_quest_payments (booking_id, amount, currency, payment_method, paystack_reference, status, confirmed_at, confirmed_by)
                        VALUES ($1, $2, 'NGN', 'paystack', $3, 'confirmed', NOW(), 'paystack_webhook')
                    `, [bookingId, verification.data.amount / 100, reference]);
                    
                    await this.logAuditEvent(bookingId, null, 'payment_confirmed', {
                        amount: verification.data.amount / 100,
                        reference,
                        method: 'paystack'
                    }, 'system', 'paystack');
                    
                    return { success: true, bookingId };
                }
            }
            
            return { success: false };
        } catch (error) {
            logger.error('Error verifying Paystack payment:', error);
            return { success: false, error: error.message };
        }
    }

    // Save video (intro)
    async saveVideo(bookingCode, mediaId, purpose = 'intro') {
        try {
            const booking = await this.getBookingByCode(bookingCode);
            if (!booking) throw new Error('Booking not found');
            
            // Download video from WhatsApp
            const media = await this.downloadWhatsAppMedia(mediaId);
            if (!media || !media.buffer) throw new Error('Failed to download video');
            
            // Determine file extension
            const ext = media.mimeType?.includes('mp4') ? 'mp4' 
                      : media.mimeType?.includes('3gpp') ? '3gp'
                      : media.mimeType?.includes('webm') ? 'webm'
                      : 'mp4';
            
            // Save file
            const filename = `${purpose}_video_${Date.now()}.${ext}`;
            const bookingDir = path.join(this.uploadDir, booking.booking_code);
            
            if (!fs.existsSync(bookingDir)) {
                fs.mkdirSync(bookingDir, { recursive: true });
            }
            
            const filePath = path.join(bookingDir, filename);
            fs.writeFileSync(filePath, media.buffer);
            
            // Get file stats
            const stats = fs.statSync(filePath);
            
            // Save to media table (UPSERT - update if exists)
            const result = await pool.query(`
                INSERT INTO love_quest_media (booking_id, media_type, media_purpose, file_path, file_size, mime_type, uploaded_by)
                VALUES ($1, 'video', $2, $3, $4, $5, 'creator')
                ON CONFLICT (booking_id, media_type, media_purpose) 
                DO UPDATE SET 
                    file_path = EXCLUDED.file_path,
                    file_size = EXCLUDED.file_size,
                    mime_type = EXCLUDED.mime_type,
                    uploaded_at = NOW()
                RETURNING *
            `, [booking.id, purpose, filePath, stats.size, media.mimeType || 'video/mp4']);
            
            // Update booking
            if (purpose === 'intro') {
                await pool.query(
                    'UPDATE love_quest_bookings SET intro_video_url = $1 WHERE id = $2',
                    [filePath, booking.id]
                );
            }
            
            await this.logAuditEvent(booking.id, null, 'video_uploaded', {
                purpose, filePath, size: stats.size
            }, 'creator', booking.creator_phone);
            
            logger.info(`🎬 Video saved for ${bookingCode}: ${purpose} (${stats.size} bytes)`);
            
            return result.rows[0];
        } catch (error) {
            logger.error('Error saving video:', error);
            throw error;
        }
    }

    async getBookingByCode(bookingCode) {
        return this.getBooking(bookingCode);
    }

    // For scheduled sending
    async getScheduledBookings() {
        try {
            const result = await pool.query(`
                SELECT * FROM love_quest_bookings 
                WHERE status = 'scheduled' 
                AND scheduled_send_at <= NOW()
                AND scheduled_send_at > NOW() - INTERVAL '1 hour'
            `);
            return result.rows;
        } catch (error) {
            logger.error('Error getting scheduled bookings:', error);
            return [];
        }
    }

    // Schedule a booking to send at specific time
    async scheduleBooking(bookingId, sendAt) {
        try {
            await pool.query(`
                UPDATE love_quest_bookings 
                SET status = 'scheduled', scheduled_send_at = $1
                WHERE id = $2
            `, [sendAt, bookingId]);
            
            await this.logAuditEvent(bookingId, null, 'booking_scheduled', {
                sendAt
            }, 'admin', null);
            
            return true;
        } catch (error) {
            logger.error('Error scheduling booking:', error);
            return false;
        }
    }

    // Handle continue after milestone
    async handleContinue(session, booking, messagingService) {
        try {
            // Clear waiting state
            await pool.query(
                'UPDATE love_quest_sessions SET waiting_for_continue = false WHERE id = $1',
                [session.id]
            );
            
            // Send next question
            await this.sendQuestion(session, booking, messagingService);
        } catch (error) {
            logger.error('Error handling continue:', error);
        }
    }

    // Get media by purpose
    async getMediaByPurpose(bookingId, purpose, mediaType = null) {
        try {
            let query = 'SELECT * FROM love_quest_media WHERE booking_id = $1 AND media_purpose = $2';
            const params = [bookingId, purpose];
            
            if (mediaType) {
                query += ' AND media_type = $3';
                params.push(mediaType);
            }
            
            const result = await pool.query(query, params);
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting media by purpose:', error);
            return null;
        }
    }

    // Get media by ID
    async getMediaById(mediaId) {
        try {
            const result = await pool.query('SELECT * FROM love_quest_media WHERE id = $1', [mediaId]);
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting media by id:', error);
            return null;
        }
    }

    // Delete media
    async deleteMedia(mediaId) {
        try {
            const media = await this.getMediaById(mediaId);
            if (media && media.file_path && fs.existsSync(media.file_path)) {
                fs.unlinkSync(media.file_path);
            }
            await pool.query('DELETE FROM love_quest_media WHERE id = $1', [mediaId]);
            return true;
        } catch (error) {
            logger.error('Error deleting media:', error);
            return false;
        }
    }

    // Upload media from admin
    async uploadMediaFromAdmin(bookingId, purpose, mediaType, fileBuffer, originalName) {
        try {
            const ext = mediaType === 'video' ? '.mp4' : '.ogg';
            const fileName = `${bookingId}_${purpose}_${Date.now()}${ext}`;
            const filePath = path.join(this.uploadDir, fileName);
            
            logger.info(`🎬 Admin upload: type=${mediaType}, purpose=${purpose}, bufferSize=${fileBuffer.length}, originalName=${originalName}`);
            
            if (mediaType === 'video') {
                // Save original file temporarily (sanitize filename to avoid path issues)
                const safeName = `temp_${bookingId}_${Date.now()}`;
                const tempPath = path.join(this.uploadDir, safeName);
                fs.writeFileSync(tempPath, fileBuffer);
                
                const tempStats = fs.statSync(tempPath);
                logger.info(`🎬 Temp file saved: ${tempPath}, size=${tempStats.size}`);
                
                // Probe the original file
                const { execSync } = require('child_process');
                try {
                    const probe = execSync(`ffprobe -v error -show_entries format=format_name,duration -show_entries stream=codec_name,codec_type,width,height -of json "${tempPath}"`, { timeout: 10000 });
                    logger.info(`🎬 Original file probe: ${probe.toString().trim()}`);
                } catch (probeErr) {
                    logger.warn(`⚠️ Original file probe failed: ${probeErr.message}`);
                }
                
                // Convert to WhatsApp-compatible MP4 (H.264 + AAC)
                try {
                    const output = execSync(
                        `ffmpeg -i "${tempPath}" -c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart -y "${filePath}" 2>&1`,
                        { timeout: 120000 }
                    );
                    logger.info(`🎬 ffmpeg output: ${output.toString().substring(0, 500)}`);
                    
                    const convertedStats = fs.statSync(filePath);
                    logger.info(`🎬 Converted file: ${filePath}, size=${convertedStats.size}`);
                    
                    // Probe converted file
                    try {
                        const convertedProbe = execSync(`ffprobe -v error -show_entries stream=codec_name,codec_type,width,height -of json "${filePath}"`, { timeout: 10000 });
                        logger.info(`🎬 Converted file probe: ${convertedProbe.toString().trim()}`);
                    } catch (e) {
                        logger.warn(`⚠️ Converted file probe failed: ${e.message}`);
                    }
                } catch (ffmpegErr) {
                    logger.error(`❌ ffmpeg conversion failed: ${ffmpegErr.stdout?.toString() || ffmpegErr.message}`);
                    // Fallback: save original file as-is
                    fs.copyFileSync(tempPath, filePath);
                    logger.warn('⚠️ Using original unconverted file as fallback');
                }
                
                // Clean up temp file
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } else {
                fs.writeFileSync(filePath, fileBuffer);
            }
            
            const result = await pool.query(`
                INSERT INTO love_quest_media (booking_id, media_type, media_purpose, file_path, mime_type, uploaded_by, original_filename)
                VALUES ($1, $2, $3, $4, $5, 'admin', $6)
                ON CONFLICT (booking_id, media_type, media_purpose) DO UPDATE SET
                    file_path = EXCLUDED.file_path,
                    original_filename = EXCLUDED.original_filename,
                    uploaded_at = NOW()
                RETURNING *
            `, [bookingId, mediaType, purpose, filePath, mediaType === 'video' ? 'video/mp4' : 'audio/ogg', originalName]);
            
            return result.rows[0];
        } catch (error) {
            logger.error('Error uploading media from admin:', error);
            throw error;
        }
    }

    // Update booking participants
    async updateBookingParticipants(bookingId, { creatorName, creatorPhone, playerName, playerPhone }) {
        try {
            // Get booking to check if international
            const booking = await this.getBooking(bookingId);
            const isInternational = booking?.package === 'international';
            
            // Normalize phone numbers if provided
            const normalizedCreatorPhone = creatorPhone ? this.normalizePhone(creatorPhone, isInternational) : null;
            const normalizedPlayerPhone = playerPhone ? this.normalizePhone(playerPhone, isInternational) : null;
            
            await pool.query(`
                UPDATE love_quest_bookings 
                SET creator_name = COALESCE($1, creator_name),
                    creator_phone = COALESCE($2, creator_phone),
                    player_name = COALESCE($3, player_name),
                    player_phone = COALESCE($4, player_phone),
                    updated_at = NOW()
                WHERE id = $5
            `, [creatorName, normalizedCreatorPhone, playerName, normalizedPlayerPhone, bookingId]);
            return true;
        } catch (error) {
            logger.error('Error updating booking participants:', error);
            return false;
        }
    }

    // Send video
    async sendVideo(phone, filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                logger.warn('Video file not found:', filePath);
                return false;
            }
            const stats = fs.statSync(filePath);
            logger.info(`🎬 sendVideo: file=${filePath}, size=${stats.size} bytes`);
            
            // Verify the file is a valid video by checking with ffmpeg
            const { execSync } = require('child_process');
            try {
                const probe = execSync(`ffprobe -v error -show_entries format=format_name,duration -show_entries stream=codec_name,codec_type,width,height -of json "${filePath}"`, { timeout: 10000 });
                logger.info(`🎬 Video probe: ${probe.toString().trim()}`);
            } catch (probeErr) {
                logger.warn(`⚠️ ffprobe failed: ${probeErr.message}`);
            }
            
            const MessagingService = require('./messaging.service');
            const messagingService = new MessagingService();
            const videoBuffer = fs.readFileSync(filePath);
            logger.info(`🎬 Sending ${videoBuffer.length} byte video buffer to ${phone}`);
            await messagingService.sendVideo(phone, videoBuffer);
            return true;
        } catch (error) {
            logger.error('Error sending video:', error);
            return false;
        }
    }

    // Demo content generator
    async generateDemoContent(bookingId) {
        const DEMO_QUESTIONS = [
            { q: "What's my favorite color?", a: "Blue", b: "Red", c: "Green", d: "Purple", correct: "A", correct_resp: "You know me so well! 💙", wrong_resp: "Hmm, pay more attention! 😅" },
            { q: "Where did we have our first date?", a: "A restaurant", b: "A movie theater", c: "A park", d: "At home", correct: "A", correct_resp: "That magical evening! 🍽️💕", wrong_resp: "How could you forget?! 😭" },
            { q: "What's my favorite food?", a: "Pizza", b: "Jollof Rice", c: "Pasta", d: "Sushi", correct: "B", correct_resp: "You've been paying attention! 🍚", wrong_resp: "Come on, you know this! 🙈" },
            { q: "What do I do when I'm stressed?", a: "Sleep", b: "Exercise", c: "Listen to music", d: "Eat snacks", correct: "C", correct_resp: "Music is my therapy! 🎵", wrong_resp: "Oops, wrong answer love! 💔" },
            { q: "What's my dream vacation spot?", a: "Paris", b: "Maldives", c: "Dubai", d: "Santorini", correct: "B", correct_resp: "Beach paradise awaits! 🏝️", wrong_resp: "Let's plan more trips! ✈️" },
            { q: "What movie did we first watch together?", a: "A comedy", b: "A romance", c: "Action movie", d: "Horror film", correct: "B", correct_resp: "So romantic! 🎬💕", wrong_resp: "Time for a movie marathon! 📺" },
            { q: "What's my love language?", a: "Words of affirmation", b: "Quality time", c: "Gifts", d: "Physical touch", correct: "D", correct_resp: "Hugs are the best! 🤗", wrong_resp: "Read up on love languages! 📖" },
            { q: "What song reminds me of us?", a: "Perfect - Ed Sheeran", b: "All of Me - John Legend", c: "Thinking Out Loud", d: "A Thousand Years", correct: "B", correct_resp: "All of me loves all of you! 🎤", wrong_resp: "Let's make a playlist! 🎶" },
            { q: "What's my biggest pet peeve?", a: "Lateness", b: "Loud chewing", c: "Dishonesty", d: "Messiness", correct: "A", correct_resp: "Time is precious! ⏰", wrong_resp: "Still learning about each other! 💝" },
            { q: "What do I want us to do more?", a: "Travel", b: "Cook together", c: "Date nights", d: "All of the above", correct: "D", correct_resp: "Everything with you is perfect! 💕", wrong_resp: "MORE time together! 🥰" },
            { q: "What's my favorite thing about you?", a: "Your smile", b: "Your laugh", c: "Your kindness", d: "Everything", correct: "D", correct_resp: "You're perfect to me! ❤️", wrong_resp: "Hint: I love EVERYTHING! 😘" },
            { q: "How do I like my morning coffee?", a: "Black", b: "With milk", c: "Very sweet", d: "I don't drink it", correct: "C", correct_resp: "Sweet like you! ☕", wrong_resp: "Pay attention at breakfast! 🌅" },
            { q: "Longest we've gone without talking?", a: "A few hours", b: "A day", c: "A week", d: "Never more than hours", correct: "D", correct_resp: "Can't stay away! 📱💕", wrong_resp: "We talk ALL the time! 📞" },
            { q: "What do I call you in my phone?", a: "Your name", b: "Baby/Babe", c: "Special nickname", d: "My Love", correct: "C", correct_resp: "Only you have that name! 📱", wrong_resp: "Check my phone sometime! 😏" },
            { q: "What's our couple goal?", a: "Travel the world", b: "Build a home", c: "Grow old together", d: "All of the above", correct: "D", correct_resp: "Forever with you! 💍", wrong_resp: "We want it ALL together! 🏠✈️👴👵" }
        ];

        try {
            const booking = await this.getBooking(bookingId);
            if (!booking) throw new Error('Booking not found');
            
            const questionCount = booking.question_count || 10;
            const playerName = booking.player_name || 'Love';
            
            // Delete existing questions
            await pool.query('DELETE FROM love_quest_questions WHERE booking_id = $1', [bookingId]);
            
            // Generate questions
            for (let i = 0; i < Math.min(questionCount, DEMO_QUESTIONS.length); i++) {
                const demo = DEMO_QUESTIONS[i];
                const isMilestone = (i + 1) === 5 || (i + 1) === 10;
                
                await this.addQuestion(bookingId, {
                    questionNumber: i + 1,
                    questionText: demo.q,
                    optionA: demo.a,
                    optionB: demo.b,
                    optionC: demo.c,
                    optionD: demo.d,
                    correctAnswer: demo.correct,
                    correctResponse: demo.correct_resp,
                    genericWrongResponse: demo.wrong_resp,
                    milestonePrizeText: isMilestone ? `🎁 Demo Milestone for Q${i + 1}!` : null,
                    milestonePrizeCash: isMilestone ? 500 : 0,
                    hintText: `Think about our memories, ${playerName}...`
                });
            }
            
            // Set demo grand reveal
            await pool.query(`
                UPDATE love_quest_bookings 
                SET grand_reveal_text = $1, updated_at = NOW()
                WHERE id = $2
            `, [`${playerName}, this was a DEMO Love Quest! 💕\n\nIn a real one, this would be a heartfelt message from your special someone.\n\nCreate your own at whatsuptrivia.com.ng/love-quest! 💘`, bookingId]);
            
            await this.logAuditEvent(bookingId, null, 'demo_generated', { questionCount }, 'admin', null);
            
            return { success: true, questionsGenerated: Math.min(questionCount, DEMO_QUESTIONS.length) };
        } catch (error) {
            logger.error('Error generating demo content:', error);
            throw error;
        }
    }
}

module.exports = new LoveQuestService();