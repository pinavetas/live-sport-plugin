'use strict';
jest.mock('../src/container', () => ({ resolve: () => undefined }));
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn(), getImpit: () => null, isImpitAvailable: () => false }));
const { safeFetch } = require('../src/impitClient');
const { verifyStreams } = require('../src/streams');
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n';
const target = 'https://cdn.unknown-family.example.org/live.m3u8';
const right = 'https://cdn.unknown-family.example.org/';
const reply = status => ({ status, text: async () => status === 200 ? playlist : 'denied' });
const run = stream => verifyStreams([stream], '', null, { noteFailure: jest.fn(), noteSuccess: jest.fn() }, { skipSpeedProbe: true });
const stream = headers => ({ url: target, behaviorHints: { proxyHeaders: { request: headers } } });
const filtered = [
  'Host', 'hOsT', 'Connection', 'Keep-Alive', 'Proxy-Connection',
  'Proxy-Authenticate', 'Proxy-Authorization', 'TE', 'Trailer',
  'Transfer-Encoding', 'Upgrade', 'Content-Length', 'Expect'
];
beforeEach(() => { safeFetch.mockReset(); safeFetch.mockResolvedValue(reply(200)); });

test.each(filtered)('verification drops provider-supplied %s', async name => {
  const headers = Object.freeze({ Referer: 'https://embed.example.org/', [name]: 'fixture' });
  expect(await run(stream(headers))).toHaveLength(1);
  const sent = safeFetch.mock.calls[0][1].headers;
  expect(Object.keys(sent).some(key => key.toLowerCase() === name.toLowerCase())).toBe(false);
  expect(headers[name]).toBe('fixture');
});

test('connection-nominated headers are removed case-insensitively while provider credentials remain', async () => {
  const headers = Object.freeze({
    cOnNeCtIoN: 'keep-alive, X-Private-Hop, x-second-hop',
    'X-Private-Hop': 'transport-only', 'X-SECOND-HOP': 'transport-only',
    Authorization: 'Bearer fixture', Cookie: 'session=fixture',
    'X-Api-Key': 'provider-fixture', Referer: 'https://embed.example.org/',
    Origin: 'https://explicit.example.org', 'User-Agent': 'Provider-UA'
  });
  expect(await run(stream(headers))).toHaveLength(1);
  const sent = safeFetch.mock.calls[0][1].headers;
  expect(sent).toEqual({ Authorization: headers.Authorization, Cookie: headers.Cookie,
    'X-Api-Key': headers['X-Api-Key'], Referer: headers.Referer, Origin: headers.Origin, 'User-Agent': headers['User-Agent'] });
});

test('the repaired request and accepted playback hints retain only filtered provider headers', async () => {
  const headers = Object.freeze({
    Referer: 'https://wrong.example.org/', Host: 'wrong-host.example.org',
    Connection: 'X-Hop', 'X-Hop': 'transport-only', 'Content-Length': '999',
    Authorization: 'Bearer fixture', Cookie: 'session=fixture', 'X-Api-Key': 'provider-fixture'
  });
  safeFetch.mockImplementation(async (_url, opts) => reply(opts.headers.Referer === right ? 200 : 403));
  const [result] = await run(stream(headers));
  expect(safeFetch).toHaveBeenCalledTimes(2);
  for (const [, options] of safeFetch.mock.calls) {
    const names = Object.keys(options.headers).map(name => name.toLowerCase());
    for (const name of ['host', 'connection', 'x-hop', 'content-length']) expect(names).not.toContain(name);
    expect(options.headers.Authorization).toBe(headers.Authorization);
    expect(options.headers.Cookie).toBe(headers.Cookie);
    expect(options.headers['X-Api-Key']).toBe(headers['X-Api-Key']);
  }
  expect(result.behaviorHints.proxyHeaders.request).toEqual(safeFetch.mock.calls[1][1].headers);
  expect(headers.Host).toBe('wrong-host.example.org');
});
