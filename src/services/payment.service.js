const Paystack = require('paystack-api');
const pool = require('../config/database');
const { logger } = require('../utils/logger');

class PaymentService {
  constructor() {
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

  generateReference(userId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `WUAIB-${userId}-${timestamp}-${random}`;
  }

  async initializePayment(user, packageId) {
    try {
      const packageResult = await pool.query(
        'SELECT * FROM game_packages WHERE id = $1 AND is_active = true',
        [packageId]
      );

      if (packageResult.rows.length === 0) {
        throw new Error('Invalid package selected');
      }

      const pkg = packageResult.rows[0];
      const reference = this.generateReference(user.id);

      const response = await this.paystack.transaction.initialize({
        email: `${user.phone_number}@wuaib.com`,
        amount: pkg.price_kobo,
        reference: reference,
        callback_url: `${process.env.APP_URL}/payment/callback`,
        metadata: {
          user_id: user.id,
          user_name: user.full_name,
          user_phone: user.phone_number,
          package_id: packageId,
          package_name: pkg.name,
          games_count: pkg.games_count,
          custom_fields: [
            {
              display_name: "User Name",
              variable_name: "user_name",
              value: user.full_name
            },
            {
              display_name: "Phone Number",
              variable_name: "phone_number",
              value: user.phone_number
            }
          ]
        },
        channels: ['card', 'bank', 'ussd', 'mobile_money']
      });

      await pool.query(
        `INSERT INTO payment_transactions 
         (user_id, package_id, reference, amount, games_purchased, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [user.id, packageId, reference, pkg.price_naira, pkg.games_count]
      );

      logger.info(`Payment initialized for user ${user.id}: ${reference}`);

      return {
        authorization_url: response.data.authorization_url,
        access_code: response.data.access_code,
        reference: reference,
        amount: pkg.price_naira,
        games: pkg.games_count
      };

    } catch (error) {
      logger.error('Error initializing payment:', error);
      throw error;
    }
  }

  async verifyPayment(reference) {
    try {
      const response = await this.paystack.transaction.verify(reference);
      
      if (response.data.status !== 'success') {
        throw new Error('Payment verification failed');
      }

      const { metadata, amount, paid_at, channel } = response.data;

      await pool.query(
        `UPDATE payment_transactions 
         SET status = 'success', 
             paystack_reference = $1,
             payment_channel = $2,
             paid_at = $3
         WHERE reference = $4`,
        [response.data.reference, channel, paid_at, reference]
      );

      await pool.query(
        `UPDATE users 
         SET games_remaining = games_remaining + $1,
             total_games_purchased = total_games_purchased + $1,
             last_purchase_date = NOW()
         WHERE id = $2`,
        [metadata.games_count, metadata.user_id]
      );

      logger.info(`Payment verified: ${reference} - ${metadata.games_count} games credited to user ${metadata.user_id}`);

      return {
        success: true,
        amount: amount / 100,
        games: metadata.games_count,
        userId: metadata.user_id
      };

    } catch (error) {
      logger.error('Error verifying payment:', error);
      
      await pool.query(
        `UPDATE payment_transactions 
         SET status = 'failed' 
         WHERE reference = $1`,
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

  async deductGame(userId) {
    try {
      await pool.query(
        `UPDATE users 
         SET games_remaining = GREATEST(games_remaining - 1, 0)
         WHERE id = $1`,
        [userId]
      );

      logger.info(`Game deducted from user ${userId}`);
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