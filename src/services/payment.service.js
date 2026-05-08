// ============================================
// FILE: src/services/payment.service.js
// COMPLETE FILE - READY TO PASTE AND REPLACE
// CHANGES: Added platform tracking to payment initialization
// ============================================

const Paystack = require('paystack-api');
const pool = require('../config/database');
const { logger } = require('../utils/logger');
const gatewayManager = require('./payment-gateway-manager');

class PaymentService {
  constructor() {
    // Legacy direct paystack instance kept for any code still referencing it
    this.paystack = Paystack(process.env.PAYSTACK_SECRET_KEY);
    this.isPaymentEnabled = process.env.PAYMENT_MODE === 'paid';
  }

  isEnabled() {
    return this.isPaymentEnabled;
  }

  async getPackages() {
    try {
      const result = await pool.query(
        'SELECT * FROM game_packages WHERE is_active = true ORDER BY price_naira ASC'
      );
      return result.rows;
    } catch (error) {
      logger.error('Error fetching packages:', error);
      throw error;
    }
  }

  generateReference(userId, gatewayName = 'paystack') {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    // Prefix indicates gateway: WUAIB-* (paystack legacy), KOR-* (korapay), etc.
    const prefix = gatewayName === 'korapay' ? 'KOR' : 'WUAIB';
    return `${prefix}-${userId}-${timestamp}-${random}`;
  }

  async initializePayment(user, packageId, gatewayName = null) {
    try {
      // Resolve which gateway to use
      const gateway = gatewayName 
        ? await gatewayManager.getEnabledGatewayByName(gatewayName)
        : await gatewayManager.getDefaultGateway();
      
      const platform = user.phone_number.startsWith('tg_') ? 'telegram' : 'whatsapp';

      const packageResult = await pool.query(
        'SELECT * FROM game_packages WHERE id = $1 AND is_active = true',
        [packageId]
      );

      if (packageResult.rows.length === 0) {
        throw new Error('Invalid package selected');
      }

      const pkg = packageResult.rows[0];
      const reference = this.generateReference(user.id, gateway.getName());

      const initResult = await gateway.initialize({
        reference,
        amount: pkg.price_naira,
        email: `${user.phone_number}@wuaib.com`,
        callbackUrl: `${process.env.APP_URL}/payment/callback`,
        customerName: user.full_name,
        metadata: {
          user_id: user.id,
          user_name: user.full_name,
          user_phone: user.phone_number,
          package_id: packageId,
          package_name: pkg.name,
          games_count: pkg.games_count,
          platform: platform,
          description: `${pkg.games_count} game tokens`
        }
      });

      await pool.query(
        `INSERT INTO payment_transactions 
         (user_id, package_id, reference, amount, games_purchased, status, platform, gateway_used)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
        [user.id, packageId, reference, pkg.price_naira, pkg.games_count, platform, gateway.getName()]
      );

      logger.info(`💳 Payment initialized via ${gateway.getName()} for user ${user.id} (${platform}): ${reference}`);

      return {
        authorization_url: initResult.authorization_url,
        access_code: initResult.access_code,
        reference: reference,
        amount: pkg.price_naira,
        games: pkg.games_count,
        platform: platform,
        gateway: gateway.getName()
      };

    } catch (error) {
      logger.error('Error initializing payment:', error);
      throw error;
    }
  }

  async verifyPayment(reference) {
    try {
      // Check if already verified in our database
      const existingTransaction = await pool.query(
        `SELECT * FROM payment_transactions WHERE reference = $1`,
        [reference]
      );

      if (existingTransaction.rows.length === 0) {
        throw new Error('Transaction not found');
      }

      const transaction = existingTransaction.rows[0];

      // If already successfully processed, return cached result
      if (transaction.status === 'success') {
        logger.info(`Payment already verified: ${reference} - Returning cached result`);
        return {
          success: true,
          amount: parseFloat(transaction.amount),
          games: transaction.games_purchased,
          userId: transaction.user_id,
          platform: transaction.platform,
          gateway: transaction.gateway_used
        };
      }

      // Only verify with gateway if status is still 'pending'
      if (transaction.status !== 'pending') {
        throw new Error(`Transaction status is ${transaction.status}`);
      }

      // Look up the gateway used for this reference
      const gateway = await gatewayManager.getGatewayForReference(reference);
      const verifyResult = await gateway.verify(reference);

      if (!verifyResult.success) {
        throw new Error('Payment verification failed');
      }

      const channel = verifyResult.raw?.channel || verifyResult.raw?.payment_method || 'unknown';
      const paid_at = verifyResult.raw?.paid_at || verifyResult.raw?.transaction_date || new Date();

      // Update transaction status FIRST (prevents race conditions)
      await pool.query(
        `UPDATE payment_transactions 
         SET status = 'success', 
             paystack_reference = $1,
             payment_channel = $2,
             paid_at = $3
         WHERE reference = $4 AND status = 'pending'`,
        [verifyResult.raw?.reference || reference, channel, paid_at, reference]
      );

      // Then credit games to user
      await pool.query(
        `UPDATE users 
         SET games_remaining = games_remaining + $1,
             total_games_purchased = total_games_purchased + $1,
             last_purchase_date = NOW()
         WHERE id = $2`,
        [transaction.games_purchased, transaction.user_id]
      );

      logger.info(`✅ Payment verified via ${gateway.getName()} (${transaction.platform}): ${reference} - ${transaction.games_purchased} games credited to user ${transaction.user_id}`);

      return {
        success: true,
        amount: verifyResult.amount,
        games: transaction.games_purchased,
        userId: transaction.user_id,
        platform: transaction.platform,
        gateway: gateway.getName()
      };

    } catch (error) {
      logger.error('Error verifying payment:', error);
      
      // Only mark as failed if it was pending
      await pool.query(
        `UPDATE payment_transactions 
         SET status = 'failed' 
         WHERE reference = $1 AND status = 'pending'`,
        [reference]
      );

      throw error;
    }
  }

  async hasGamesRemaining(userId) {
    try {
      const result = await pool.query(
        'SELECT games_remaining FROM users WHERE id = $1',
        [userId]
      );

      if (result.rows.length === 0) return false;
      
      return result.rows[0].games_remaining > 0;
    } catch (error) {
      logger.error('Error checking games remaining:', error);
      return false;
    }
  }

  async getGamesRemaining(userId) {
    try {
      const result = await pool.query(
        'SELECT games_remaining FROM users WHERE id = $1',
        [userId]
      );

      if (result.rows.length === 0) return 0;
      
      return result.rows[0].games_remaining;
    } catch (error) {
      logger.error('Error getting games remaining:', error);
      return 0;
    }
  }

  async deductGame(userId) {
    try {
      const result = await pool.query(
        `UPDATE users 
         SET games_remaining = GREATEST(games_remaining - 1, 0)
         WHERE id = $1
         RETURNING games_remaining`,
        [userId]
      );

      const gamesLeft = result.rows[0]?.games_remaining || 0;
      logger.info(`Game deducted from user ${userId}. Games remaining: ${gamesLeft}`);
      
      return gamesLeft;
    } catch (error) {
      logger.error('Error deducting game:', error);
      throw error;
    }
  }

  formatPaymentMessage(packages) {
    let message = '💰 BUY GAMES 💰\n\n';
    message += 'Select a package:\n\n';

    packages.forEach((pkg, index) => {
      const bestValue = pkg.name === 'Value' ? ' ⭐ BEST VALUE' : '';
      message += `${index + 1}️⃣ ${pkg.name} - ₦${pkg.price_naira.toLocaleString()}\n`;
      message += `   ${pkg.games_count} games${bestValue}\n`;
      message += `   ${pkg.description}\n\n`;
    });

    message += 'Reply with package number (1, 2, or 3)';
    return message;
  }
}

module.exports = PaymentService;