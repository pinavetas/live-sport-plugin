'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const {
  resolverProxyOptions,
  onResolverProxyError,
  RESOLVER_DOWN_MESSAGE,
} = require('../src/resolverProxyOptions');

describe('resolver proxy options (http-proxy-middleware v4)', () => {
  test('uses the v4 keys, not the ignored legacy ones', () => {
    const opts = resolverProxyOptions(7123);
    expect(opts.target).toBe('http://127.0.0.1:7123/api');
    expect(opts.on && typeof opts.on.error).toBe('function');
    expect(opts).not.toHaveProperty('onError');
    expect(opts).not.toHaveProperty('logLevel');
  });

  describe('onResolverProxyError', () => {
    let errSpy;
    beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { errSpy.mockRestore(); });

    test('answers 502 through Express when nothing was sent yet', () => {
      const res = { headersSent: false, writeHead: jest.fn(), status: jest.fn(), send: jest.fn(), end: jest.fn() };
      res.status.mockReturnValue(res);
      onResolverProxyError(new Error('connect ECONNREFUSED'), {}, res);
      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.send).toHaveBeenCalledWith(RESOLVER_DOWN_MESSAGE);
    });

    test('only ends a response whose headers already went out', () => {
      const res = { headersSent: true, writeHead: jest.fn(), status: jest.fn(), send: jest.fn(), end: jest.fn() };
      onResolverProxyError(new Error('socket hang up'), {}, res);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });

    test('destroys a raw socket (upgrade requests)', () => {
      const socket = { write: jest.fn(), destroy: jest.fn() };
      onResolverProxyError(new Error('x'), {}, socket);
      expect(socket.destroy).toHaveBeenCalled();
    });
  });

  // http-proxy-middleware is ESM-only and Jest here runs CommonJS, so the
  // end-to-end check runs in a plain Node child process (loopback only).
  test('a down resolver yields the custom 502, not the library default', () => {
    const script = `
      const http = require('http');
      const express = require('express');
      const { createProxyMiddleware } = require('http-proxy-middleware');
      const { resolverProxyOptions } = require('./src/resolverProxyOptions');
      console.error = () => {};
      const probe = http.createServer().listen(0, '127.0.0.1', () => {
        const deadPort = probe.address().port;
        probe.close(() => {
          const app = express();
          app.use('/api', createProxyMiddleware(resolverProxyOptions(deadPort)));
          const server = app.listen(0, '127.0.0.1', () => {
            http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/resolve?x=1' }, (res) => {
              let body = '';
              res.on('data', (c) => { body += c; });
              res.on('end', () => {
                process.stdout.write(JSON.stringify({ status: res.statusCode, body }));
                server.close(() => process.exit(0));
              });
            });
          });
        });
      });
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 20000,
    });
    const { status, body } = JSON.parse(out);
    expect(status).toBe(502);
    expect(body).toBe(RESOLVER_DOWN_MESSAGE);
  });
});
