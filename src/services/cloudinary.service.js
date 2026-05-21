// ============================================
// FILE: src/services/cloudinary.service.js
// Handles photo verification image uploads to Cloudinary
// ============================================

const { logger } = require('../utils/logger');

// The Cloudinary SDK auto-reads CLOUDINARY_URL on require() and crashes
// if the format is even slightly off. We unset it before requiring,
// then configure manually.
const cloudinaryUrl = process.env.CLOUDINARY_URL || '';
delete process.env.CLOUDINARY_URL;

const { v2: cloudinary } = require('cloudinary');

// Parse and configure manually
// Format: cloudinary://<api_key>:<api_secret>@<cloud_name>
const match = cloudinaryUrl.match(/cloudinary:\/\/(\d+):([^@]+)@(.+)/);
if (match) {
    cloudinary.config({
        cloud_name: match[3],
        api_key: match[1],
        api_secret: match[2]
    });
    // Restore env var for any other code that might need it
    process.env.CLOUDINARY_URL = cloudinaryUrl;
} else {
    logger.warn('⚠️ CLOUDINARY_URL not set or invalid — photo uploads will be skipped');
}

class CloudinaryService {

    /**
     * Upload a photo verification image buffer to Cloudinary.
     * Returns { url, analysis } or null on upload failure.
     * Analysis includes: hasFace, faces, brightness, width, height, format, isLikelyTooDark
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
                        // Request rich analysis from Cloudinary on upload
                        faces: true,              // Returns face bounding boxes
                        colors: true,             // Returns dominant colors with frequencies
                        image_metadata: true,     // Returns EXIF when present (rare for WhatsApp)
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

            // Analyze the result
            const analysis = this._analyzeUploadResult(result);
            logger.info(`📊 Photo analysis: faces=${analysis.faces} brightness=${analysis.brightness.toFixed(2)} dark=${analysis.isLikelyTooDark}`);

            return { url: result.secure_url, analysis };

        } catch (error) {
            logger.error('Error uploading to Cloudinary:', error.message);
            return null;
        }
    }

    /**
     * Analyze a Cloudinary upload response to extract:
     * - face count (from `faces` array)
     * - perceived brightness (0-1, computed from `colors` palette)
     * - dimensions
     * - dark image flag
     */
    _analyzeUploadResult(result) {
        const faces = Array.isArray(result.faces) ? result.faces.length : 0;
        
        // Compute weighted brightness from dominant color palette
        // result.colors is an array of [hexColor, percentage] pairs
        let brightness = 0;
        if (Array.isArray(result.colors) && result.colors.length > 0) {
            let totalWeight = 0;
            for (const [hex, pct] of result.colors) {
                if (!hex || typeof hex !== 'string') continue;
                const clean = hex.replace('#', '');
                if (clean.length < 6) continue;
                const r = parseInt(clean.substring(0, 2), 16);
                const g = parseInt(clean.substring(2, 4), 16);
                const b = parseInt(clean.substring(4, 6), 16);
                // Perceived luminance formula (ITU-R BT.601)
                const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                const weight = Number(pct) || 0;
                brightness += lum * weight;
                totalWeight += weight;
            }
            if (totalWeight > 0) brightness /= totalWeight;
        }
        
        // Dark threshold: under 25% perceived luminance = very dark
        const isLikelyTooDark = brightness > 0 && brightness < 0.25;
        
        return {
            faces,
            hasFace: faces > 0,
            brightness,
            isLikelyTooDark,
            width: result.width || 0,
            height: result.height || 0,
            format: result.format || 'unknown',
            bytes: result.bytes || 0,
            exif: result.image_metadata || null
        };
    }

    /**
     * Validate analysis against verification rules.
     * Returns { passed: bool, reasons: string[] }
     * 
     * Rules (in order of severity):
     * 1. Must have at least one face detected (hard fail)
     * 2. Must not be extremely dark, regardless of time (hard fail)
     * 3. Daytime + dark image = soft fail (suspicious)
     * 4. Image must be at least 200x200 (block tiny screenshots/avatars)
     */
    validateVerificationPhoto(analysis, userTimezone = 'Africa/Lagos') {
        const reasons = [];
        
        if (!analysis) {
            return { passed: false, reasons: ['Image analysis unavailable'] };
        }

        // Rule 1: face must be detected
        if (!analysis.hasFace) {
            reasons.push('No face detected — please send a clear selfie showing your face');
        }

        // Rule 4: dimensions check
        if (analysis.width > 0 && analysis.height > 0) {
            if (analysis.width < 200 || analysis.height < 200) {
                reasons.push('Image too small — please send a normal-sized photo');
            }
        }

        // Determine local hour for the user
        let localHour = -1;
        try {
            const now = new Date();
            const fmt = new Intl.DateTimeFormat('en-NG', { 
                timeZone: userTimezone, 
                hour: 'numeric', 
                hour12: false 
            });
            localHour = parseInt(fmt.format(now), 10);
        } catch (e) {
            // Default to Lagos
            const utc = new Date().getUTCHours();
            localHour = (utc + 1) % 24; // Nigeria is UTC+1
        }
        
        // Rule 2 & 3: brightness check
        // Daytime = 7am-6pm. Dark photo during daytime = suspicious.
        const isDaytime = localHour >= 7 && localHour < 18;
        
        if (analysis.isLikelyTooDark && isDaytime) {
            reasons.push('Image too dark for daytime — please use better lighting');
        } else if (analysis.brightness > 0 && analysis.brightness < 0.10) {
            // Extremely dark regardless of time
            reasons.push('Image is too dark — please use better lighting');
        }
        
        return {
            passed: reasons.length === 0,
            reasons,
            localHour,
            isDaytime
        };
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