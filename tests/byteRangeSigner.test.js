'use strict';

const byteRangeSigner = require('../src/services/ByteRangeSigner');
const { ByteRangeSigner } = byteRangeSigner;

describe('ByteRangeSigner', () => {
  const testUrl = 'https://p16-common-sign.tiktokcdn-us.com/tos-useast8-v-5300-tx2/segment_1.image';
  const testData = {
    url: testUrl,
    referer: 'https://embed.st/',
    origin: 'https://embed.st',
    prefixBytes: 42
  };

  test('successfully encodes and verifies a valid segment token', () => {
    const { token, psig } = byteRangeSigner.encodeSegmentToken(testData, 60000);
    expect(token).toBeDefined();
    expect(psig).toBeDefined();

    const decoded = byteRangeSigner.verifySegmentToken(token, psig);
    expect(decoded).not.toBeNull();
    expect(decoded.url).toBe(testUrl);
    expect(decoded.referer).toBe('https://embed.st/');
    expect(decoded.origin).toBe('https://embed.st');
    expect(decoded.prefixBytes).toBe(42);
  });

  test('rejects expired token', () => {
    // TTL of -1000ms (already expired)
    const { token, psig } = byteRangeSigner.encodeSegmentToken(testData, -1000);
    const decoded = byteRangeSigner.verifySegmentToken(token, psig);
    expect(decoded).toBeNull();
  });

  test('rejects tampered token', () => {
    const { token, psig } = byteRangeSigner.encodeSegmentToken(testData, 60000);
    const tamperedToken = token.slice(0, -4) + 'AAAA';
    const decoded = byteRangeSigner.verifySegmentToken(tamperedToken, psig);
    expect(decoded).toBeNull();
  });

  test('rejects tampered signature', () => {
    const { token, psig } = byteRangeSigner.encodeSegmentToken(testData, 60000);
    const tamperedPsig = psig + 'x';
    const decoded = byteRangeSigner.verifySegmentToken(token, tamperedPsig);
    expect(decoded).toBeNull();
  });

  test('rejects tokens signed with a different secret', () => {
    const signer1 = new ByteRangeSigner('secret-one');
    const signer2 = new ByteRangeSigner('secret-two');

    const { token, psig } = signer1.encodeSegmentToken(testData, 60000);
    const decoded = signer2.verifySegmentToken(token, psig);
    expect(decoded).toBeNull();
  });

  test('handles malformed inputs defensively', () => {
    expect(byteRangeSigner.verifySegmentToken(null, 'psig')).toBeNull();
    expect(byteRangeSigner.verifySegmentToken('token', null)).toBeNull();
    expect(byteRangeSigner.verifySegmentToken('token', 'invalidpsigformat')).toBeNull();
    expect(byteRangeSigner.verifySegmentToken('not-json-token', '12345.sig')).toBeNull();
  });
});
