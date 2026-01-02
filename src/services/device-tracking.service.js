// ============================================
// FILE: src/services/device-tracking.service.js
// Handles: Device fingerprinting, IP tracking, multi-account detection
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');
const crypto = require('crypto');

class DeviceTrackingService {
    
    // ============================================
    // GENERATE DEVICE FINGERPRINT
    // ============================================
    
    generateDeviceFingerprint(platformData) {
        // For WhatsApp: use phone number as primary identifier
        // For Telegram: use telegram user ID
        // Additional: any metadata from the platform
        
        const components = [
            platformData.platform || 'unknown',
            platformData.phoneNumber || platformData.telegramId || 'unknown',
            platformData.deviceType || '',
            platformData.osVersion || '',
            platformData.appVersion || ''
        ].filter(Boolean);
        
        const fingerprint = crypto
            .createHash('sha256')
            .update(components.join('|'))
            .digest('hex')
            .substring(0, 32);
        
        return fingerprint;
    }
    
    // ============================================
    // RECORD DEVICE
    // ============================================
    
    async recordDevice(userId, deviceId, platform, deviceInfo = {}) {
        try {
            const result = await pool.query(`
                INSERT INTO device_fingerprints (user_id, device_id, platform, device_info)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id, device_id) 
                DO UPDATE SET 
                    last_seen_at = NOW(),
                    device_info = COALESCE(device_fingerprints.device_info, '{}')::jsonb || $4::jsonb
                RETURNING id, is_flagged
            `, [userId, deviceId, platform, JSON.stringify(deviceInfo)]);
            
            // Update user's primary device if not set
            await pool.query(`
                UPDATE users 
                SET primary_device_id = COALESCE(primary_device_id, $1)
                WHERE id = $2
            `, [deviceId, userId]);
            
            // Check for multi-account usage
            await this.checkMultiAccountByDevice(deviceId, userId);
            
            return result.rows[0];
        } catch (error) {
            logger.error('Error recording device:', error);
            return null;
        }
    }
    
    // ============================================
    // RECORD IP ADDRESS
    // ============================================
    
    async recordIP(userId, ipAddress, actionType, geoLocation = null) {
        try {
            // Detect VPN/Proxy (basic check - can be enhanced with external API)
            const isVpnOrProxy = this.isLikelyVpnOrProxy(ipAddress);
            
            await pool.query(`
                INSERT INTO ip_logs (user_id, ip_address, action_type, geo_location, is_vpn, is_proxy)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [
                userId, 
                ipAddress, 
                actionType, 
                geoLocation ? JSON.stringify(geoLocation) : null,
                isVpnOrProxy.isVpn,
                isVpnOrProxy.isProxy
            ]);
            
            // Update user's last IP
            await pool.query(`
                UPDATE users SET last_ip_address = $1 WHERE id = $2
            `, [ipAddress, userId]);
            
            // Check for multi-account by IP
            await this.checkMultiAccountByIP(ipAddress, userId);
            
            // Flag if VPN/Proxy detected
            if (isVpnOrProxy.isVpn || isVpnOrProxy.isProxy) {
                await this.createFraudAlert(userId, 'vpn_usage', 'low', 
                    `VPN/Proxy detected: ${ipAddress}`, 
                    { ipAddress, ...isVpnOrProxy }
                );
            }
            
            return true;
        } catch (error) {
            logger.error('Error recording IP:', error);
            return false;
        }
    }
    
    // ============================================
    // BASIC VPN/PROXY DETECTION
    // ============================================
    
    isLikelyVpnOrProxy(ipAddress) {
        // Known VPN/Proxy IP ranges (simplified - in production use an API)
        const suspiciousRanges = [
            '10.', '172.16.', '172.17.', '172.18.', '172.19.', 
            '172.20.', '172.21.', '172.22.', '172.23.', '172.24.',
            '172.25.', '172.26.', '172.27.', '172.28.', '172.29.',
            '172.30.', '172.31.', '192.168.', '127.'
        ];
        
        const isPrivate = suspiciousRanges.some(range => ipAddress.startsWith(range));
        
        // In production, you'd call an API like ip-api.com or ipinfo.io
        // For now, just flag private IPs
        return {
            isVpn: false,
            isProxy: isPrivate,
            reason: isPrivate ? 'private_ip_range' : null
        };
    }
    
    // ============================================
    // CHECK MULTI-ACCOUNT BY DEVICE
    // ============================================
    
    async checkMultiAccountByDevice(deviceId, currentUserId) {
        try {
            const result = await pool.query(`
                SELECT user_id FROM device_fingerprints 
                WHERE device_id = $1 AND user_id != $2
            `, [deviceId, currentUserId]);
            
            if (result.rows.length > 0) {
                for (const row of result.rows) {
                    await this.createAccountLink(
                        currentUserId, 
                        row.user_id, 
                        'same_device',
                        0.9, // High confidence
                        { deviceId }
                    );
                }
                
                // Flag the device
                await pool.query(`
                    UPDATE device_fingerprints 
                    SET is_flagged = true, flag_reason = 'multi_account_detected'
                    WHERE device_id = $1
                `, [deviceId]);
                
                // Increment multi-account flags for both users
                await pool.query(`
                    UPDATE users 
                    SET multi_account_flags = multi_account_flags + 1
                    WHERE id = ANY($1)
                `, [[currentUserId, ...result.rows.map(r => r.user_id)]]);
                
                logger.warn(`Multi-account detected by device: ${deviceId} - Users: ${currentUserId}, ${result.rows.map(r => r.user_id).join(', ')}`);
            }
        } catch (error) {
            logger.error('Error checking multi-account by device:', error);
        }
    }
    
    // ============================================
    // CHECK MULTI-ACCOUNT BY IP
    // ============================================
    
    async checkMultiAccountByIP(ipAddress, currentUserId) {
        try {
            // Look for other users from same IP in last 7 days
            const result = await pool.query(`
                SELECT DISTINCT user_id 
                FROM ip_logs 
                WHERE ip_address = $1 
                AND user_id != $2
                AND created_at >= NOW() - INTERVAL '7 days'
            `, [ipAddress, currentUserId]);
            
            if (result.rows.length > 0) {
                // Multiple users from same IP - could be legitimate (shared WiFi)
                // Use lower confidence than device match
                for (const row of result.rows) {
                    // Check if they played at similar times (more suspicious)
                    const timeOverlap = await this.checkTimeOverlap(currentUserId, row.user_id);
                    const confidence = timeOverlap ? 0.7 : 0.4;
                    
                    await this.createAccountLink(
                        currentUserId,
                        row.user_id,
                        'same_ip',
                        confidence,
                        { ipAddress, timeOverlap }
                    );
                }
                
                if (result.rows.length >= 3) {
                    // 3+ accounts from same IP is more suspicious
                    await this.createFraudAlert(
                        currentUserId,
                        'multi_account',
                        'medium',
                        `Multiple accounts (${result.rows.length + 1}) detected from IP ${ipAddress}`,
                        { ipAddress, linkedUsers: result.rows.map(r => r.user_id) }
                    );
                }
            }
        } catch (error) {
            logger.error('Error checking multi-account by IP:', error);
        }
    }
    
    // ============================================
    // CHECK TIME OVERLAP
    // ============================================
    
    async checkTimeOverlap(userId1, userId2) {
        try {
            // Check if both users played within 5 minutes of each other
            const result = await pool.query(`
                SELECT COUNT(*) as overlap_count
                FROM game_sessions gs1
                JOIN game_sessions gs2 ON gs1.user_id = $1 AND gs2.user_id = $2
                WHERE ABS(EXTRACT(EPOCH FROM (gs1.started_at - gs2.started_at))) < 300
                AND gs1.started_at >= NOW() - INTERVAL '30 days'
            `, [userId1, userId2]);
            
            return parseInt(result.rows[0].overlap_count) > 0;
        } catch (error) {
            logger.error('Error checking time overlap:', error);
            return false;
        }
    }
    
    // ============================================
    // CREATE ACCOUNT LINK
    // ============================================
    
    async createAccountLink(userId1, userId2, linkType, confidence, evidence) {
        try {
            // Ensure consistent ordering (smaller ID first)
            const [user1, user2] = userId1 < userId2 ? [userId1, userId2] : [userId2, userId1];
            
            await pool.query(`
                INSERT INTO account_links (user_id_1, user_id_2, link_type, confidence_score, evidence)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (user_id_1, user_id_2, link_type) 
                DO UPDATE SET 
                    confidence_score = GREATEST(account_links.confidence_score, $4),
                    evidence = account_links.evidence || $5::jsonb,
                    detected_at = NOW()
            `, [user1, user2, linkType, confidence, JSON.stringify(evidence)]);
            
            logger.info(`Account link created: ${user1} <-> ${user2} (${linkType}, confidence: ${confidence})`);
        } catch (error) {
            logger.error('Error creating account link:', error);
        }
    }
    
    // ============================================
    // CREATE FRAUD ALERT
    // ============================================
    
    async createFraudAlert(userId, alertType, severity, description, evidence) {
        try {
            await pool.query(`
                INSERT INTO fraud_alerts (user_id, alert_type, severity, description, evidence)
                VALUES ($1, $2, $3, $4, $5)
            `, [userId, alertType, severity, description, JSON.stringify(evidence)]);
            
            logger.warn(`Fraud alert created for user ${userId}: ${alertType} (${severity})`);
        } catch (error) {
            logger.error('Error creating fraud alert:', error);
        }
    }
    
    // ============================================
    // GET USER DEVICES
    // ============================================
    
    async getUserDevices(userId) {
        try {
            const result = await pool.query(`
                SELECT device_id, platform, device_info, first_seen_at, last_seen_at, is_flagged
                FROM device_fingerprints
                WHERE user_id = $1
                ORDER BY last_seen_at DESC
            `, [userId]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting user devices:', error);
            return [];
        }
    }
    
    // ============================================
    // GET USER IPS
    // ============================================
    
    async getUserIPs(userId, days = 30) {
        try {
            const result = await pool.query(`
                SELECT ip_address, 
                       COUNT(*) as usage_count,
                       MAX(created_at) as last_used,
                       bool_or(is_vpn) as has_vpn,
                       bool_or(is_proxy) as has_proxy
                FROM ip_logs
                WHERE user_id = $1
                AND created_at >= NOW() - ($2 || ' days')::INTERVAL
                GROUP BY ip_address
                ORDER BY last_used DESC
            `, [userId, days]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting user IPs:', error);
            return [];
        }
    }
    
    // ============================================
    // GET LINKED ACCOUNTS
    // ============================================
    
    async getLinkedAccounts(userId) {
        try {
            const result = await pool.query(`
                SELECT 
                    CASE WHEN user_id_1 = $1 THEN user_id_2 ELSE user_id_1 END as linked_user_id,
                    link_type,
                    confidence_score,
                    evidence,
                    detected_at,
                    is_confirmed,
                    u.username,
                    u.full_name
                FROM account_links al
                JOIN users u ON u.id = CASE WHEN al.user_id_1 = $1 THEN al.user_id_2 ELSE al.user_id_1 END
                WHERE user_id_1 = $1 OR user_id_2 = $1
                ORDER BY confidence_score DESC
            `, [userId]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting linked accounts:', error);
            return [];
        }
    }
    
    // ============================================
    // GET SHARED DEVICE USERS
    // ============================================
    
    async getSharedDeviceUsers() {
        try {
            const result = await pool.query(`
                SELECT 
                    df.device_id,
                    COUNT(DISTINCT df.user_id) as user_count,
                    ARRAY_AGG(DISTINCT df.user_id) as user_ids,
                    ARRAY_AGG(DISTINCT u.username) as usernames
                FROM device_fingerprints df
                JOIN users u ON df.user_id = u.id
                GROUP BY df.device_id
                HAVING COUNT(DISTINCT df.user_id) > 1
                ORDER BY user_count DESC
            `);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting shared device users:', error);
            return [];
        }
    }
    
    // ============================================
    // GET FRAUD ALERTS
    // ============================================
    
    async getFraudAlerts(status = 'new', limit = 50) {
        try {
            const result = await pool.query(`
                SELECT fa.*, u.username, u.full_name
                FROM fraud_alerts fa
                JOIN users u ON fa.user_id = u.id
                WHERE fa.status = $1
                ORDER BY 
                    CASE fa.severity 
                        WHEN 'critical' THEN 1 
                        WHEN 'high' THEN 2 
                        WHEN 'medium' THEN 3 
                        ELSE 4 
                    END,
                    fa.created_at DESC
                LIMIT $2
            `, [status, limit]);
            
            return result.rows;
        } catch (error) {
            logger.error('Error getting fraud alerts:', error);
            return [];
        }
    }
    
    // ============================================
    // RESOLVE FRAUD ALERT
    // ============================================
    
    async resolveFraudAlert(alertId, adminId, resolution, notes) {
        try {
            await pool.query(`
                UPDATE fraud_alerts
                SET status = $1, resolved_by = $2, resolved_at = NOW(), resolution_notes = $3
                WHERE id = $4
            `, [resolution, adminId, notes, alertId]);
            
            return true;
        } catch (error) {
            logger.error('Error resolving fraud alert:', error);
            return false;
        }
    }
    
    // ============================================
    // CONFIRM/DENY ACCOUNT LINK
    // ============================================
    
    async reviewAccountLink(linkId, adminId, isConfirmed) {
        try {
            await pool.query(`
                UPDATE account_links
                SET is_confirmed = $1, reviewed_at = NOW(), reviewed_by = $2
                WHERE id = $3
            `, [isConfirmed, adminId, linkId]);
            
            if (isConfirmed) {
                // Get the linked users
                const result = await pool.query(`
                    SELECT user_id_1, user_id_2 FROM account_links WHERE id = $1
                `, [linkId]);
                
                if (result.rows.length > 0) {
                    const { user_id_1, user_id_2 } = result.rows[0];
                    
                    // Increment fraud flags for both users
                    await pool.query(`
                        UPDATE users 
                        SET fraud_flags = fraud_flags + 1
                        WHERE id = ANY($1)
                    `, [[user_id_1, user_id_2]]);
                }
            }
            
            return true;
        } catch (error) {
            logger.error('Error reviewing account link:', error);
            return false;
        }
    }
}

module.exports = new DeviceTrackingService();