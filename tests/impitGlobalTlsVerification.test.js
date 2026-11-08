'use strict';

// Regression: requiring src/impitClient used to call setGlobalDispatcher() with
// the scraping agent, whose connect options carry `rejectUnauthorized: false`.
// Every fetch in the process (LLM API calls carrying API keys, DoH, any other
// library) then accepted any certificate. The global dispatcher must verify
// TLS; only the explicit undici scraping path inside safeFetch may relax it.
//
// No external network: a local HTTPS server with a self-signed certificate
// (tests/fixtures/tls) stands in for a man-in-the-middle endpoint.

jest.mock('impit', () => ({
  // Force safeFetch onto its undici path (the one that intentionally keeps
  // relaxed TLS for broken upstream chains).
  Impit: class {
    constructor() {
      throw new Error('simulated native addon failure');
    }
  },
}));

const fs = require('fs');
const path = require('path');
const https = require('https');
const undici = require('undici');

const FIXTURES = path.join(__dirname, 'fixtures', 'tls');

let server;
let baseUrl;

beforeAll(async () => {
  server = https.createServer({
    key: fs.readFileSync(path.join(FIXTURES, 'self-signed-key.pem')),
    cert: fs.readFileSync(path.join(FIXTURES, 'self-signed-cert.pem')),
  }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('self-signed-ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `https://127.0.0.1:${server.address().port}/`;
  // Side effect under test: this installs the process-wide dispatcher.
  require('../src/impitClient');
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function causeChain(err) {
  const parts = [];
  for (let e = err; e; e = e.cause) parts.push(`${e.code || ''} ${e.message || ''}`);
  return parts.join(' | ');
}

describe('impitClient global dispatcher keeps TLS verification on', () => {
  test('fetch through the global dispatcher rejects a self-signed certificate', async () => {
    let err = null;
    try {
      // undici.fetch reads the same global dispatcher slot that Node's built-in
      // fetch reads, so this is what every other library in the process gets.
      const res = await undici.fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
      await res.text();
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(causeChain(err)).toMatch(/SELF_SIGNED|self[- ]signed|certificate/i);
  });

  test('the installed global dispatcher is not the relaxed scraping agent', async () => {
    const dispatcher = undici.getGlobalDispatcher();
    let err = null;
    try {
      const res = await undici.request(baseUrl, { dispatcher, headersTimeout: 5000, bodyTimeout: 5000 });
      await res.body.text();
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(causeChain(err)).toMatch(/SELF_SIGNED|self[- ]signed|certificate/i);
  });

  test('safeFetch undici scraping path still tolerates broken upstream chains', async () => {
    const { safeFetch } = require('../src/impitClient');
    const res = await safeFetch(baseUrl, { timeoutMs: 5000, maxAttempts: 1 });
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('self-signed-ok');
  });
});
