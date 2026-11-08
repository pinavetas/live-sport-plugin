'use strict';

// Regression: an impit error containing "dns error" (or the Spanish-locale
// "Host desconocido") used to trip the adaptive DNS circuit breaker for 30 min,
// disabling impit's TLS impersonation for the host, even when the domain was
// simply dead. The breaker must only trip on evidence of sinkholing, which
// adaptiveDnsResolver.confirmSinkhole() decides. No socket is opened: impit and
// undici are both stubbed.

let mockImpitError = new Error('dns error: failed to lookup address information: Host desconocido');

jest.mock('impit', () => ({
  Impit: class {
    async fetch() {
      throw mockImpitError;
    }
  },
}));

jest.mock('undici', () => ({
  request: jest.fn(),
  Agent: class {
    constructor() {}
    close() { return Promise.resolve(); }
  },
  setGlobalDispatcher: jest.fn(),
}));

const { request } = require('undici');
const adaptiveDnsResolver = require('../src/services/AdaptiveDnsResolver');
const { safeFetch } = require('../src/impitClient');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function okResponse(body) {
  return {
    statusCode: 200,
    headers: {},
    body: { dump: jest.fn(), arrayBuffer: async () => new TextEncoder().encode(body).buffer },
  };
}

beforeEach(() => {
  jest.restoreAllMocks();
  request.mockReset();
  request.mockResolvedValue(okResponse('ok'));
  adaptiveDnsResolver.poisonedHosts.clear();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

test('a DNS error on a genuinely dead domain does not mark the host poisoned', async () => {
  mockImpitError = new Error('dns error: failed to lookup address information: Host desconocido');
  const confirm = jest.spyOn(adaptiveDnsResolver, 'confirmSinkhole').mockResolvedValue(false);
  const mark = jest.spyOn(adaptiveDnsResolver, 'markPoisoned');

  const res = await safeFetch('https://dead-domain.example/', { timeoutMs: 2000, maxAttempts: 2 });
  await flush();

  expect(res.ok).toBe(true); // still falls back to undici right away
  expect(confirm).toHaveBeenCalledWith('dead-domain.example', expect.stringContaining('Host desconocido'));
  expect(mark).not.toHaveBeenCalled();
  expect(adaptiveDnsResolver.isPoisonedHost('dead-domain.example')).toBe(false);
});

test('a DNS error with confirmed sinkhole evidence trips the circuit breaker', async () => {
  mockImpitError = new Error('dns error: failed to lookup address information');
  jest.spyOn(adaptiveDnsResolver, 'confirmSinkhole').mockResolvedValue(true);

  await safeFetch('https://blocked.example/', { timeoutMs: 2000, maxAttempts: 2 });
  await flush();

  expect(adaptiveDnsResolver.isPoisonedHost('blocked.example')).toBe(true);
});

test('a confirmation failure never breaks the request or poisons the host', async () => {
  mockImpitError = new Error('ConnectionRefused');
  jest.spyOn(adaptiveDnsResolver, 'confirmSinkhole').mockRejectedValue(new Error('boom'));

  const res = await safeFetch('https://flaky.example/', { timeoutMs: 2000, maxAttempts: 2 });
  await flush();

  expect(res.ok).toBe(true);
  expect(adaptiveDnsResolver.isPoisonedHost('flaky.example')).toBe(false);
});
