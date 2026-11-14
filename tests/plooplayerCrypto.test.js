'use strict';

const { decryptPloo, tryDecryptPloo, encryptPloo, chacha20BouncyCastle } = require('../src/services/plooplayer/PlooCrypto');
const { encodeDecryptorToken, decodeDecryptorToken } = require('../src/services/plooplayer/PlooDecryptorToken');

describe('PlooCrypto', () => {
  test('decrypts a value captured from a live list (root `pl` = minimum app version)', () => {
    // Known-answer vector: proves the BouncyCastle 128-bit-key ChaCha20 + AES layers match the app.
    expect(decryptPloo('gLkh5CMGJXb7mXJrduO4jlR0310zXx96WVfQpv/8gh8=')).toBe('0.9.9');
  });

  test('round-trips URLs and kid:key pairs longer than one ChaCha block', () => {
    const long = `https://cdn.example.com/${'a'.repeat(200)}/manifest.mpd?token=${'z'.repeat(90)}`;
    expect(decryptPloo(encryptPloo(long))).toBe(long);
    const pair = '573117b598d24b76b25e348ecb1c7ebe:b1acb08c7b775d25a5d73bd41e31dcd5';
    expect(decryptPloo(encryptPloo(pair))).toBe(pair);
  });

  test('the keystream is symmetric and depends on the IV', () => {
    const key = Buffer.from('12MichaelJackson');
    const data = Buffer.from('hello plooplayer, more than sixty-four bytes of payload to cross a block boundary!!');
    const iv = Buffer.from('01234567');
    const enc = chacha20BouncyCastle(key, iv, data);
    expect(enc.equals(data)).toBe(false);
    expect(chacha20BouncyCastle(key, iv, enc).equals(data)).toBe(true);
    expect(chacha20BouncyCastle(key, Buffer.from('76543210'), data).equals(enc)).toBe(false);
  });

  test('tryDecryptPloo returns null for missing or garbage input instead of throwing', () => {
    expect(tryDecryptPloo(undefined)).toBeNull();
    expect(tryDecryptPloo('')).toBeNull();
    expect(tryDecryptPloo('bm90LWVuY3J5cHRlZA==')).toBeNull();
    expect(() => decryptPloo('AAAA')).toThrow();
  });
});

describe('PlooDecryptorToken', () => {
  const KID = '573117b598d24b76b25e348ecb1c7ebe';
  const KEY = 'b1acb08c7b775d25a5d73bd41e31dcd5';

  test('round-trips manifest, keys and allowed headers', () => {
    const token = encodeDecryptorToken({
      mpdUrl: 'https://cdn.example.com/live/default.mpd',
      keys: { [KID.toUpperCase()]: KEY },
      headers: { referer: 'https://www.izzigo.tv', Origin: 'https://www.izzigo.tv', 'User-Agent': 'UA/1' }
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeDecryptorToken(token)).toEqual({
      mpdUrl: 'https://cdn.example.com/live/default.mpd',
      keys: { [KID]: KEY },
      headers: { Referer: 'https://www.izzigo.tv', Origin: 'https://www.izzigo.tv', 'User-Agent': 'UA/1' }
    });
  });

  test('drops non-allowlisted headers, header injection and malformed keys', () => {
    const token = encodeDecryptorToken({
      mpdUrl: 'https://cdn.example.com/a.mpd',
      keys: { [KID]: KEY, nothex: KEY, [KID.slice(2)]: KEY },
      headers: { Cookie: 'x=1', Authorization: 'secret', Referer: 'https://a.example/\r\nX-Evil: 1' }
    });
    expect(decodeDecryptorToken(token)).toEqual({ mpdUrl: 'https://cdn.example.com/a.mpd', keys: { [KID]: KEY }, headers: {} });
  });

  test('rejects non-http manifests and tampered or foreign tokens', () => {
    expect(() => encodeDecryptorToken({ mpdUrl: 'file:///etc/passwd' })).toThrow();
    expect(decodeDecryptorToken('')).toBeNull();
    expect(decodeDecryptorToken('not base64!')).toBeNull();
    const foreign = Buffer.from(JSON.stringify({ v: 1, u: 'ftp://x/y.mpd', k: {} })).toString('base64url');
    expect(decodeDecryptorToken(foreign)).toBeNull();
    const wrongVersion = Buffer.from(JSON.stringify({ v: 9, u: 'https://x/y.mpd' })).toString('base64url');
    expect(decodeDecryptorToken(wrongVersion)).toBeNull();
    expect(decodeDecryptorToken('a'.repeat(9000))).toBeNull();
  });
});
