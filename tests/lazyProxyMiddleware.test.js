'use strict';

const fs = require('fs');
const path = require('path');
const { createProxyMiddleware } = require('../src/lazyProxyMiddleware');

const flush = () => new Promise((r) => setImmediate(r));

describe('lazy http-proxy-middleware wrapper', () => {
  test('imports once, builds the proxy with the given options and reuses it', async () => {
    const handler = jest.fn((req, res, next) => next());
    const real = jest.fn(() => handler);
    const importer = jest.fn(async () => ({ createProxyMiddleware: real }));
    const options = { target: 'http://127.0.0.1:1/api' };
    const mw = createProxyMiddleware(options, importer);

    const next = jest.fn();
    mw({}, {}, next);
    mw({}, {}, next);
    await flush();
    mw({}, {}, next);

    expect(importer).toHaveBeenCalledTimes(1);
    expect(real).toHaveBeenCalledWith(options);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(next).toHaveBeenCalledTimes(3);
  });

  test('does not touch the library until a request arrives', () => {
    const importer = jest.fn();
    createProxyMiddleware({}, importer);
    expect(importer).not.toHaveBeenCalled();
  });

  test('a failed import reaches next(err) and is retried on the next request', async () => {
    const err = new Error('ERR_REQUIRE_ESM');
    const handler = jest.fn();
    const importer = jest.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ createProxyMiddleware: () => handler });
    const mw = createProxyMiddleware({}, importer);

    const next = jest.fn();
    mw({}, {}, next);
    await flush();
    expect(next).toHaveBeenCalledWith(err);

    mw({}, {}, next);
    await flush();
    expect(importer).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('index.js never require()s the ESM-only library directly', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    expect(index).not.toMatch(/require\(\s*['"]http-proxy-middleware['"]\s*\)/);
    expect(index).toMatch(/require\('\.\/lazyProxyMiddleware'\)/);
  });
});
