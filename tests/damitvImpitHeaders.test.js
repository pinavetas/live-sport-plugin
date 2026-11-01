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
const { isDamitvTarget, safeFetch } = require('../src/impitClient');

const impitFetch = impit.__fetchMock;

function mockResponse(status, body = 'ok') {
  return {
    status,
    headers: {},
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

describe('damitv.st Impit Headers & User-Agent Upgrade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    impitFetch.mockResolvedValue(mockResponse(200, '#EXTM3U\n#EXT-X-VERSION:3'));
  });

  test('isDamitvTarget correctly identifies damitv domains', () => {
    expect(isDamitvTarget('https://damitv.st/papi/api/streams')).toBe(true);
    expect(isDamitvTarget('https://messi.damitv.st/live-hls/channel/test/playlist.m3u8')).toBe(true);
    expect(isDamitvTarget('https://example.com/stream.m3u8')).toBe(false);
  });

  test('upgrades legacy Chrome/127 User-Agent to Chrome/131 on damitv requests', async () => {
    await safeFetch('https://messi.damitv.st/live-hls/channel/test/playlist.m3u8', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Referer': 'https://damitv.st/'
      }
    });

    expect(impitFetch).toHaveBeenCalledTimes(1);
    const sentHeaders = impitFetch.mock.calls[0][1].headers;
    expect(sentHeaders['User-Agent']).toContain('Chrome/131.0.0.0');
    expect(sentHeaders['User-Agent']).not.toContain('Chrome/127');
    expect(sentHeaders['Referer']).toBe('https://damitv.st/');
  });

  test('injects default Chrome/131 UA and Referer if omitted on damitv requests', async () => {
    await safeFetch('https://damitv.st/papi/extract-url/123');

    expect(impitFetch).toHaveBeenCalledTimes(1);
    const sentHeaders = impitFetch.mock.calls[0][1].headers;
    expect(sentHeaders['User-Agent']).toContain('Chrome/131.0.0.0');
    expect(sentHeaders['Referer']).toBe('https://damitv.st/');
  });

  test('preserves modern non-Chrome/127 User-Agent on damitv requests', async () => {
    await safeFetch('https://damitv.st/papi/extract-url/123', {
      headers: {
        'User-Agent': 'Mozilla/5.0 CustomBrowser/1.0',
        'Referer': 'https://damitv.st/'
      }
    });

    expect(impitFetch).toHaveBeenCalledTimes(1);
    const sentHeaders = impitFetch.mock.calls[0][1].headers;
    expect(sentHeaders['User-Agent']).toBe('Mozilla/5.0 CustomBrowser/1.0');
  });
});
