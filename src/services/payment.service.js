// ============================================
// FILE: src/services/payment.service.js
// COMPLETE FILE - READY TO PASTE AND REPLACE
// CHANGES: Added platform tracking to payment initialization
// ============================================

const Paystack = require('paystack-api');
const pool = require('../config/database');
const { logger } = require('../utils/logger');
const activityService = require('../services/activity.service');
const gatewayManager = require('./payment-gateway-manager');
const { platformOf } = require('../utils/platform');

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

  /**
   * @param {object} user       full users row
   * @param {number} packageId
   * @param {string|null} gatewayName
   * @param {object} options    { email, callbackUrl } — per-call overrides.
   *                            Web players have a real email on file; chat
   *                            players don't, hence the synthetic fallback.
   */
  async initializePayment(user, packageId, gatewayName = null, options = {}) {
    try {
      // Resolve which gateway to use
      const gateway = gatewayName 
        ? await gatewayManager.getEnabledGatewayByName(gatewayName)
        : await gatewayManager.getDefaultGateway();
      
      const platform = platformOf(user);

      const packageResult = await pool.query(
        'SELECT * FROM game_packages WHERE id = $1 AND is_active = true',
        [packageId]
      );

      if (packageResult.rows.length === 0) {
        throw new Error('Invalid package selected');
      }

      const pkg = packageResult.rows[0];
      const reference = this.generateReference(user.id, gateway.getName());

      // Gateways email the receipt to this address, so send the real one when
      // we have it. web_a1b2c3@wuaib.com is a black hole.
      const email = options.email
        || user.email
        || `${user.phone_number}@wuaib.com`;

      const initResult = await gateway.initialize({
        reference,
        amount: pkg.price_naira,
        email,
        callbackUrl: options.callbackUrl || `${process.env.APP_URL}/payment/callback`,
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

  /**
   * @param {string} reference
   * @param {object} opts  { markFailed } — set false for background polling.
   *   A poll that fires while the player is still typing their card number
   *   would otherwise bury a perfectly good transaction as 'failed'.
   */
  async verifyPayment(reference, { markFailed = true } = {}) {
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

      // 'failed' is recoverable, not terminal. A slow bank transfer — or a
      // verification attempt we made too early — can be followed by the money
      // actually arriving, and the webhook must still be able to credit it.
      if (transaction.status !== 'pending' && transaction.status !== 'failed') {
        throw new Error(`Transaction status is ${transaction.status}`);
      }

      // Look up the gateway used for this reference
      const gateway = await gatewayManager.getGatewayForReference(reference);
      const verifyResult = await gateway.verify(reference);

      if (!verifyResult.success) {
        // Transient states — webhook will eventually complete this
        if (verifyResult.status === 'processing' || verifyResult.status === 'pending') {
          const err = new Error('Payment is still processing — please wait');
          err.transient = true;
          err.status = verifyResult.status;
          throw err;
        }
        throw new Error(`Payment verification failed (gateway=${gateway.getName()}, status=${verifyResult.status || 'unknown'}, error=${verifyResult.error || 'none'})`);
      }

      const channel = verifyResult.raw?.channel || verifyResult.raw?.payment_method || 'unknown';
      const paid_at = verifyResult.raw?.paid_at || verifyResult.raw?.transaction_date || new Date();

      // Flip the status first and use the row count as the lock. Whichever
      // path gets here first (callback, poll, webhook) does the crediting;
      // the others see rowCount 0 and skip it. That is what makes this safe
      // to call from three places at once.
      const claimed = await pool.query(
        `UPDATE payment_transactions 
         SET status = 'success', 
             paystack_reference = $1,
             payment_channel = $2,
             paid_at = $3
         WHERE reference = $4 AND status <> 'success'`,
        [verifyResult.raw?.reference || reference, channel, paid_at, reference]
      );

      if (claimed.rowCount > 0) {
        await pool.query(
          `UPDATE users 
           SET games_remaining = games_remaining + $1,
               total_games_purchased = total_games_purchased + $1,
               last_purchase_date = NOW()
           WHERE id = $2`,
          [transaction.games_purchased, transaction.user_id]
        );

        if (transaction.status === 'failed') {
          logger.warn(`♻️ Recovered payment previously marked failed: ${reference}`);
        }
        logger.info(`✅ Payment verified via ${gateway.getName()} (${transaction.platform}): ${reference} - ${transaction.games_purchased} games credited to user ${transaction.user_id}`);

        // Social proof event (site ticker). Fire-and-forget by contract:
        // record() never throws and is not awaited — a broken activity
        // feed must never break a payment. Actor is the public username;
        // the event text names the package, never the amount paid.
        activityService.record('purchase', transaction.user_id, { games: transaction.games_purchased });
      } else {
        logger.info(`Payment ${reference} already credited by another path — not crediting twice`);
      }

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
      
      // Don't mark transient errors as failed — leave pending so webhook can retry.
      // markFailed=false does the same for background polling, which runs while
      // the player may not have finished paying yet.
      if (markFailed && !error.transient) {
        await pool.query(
          `UPDATE payment_transactions 
           SET status = 'failed' 
           WHERE reference = $1 AND status = 'pending'`,
          [reference]
        );
      }

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

  // ============================================
  // DEDUCT ONE CREDIT — ATOMIC
  // ============================================
  // deductGame() uses GREATEST(games_remaining - 1, 0), which succeeds even
  // when the balance is already zero, so callers have to check first — and
  // check-then-deduct is a TOCTOU. With twenty people joining a group
  // challenge at once, two requests can both read 1 and both "succeed".
  //
  // This variant makes the balance check part of the UPDATE. rowCount === 0
  // means there was nothing to take, with no separate read to race against.
  // Returns { deducted, gamesLeft }.

  async deductGameAtomic(userId) {
    try {
      const result = await pool.query(
        `UPDATE users
         SET games_remaining = games_remaining - 1
         WHERE id = $1 AND games_remaining > 0
         RETURNING games_remaining`,
        [userId]
      );

      if (result.rowCount === 0) {
        return { deducted: false, gamesLeft: 0 };
      }

      const gamesLeft = result.rows[0].games_remaining;
      logger.info(`Game deducted from user ${userId}. Games remaining: ${gamesLeft}`);
      return { deducted: true, gamesLeft };
    } catch (error) {
      logger.error('Error deducting game atomically:', error);
      return { deducted: false, gamesLeft: 0 };
    }
  }

  // ============================================
  // RETURN ONE CREDIT
  // ============================================
  // Used when a challenge expires without completing and the participant never
  // started a round. Someone who played their 15 questions got the game they
  // paid for even if nobody raced them; someone who sat in a lobby that never
  // started did not.

  async refundGameCredit(userId, reason = 'challenge_not_completed') {
    try {
      const result = await pool.query(
        `UPDATE users SET games_remaining = games_remaining + 1
         WHERE id = $1 RETURNING games_remaining`,
        [userId]
      );
      if (result.rowCount === 0) return { refunded: false, gamesLeft: 0 };

      logger.info(`Credit returned to user ${userId} (${reason}). Now: ${result.rows[0].games_remaining}`);
      return { refunded: true, gamesLeft: result.rows[0].games_remaining };
    } catch (error) {
      logger.error('Error returning game credit:', error);
      return { refunded: false, gamesLeft: 0 };
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