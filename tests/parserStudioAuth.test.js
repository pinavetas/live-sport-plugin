'use strict';

/**
 * /api/parser/* (AI Parser Studio) security:
 *  - router-level auth: local direct requests or PARSER_STUDIO_TOKEN only;
 *  - the server's AI key is never paired with a caller-chosen baseUrl;
 *  - scraped target URLs pass the SSRF guard before any fetch.
 */

jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));

const http = require('http');
const express = require('express');
const { safeFetch } = require('../src/impitClient');
const parserStudioRouter = require('../src/routes/parserStudio');
const dynamicParserRegistry = require('../src/services/DynamicParserRegistry');
const AiParserGeneratorService = require('../src/services/AiParserGeneratorService');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.set('container', null);
  app.use('/api/parser', parserStudioRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/parser`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const ORIGINAL_TOKEN = process.env.PARSER_STUDIO_TOKEN;
beforeEach(() => {
  delete process.env.PARSER_STUDIO_TOKEN;
  safeFetch.mockReset();
  jest.spyOn(dynamicParserRegistry, 'listParsers').mockReturnValue([]);
});
afterEach(() => {
  jest.restoreAllMocks();
  if (ORIGINAL_TOKEN === undefined) delete process.env.PARSER_STUDIO_TOKEN;
  else process.env.PARSER_STUDIO_TOKEN = ORIGINAL_TOKEN;
});

// A request that came through the public reverse proxy carries forwarding headers.
const REMOTE = { 'x-forwarded-for': '203.0.113.9' };

function call(method, path, { headers = {}, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('Parser Studio router auth', () => {
  const endpoints = [
    ['GET', '/list', undefined],
    ['POST', '/generate', { url: 'https://example.com/' }],
    ['POST', '/test', { url: 'https://example.com/', selectors: { matches: 'a' } }],
    ['POST', '/save', { config: { name: 'x', baseUrl: 'https://example.com', selectors: {} } }],
    ['POST', '/sync', {}],
    ['DELETE', '/someparser', undefined],
  ];

  test.each(endpoints)('unauthenticated remote %s %s -> 401 and no work done', async (method, path, body) => {
    const generate = jest.spyOn(AiParserGeneratorService.prototype, 'generateParser');
    const save = jest.spyOn(dynamicParserRegistry, 'saveParser');
    const del = jest.spyOn(dynamicParserRegistry, 'deleteParser');

    const res = await call(method, path, { headers: REMOTE, body });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(expect.objectContaining({ success: false, reason: 'local_only' }));
    expect(generate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test('remote caller cannot authenticate with any token while PARSER_STUDIO_TOKEN is unset', async () => {
    const res = await call('GET', '/list', { headers: { ...REMOTE, 'x-parser-studio-token': '' } });
    expect(res.status).toBe(401);
    const res2 = await call('GET', '/list?token=undefined', { headers: REMOTE });
    expect(res2.status).toBe(401);
  });

  test('remote caller with a wrong token -> 401', async () => {
    process.env.PARSER_STUDIO_TOKEN = 's3cret-token';
    const res = await call('GET', '/list', { headers: { ...REMOTE, 'x-parser-studio-token': 'nope' } });
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe('invalid_token');
  });

  test('remote caller with the right token (header or ?token=) is allowed', async () => {
    process.env.PARSER_STUDIO_TOKEN = 's3cret-token';
    const viaHeader = await call('GET', '/list', { headers: { ...REMOTE, 'x-parser-studio-token': 's3cret-token' } });
    expect(viaHeader.status).toBe(200);
    const viaQuery = await call('GET', '/list?token=s3cret-token', { headers: REMOTE });
    expect(viaQuery.status).toBe(200);
  });

  test('direct local request is allowed without a token', async () => {
    const res = await call('GET', '/list');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, parsers: [] });
  });
});

describe('Parser Studio SSRF gate', () => {
  test('POST /test rejects a private / loopback target before fetching', async () => {
    const res = await call('POST', '/test', { body: { url: 'http://127.0.0.1:7000/api/matches', selectors: { matches: 'a' } } });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('blocked_address');
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test('POST /generate rejects the cloud metadata address before fetching', async () => {
    const res = await call('POST', '/generate', { body: { url: 'http://169.254.169.254/latest/meta-data/' } });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('blocked_address');
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test('generateParser refuses private targets and never calls fetchFn', async () => {
    const fetchFn = jest.fn();
    const svc = new AiParserGeneratorService({ fetchFn });
    await expect(svc.generateParser({ url: 'http://10.0.0.5/admin' })).rejects.toThrow(/Blocked outbound URL/);
    await expect(svc.generateParser({ url: 'http://localhost:8080/' })).rejects.toThrow(/Blocked outbound URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('AI key is never paired with a caller-supplied baseUrl', () => {
  function captureService() {
    const calls = [];
    const svc = new AiParserGeneratorService({
      baseUrl: 'https://llm.server-configured.example/v1',
      apiKey: 'server-secret-key',
      fetchFn: async (url, opts) => {
        calls.push({ url, headers: opts.headers || {} });
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
      },
    });
    return { svc, calls };
  }

  test('caller baseUrl without apiKey -> request carries NO Authorization header', async () => {
    const { svc, calls } = captureService();
    await svc.queryLlm({ prompt: 'p', systemPrompt: 's', config: { baseUrl: 'https://attacker.example/v1' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://attacker.example/v1/chat/completions');
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(JSON.stringify(calls[0])).not.toContain('server-secret-key');
  });

  test('caller baseUrl with its own apiKey -> caller key is used', async () => {
    const { svc, calls } = captureService();
    await svc.queryLlm({ prompt: 'p', systemPrompt: 's', config: { baseUrl: 'https://my-llm.example/v1', apiKey: 'caller-key' } });
    expect(calls[0].headers.Authorization).toBe('Bearer caller-key');
  });

  test('no caller baseUrl (or the configured one) -> server key goes to the server endpoint', async () => {
    const { svc, calls } = captureService();
    await svc.queryLlm({ prompt: 'p', systemPrompt: 's', config: {} });
    await svc.queryLlm({ prompt: 'p', systemPrompt: 's', config: { baseUrl: 'https://llm.server-configured.example/v1/' } });
    for (const c of calls) {
      expect(c.url).toBe('https://llm.server-configured.example/v1/chat/completions');
      expect(c.headers.Authorization).toBe('Bearer server-secret-key');
    }
  });
});
