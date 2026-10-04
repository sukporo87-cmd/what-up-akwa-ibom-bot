const axios = require('axios');
const { logger } = require('../utils/logger');

// ============================================
// BANK LIST AND ACCOUNT-NAME VERIFICATION
// ============================================
//
// WHY THE PROVIDER IS SWITCHABLE, AND WHY THE LIST AND THE CHECK MOVE TOGETHER
//
// This used to call Paystack for both the list of banks and the account-name
// check. When the Paystack business was disabled, every verification failed
// with "Integration has been disabled" and every prize claim went unverified.
//
// Bank codes are not universal. The traditional banks share their CBN codes
// across gateways (044 Access, 058 GTBank and so on), but the newer banks and
// fintechs do not: 999992 is Paystack's code for OPay, and another gateway may
// use a different one. So the list of banks and the verification must always
// come from the SAME provider — sending one gateway's code to another is how a
// valid account comes back as "invalid".
//
// Flutterwave is the default. Set BANK_VERIFY_PROVIDER=paystack to switch back
// if that business is ever reactivated.
//
// Flutterwave's endpoints, per its docs:
//   GET  /v3/banks/NG            the bank list, with Flutterwave's own codes
//   POST /v3/accounts/resolve    { account_number, account_bank } -> account_name
// In TEST mode Flutterwave only resolves Access Bank (044) accounts, so a test
// key will reject everything else. Use the live key on Render.

const PROVIDERS = ['flutterwave', 'paystack'];
const LIST_CACHE_MS = 12 * 60 * 60 * 1000;

// Words that differ between how a player types a bank and how a gateway lists
// it: "OPay" against "OPay Digital Services Limited (OPay)", "GTBank" against
// "Guaranty Trust Bank". Stripped before names are compared.
const NOISE = /\b(bank|plc|limited|ltd|nigeria|nig|microfinance|mfb|digital|services|service|financial|finance|holdings|company|co|of|for|the|and)\b/g;

function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')     // drop bracketed aliases for the main key
    .replace(/&/g, ' and ')
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Short names players type for banks whose official names look nothing like
// them. Checked before fuzzy matching.
const ALIASES = {
  gtbank: 'guarantytrust', gtb: 'guarantytrust', gtco: 'guarantytrust',
  uba: 'unitedafrica', fcmb: 'firstcitymonument', firstbank: 'first',
  stanbic: 'stanbicibtc', fidelity: 'fidelity', zenith: 'zenith',
  moniepoint: 'moniepoint', palmpay: 'palmpay', kuda: 'kuda', opay: 'opay'
};

class BankService {
  constructor() {
    const chosen = String(process.env.BANK_VERIFY_PROVIDER || 'flutterwave').toLowerCase();
    this.provider = PROVIDERS.includes(chosen) ? chosen : 'flutterwave';
    this.flutterwaveKey = process.env.FLUTTERWAVE_SECRET_KEY;
    this.paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
    this._list = null;
    this._listAt = 0;
  }

  // ============================================
  // THE BANK LIST
  // ============================================
  async getBankList() {
    if (this._list && Date.now() - this._listAt < LIST_CACHE_MS) return this._list;
    try {
      let banks = [];
      if (this.provider === 'flutterwave') {
        const r = await axios.get('https://api.flutterwave.com/v3/banks/NG', {
          headers: { Authorization: `Bearer ${this.flutterwaveKey}` },
          timeout: 15000
        });
        if (r.data && r.data.status === 'success' && Array.isArray(r.data.data)) {
          banks = r.data.data.map(b => ({ name: b.name, code: String(b.code), slug: nameKey(b.name) }));
        }
      } else {
        const r = await axios.get('https://api.paystack.co/bank', {
          headers: { Authorization: `Bearer ${this.paystackSecretKey}` },
          params: { country: 'nigeria', perPage: 100 },
          timeout: 15000
        });
        if (r.data && r.data.status) {
          banks = r.data.data.map(b => ({ name: b.name, code: String(b.code), slug: b.slug || nameKey(b.name) }));
        }
      }
      // An empty answer is not cached: it is almost always an outage, and
      // caching it would turn a blip into twelve hours of failed claims.
      if (banks.length) { this._list = banks; this._listAt = Date.now(); }
      return banks;
    } catch (error) {
      logger.error(`Error fetching bank list from ${this.provider}: ${error.response?.data?.message || error.message}`);
      return this._list || [];
    }
  }

  // ============================================
  // ACCOUNT-NAME VERIFICATION
  // ============================================
  /**
   * @param {string} accountNumber  10-digit NUBAN
   * @param {string} bankCode       the code we hold for the bank
   * @param {string} [bankName]     the bank's name, as the player gave it
   * @returns {Promise<{verified:boolean, accountName?:string, accountNumber?:string,
   *                    bankCode?:string, codeChanged?:boolean, error?:string}>}
   *
   * When a NAME is given and the provider rejects the code, the provider's own
   * code for that bank is looked up and the check retried once. Codes cached
   * from Paystack (999992 for OPay, for one) would otherwise keep failing on
   * Flutterwave forever. The caller should store the returned code when
   * codeChanged is true, so the cache heals itself.
   */
  async verifyBankAccount(accountNumber, bankCode, bankName = null) {
    logger.info(`Verifying account: ${accountNumber} with bank code: ${bankCode} via ${this.provider}`);

    let result = await this._resolve(accountNumber, bankCode);
    if (result.verified || !bankName) return result;

    const theirCode = await this.getBankCodeByName(bankName);
    if (theirCode && String(theirCode) !== String(bankCode)) {
      logger.info(`Retrying ${accountNumber} with ${this.provider}'s own code ${theirCode} for "${bankName}"`);
      const retry = await this._resolve(accountNumber, theirCode);
      if (retry.verified) return { ...retry, codeChanged: true };
    }
    return result;
  }

  async _resolve(accountNumber, bankCode) {
    if (!bankCode) return { verified: false, error: 'Unknown bank' };
    try {
      let name = null, number = accountNumber;
      if (this.provider === 'flutterwave') {
        const r = await axios.post('https://api.flutterwave.com/v3/accounts/resolve',
          { account_number: String(accountNumber), account_bank: String(bankCode) },
          { headers: { Authorization: `Bearer ${this.flutterwaveKey}`, 'Content-Type': 'application/json' },
            timeout: 20000 });
        if (r.data && r.data.status === 'success' && r.data.data && r.data.data.account_name) {
          name = r.data.data.account_name;
          number = r.data.data.account_number || accountNumber;
        }
      } else {
        const r = await axios.get('https://api.paystack.co/bank/resolve', {
          headers: { Authorization: `Bearer ${this.paystackSecretKey}` },
          params: { account_number: accountNumber, bank_code: bankCode },
          timeout: 20000
        });
        if (r.data && r.data.status && r.data.data) {
          name = r.data.data.account_name;
          number = r.data.data.account_number || accountNumber;
        }
      }
      if (!name) return { verified: false, error: 'Account verification failed' };
      logger.info(`✅ Account verified via ${this.provider}: ${name}`);
      return { verified: true, accountName: name, accountNumber: number, bankCode: String(bankCode) };
    } catch (error) {
      const msg = error.response?.data?.message;
      logger.error(`Error verifying bank account via ${this.provider}: ${msg || error.message}`);
      return {
        verified: false,
        error: msg || 'Could not verify account. Please check account number and bank.'
      };
    }
  }

  // ============================================
  // NAMES
  // ============================================
  formatBankName(bankName) {
    return bankName.replace(/\s+BANK$/i, '').replace(/\s+PLC$/i, '').trim();
  }

  async searchBankByName(searchTerm) {
    const banks = await this.getBankList();
    const key = nameKey(searchTerm);
    if (!key) return [];
    return banks.filter(b => b.slug.includes(key) || key.includes(b.slug));
  }

  /**
   * The provider's code for a bank, from a name as a player might type it.
   * Exact match first, then a known alias, then the closest containing match
   * (shortest name wins, so "Access" finds Access Bank, not a microfinance bank
   * that merely contains the word).
   */
  async getBankCodeByName(bankName) {
    const banks = await this.getBankList();
    if (!banks.length || !bankName) return null;

    const lower = String(bankName).toLowerCase().trim();
    const exact = banks.find(b => b.name.toLowerCase() === lower);
    if (exact) return exact.code;

    let key = nameKey(bankName);
    if (!key) return null;
    key = ALIASES[key] || key;

    const same = banks.find(b => b.slug === key);
    if (same) return same.code;

    const close = banks
      .filter(b => b.slug && (b.slug.startsWith(key) || key.startsWith(b.slug)))
      .sort((a, b) => a.name.length - b.name.length);
    return close.length ? close[0].code : null;
  }
}

module.exports = BankService;
module.exports.nameKey = nameKey;