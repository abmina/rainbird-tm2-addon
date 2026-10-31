'use strict';
// Rain Bird LNK payload encryption, as implemented by pyrainbird (encryption.py):
//   key        = SHA-256(password)
//   plaintext  = JSON-RPC request, NUL-padded to a 16-byte boundary
//   message    = SHA-256(unpadded plaintext) [32] || IV [16] || AES-256-CBC(ciphertext)
const crypto = require('crypto');

function deriveKey(password) {
  return crypto.createHash('sha256').update(Buffer.from(password, 'utf8')).digest();
}

function encrypt(text, password) {
  const data = Buffer.from(text, 'utf8');
  const pad = (16 - (data.length % 16)) % 16;
  const padded = Buffer.concat([data, Buffer.alloc(pad, 0)]);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', deriveKey(password), iv);
  cipher.setAutoPadding(false);
  const ct = Buffer.concat([cipher.update(padded), cipher.final()]);
  const digest = crypto.createHash('sha256').update(data).digest();
  return Buffer.concat([digest, iv, ct]);
}

function decrypt(buf, password) {
  if (!Buffer.isBuffer(buf) || buf.length < 48 || (buf.length - 48) % 16 !== 0) {
    throw new Error(`Malformed encrypted payload (${buf ? buf.length : 0} bytes)`);
  }
  const iv = buf.subarray(32, 48);
  const decipher = crypto.createDecipheriv('aes-256-cbc', deriveKey(password), iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(buf.subarray(48)), decipher.final()]);
  // Device pads with NUL / 0x10 / newline; JSON always ends in '}' so strip trailing controls.
  return plain.toString('utf8').replace(/[\x00-\x20]+$/u, '');
}

module.exports = { encrypt, decrypt, deriveKey };
