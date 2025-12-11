const axios = require('axios');
const { logger } = require('../utils/logger');

class BankService {
  constructor() {
    this.paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
    this.baseUrl = 'https://api.paystack.co';
  }

  /**
   * Get list of Nigerian banks from Paystack
   */
  async getBankList() {
    try {
      const response = await axios.get(`${this.baseUrl}/bank`, {
        headers: {
          Authorization: `Bearer ${this.paystackSecretKey}`
        },
        params: {
          country: 'nigeria',
          perPage: 100
        }
      });

      if (response.data.status) {
        return response.data.data.map(bank => ({
          name: bank.name,
          code: bank.code,
          slug: bank.slug
        }));
      }

      return [];
    } catch (error) {
      logger.error('Error fetching bank list:', error);
      return [];
    }
  }

  /**
   * Verify bank account and return account name
   * @param {string} accountNumber - 10-digit account number
   * @param {string} bankCode - Bank code from Paystack
   * @returns {Promise<{verified: boolean, accountName: string, accountNumber: string, bankCode: string}>}
   */
  async verifyBankAccount(accountNumber, bankCode) {
    try {
      logger.info(`Verifying account: ${accountNumber} with bank code: ${bankCode}`);

      const response = await axios.get(`${this.baseUrl}/bank/resolve`, {
        headers: {
          Authorization: `Bearer ${this.paystackSecretKey}`
        },
        params: {
          account_number: accountNumber,
          bank_code: bankCode
        }
      });

      if (response.data.status && response.data.data) {
        const { account_name, account_number } = response.data.data;
        
        logger.info(`✅ Account verified: ${account_name}`);

        return {
          verified: true,
          accountName: account_name,
          accountNumber: account_number,
          bankCode: bankCode
        };
      }

      return {
        verified: false,
        error: 'Account verification failed'
      };

    } catch (error) {
      logger.error('Error verifying bank account:', error.response?.data || error.message);
      
      // Check for specific error messages
      if (error.response?.data?.message) {
        return {
          verified: false,
          error: error.response.data.message
        };
      }

      return {
        verified: false,
        error: 'Could not verify account. Please check account number and bank.'
      };
    }
  }

  /**
   * Format bank name for display
   */
  formatBankName(bankName) {
    // Remove "BANK" suffix if present for cleaner display
    return bankName
      .replace(/\s+BANK$/i, '')
      .replace(/\s+PLC$/i, '')
      .trim();
  }

  /**
   * Search bank by name (fuzzy matching)
   */
  async searchBankByName(searchTerm) {
    const banks = await this.getBankList();
    const normalizedSearch = searchTerm.toLowerCase().trim();

    return banks.filter(bank => 
      bank.name.toLowerCase().includes(normalizedSearch) ||
      bank.slug.includes(normalizedSearch)
    );
  }

  /**
   * Get bank code by exact name match
   */
  async getBankCodeByName(bankName) {
    const banks = await this.getBankList();
    const bank = banks.find(b => 
      b.name.toLowerCase() === bankName.toLowerCase()
    );

    return bank ? bank.code : null;
  }
}

module.exports = BankService;