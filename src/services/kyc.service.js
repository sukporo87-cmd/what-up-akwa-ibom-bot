// ============================================
// FILE: src/services/kyc.service.js
// Handles: KYC verification workflow
// Trigger: Daily cumulative winnings >= ₦20,000
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class KYCService {
    constructor() {
        this.KYC_THRESHOLD = parseInt(process.env.KYC_THRESHOLD) || 20000;
        this.VALID_ID_TYPES = ['nin', 'voters_card', 'drivers_license', 'passport', 'national_id'];
    }
    
    // ============================================
    // CHECK IF KYC REQUIRED
    // ============================================
    
    async checkKYCRequired(userId) {
        try {
            // Get user's KYC status
            const userResult = await pool.query(`
                SELECT kyc_status, is_kyc_blocked FROM users WHERE id = $1
            `, [userId]);
            
            if (!userResult.rows.length) {
                return { required: false };
            }
            
            const user = userResult.rows[0];
            
            // Already approved
            if (user.kyc_status === 'approved') {
                return { required: false, status: 'approved' };
            }
            
            // Already blocked pending KYC
            if (user.is_kyc_blocked) {
                return { 
                    required: true, 
                    status: 'blocked',
                    message: this.getKYCBlockedMessage()
                };
            }
            
            // Check daily winnings
            const dailyWinnings = await this.getDailyWinnings(userId);
            
            if (dailyWinnings >= this.KYC_THRESHOLD) {
                return {
                    required: true,
                    status: 'threshold_exceeded',
                    dailyWinnings,
                    threshold: this.KYC_THRESHOLD,
                    message: this.getKYCRequiredMessage(dailyWinnings)
                };
            }
            
            return { required: false, dailyWinnings };
        } catch (error) {
            logger.error('Error checking KYC required:', error);
            return { required: false };
        }
    }
    
    // ============================================
    // GET DAILY WINNINGS
    // ============================================
    
    async getDailyWinnings(userId) {
        try {
            const result = await pool.query(`
                SELECT COALESCE(SUM(amount), 0) as total
                FROM transactions
                WHERE user_id = $1
                AND transaction_type = 'prize'
                AND payment_status = 'success'
                AND DATE(created_at) = CURRENT_DATE
            `, [userId]);
            
            return parseFloat(result.rows[0].total);
        } catch (error) {
            logger.error('Error getting daily winnings:', error);
            return 0;
        }
    }
    
    // ============================================
    // TRIGGER KYC REQUIREMENT
    // ============================================
    
    async triggerKYCRequirement(userId, triggerReason, triggerAmount) {
        try {
            // Check if there's already a pending KYC
            const existingKYC = await pool.query(`
                SELECT id, status FROM kyc_verifications
                WHERE user_id = $1 AND status IN ('pending', 'submitted')
                ORDER BY created_at DESC LIMIT 1
            `, [userId]);
            
            if (existingKYC.rows.length > 0) {
                // Already has pending KYC
                return { success: true, existing: true, kycId: existingKYC.rows[0].id };
            }
            
            // Create new KYC requirement
            const result = await pool.query(`
                INSERT INTO kyc_verifications (user_id, trigger_reason, trigger_amount, status)
                VALUES ($1, $2, $3, 'pending')
                RETURNING id
            `, [userId, triggerReason, triggerAmount]);
            
            // Block user from claiming until KYC
            await pool.query(`
                UPDATE users 
                SET kyc_status = 'required', is_kyc_blocked = true
                WHERE id = $1
            `, [userId]);
            
            logger.info(`KYC triggered for user ${userId}: ${triggerReason} (₦${triggerAmount})`);
            
            return { success: true, kycId: result.rows[0].id };
        } catch (error) {
            logger.error('Error triggering KYC requirement:', error);
            return { success: false, error: error.message };
        }
    }
    
    // ============================================
    // SUBMIT KYC DOCUMENTS
    // ============================================
    
    async submitKYCDocuments(userId, documents) {
        try {
            const { idType, idNumber, idImageUrl, selfieImageUrl } = documents;
            
            // Validate ID type
            if (!this.VALID_ID_TYPES.includes(idType)) {
                return { success: false, error: 'Invalid ID type' };
            }
            
            // Get pending KYC
            const kycResult = await pool.query(`
                SELECT id FROM kyc_verifications
                WHERE user_id = $1 AND status = 'pending'
                ORDER BY created_at DESC LIMIT 1
            `, [userId]);
            
            if (!kycResult.rows.length) {
                return { success: false, error: 'No pending KYC verification found' };
            }
            
            const kycId = kycResult.rows[0].id;
            
            // Update KYC with documents
            await pool.query(`
                UPDATE kyc_verifications
                SET id_type = $1, id_number = $2, id_image_url = $3, 
                    selfie_image_url = $4, status = 'submitted', submitted_at = NOW()
                WHERE id = $5
            `, [idType, idNumber, idImageUrl, selfieImageUrl, kycId]);
            
            // Update user status
            await pool.query(`
                UPDATE users SET kyc_status = 'submitted' WHERE id = $1
            `, [userId]);
            
            logger.info(`KYC documents submitted for user ${userId}`);
            
            return { success: true, kycId };
        } catch (error) {
            logger.error('Error submitting KYC documents:', error);
            return { success: false, error: error.message };
        }
    }
    
    // ============================================
    // APPROVE KYC
    // ============================================
    
    async approveKYC(kycId, adminId, notes = null) {
        try {
            // Get KYC details
            const kycResult = await pool.query(`
                SELECT user_id FROM kyc_verifications WHERE id = $1
            `, [kycId]);
            
            if (!kycResult.rows.length) {
                return { success: false, error: 'KYC not found' };
            }
            
            const userId = kycResult.rows[0].user_id;
            
            // Update KYC status
            await pool.query(`
                UPDATE kyc_verifications
                SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1, notes = $2
                WHERE id = $3
            `, [adminId, notes, kycId]);
            
            // Update user - unblock and mark as verified
            await pool.query(`
                UPDATE users
                SET kyc_status = 'approved', is_kyc_blocked = false, kyc_verified_at = NOW()
                WHERE id = $1
            `, [userId]);
            
            logger.info(`KYC approved for user ${userId} by admin ${adminId}`);
            
            return { success: true, userId };
        } catch (error) {
            logger.error('Error approving KYC:', error);
            return { success: false, error: error.message };
        }
    }
    
    // ============================================
    // REJECT KYC
    // ============================================
    
    async rejectKYC(kycId, adminId, rejectionReason) {
        try {
            // Get KYC details
            const kycResult = await pool.query(`
                SELECT user_id FROM kyc_verifications WHERE id = $1
            `, [kycId]);
            
            if (!kycResult.rows.length) {
                return { success: false, error: 'KYC not found' };
            }
            
            const userId = kycResult.rows[0].user_id;
            
            // Update KYC status
            await pool.query(`
                UPDATE kyc_verifications
                SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $1, 
                    rejection_reason = $2
                WHERE id = $3
            `, [adminId, rejectionReason, kycId]);
            
            // Create new pending KYC for resubmission
            await pool.query(`
                INSERT INTO kyc_verifications (user_id, trigger_reason, status)
                VALUES ($1, 'resubmission_required', 'pending')
            `, [userId]);
            
            // User remains blocked
            await pool.query(`
                UPDATE users SET kyc_status = 'rejected' WHERE id = $1
            `, [userId]);
            
            logger.info(`KYC rejected for user ${userId} by admin ${adminId}: ${rejectionReason}`);
            
            return { success: true, userId };
        } catch (error) {
            logger.error('Error rejecting KYC:', error);
            return { success: false, error: error.message };
        }
    }
    
    // ============================================
    // GET KYC STATUS
    // ============================================
    
    async getKYCStatus(userId) {
        try {
            const result = await pool.query(`
                SELECT kv.*, u.kyc_status as user_kyc_status, u.is_kyc_blocked
                FROM kyc_verifications kv
                RIGHT JOIN users u ON kv.user_id = u.id
                WHERE u.id = $1
                ORDER BY kv.created_at DESC
                LIMIT 1
            `, [userId]);
            
            if (!result.rows.length) {
                return null;
            }
            
            return result.rows[0];
        } catch (error) {
            logger.error('Error getting KYC status:', error);
            return null;
        }
    }
    
    // ============================================
    // GET PENDING KYC REVIEWS (Admin)
    // ============================================
    
    async getPendingKYCReviews() {
        try {
            const result = await pool.query(`
                SELECT kv.*, u.username, u.full_name, u.phone_number, u.city,
                       (SELECT COALESCE(SUM(amount), 0) FROM transactions 
                        WHERE user_id = u.id AND transaction_type = 'prize') as total_winnings
                FROM kyc_verifications kv
                JOIN users u ON kv.user_id = u.id
                WHERE kv.status = 'submitted'
                ORDER BY kv.submitted_at ASC
            `);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting pending KYC reviews:', error);
            return [];
        }
    }
    
    // ============================================
    // GET ALL KYC RECORDS (Admin)
    // ============================================
    
    async getAllKYCRecords(status = null, limit = 50, offset = 0) {
        try {
            let query = `
                SELECT kv.*, u.username, u.full_name, u.phone_number
                FROM kyc_verifications kv
                JOIN users u ON kv.user_id = u.id
            `;
            const params = [];
            let paramIndex = 1;
            
            if (status) {
                query += ` WHERE kv.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }
            
            query += ` ORDER BY kv.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);
            
            const result = await pool.query(query, params);
            return result.rows;
        } catch (error) {
            logger.error('Error getting all KYC records:', error);
            return [];
        }
    }
    
    // ============================================
    // MESSAGE TEMPLATES
    // ============================================
    
    getKYCRequiredMessage(dailyWinnings) {
        return `🎉 *CONGRATULATIONS ON YOUR WINS!* 🎉\n\n` +
               `Your total winnings today: *₦${dailyWinnings.toLocaleString()}*\n\n` +
               `📋 *VERIFICATION REQUIRED*\n\n` +
               `For security and to comply with regulations, we need to verify your identity before processing further withdrawals.\n\n` +
               `Please provide:\n` +
               `1️⃣ Photo of valid ID (NIN, Voter's Card, Driver's License, or Passport)\n` +
               `2️⃣ A selfie holding your ID\n\n` +
               `Send these images to complete verification.\n\n` +
               `_Your winnings are safe and will be released once verified._`;
    }
    
    getKYCBlockedMessage() {
        return `⚠️ *VERIFICATION PENDING* ⚠️\n\n` +
               `Your account requires identity verification before you can claim prizes.\n\n` +
               `Please submit:\n` +
               `1️⃣ Photo of valid ID\n` +
               `2️⃣ Selfie holding your ID\n\n` +
               `Send these images to proceed.\n\n` +
               `_You can continue playing, but cannot claim until verified._`;
    }
    
    getKYCSubmittedMessage() {
        return `✅ *DOCUMENTS RECEIVED* ✅\n\n` +
               `Thank you for submitting your verification documents.\n\n` +
               `Our team will review them within 24 hours.\n\n` +
               `You will be notified once verification is complete.\n\n` +
               `_You can continue playing while we verify._`;
    }
    
    getKYCApprovedMessage() {
        return `🎉 *VERIFICATION APPROVED* 🎉\n\n` +
               `Your identity has been verified successfully!\n\n` +
               `You can now claim all your prizes.\n\n` +
               `Reply *CLAIM* to proceed with your withdrawal.`;
    }
    
    getKYCRejectedMessage(reason) {
        return `❌ *VERIFICATION UNSUCCESSFUL* ❌\n\n` +
               `Unfortunately, we couldn't verify your documents.\n\n` +
               `*Reason:* ${reason}\n\n` +
               `Please submit new, clear photos of:\n` +
               `1️⃣ Your valid ID\n` +
               `2️⃣ Selfie holding your ID\n\n` +
               `_Make sure the images are clear and all details are visible._`;
    }
    
    // ============================================
    // CHECK IF USER CAN CLAIM
    // ============================================
    
    async canUserClaim(userId) {
        try {
            const user = await pool.query(`
                SELECT is_kyc_blocked, kyc_status FROM users WHERE id = $1
            `, [userId]);
            
            if (!user.rows.length) {
                return { canClaim: false, reason: 'user_not_found' };
            }
            
            if (user.rows[0].is_kyc_blocked) {
                return { 
                    canClaim: false, 
                    reason: 'kyc_required',
                    message: this.getKYCBlockedMessage()
                };
            }
            
            return { canClaim: true };
        } catch (error) {
            logger.error('Error checking if user can claim:', error);
            return { canClaim: true }; // Default to allow in case of error
        }
    }
    
    // ============================================
    // PROCESS IMAGE UPLOAD (Placeholder)
    // ============================================
    
    async processImageUpload(userId, imageBuffer, imageType) {
        // In production, you would:
        // 1. Upload to cloud storage (S3, Cloudinary, etc.)
        // 2. Return the URL
        // For now, return a placeholder
        
        // This would be implemented based on your storage solution
        logger.info(`Image upload requested for user ${userId}: ${imageType}`);
        
        return {
            success: true,
            url: `https://storage.example.com/kyc/${userId}/${imageType}_${Date.now()}.jpg`
        };
    }
}

module.exports = new KYCService();