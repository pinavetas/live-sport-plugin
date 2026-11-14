'use strict';

/**
 * PlooCrypto — decrypts the obfuscated fields of a Plooplayer (W3U) list.
 *
 * Every protected value (`ploorl`, `ploore`, `ploori`, `ploousag`, `pl`, each
 * entry of `qqs.qs`) is the same two-layer envelope, reverse engineered from the
 * app's `bc.d.d()`:
 *
 *   base64( iv8 ‖ ChaCha20( base64( AES-128-CBC(plaintext) ) ) )
 *
 *   - ChaCha20: BouncyCastle `ChaChaEngine`, 20 rounds, **16-byte** key
 *     ("expand 16-byte k" constants, key repeated), 8-byte IV, 64-bit counter
 *     from 0. OpenSSL/Node only implement the 32-byte IETF variant, hence the
 *     hand-written block function below.
 *   - AES-128-CBC with a zero IV and PKCS#7 padding.
 *
 * The keys are constants of the app (same for every list).
 */

const crypto = require('crypto');

const CHACHA_KEY = Buffer.from('12MichaelJackson', 'utf8');
const AES_KEY = Buffer.from('Mich@elJ@ckson12', 'utf8');
const AES_IV = Buffer.alloc(16);
const TAU = [0x61707865, 0x3120646e, 0x79622d36, 0x6b206574]; // "expand 16-byte k"

function rotl(v, c) {
  return ((v << c) | (v >>> (32 - c))) >>> 0;
}

/**
 * ChaCha20 keystream XOR exactly as BouncyCastle's ChaChaEngine does it for a
 * 128-bit key and a 64-bit IV.
 */
function chacha20BouncyCastle(key, iv, data) {
  if (key.length !== 16) throw new Error('ChaCha20 (BC) key must be 16 bytes');
  if (iv.length !== 8) throw new Error('ChaCha20 (BC) IV must be 8 bytes');
  const k = [0, 4, 8, 12].map((i) => key.readUInt32LE(i));
  const iv0 = iv.readUInt32LE(0);
  const iv1 = iv.readUInt32LE(4);
  const out = Buffer.alloc(data.length);
  const state = new Array(16);
  const x = new Array(16);
  const keystream = Buffer.alloc(64);

  const quarter = (a, b, c, d) => {
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 16);
    x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 12);
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 8);
    x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 7);
  };

  for (let block = 0, offset = 0; offset < data.length; block++, offset += 64) {
    state[0] = TAU[0]; state[1] = TAU[1]; state[2] = TAU[2]; state[3] = TAU[3];
    state[4] = k[0]; state[5] = k[1]; state[6] = k[2]; state[7] = k[3];
    state[8] = k[0]; state[9] = k[1]; state[10] = k[2]; state[11] = k[3];
    state[12] = block >>> 0; // counter low word; lists never get near 2^32 blocks
    state[13] = 0;
    state[14] = iv0;
    state[15] = iv1;
    for (let i = 0; i < 16; i++) x[i] = state[i];
    for (let round = 0; round < 10; round++) {
      quarter(0, 4, 8, 12); quarter(1, 5, 9, 13); quarter(2, 6, 10, 14); quarter(3, 7, 11, 15);
      quarter(0, 5, 10, 15); quarter(1, 6, 11, 12); quarter(2, 7, 8, 13); quarter(3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) keystream.writeUInt32LE((x[i] + state[i]) >>> 0, i * 4);
    const end = Math.min(64, data.length - offset);
    for (let i = 0; i < end; i++) out[offset + i] = data[offset + i] ^ keystream[i];
  }
  return out;
}

/**
 * Decrypts one Plooplayer envelope. Throws on malformed input.
 * @param {string} value
 * @returns {string}
 */
function decryptPloo(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('empty Plooplayer value');
  const raw = Buffer.from(value.trim(), 'base64');
  if (raw.length <= 8) throw new Error('Plooplayer value too short');
  const inner = chacha20BouncyCastle(CHACHA_KEY, raw.subarray(0, 8), raw.subarray(8)).toString('utf8');
  const aesCiphertext = Buffer.from(inner, 'base64');
  if (aesCiphertext.length === 0 || aesCiphertext.length % 16 !== 0) {
    throw new Error('Plooplayer inner layer is not an AES block sequence');
  }
  const decipher = crypto.createDecipheriv('aes-128-cbc', AES_KEY, AES_IV);
  return Buffer.concat([decipher.update(aesCiphertext), decipher.final()]).toString('utf8');
}

/** decryptPloo() that returns null instead of throwing (missing or bad values). */
function tryDecryptPloo(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return decryptPloo(value);
  } catch (_) {
    return null;
  }
}

/** Inverse of decryptPloo(); only used by tests to build fixtures. */
function encryptPloo(plaintext, iv = crypto.randomBytes(8)) {
  const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
  const aes = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]).toString('base64');
  const outer = chacha20BouncyCastle(CHACHA_KEY, iv, Buffer.from(aes, 'utf8'));
  return Buffer.concat([iv, outer]).toString('base64');
}

module.exports = { decryptPloo, tryDecryptPloo, encryptPloo, chacha20BouncyCastle };
