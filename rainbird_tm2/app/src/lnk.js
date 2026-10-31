'use strict';
// Transport for the Rain Bird LNK / LNK2 / LNK3 WiFi module.
// - POST /stick with an encrypted JSON-RPC body (see crypto.js)
// - newer firmware is HTTPS-only with a self-signed cert; older is plain HTTP
// - the module handles ONE request at a time and is fragile (ESP32, cloud sync
//   every ~5 min), so every request goes through a single serialized queue with
//   pacing, a timeout, and retry/backoff on "busy" responses.
const http = require('http');
const https = require('https');
const { encrypt, decrypt } = require('./crypto');

class LnkError extends Error {
  constructor(message, { code, retryable = false, auth = false } = {}) {
    super(message);
    this.name = 'LnkError';
    this.code = code;
    this.retryable = retryable;
    this.auth = auth;
  }
}

const HEADERS = {
  'Accept-Language': 'en',
  'Accept-Encoding': 'identity',
  'User-Agent': 'RainBird/2.0 CFNetwork/811.5.4 Darwin/16.7.0',
  Accept: '*/*',
  'Content-Type': 'application/octet-stream',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LnkClient {
  constructor({ host, password, scheme = 'auto', port, minDelayMs = 250, timeoutMs = 10000, attempts = 5, log }) {
    if (!host) throw new Error('LNK host is required');
    this.host = host;
    this.password = password;
    this.scheme = scheme; // 'auto' | 'https' | 'http'
    this.port = port;
    this.minDelayMs = minDelayMs;
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;
    this.log = log || { debug() {}, info() {}, warn() {}, error() {} };
    this._queue = Promise.resolve();
    this._lastEnd = 0;
    this._id = 0;
    this.stats = { requests: 0, failures: 0, retries: 0, lastError: null, lastOk: null };
  }

  /** Queue a JSON-RPC call. Resolves with `result`, rejects with LnkError. */
  request(method, params = {}) {
    const run = () => this._withRetry(method, params);
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  async tunnelSip(data, length) {
    const result = await this.request('tunnelSip', { data, length });
    if (!result || typeof result.data !== 'string') {
      throw new LnkError('tunnelSip reply missing data field');
    }
    return result.data.toUpperCase();
  }

  async _withRetry(method, params) {
    let delay = 1000;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this._paced(method, params);
        this.stats.lastOk = new Date().toISOString();
        return res;
      } catch (err) {
        const e = err instanceof LnkError ? err : new LnkError(err.message, { retryable: true });
        if (!e.retryable || attempt >= this.attempts) {
          this.stats.failures++;
          this.stats.lastError = `${new Date().toISOString()} ${e.message}`;
          throw e;
        }
        this.stats.retries++;
        const wait = delay + Math.floor(Math.random() * 400);
        this.log.debug(`LNK ${method} attempt ${attempt} failed (${e.message}); retrying in ${wait}ms`);
        await sleep(wait);
        delay = Math.min(delay * 2, 8000);
      }
    }
  }

  async _paced(method, params) {
    const wait = this._lastEnd + this.minDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await this._send(method, params);
    } finally {
      this._lastEnd = Date.now();
    }
  }

  async _send(method, params) {
    const schemes = this.scheme === 'auto' ? ['https', 'http'] : [this.scheme];
    let lastErr;
    for (const scheme of schemes) {
      try {
        const result = await this._post(scheme, method, params);
        if (this.scheme === 'auto') {
          this.scheme = scheme;
          this.log.info(`LNK module answers on ${scheme.toUpperCase()}`);
        }
        return result;
      } catch (err) {
        lastErr = err;
        // Only fall back to the other scheme when the port is refused/unreachable.
        if (!(err.code === 'ECONNREFUSED' || err.code === 'EPROTO' || err.code === 'ERR_SSL_WRONG_VERSION_NUMBER')) break;
      }
    }
    throw lastErr;
  }

  _post(scheme, method, params) {
    const body = encrypt(JSON.stringify({ id: ++this._id + Date.now() / 1000, jsonrpc: '2.0', method, params }), this.password);
    const mod = scheme === 'https' ? https : http;
    const opts = {
      host: this.host,
      port: this.port || (scheme === 'https' ? 443 : 80),
      path: '/stick',
      method: 'POST',
      headers: { ...HEADERS, 'Content-Length': body.length },
      agent: false, // never hold the module's single connection open
      timeout: this.timeoutMs,
    };
    if (scheme === 'https') opts.rejectUnauthorized = false; // self-signed, LAN-only, addressed by IP

    return new Promise((resolve, reject) => {
      const req = mod.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          this.stats.requests++;
          const buf = Buffer.concat(chunks);
          if (res.statusCode === 503) return reject(new LnkError('Module busy (HTTP 503)', { code: 503, retryable: true }));
          if (res.statusCode === 403) return reject(new LnkError('Module rejected the password (HTTP 403)', { code: 403, auth: true }));
          if (res.statusCode !== 200) return reject(new LnkError(`HTTP ${res.statusCode} from module`, { code: res.statusCode, retryable: res.statusCode >= 500 }));
          let text;
          try {
            text = decrypt(buf, this.password);
          } catch (e) {
            return reject(new LnkError(`Could not decrypt reply - wrong device password? (${e.message})`, { auth: true }));
          }
          let json;
          try {
            json = JSON.parse(text);
          } catch (e) {
            return reject(new LnkError('Reply is not valid JSON - wrong device password?', { auth: true }));
          }
          if (json.error) {
            const code = json.error.code;
            const msg = json.error.message || 'error';
            if (code === -32002) return reject(new LnkError(`Controller busy: ${msg}`, { code, retryable: true }));
            if (code === -32001) return reject(new LnkError(`Lockout active: ${msg}`, { code, auth: true }));
            return reject(new LnkError(`Controller error ${code}: ${msg}`, { code }));
          }
          resolve(json.result);
        });
        res.on('error', (e) => reject(Object.assign(e, { retryable: true })));
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error(`Timed out after ${this.timeoutMs}ms`), { code: 'ETIMEDOUT' })));
      req.on('error', (e) => {
        const retryable = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ECONNREFUSED', 'ENETUNREACH', 'EAI_AGAIN'].includes(e.code);
        const err = new LnkError(`${e.code || 'error'}: ${e.message}`, { code: e.code, retryable });
        reject(err);
      });
      req.end(body);
    });
  }
}

module.exports = { LnkClient, LnkError };
