'use strict';

jest.mock('impit', () => {
  const fetchMock = jest.fn();
  return {
    __fetchMock: fetchMock,
    Impit: class {
      fetch(...args) {
        return fetchMock(...args);
      }
    },
  };
});

jest.mock('undici', () => ({
  request: jest.fn(),
  Agent: class {
    constructor() {}
    close() { return Promise.resolve(); }
  },
}));

const impit = require('impit');
const { isDembedTarget, safeFetch } = require('../src/impitClient');

const impitFetch = impit.__fetchMock;

function mockResponse(status, body = 'ok') {
  return {
    status,
    headers: {},
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

describe('dembed.st Impit Headers & Target Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    impitFetch.mockResolvedValue(mockResponse(200, '<!doctype html><div id="player"></div>'));
  });

  describe('isDembedTarget', () => {
    test('correctly identifies dembed.st URLs', () => {
      expect(isDembedTarget('https://dembed.st/premiumtv/daddy.php?id=593')).toBe(true);
      expect(isDembedTarget('https://sub.dembed.st/embed/channel')).toBe(true);
      expect(isDembedTarget('http://dembed.st/player.php')).toBe(true);
    });

    test('returns false for non-dembed domains and falsy inputs', () => {
      expect(isDembedTarget('https://dlive.sx/stream/593.html')).toBe(false);
      expect(isDembedTarget('https://damitv.st/papi/matches')).toBe(false);
      expect(isDembedTarget('https://dlstreams.st/schedule')).toBe(false);
      expect(isDembedTarget('')).toBe(false);
      expect(isDembedTarget(null)).toBe(false);
      expect(isDembedTarget(undefined)).toBe(false);
    });
  });

  describe('safeFetch header decoration for dembed.st', () => {
    test('decorates dembed.st target with iframe Sec-Fetch headers and default referer when omitted', async () => {
      await safeFetch('https://dembed.st/premiumtv/daddy.php?id=593', { attempts: 1 });

      expect(impitFetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOpts] = impitFetch.mock.calls[0];
      expect(calledUrl).toBe('https://dembed.st/premiumtv/daddy.php?id=593');
      expect(calledOpts.headers['Referer']).toBe('https://dlive.sx/');
      expect(calledOpts.headers['Sec-Fetch-Dest']).toBe('iframe');
      expect(calledOpts.headers['Sec-Fetch-Mode']).toBe('navigate');
      expect(calledOpts.headers['Sec-Fetch-Site']).toBe('cross-site');
      expect(calledOpts.headers['User-Agent']).toMatch(/Mozilla/);
    });

    test('preserves caller-provided referer while ensuring iframe Sec-Fetch headers', async () => {
      const customReferer = 'https://dlive.sx/stream/stream-593.php';
      await safeFetch('https://dembed.st/premiumtv/daddy.php?id=593', {
        headers: { 'Referer': customReferer },
        attempts: 1,
      });

      expect(impitFetch).toHaveBeenCalledTimes(1);
      const [, calledOpts] = impitFetch.mock.calls[0];
      expect(calledOpts.headers['Referer']).toBe(customReferer);
      expect(calledOpts.headers['Sec-Fetch-Dest']).toBe('iframe');
      expect(calledOpts.headers['Sec-Fetch-Mode']).toBe('navigate');
      expect(calledOpts.headers['Sec-Fetch-Site']).toBe('cross-site');
    });

    test('does not decorate non-dembed targets with dembed headers', async () => {
      await safeFetch('https://dlive.sx/stream/stream-593.php', { attempts: 1 });

      expect(impitFetch).toHaveBeenCalledTimes(1);
      const [, calledOpts] = impitFetch.mock.calls[0];
      expect(calledOpts.headers['Sec-Fetch-Dest']).toBeUndefined();
      expect(calledOpts.headers['Referer']).toBeUndefined();
    });
  });
});
