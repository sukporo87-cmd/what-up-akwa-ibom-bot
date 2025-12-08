// ============================================
// FILE: src/services/payout.service.js
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class PayoutService {
  // Get bank code from bank name
  async getBankCode(bankName) {
    try {
      const result = await pool.query(
        'SELECT bank_code FROM bank_codes WHERE LOWER(bank_name) = LOWER($1) AND is_active = true',
        [bankName]
      );

      return result.rows[0]?.bank_code || null;
    } catch (error) {
      logger.error('Error getting bank code:', error);
      return null;
    }
  }

  // Get all active banks
  async getAllBanks() {
    try {
      const result = await pool.query(
        'SELECT bank_name, bank_code FROM bank_codes WHERE is_active = true ORDER BY bank_name ASC'
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting banks:', error);
      return [];
    }
  }

  // Save payout details
  async savePayoutDetails(userId, transactionId, accountName, accountNumber, bankName) {
    try {
      // Get bank code
      const bankCode = await this.getBankCode(bankName);

      // Check if details already exist for this transaction
      const existingDetails = await pool.query(
        'SELECT id FROM payout_details WHERE transaction_id = $1',
        [transactionId]
      );

      let result;

      if (existingDetails.rows.length > 0) {
        // Update existing details
        result = await pool.query(
          `UPDATE payout_details 
           SET account_name = $1, account_number = $2, bank_name = $3, bank_code = $4, updated_at = NOW()
           WHERE transaction_id = $5
           RETURNING *`,
          [accountName, accountNumber, bankName, bankCode, transactionId]
        );

        logger.info(`Updated payout details for transaction ${transactionId}`);
      } else {
        // Insert new details
        result = await pool.query(
          `INSERT INTO payout_details (user_id, transaction_id, account_name, account_number, bank_name, bank_code)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [userId, transactionId, accountName, accountNumber, bankName, bankCode]
        );

        logger.info(`Saved payout details for transaction ${transactionId}`);
      }

      // Log the action
      await this.logPayoutAction(transactionId, null, 'details_collected', 
        `Details provided: ${bankName} - ${accountNumber}`);

      return result.rows[0];
    } catch (error) {
      logger.error('Error saving payout details:', error);
      throw error;
    }
  }

  // Get pending transaction for user
  async getPendingTransaction(userId) {
    try {
      const result = await pool.query(
        `SELECT t.*, pd.id as has_details
         FROM transactions t
         LEFT JOIN payout_details pd ON t.id = pd.transaction_id
         WHERE t.user_id = $1 
           AND t.transaction_type = 'prize' 
           AND t.payout_status IN ('pending', 'details_collected')
         ORDER BY t.created_at DESC
         LIMIT 1`,
        [userId]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting pending transaction:', error);
      return null;
    }
  }

  // Check if user has pending payout details to provide
  async hasPendingPayoutDetails(userId) {
    try {
      const transaction = await this.getPendingTransaction(userId);
      
      if (!transaction) return false;
      
      // Has transaction but no details provided yet
      return transaction.has_details === null;
    } catch (error) {
      logger.error('Error checking pending payout:', error);
      return false;
    }
  }

  // Validate account number format
  validateAccountNumber(accountNumber) {
    // Remove spaces and non-digits
    const cleaned = accountNumber.replace(/\D/g, '');
    
    // Nigerian bank accounts are 10 digits
    if (cleaned.length === 10) {
      return { valid: true, cleaned };
    }
    
    return { valid: false, cleaned: null, error: 'Account number must be 10 digits' };
  }

  // Log payout action
  async logPayoutAction(transactionId, adminId, action, notes = null) {
    try {
      await pool.query(
        `INSERT INTO payout_history (transaction_id, admin_id, action, notes)
         VALUES ($1, $2, $3, $4)`,
        [transactionId, adminId, action, notes]
      );
    } catch (error) {
      logger.error('Error logging payout action:', error);
    }
  }

  // Get payout details for a transaction
  async getPayoutDetails(transactionId) {
    try {
      const result = await pool.query(
        'SELECT * FROM payout_details WHERE transaction_id = $1',
        [transactionId]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting payout details:', error);
      return null;
    }
  }

  // Format bank list for display
  formatBankList() {
    return `Please select your bank:

1️⃣ Access Bank
2️⃣ GTBank
3️⃣ First Bank
4️⃣ UBA
5️⃣ Zenith Bank
6️⃣ Ecobank
7️⃣ Fidelity Bank
8️⃣ Stanbic IBTC
9️⃣ Union Bank
🔟 Wema Bank

Or type your bank name if not listed above.

Reply with number or bank name:`;
  }

  // Parse bank selection
  parseBankSelection(input) {
    const bankMap = {
      '1': 'Access Bank',
      '2': 'GTBank',
      '3': 'First Bank',
      '4': 'UBA',
      '5': 'Zenith Bank',
      '6': 'Ecobank',
      '7': 'Fidelity Bank',
      '8': 'Stanbic IBTC',
      '9': 'Union Bank',
      '10': 'Wema Bank'
    };

    const trimmed = input.trim();
    
    // Check if it's a number selection
    if (bankMap[trimmed]) {
      return bankMap[trimmed];
    }
    
    // Otherwise, return the input as bank name
    return trimmed;
  }

  // Mark payout as approved (admin action)
  async approvePayout(transactionId, adminId) {
    try {
      await pool.query(
        `UPDATE transactions 
         SET payout_status = 'approved', updated_at = NOW()
         WHERE id = $1`,
        [transactionId]
      );

      await this.logPayoutAction(transactionId, adminId, 'approved', 'Approved by admin');
      
      logger.info(`Transaction ${transactionId} approved for payout by admin ${adminId}`);
      return true;
    } catch (error) {
      logger.error('Error approving payout:', error);
      return false;
    }
  }

  // Mark payout as paid (admin action)
  async markAsPaid(transactionId, adminId, paymentReference, paymentMethod = 'bank_transfer') {
    try {
      await pool.query(
        `UPDATE transactions 
         SET payout_status = 'paid', 
             payment_status = 'completed',
             payment_reference = $2,
             payment_method = $3,
             paid_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [transactionId, paymentReference, paymentMethod]
      );

      await this.logPayoutAction(
        transactionId, 
        adminId, 
        'paid', 
        `Payment made via ${paymentMethod}. Reference: ${paymentReference}`
      );

      logger.info(`Transaction ${transactionId} marked as paid. Reference: ${paymentReference}`);
      return true;
    } catch (error) {
      logger.error('Error marking payout as paid:', error);
      return false;
    }
  }

  // Mark payout as confirmed by user
  async confirmPayout(transactionId) {
    try {
      await pool.query(
        `UPDATE transactions 
         SET payout_status = 'confirmed', 
             confirmed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [transactionId]
      );

      await this.logPayoutAction(transactionId, null, 'confirmed', 'Confirmed by winner');
      
      logger.info(`Transaction ${transactionId} confirmed by winner`);
      return true;
    } catch (error) {
      logger.error('Error confirming payout:', error);
      return false;
    }
  }

  // Get all pending payouts for admin dashboard
  async getAllPendingPayouts(status = null) {
    try {
      let query = 'SELECT * FROM admin_pending_payouts';
      let params = [];

      if (status) {
        query += ' WHERE payout_status = $1';
        params.push(status);
      }

      query += ' ORDER BY win_date DESC';

      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error('Error getting pending payouts:', error);
      return [];
    }
  }

  // Get payout statistics for admin
  async getPayoutStats() {
    try {
      const result = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE payout_status = 'pending') as pending_count,
          COUNT(*) FILTER (WHERE payout_status = 'details_collected') as details_collected_count,
          COUNT(*) FILTER (WHERE payout_status = 'approved') as approved_count,
          COUNT(*) FILTER (WHERE payout_status = 'paid') as paid_count,
          COUNT(*) FILTER (WHERE payout_status = 'confirmed') as confirmed_count,
          COALESCE(SUM(amount) FILTER (WHERE payout_status IN ('pending', 'details_collected', 'approved')), 0) as pending_amount,
          COALESCE(SUM(amount) FILTER (WHERE payout_status = 'paid'), 0) as paid_today_amount,
          COALESCE(SUM(amount) FILTER (WHERE payout_status = 'confirmed'), 0) as confirmed_amount
        FROM transactions
        WHERE transaction_type = 'prize'
          AND created_at >= CURRENT_DATE
      `);

      return result.rows[0];
    } catch (error) {
      logger.error('Error getting payout stats:', error);
      return null;
    }
  }
}

module.exports = PayoutService;