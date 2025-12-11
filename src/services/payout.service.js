// ============================================
// FILE: src/services/payout.service.js - COMPLETE VERSION WITH BANK VERIFICATION
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');
const BankService = require('./bank.service');

class PayoutService {
  constructor() {
    this.bankService = new BankService();
  }

  // Get user's existing bank details
  async getUserBankDetails(userId) {
    try {
      const result = await pool.query(
        `SELECT * FROM payout_details 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [userId]
      );
      
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting user bank details:', error);
      return null;
    }
  }

  // Check if user has bank details on file
  async hasBankDetails(userId) {
    const details = await this.getUserBankDetails(userId);
    return details !== null;
  }

  // Get pending transaction for user
  async getPendingTransaction(userId) {
    try {
      const result = await pool.query(
        `SELECT * FROM transactions 
         WHERE user_id = $1 
         AND transaction_type = 'prize' 
         AND payout_status IN ('pending', 'details_collected', 'approved')
         ORDER BY created_at DESC 
         LIMIT 1`,
        [userId]
      );
      
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting pending transaction:', error);
      throw error;
    }
  }

  // Get payout details for specific transaction
  async getPayoutDetails(transactionId) {
    try {
      const result = await pool.query(
        'SELECT * FROM payout_details WHERE transaction_id = $1',
        [transactionId]
      );
      
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting payout details:', error);
      throw error;
    }
  }

  // Link existing bank details to new transaction
  async linkBankDetailsToTransaction(userId, transactionId) {
    try {
      const existingDetails = await this.getUserBankDetails(userId);
      
      if (!existingDetails) {
        return false;
      }

      // Create new payout_details record for this transaction
      // using the existing bank details
      await pool.query(
        `INSERT INTO payout_details 
         (user_id, transaction_id, account_name, account_number, bank_name, bank_code, verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          transactionId,
          existingDetails.account_name,
          existingDetails.account_number,
          existingDetails.bank_name,
          existingDetails.bank_code,
          existingDetails.verified
        ]
      );

      logger.info(`Linked existing bank details for user ${userId} to transaction ${transactionId}`);
      return true;
    } catch (error) {
      logger.error('Error linking bank details:', error);
      return false;
    }
  }

  // Save new bank details with bank verification
  async savePayoutDetails(userId, transactionId, accountName, accountNumber, bankName) {
    try {
      // Get bank code from bank_codes table
      const bankResult = await pool.query(
        'SELECT bank_code FROM bank_codes WHERE bank_name = $1',
        [bankName]
      );

      let bankCode = bankResult.rows[0]?.bank_code || null;

      // If no bank code found, try to get it from Paystack
      if (!bankCode) {
        bankCode = await this.bankService.getBankCodeByName(bankName);
        
        if (bankCode) {
          // Save it for future use
          await pool.query(
            'INSERT INTO bank_codes (bank_name, bank_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [bankName, bankCode]
          );
        }
      }

      // Attempt bank verification if we have bank code
      let verified = false;
      let verifiedAccountName = accountName;

      if (bankCode) {
        logger.info(`Attempting to verify account ${accountNumber} with ${bankName}`);
        
        const verificationResult = await this.bankService.verifyBankAccount(accountNumber, bankCode);

        if (verificationResult.verified) {
          verified = true;
          verifiedAccountName = verificationResult.accountName;
          
          logger.info(`✅ Account verified! Name: ${verifiedAccountName}`);

          // Check if provided name matches verified name (fuzzy match)
          const providedNameNormalized = accountName.toLowerCase().replace(/\s+/g, '');
          const verifiedNameNormalized = verifiedAccountName.toLowerCase().replace(/\s+/g, '');
          
          if (!verifiedNameNormalized.includes(providedNameNormalized) && 
              !providedNameNormalized.includes(verifiedNameNormalized)) {
            logger.warn(`⚠️ Name mismatch: Provided "${accountName}" vs Verified "${verifiedAccountName}"`);
          }
        } else {
          logger.warn(`❌ Account verification failed: ${verificationResult.error}`);
          // Continue anyway - admin will review
        }
      }

      // Save payout details
      const result = await pool.query(
        `INSERT INTO payout_details
         (user_id, transaction_id, account_name, account_number, bank_name, bank_code, verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [userId, transactionId, verifiedAccountName, accountNumber, bankName, bankCode, verified]
      );

      // Log the action
      await pool.query(
        `INSERT INTO payout_history (transaction_id, action, notes)
         VALUES ($1, 'details_collected', $2)`,
        [transactionId, verified ? 'Bank details submitted and verified' : 'Bank details submitted (verification failed)']
      );

      logger.info(`Saved payout details for transaction ${transactionId} - Verified: ${verified}`);
      return result.rows[0];
    } catch (error) {
      logger.error('Error saving payout details:', error);
      throw error;
    }
  }

  // Update existing bank details
  async updateBankDetails(userId, accountName, accountNumber, bankName) {
    try {
      const bankResult = await pool.query(
        'SELECT bank_code FROM bank_codes WHERE bank_name = $1',
        [bankName]
      );

      const bankCode = bankResult.rows[0]?.bank_code || null;

      // Get the most recent payout_details record
      const existingDetails = await this.getUserBankDetails(userId);
      
      if (existingDetails) {
        // Update the existing record
        await pool.query(
          `UPDATE payout_details 
           SET account_name = $1, account_number = $2, bank_name = $3, bank_code = $4, updated_at = NOW()
           WHERE id = $5`,
          [accountName, accountNumber, bankName, bankCode, existingDetails.id]
        );
      }

      logger.info(`Updated bank details for user ${userId}`);
      return true;
    } catch (error) {
      logger.error('Error updating bank details:', error);
      return false;
    }
  }

  // Get verification status for a payout
  async getVerificationStatus(transactionId) {
    try {
      const result = await pool.query(
        'SELECT verified, account_name, account_number, bank_code FROM payout_details WHERE transaction_id = $1',
        [transactionId]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting verification status:', error);
      return null;
    }
  }

  // Re-verify an existing payout
  async reverifyPayout(transactionId) {
    try {
      const details = await pool.query(
        'SELECT * FROM payout_details WHERE transaction_id = $1',
        [transactionId]
      );

      if (details.rows.length === 0) {
        return { success: false, error: 'Payout details not found' };
      }

      const { account_number, bank_code } = details.rows[0];

      if (!bank_code) {
        return { success: false, error: 'Bank code not available for verification' };
      }

      const verification = await this.bankService.verifyBankAccount(account_number, bank_code);

      if (verification.verified) {
        // Update verification status
        await pool.query(
          `UPDATE payout_details 
           SET verified = true, account_name = $1, updated_at = NOW()
           WHERE transaction_id = $2`,
          [verification.accountName, transactionId]
        );

        await pool.query(
          `INSERT INTO payout_history (transaction_id, action, notes)
           VALUES ($1, 'reverified', 'Account successfully re-verified')`,
          [transactionId]
        );

        return { success: true, accountName: verification.accountName };
      }

      return { success: false, error: verification.error };
    } catch (error) {
      logger.error('Error re-verifying payout:', error);
      return { success: false, error: 'Verification failed' };
    }
  }

  // Validate account number
  validateAccountNumber(accountNumber) {
    const cleaned = accountNumber.replace(/\D/g, '');
    
    if (cleaned.length !== 10) {
      return {
        valid: false,
        error: 'Account number must be exactly 10 digits'
      };
    }

    return {
      valid: true,
      cleaned: cleaned
    };
  }

  // Get all pending payouts (for admin)
  async getAllPendingPayouts(statusFilter = null) {
    try {
      let whereClause = "t.transaction_type = 'prize' AND t.payout_status != 'confirmed'";
      const params = [];
      
      if (statusFilter && statusFilter !== '') {
        params.push(statusFilter);
        whereClause += ` AND t.payout_status = $${params.length}`;
      } else {
        whereClause += " AND t.payout_status IN ('pending', 'details_collected', 'approved', 'paid')";
      }

      const query = `
        SELECT 
          t.id as transaction_id,
          t.user_id,
          u.full_name,
          u.phone_number,
          u.lga,
          t.amount,
          t.payout_status,
          t.transaction_type,
          t.created_at as win_date,
          t.paid_at,
          pd.id as payout_detail_id,
          pd.account_name,
          pd.account_number,
          pd.bank_name,
          pd.bank_code,
          pd.verified,
          pd.created_at as details_submitted_at,
          gs.current_question as questions_answered,
          gs.session_key
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN payout_details pd ON t.id = pd.transaction_id
        LEFT JOIN game_sessions gs ON t.session_id = gs.id
        WHERE ${whereClause}
        ORDER BY t.created_at DESC
        LIMIT 100
      `;

      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error('Error getting pending payouts:', error);
      throw error;
    }
  }

  // Approve payout
  async approvePayout(transactionId, adminId) {
    try {
      await pool.query(
        `UPDATE transactions 
         SET payout_status = 'approved', updated_at = NOW()
         WHERE id = $1`,
        [transactionId]
      );

      await pool.query(
        `INSERT INTO payout_history (transaction_id, action, admin_id)
         VALUES ($1, 'approved', $2)`,
        [transactionId, adminId]
      );

      logger.info(`Transaction ${transactionId} approved by ${adminId}`);
      return true;
    } catch (error) {
      logger.error('Error approving payout:', error);
      return false;
    }
  }

  // Mark as paid
  async markAsPaid(transactionId, adminId, paymentReference, paymentMethod) {
    try {
      await pool.query(
        `UPDATE transactions 
         SET payout_status = 'paid', 
             payment_reference = $1, 
             payment_method = $2,
             paid_at = NOW(),
             updated_at = NOW()
         WHERE id = $3`,
        [paymentReference, paymentMethod, transactionId]
      );

      await pool.query(
        `INSERT INTO payout_history (transaction_id, action, admin_id, payment_reference, payment_method)
         VALUES ($1, 'paid', $2, $3, $4)`,
        [transactionId, adminId, paymentReference, paymentMethod]
      );

      logger.info(`Transaction ${transactionId} marked as paid by ${adminId}`);
      return true;
    } catch (error) {
      logger.error('Error marking as paid:', error);
      return false;
    }
  }

  // Confirm payout (user confirms receipt)
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

      await pool.query(
        `INSERT INTO payout_history (transaction_id, action, notes)
         VALUES ($1, 'confirmed', 'User confirmed receipt')`,
        [transactionId]
      );

      logger.info(`Transaction ${transactionId} confirmed by user`);
      return true;
    } catch (error) {
      logger.error('Error confirming payout:', error);
      return false;
    }
  }

  // Get payout statistics
  async getPayoutStats() {
    try {
      const result = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE payout_status IN ('pending', 'details_collected', 'approved')) as pending_count,
          COALESCE(SUM(amount) FILTER (WHERE payout_status IN ('pending', 'details_collected', 'approved')), 0) as pending_amount,
          COUNT(*) FILTER (WHERE payout_status = 'paid' AND DATE(paid_at) = CURRENT_DATE) as paid_today_count,
          COALESCE(SUM(amount) FILTER (WHERE payout_status = 'paid' AND DATE(paid_at) = CURRENT_DATE), 0) as paid_today_amount,
          COUNT(*) FILTER (WHERE payout_status = 'confirmed') as confirmed_count,
          COALESCE(SUM(amount) FILTER (WHERE payout_status = 'confirmed'), 0) as confirmed_amount
        FROM transactions
        WHERE transaction_type = 'prize'
      `);

      return result.rows[0];
    } catch (error) {
      logger.error('Error getting payout stats:', error);
      throw error;
    }
  }
}

module.exports = PayoutService;