'use strict';

describe('ByteRangeSigner default secret configuration', () => {
  const originalAppSecret = process.env.APP_SECRET;
  const originalSessionSecret = process.env.SESSION_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalAppSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = originalAppSecret;
    if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSessionSecret;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('disables signing in production without taking down module loading', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.APP_SECRET;
    delete process.env.SESSION_SECRET;
    jest.resetModules();
    const fatal = jest.spyOn(console, 'error').mockImplementation(() => {});
    const signer = require('../src/services/ByteRangeSigner');
    expect(signer.enabled).toBe(false);
    expect(() => signer.encodeSegmentToken({ url: 'https://cdn.example/segment.ts' }))
      .toThrow(expect.objectContaining({ code: 'ERR_HLS_SIGNING_DISABLED' }));
    const forged = new signer.ByteRangeSigner('nuvio-tiktok-byterange-secret-v1')
      .encodeSegmentToken({ url: 'https://cdn.example/segment.ts' });
    expect(signer.verifySegmentToken(forged.token, forged.psig)).toBeNull();
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal.mock.calls[0][0]).toMatch(/FATAL.*signed HLS redirects disabled/);
  });

  test('uses an unpredictable process-local secret in development', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.APP_SECRET;
    delete process.env.SESSION_SECRET;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.resetModules();
    const { ByteRangeSigner: SignerA } = require('../src/services/ByteRangeSigner');
    const signerA = new SignerA();
    const { token, psig } = signerA.encodeSegmentToken({
      url: 'https://cdn.example/segment.ts',
      referer: 'https://embed.example/',
      origin: 'https://embed.example',
      prefixBytes: 42,
    }, 60000);

    jest.resetModules();
    const { ByteRangeSigner: SignerB } = require('../src/services/ByteRangeSigner');
    expect(new SignerB().verifySegmentToken(token, psig)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  test('uses APP_SECRET consistently across production workers and module reloads', () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_SECRET = 'shared-test-secret';
    delete process.env.SESSION_SECRET;
    jest.resetModules();
    const { ByteRangeSigner: SignerA } = require('../src/services/ByteRangeSigner');
    const { token, psig } = new SignerA().encodeSegmentToken({
      url: 'https://cdn.example/segment.ts',
      referer: 'https://embed.example/',
      origin: 'https://embed.example',
      prefixBytes: 42,
    }, 60000);

    jest.resetModules();
    const { ByteRangeSigner: SignerB } = require('../src/services/ByteRangeSigner');
    expect(new SignerB().verifySegmentToken(token, psig)).not.toBeNull();
  });

  test('accepts the existing SESSION_SECRET fallback for backward compatibility', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.APP_SECRET;
    process.env.SESSION_SECRET = 'legacy-shared-test-secret';
    jest.resetModules();
    const signer = require('../src/services/ByteRangeSigner');
    const { token, psig } = signer.encodeSegmentToken({
      url: 'https://cdn.example/segment.ts',
      prefixBytes: 42,
    }, 60000);
    expect(signer.verifySegmentToken(token, psig)).not.toBeNull();
  });

  test('rejects the formerly public fallback secret in development', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.APP_SECRET;
    delete process.env.SESSION_SECRET;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.resetModules();
    const signer = require('../src/services/ByteRangeSigner');
    const { ByteRangeSigner } = signer;
    const { token, psig } = new ByteRangeSigner('nuvio-tiktok-byterange-secret-v1')
      .encodeSegmentToken({ url: 'https://cdn.example/segment.ts' }, 60000);
    expect(signer.verifySegmentToken(token, psig)).toBeNull();
  });
});
