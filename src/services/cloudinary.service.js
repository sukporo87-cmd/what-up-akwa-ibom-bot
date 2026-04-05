// ============================================
// FILE: src/services/cloudinary.service.js
// Handles photo verification image uploads to Cloudinary
// ============================================

const { v2: cloudinary } = require('cloudinary');
const { logger } = require('../utils/logger');

// Cloudinary auto-configures from CLOUDINARY_URL environment variable
// Format: cloudinary://<api_key>:<api_secret>@<cloud_name>

class CloudinaryService {

    /**
     * Upload a photo verification image buffer to Cloudinary.
     * Returns the secure URL or null on failure.
     */
    async uploadVerificationPhoto(buffer, userId, sessionId) {
        try {
            const filename = `pv_${userId}_${sessionId}_${Date.now()}`;

            const result = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    {
                        folder: 'whatsup-trivia/photo-verifications',
                        public_id: filename,
                        resource_type: 'image',
                        overwrite: false,
                        transformation: [
                            { quality: 'auto:good', fetch_format: 'auto' }
                        ]
                    },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                stream.end(buffer);
            });

            logger.info(`📸 Photo uploaded to Cloudinary: ${result.secure_url}`);
            return result.secure_url;

        } catch (error) {
            logger.error('Error uploading to Cloudinary:', error.message);
            return null;
        }
    }

    /**
     * Delete a photo from Cloudinary by its public ID.
     */
    async deletePhoto(publicId) {
        try {
            await cloudinary.uploader.destroy(publicId);
            logger.info(`Photo deleted from Cloudinary: ${publicId}`);
            return true;
        } catch (error) {
            logger.error('Error deleting from Cloudinary:', error.message);
            return false;
        }
    }
}

module.exports = new CloudinaryService();