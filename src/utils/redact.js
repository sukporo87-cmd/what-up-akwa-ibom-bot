// ============================================
// FILE: src/utils/redact.js
// Keep secrets out of logs, error objects and crash output.
// ============================================
//
// WHY THIS EXISTS. On 11 Sep a WhatsApp send failed, nothing caught it, and
// Node printed the whole axios error as the process died: request headers
// included, so the WhatsApp access token went into the Render logs in plain
// text. A second failure logged through winston dumped the same object as
// JSON. Any axios error carries the request that produced it — Authorization
// headers, Telegram bot tokens in URLs, payment gateway secret keys — and any
// code that logs `error` whole prints them.
//
// Three layers, each enough on its own for the case it covers:
//   1. installAxiosRedaction  — every axios error is replaced, at the source,
//      by a plain error with no request, no socket and no headers. Callers keep
//      what they actually use: message, code, response.status, response.data.
//   2. redactLogInfo          — the winston format. Whatever reaches the
//      logger, errors or not, is scrubbed before it is written.
//   3. summarizeError         — for the process-level crash handlers, which
//      would otherwise print through Node's own inspector.
//
// Redaction is by pattern (Bearer tokens, bot tokens, known key prefixes,
// credentials in URLs) AND by value: any environment variable whose name says
// it is a secret is replaced wherever its value appears, whatever its format.

// Anywhere in the name, not just at the end: WHATSAPP_ACCESS_TOKEN_PROD is a
// secret too. Over-matching costs a redacted log value; under-matching leaks.
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|_KEY|AUTH)/i;
const CREDENTIAL_URL_ENV = /(DATABASE_URL|REDIS_URL|_URI|_DSN)$/i;
const MIN_SECRET_LENGTH = 12;
const REDACTED = '[REDACTED]';

const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const MAX_ARRAY = 50;
const MAX_STRING = 4000;

// Keys that only ever hold transport machinery: sockets, TLS sessions, the
// outgoing request with its headers. Never worth logging, often the leak.
const DROP_KEYS = new Set([
  'request', '_httpMessage', 'socket', 'agent', 'httpAgent', 'httpsAgent',
  '_events', '_eventsCount', '_readableState', '_writableState', 'client',
  'connection', '_currentRequest', '_redirectable', '_options', 'res', 'req',
  '_sessionCache', 'freeSockets', 'sockets', 'ssl', '_parent', '_parentWrap',
  '_secureContext', 'secureContext', 'session', 'outputData', 'parser'
]);
const SECRET_HEADER_KEYS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'x-auth-token', 'api-key', 'apikey'
]);

const PATTERNS = [
  [/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, `$1${REDACTED}`],
  [/(\/bot)\d{5,}:[A-Za-z0-9_-]{20,}/g, `$1${REDACTED}`],          // Telegram API URLs
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, REDACTED],                      // bare Telegram bot token
  [/\bEAA[A-Za-z0-9]{40,}\b/g, REDACTED],                            // Meta access tokens
  [/\b(sk|pk)_(live|test)_[A-Za-z0-9]{10,}\b/g, `$1_$2_${REDACTED}`], // Paystack / Korapay style
  [/\bFLWSECK[-_A-Za-z0-9]{10,}\b/g, REDACTED],                      // Flutterwave secret
  [/\bre_[A-Za-z0-9]{16,}\b/g, REDACTED],                            // Resend API keys
  [/(:\/\/)[^:/\s@]+:[^@\s/]+@/g, `$1${REDACTED}@`],                 // user:pass@ in URLs
  [/((?:api[_-]?key|secret|access[_-]?token|token|password)["']?\s*[:=]\s*["']?)[^"'&\s,}]{8,}/gi, `$1${REDACTED}`]
];

// Secret values from the environment, longest first so a secret that contains
// another is replaced whole. Recomputed if the environment grows — dotenv runs
// after the first modules have already logged.
let envCache = { size: -1, values: [] };
function envSecrets() {
  const keys = Object.keys(process.env);
  if (keys.length === envCache.size) return envCache.values;
  const values = [];
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v !== 'string' || v.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_ENV_NAME.test(k) || CREDENTIAL_URL_ENV.test(k)) values.push(v);
  }
  values.sort((a, b) => b.length - a.length);
  envCache = { size: keys.length, values };
  return values;
}

function redactString(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  let s = input.length > MAX_STRING ? input.slice(0, MAX_STRING) + '…[truncated]' : input;
  for (const value of envSecrets()) {
    if (s.includes(value)) s = s.split(value).join(REDACTED);
  }
  for (const [re, replacement] of PATTERNS) s = s.replace(re, replacement);
  return s;
}

function isAxiosLike(value) {
  return !!(value && typeof value === 'object' &&
    (value.isAxiosError === true || (value.config && (value.request || value.response))));
}

function isErrorLike(value) {
  return value instanceof Error || isAxiosLike(value);
}

// A small, safe description of any error: what went wrong and where, never
// how the request was authenticated.
function summarizeError(err) {
  if (err === null || err === undefined) return { message: String(err) };
  if (typeof err !== 'object') return { message: redactString(String(err)) };

  const out = {
    name: err.name || 'Error',
    message: redactString(String(err.message || ''))
  };
  if (err.code !== undefined) out.code = err.code;

  const response = err.response;
  const status = response && (response.status || response.statusCode);
  if (status) out.status = status;
  if (response && response.data !== undefined) out.data = redactDeep(response.data, 2);
  else if (response && response.body !== undefined) out.data = redactDeep(response.body, 2);

  if (err.config) {
    if (err.config.method) out.method = String(err.config.method).toUpperCase();
    if (err.config.url) out.url = redactString(String(err.config.url));
  }
  if (err.stack) out.stack = redactString(String(err.stack)).split('\n').slice(0, 8).join('\n');
  return out;
}

function redactDeep(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string') return redactString(value);
  if (type !== 'object') return type === 'function' ? undefined : value;

  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (isErrorLike(value)) return summarizeError(value);
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);

  if (Array.isArray(value)) {
    const arr = value.slice(0, MAX_ARRAY).map(v => redactDeep(v, depth + 1, seen));
    if (value.length > MAX_ARRAY) arr.push(`…${value.length - MAX_ARRAY} more`);
    return arr;
  }
  if (value instanceof Date) return value.toISOString();

  const out = {};
  let n = 0;
  for (const key of Object.keys(value)) {
    if (DROP_KEYS.has(key)) continue;
    if (++n > MAX_KEYS) { out['…'] = 'more keys omitted'; break; }
    out[key] = SECRET_HEADER_KEYS.has(key.toLowerCase())
      ? REDACTED
      : redactDeep(value[key], depth + 1, seen);
  }
  return out;
}

// --------------------------------------------
// LAYER 1: axios
// --------------------------------------------
// The replacement keeps the shape callers read — message, code, status,
// response.status, response.data, isAxiosError — and nothing that can carry a
// credential. Nothing in this codebase reads error.config, error.request or
// response headers (checked when this was written).
function toSafeAxiosError(err) {
  if (!err || typeof err !== 'object') return err;
  if (err.__wutRedacted) return err;

  const safe = new Error(redactString(String(err.message || 'Request failed')));
  safe.name = err.name || 'AxiosError';
  safe.isAxiosError = true;
  safe.__wutRedacted = true;
  if (err.code !== undefined) safe.code = err.code;
  if (err.config) {
    safe.config = {
      method: err.config.method,
      url: err.config.url ? redactString(String(err.config.url)) : undefined
    };
  }
  if (err.response) {
    safe.response = {
      status: err.response.status,
      statusText: err.response.statusText,
      data: redactDeep(err.response.data)
    };
    safe.status = err.response.status;
  }
  if (err.stack) safe.stack = redactString(String(err.stack));
  return safe;
}

function installAxiosRedaction(axiosInstance) {
  if (!axiosInstance || !axiosInstance.interceptors || axiosInstance.__wutRedactionInstalled) return false;
  axiosInstance.interceptors.response.use(
    response => response,
    error => Promise.reject(toSafeAxiosError(error))
  );
  axiosInstance.__wutRedactionInstalled = true;
  return true;
}

// --------------------------------------------
// LAYER 2: winston
// --------------------------------------------
// winston copies an Error's own properties onto the log entry, so a logged
// axios error arrives as info.config / info.request / info.response. Those are
// collapsed into one `error` summary; everything else is scrubbed in place.
// Symbol keys (winston's internal LEVEL / MESSAGE / SPLAT) are left alone.
const LOG_KEEP = new Set(['level', 'timestamp']);
function redactLogInfo(info) {
  if (!info || typeof info !== 'object') return info;

  if (typeof info.message === 'string') info.message = redactString(info.message);
  else if (info.message && typeof info.message === 'object') info.message = redactDeep(info.message);

  if (isAxiosLike(info)) {
    info.error = summarizeError(info);
    for (const key of ['config', 'request', 'response', 'toJSON', 'isAxiosError', 'status', 'code', 'cause']) {
      delete info[key];
    }
  }

  for (const key of Object.keys(info)) {
    if (LOG_KEEP.has(key) || key === 'message') continue;
    if (DROP_KEYS.has(key)) { delete info[key]; continue; }
    const v = info[key];
    info[key] = (typeof v === 'string') ? redactString(v) : redactDeep(v);
  }
  return info;
}

module.exports = {
  REDACTED,
  redactString,
  redactDeep,
  summarizeError,
  toSafeAxiosError,
  installAxiosRedaction,
  redactLogInfo,
  _resetEnvCacheForTests: () => { envCache = { size: -1, values: [] }; }
};