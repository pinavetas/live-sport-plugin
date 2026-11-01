'use strict';

process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const container = require('../src/container');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const MadPlayProvider = require('../src/providers/MadPlayProvider');
const {
  MadPlayResolver,
  DEFAULT_BASE_URL,
  DEFAULT_API_HOST,
  PLAYER_REFERER,
  PLAYER_ORIGIN,
  USER_AGENT
} = require('../src/resolver/madplay/MadPlayResolver');
const {
  rot47,
  decryptStreamUrl,
  extractSignature,
  getMd5Prefix,
  signStreamUrl,
  getWebPlayerUrl,
  AES_KEY,
  AES_IV
} = require('../src/resolver/madplay/MadPlayCrypto');
const {
  decodeProtobuf,
  readVarint
} = require('../src/resolver/madplay/MadPlayProtobuf');

function encodeVarint(n) {
  const bytes = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7Fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeLengthDelimited(fieldNumber, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(b.length);
  return Buffer.concat([tag, len, b]);
}

describe('MadPlay / RBTV+ Provider & Resolver Suite', () => {

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Protobuf Engine (MadPlayProtobuf)
  // ──────────────────────────────────────────────────────────────────────────
  describe('MadPlayProtobuf', () => {
    test('decodes varint numbers accurately', () => {
      // 300 = 0xAC 0x02
      const buf = Buffer.from([0xac, 0x02]);
      const res = readVarint(buf, 0);
      expect(Number(res.value)).toBe(300);
      expect(res.offset).toBe(2);
    });

    test('decodes length-delimited string fields', () => {
      const strBytes = Buffer.from('hello', 'utf8');
      const buf = encodeLengthDelimited(1, strBytes);

      const decoded = decodeProtobuf(buf);
      expect(decoded['1']).toBe('hello');
    });

    test('decodes nested protobuf messages', () => {
      const innerStr = Buffer.from('team A', 'utf8');
      const innerMsg = encodeLengthDelimited(2, innerStr);
      const outerBuf = encodeLengthDelimited(10, innerMsg);

      const decoded = decodeProtobuf(outerBuf);
      expect(decoded['10']).toBeDefined();
      expect(decoded['10']['2']).toBe('team A');
    });

    test('handles empty or malformed buffers without exceptions', () => {
      expect(decodeProtobuf(null)).toEqual({});
      expect(decodeProtobuf(Buffer.alloc(0))).toEqual({});
      expect(decodeProtobuf(Buffer.from([0xff, 0xff]))).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Cryptographic Engine (MadPlayCrypto)
  // ──────────────────────────────────────────────────────────────────────────
  describe('MadPlayCrypto', () => {
    test('rot47 transforms characters reversibly', () => {
      const plaintext = 'https://example.com/hls/live.m3u8';
      const encrypted = rot47(plaintext);
      expect(encrypted).not.toBe(plaintext);
      const decrypted = rot47(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    test('decryptStreamUrl applies rot47 and strips 8-char salt prefix', () => {
      const originalUrl = 'https://fhlsport954.cdx904gouh.xyz/live/test.m3u8';
      const salt = 'abcdefgh'; // 8-char salt
      const combined = salt + originalUrl;
      const encrypted = rot47(combined);

      const decrypted = decryptStreamUrl(encrypted);
      expect(decrypted).toBe(originalUrl);
    });

    test('extractSignature extracts 32-hex signature from handshake payload', () => {
      const payload = Buffer.from('random_prefix_d7192eb2957b44baaa06f470559eb434_random_suffix');
      const sig = extractSignature(payload);
      expect(sig).toBe('d7192eb2957b44baaa06f470559eb434');

      expect(extractSignature('')).toBeNull();
      expect(extractSignature(null)).toBeNull();
    });

    test('getMd5Prefix sorts query parameters strictly according to spec', () => {
      // Order: ['matchId', 'leagueId', 'seasonId', 'sportType', 'language', 'stream']
      const paramsUnsorted = {
        stream: true,
        sportType: 1,
        matchId: '4330298'
      };

      const md5 = getMd5Prefix(paramsUnsorted);
      expect(typeof md5).toBe('string');
      expect(md5.length).toBe(6);

      // Verify that parameter insertion order does not alter MD5
      const paramsReverse = {
        matchId: '4330298',
        sportType: 1,
        stream: true
      };
      expect(getMd5Prefix(paramsReverse)).toBe(md5);
    });

    test('signStreamUrl encrypts rb-session via AES-256-CBC and formats signed URL', () => {
      const streamUrl = 'https://fhlsport.cdx.xyz/live/stream/index.m3u8?param=1';
      const session = 'test-rb-session-token-9988';

      const signed = signStreamUrl(streamUrl, session);
      expect(signed).toContain('/token-');
      expect(signed).toContain('index.m3u8?param=1');

      // Verify token can be decrypted with AES_KEY and AES_IV
      const tokenMatch = signed.match(/\/token-([^/]+)\//);
      expect(tokenMatch).not.toBeNull();
      const rawToken = decodeURIComponent(tokenMatch[1].slice(0, -1)); // strip trailing 'a'

      const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, AES_IV);
      let decryptedSession = decipher.update(rawToken, 'base64', 'utf8');
      decryptedSession += decipher.final('utf8');
      expect(decryptedSession).toBe(session);
    });

    test('getWebPlayerUrl formats base64 encoded match metadata', () => {
      const playerUrl = getWebPlayerUrl('4330298', 1);
      expect(playerUrl).toContain('mdata=NDMzMDI5OF8x');
      expect(playerUrl).toContain('ilang=en');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. MadPlayResolver Engine
  // ──────────────────────────────────────────────────────────────────────────
  describe('MadPlayResolver', () => {
    let mockFetch;
    let resolver;

    beforeEach(() => {
      mockFetch = jest.fn();
      resolver = new MadPlayResolver({
        baseUrl: DEFAULT_BASE_URL,
        fetchFn: mockFetch
      });
    });

    test('supports dynamic base URL getter and setter', () => {
      expect(resolver.getBaseUrl()).toBe(DEFAULT_BASE_URL);
      resolver.setBaseUrl('https://madplay-mirror-99.org/');
      expect(resolver.getBaseUrl()).toBe('https://madplay-mirror-99.org/');
    });

    test('discoverConfig extracts CF_DA_API and DIGIT_ENV from Nuxt HTML', async () => {
      const nuxtHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <script>
            window.__NUXT__ = {
              state: {
                c$config: {
                  brandName: "MadPlay77",
                  CF_DA_API: "https://apis-data99.dynamic-host.ru",
                  DIGIT_ENV: "seth"
                }
              }
            };
          </script>
        </head>
        </html>
      `;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => nuxtHtml
      });

      const config = await resolver.discoverConfig();
      expect(config.apiHost).toBe('https://apis-data99.dynamic-host.ru');
      expect(config.digitEnv).toBe('seth');
      expect(resolver.apiHost).toBe('https://apis-data99.dynamic-host.ru');
    });

    test('getMatches parses matches, indexes streams with O(1) hash map, and outputs MatchEntities', async () => {
      // 1. discoverConfig fetch (landing page)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '<html></html>'
      });

      // Handshake signature buffer
      const sigBuf = Buffer.from('sig_32_chars_12345678901234567890123456789012_ok');

      // Craft protobuf match message
      const homeName = Buffer.from('Arsenal', 'utf8');
      const homeObj = encodeLengthDelimited(3, encodeLengthDelimited(2, homeName));
      const homeTeam = encodeLengthDelimited(10, homeObj);

      const awayName = Buffer.from('Chelsea', 'utf8');
      const awayObj = encodeLengthDelimited(3, encodeLengthDelimited(2, awayName));
      const awayTeam = encodeLengthDelimited(10, awayObj);

      const titleBytes = Buffer.from('Arsenal vs Chelsea', 'utf8');
      const titleObj = encodeLengthDelimited(2, titleBytes);

      const team30Arr = Buffer.concat([
        encodeLengthDelimited(30, titleObj),
        encodeLengthDelimited(30, homeTeam),
        encodeLengthDelimited(30, awayTeam)
      ]);

      const matchId = Buffer.from([0x08, 0xe9, 0x07]); // field 1 = 1001
      const matchMsg = Buffer.concat([matchId, team30Arr]);

      // Stream marker for match 1001: field 50 = "1001"
      const streamMarker = encodeLengthDelimited(50, Buffer.from('1001', 'utf8'));

      // Field 10 envelope containing field 1 (matchMsg) and field 2 (streamMarker)
      const field10Body = Buffer.concat([
        encodeLengthDelimited(1, matchMsg),
        encodeLengthDelimited(2, streamMarker)
      ]);
      const liveProtoBuf = encodeLengthDelimited(10, field10Body);

      // Set up mocks for sportType 1 (football)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => sigBuf
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => liveProtoBuf
      });

      // Other sports return empty handshakes
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404
      });

      const matches = await resolver.getMatches();
      expect(matches.length).toBeGreaterThanOrEqual(1);

      const m = matches.find(item => item.id.includes('1001'));
      expect(m).toBeDefined();
      expect(m).toBeInstanceOf(MatchEntity);
      expect(m.title).toBe('Arsenal vs Chelsea');
      expect(m.category).toBe('football');
      expect(m.team1.name).toBe('Arsenal');
      expect(m.team2.name).toBe('Chelsea');
      expect(m.sources[0].source).toBe('madplay');
    });

    test('resolveStream resolves live stream URL, decrypts ROT47, signs token, and returns StreamEntity', async () => {
      const sigBuf = Buffer.from('sig_32_chars_12345678901234567890123456789012_ok');

      // Detail Protobuf: stream item with streamId = 999, name = TNT Sports, siteType = 2001
      const streamItem = Buffer.concat([
        encodeLengthDelimited(1, Buffer.from('999', 'utf8')),
        encodeLengthDelimited(3, Buffer.from('TNT Sports 1 HD', 'utf8')),
        encodeLengthDelimited(9, Buffer.from('2001', 'utf8'))
      ]);
      const detBody = encodeLengthDelimited(2, streamItem);
      const detProto = encodeLengthDelimited(10, detBody);

      // Stream Detail Protobuf: field 4 = ROT47 encrypted stream URL
      // Add a non-printable varint field (field 1 = 999) so protobuf decoder treats field 2 as submessage
      const rawCdnUrl = 'https://fhlsport954.cdx904gouh.xyz/live/tnt1/index.m3u8';
      const encCdnUrl = rot47('12345678' + rawCdnUrl); // 8-char salt
      const encBytes = Buffer.from(encCdnUrl, 'utf8');
      const streamDetailObj = Buffer.concat([
        Buffer.from([0x08, 0xe7, 0x07]), // field 1 (varint 999)
        encodeLengthDelimited(4, encBytes)
      ]);
      const streamDetailBody = encodeLengthDelimited(2, streamDetailObj);
      const streamDetailProto = encodeLengthDelimited(10, streamDetailBody);

      // Mock 1: code 102 handshake
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => sigBuf
      });
      // Mock 2: match detail
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => detProto
      });
      // Mock 3: stream detail with rb-session
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          'rb-session': 'session-xyz-123'
        },
        arrayBuffer: async () => streamDetailProto
      });

      const streams = await resolver.resolveStream('1001_1', 'football', 'Arsenal vs Chelsea', {}, {}, 'https://addon.live');
      expect(streams.length).toBe(2); // 1 direct/proxied stream + 1 web player

      const directStream = streams[0];
      expect(directStream).toBeInstanceOf(StreamEntity);
      expect(directStream.title).toContain('TNT Sports 1 HD');
      expect(directStream.url).toContain('/api/manifest?url=');
      expect(directStream.behaviorHints.proxyHeaders.request['Referer']).toBe(PLAYER_REFERER);
      expect(directStream.behaviorHints.proxyHeaders.request['Origin']).toBe(PLAYER_ORIGIN);

      const webPlayerStream = streams[1];
      expect(webPlayerStream.externalUrl).toContain('mdata=MTAwMV8x');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Provider & Dependency Injection Integration
  // ──────────────────────────────────────────────────────────────────────────
  describe('MadPlayProvider & Container Integration', () => {
    test('resolves madplayProvider from Awilix container as a singleton', () => {
      const provider = container.resolve('madplayProvider');
      expect(provider).toBeInstanceOf(MadPlayProvider);
      expect(provider.name).toBe('MadPlay');
      expect(provider.source).toBe('madplay');
    });

    test('MatchAggregator includes madplayProvider in its provider list', () => {
      const aggregator = container.resolve('matchAggregator');
      const hasMadPlay = aggregator.providers.some(p => p && p.name === 'MadPlay');
      expect(hasMadPlay).toBe(true);
    });

    test('MadPlayProvider honors custom madplayUrl override', () => {
      const provider = new MadPlayProvider({
        madplayUrl: 'https://custom-madplay.domain.com/'
      });
      expect(provider.getBaseUrl()).toBe('https://custom-madplay.domain.com/');
    });
  });
});
