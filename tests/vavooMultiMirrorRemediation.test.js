'use strict';

const VavooProvider = require('../src/providers/VavooProvider');
const StreamEntity = require('../src/domain/StreamEntity');
const { deduplicateResolutions } = require('../src/streams');
const { compareStreams, getVavooClusterRank, parseLanguagePriority } = require('../src/services/LanguagePriorityService');
const { fetchUpstreamManifest } = require('../src/manifestProxy');
const impitClient = require('../src/impitClient');

jest.mock('../src/impitClient', () => ({
  safeFetch: jest.fn(),
  isImpitAvailable: () => false,
  getImpit: () => null,
}));

describe('Vavoo Multi-Mirror Remediation & ExoPlayer 403 Hardening', () => {
  const originalEnv = process.env.VAVOO_ENABLED;

  beforeEach(() => {
    process.env.VAVOO_ENABLED = 'true';
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env.VAVOO_ENABLED = originalEnv;
  });

  describe('1. Multi-Mirror UI Tagging and Scoring in VavooProvider', () => {
    const mockTokenManager = {
      getOrRefreshSig: jest.fn().mockResolvedValue('test_sig'),
      sig: 'test_sig',
      validUntil: Date.now() + 3600000,
      isValid: () => true
    };

    it('resolves Server C feeds with [Server C - 1080p] and score 90', async () => {
      const provider = new VavooProvider({ tokenManager: mockTokenManager });
      const cdnUrl = 'https://37.49.225.28:8008/sunshine/play/sky1c/index.m3u8';
      provider.proxyFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ url: cdnUrl }])
      });

      const streams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/sky1c',
        'networks',
        'SKY SPORT 1 .c',
        { id: 'https://vavoo.to/vavoo-iptv/play/sky1c', channelName: 'SKY SPORT 1 .c', group: 'Germany', language: 'de', is4k: false }
      );

      expect(streams).toHaveLength(1);
      const s = streams[0];
      expect(s.title).toBe('Vavoo (SKY SPORT 1) [Server C - 1080p]');
      expect(s.score).toBe(90);
      expect(s.cluster).toBe('c');
      expect(s.serverCluster).toBe('Server C - 1080p');
      expect(s.url).toContain('/api/manifest?url=');
      expect(s.url).toContain(encodeURIComponent(cdnUrl));
      expect(s.url).toContain('referer=' + encodeURIComponent('https://vavoo.to/'));
    });

    it('resolves Server S feeds with [Server S - 1080p] and score 88', async () => {
      const provider = new VavooProvider({ tokenManager: mockTokenManager });
      const cdnUrl = 'https://37.49.225.28:8008/sunshine/play/sky1s/index.m3u8';
      provider.proxyFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ url: cdnUrl }])
      });

      const streams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/sky1s',
        'networks',
        'SKY SPORT 1 .s',
        { id: 'https://vavoo.to/vavoo-iptv/play/sky1s', channelName: 'SKY SPORT 1 .s', group: 'Germany', language: 'de', is4k: false }
      );

      expect(streams).toHaveLength(1);
      const s = streams[0];
      expect(s.title).toBe('Vavoo (SKY SPORT 1) [Server S - 1080p]');
      expect(s.score).toBe(88);
      expect(s.cluster).toBe('s');
      expect(s.serverCluster).toBe('Server S - 1080p');
    });

    it('resolves Server B feeds with [Server B - 1080p] and score 85', async () => {
      const provider = new VavooProvider({ tokenManager: mockTokenManager });
      const cdnUrl = 'https://37.49.225.28:8008/sunshine/play/sky1b/index.m3u8';
      provider.proxyFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ url: cdnUrl }])
      });

      const streams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/sky1b',
        'networks',
        'SKY SPORT 1 .b',
        { id: 'https://vavoo.to/vavoo-iptv/play/sky1b', channelName: 'SKY SPORT 1 .b', group: 'Germany', language: 'de', is4k: false }
      );

      expect(streams).toHaveLength(1);
      const s = streams[0];
      expect(s.title).toBe('Vavoo (SKY SPORT 1) [Server B - 1080p]');
      expect(s.score).toBe(85);
      expect(s.cluster).toBe('b');
      expect(s.serverCluster).toBe('Server B - 1080p');
    });

    it('resolves HEVC, RAW, and Backup feeds with distinct tags and scores', async () => {
      const provider = new VavooProvider({ tokenManager: mockTokenManager });
      const cdnUrl = 'https://37.49.225.28:8008/sunshine/play/stream/index.m3u8';
      provider.proxyFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ url: cdnUrl }])
      });

      // HEVC
      const hevcStreams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/hevc',
        'networks',
        'SKY SPORT 1 HEVC .b',
        { id: 'https://vavoo.to/vavoo-iptv/play/hevc', channelName: 'SKY SPORT 1 HEVC .b', group: 'Germany', language: 'de' }
      );
      expect(hevcStreams[0].title).toBe('Vavoo (SKY SPORT 1) [HEVC]');
      expect(hevcStreams[0].score).toBe(80);
      expect(hevcStreams[0].cluster).toBe('hevc');

      // RAW
      const rawStreams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/raw',
        'networks',
        'SKY SPORT 1 RAW .b',
        { id: 'https://vavoo.to/vavoo-iptv/play/raw', channelName: 'SKY SPORT 1 RAW .b', group: 'Germany', language: 'de' }
      );
      expect(rawStreams[0].title).toBe('Vavoo (SKY SPORT 1) [RAW]');
      expect(rawStreams[0].score).toBe(79);
      expect(rawStreams[0].cluster).toBe('raw');

      // Server B Backup
      const backupStreams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/backup',
        'networks',
        'SKY SPORT 1 (BACKUP) .b',
        { id: 'https://vavoo.to/vavoo-iptv/play/backup', channelName: 'SKY SPORT 1 (BACKUP) .b', group: 'Germany', language: 'de', isBackup: true }
      );
      expect(backupStreams[0].title).toBe('Vavoo (SKY SPORT 1) [Backup]');
      expect(backupStreams[0].score).toBe(70);
      expect(backupStreams[0].cluster).toBe('backup');
      expect(backupStreams[0].isBackup).toBe(true);

      // Server C Backup
      const backupCStreams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/backup_c',
        'networks',
        'SKY SPORT 1 (BACKUP) .c',
        { id: 'https://vavoo.to/vavoo-iptv/play/backup_c', channelName: 'SKY SPORT 1 (BACKUP) .c', group: 'Germany', language: 'de', isBackup: true }
      );
      expect(backupCStreams[0].title).toBe('Vavoo (SKY SPORT 1) [Server C - Backup]');
      expect(backupCStreams[0].score).toBe(72);
      expect(backupCStreams[0].cluster).toBe('c-backup');
      expect(backupCStreams[0].isBackup).toBe(true);
    });
  });

  describe('2. Deduplication Preservation in deduplicateResolutions', () => {
    it('preserves both Server C and Server B streams for the same channel without deduping them away', () => {
      const serverCStream = new StreamEntity({
        name: 'Vavoo',
        title: 'Vavoo (Sky Sport 1 HD) [Server C - 1080p]',
        url: 'http://localhost:7000/api/manifest?url=cdn1',
        resolution: '1080p',
        score: 90,
        cluster: 'c',
        serverCluster: 'Server C - 1080p',
        channelName: 'Sky Sport 1 HD',
        language: 'German'
      });

      const serverBStream = new StreamEntity({
        name: 'Vavoo',
        title: 'Vavoo (Sky Sport 1 HD) [Server B - 1080p]',
        url: 'http://localhost:7000/api/manifest?url=cdn2',
        resolution: '1080p',
        score: 85,
        cluster: 'b',
        serverCluster: 'Server B - 1080p',
        channelName: 'Sky Sport 1 HD',
        language: 'German'
      });

      const deduped = deduplicateResolutions([serverCStream, serverBStream]);
      expect(deduped).toHaveLength(2);
      expect(deduped.map(s => s.cluster)).toEqual(['c', 'b']);
    });

    it('deduplicates identical feeds within the same cluster and retains the highest score', () => {
      const streamLow = new StreamEntity({
        name: 'Vavoo',
        title: 'Vavoo (Sky Sport 1 HD) [Server C - 1080p]',
        url: 'http://localhost:7000/api/manifest?url=cdn1',
        resolution: '1080p',
        score: 88,
        cluster: 'c',
        channelName: 'Sky Sport 1 HD',
        language: 'German'
      });

      const streamHigh = new StreamEntity({
        name: 'Vavoo',
        title: 'Vavoo (Sky Sport 1 HD) [Server C - 1080p]',
        url: 'http://localhost:7000/api/manifest?url=cdn1_alt',
        resolution: '1080p',
        score: 92,
        cluster: 'c',
        channelName: 'Sky Sport 1 HD',
        language: 'German'
      });

      const deduped = deduplicateResolutions([streamLow, streamHigh]);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].score).toBe(92);
    });

    it('retains distinct cluster mirrors (.b, .c, backup) and deduplicates redundant in-cluster backups', () => {
      const serverB = new StreamEntity({
        name: 'Vavoo',
        title: 'Vavoo (Sky Sport 1 HD) [Server B - 1080p]',
        url: 'http://localhost:7000/api/manifest?url=cdn_b',
        resolution: '1080p',
        score: 85,
        cluster: 'b',
        serverCluster: 'Server B - 1080p',
        channelName: 'Sky Sport 1 HD',
        language: 'German'
      });

      const serverBBackup = new StreamEntity({
        name: 'Vavoo',
        title: 'Vavoo (Sky Sport 1 HD) [Server B - 1080p]',
        url: 'http://localhost:7000/api/manifest?url=cdn_b_bkp',
        resolution: '1080p',
        score: 70,
        cluster: 'b',
        serverCluster: 'Server B - 1080p',
        isBackup: true,
        channelName: 'Sky Sport 1 HD',
        language: 'German'
      });

      const standaloneBackup = new StreamEntity({
        name: 'Vavoo',
        title: 'Vavoo (Sky Sport 1 HD) [Backup]',
        url: 'http://localhost:7000/api/manifest?url=cdn_bkp',
        resolution: '1080p',
        score: 70,
        cluster: 'backup',
        serverCluster: 'Backup',
        isBackup: true,
        channelName: 'Sky Sport 1 HD',
        language: 'German'
      });

      // serverB and serverBBackup share cluster 'b', so serverB (score 85, non-backup) wins.
      // standaloneBackup has cluster 'backup', so it is preserved alongside serverB.
      const deduped = deduplicateResolutions([serverB, serverBBackup, standaloneBackup]);
      expect(deduped).toHaveLength(2);
      expect(deduped.map(s => s.url)).toEqual([
        'http://localhost:7000/api/manifest?url=cdn_b',
        'http://localhost:7000/api/manifest?url=cdn_bkp'
      ]);
    });
  });

  describe('3. Cluster Ordering in LanguagePriorityService', () => {
    it('ranks clusters: Server C (6) > Server S (5) > Server B (4) > HEVC (3) > RAW (2) > Backup (1)', () => {
      expect(getVavooClusterRank({ name: 'Vavoo', cluster: 'c' })).toBe(6);
      expect(getVavooClusterRank({ name: 'Vavoo', cluster: 's' })).toBe(5);
      expect(getVavooClusterRank({ name: 'Vavoo', cluster: 'b' })).toBe(4);
      expect(getVavooClusterRank({ name: 'Vavoo', cluster: 'hevc' })).toBe(3);
      expect(getVavooClusterRank({ name: 'Vavoo', cluster: 'raw' })).toBe(2);
      expect(getVavooClusterRank({ name: 'Vavoo', isBackup: true })).toBe(1);
      expect(getVavooClusterRank({ name: 'Vavoo' })).toBe(3.5);
    });

    it('sorts Server C above Server B when language and provider are equal', () => {
      const config = parseLanguagePriority({});
      const serverC = {
        name: 'Vavoo',
        language: 'German',
        score: 90,
        speedScore: 90,
        cluster: 'c'
      };
      const serverB = {
        name: 'Vavoo',
        language: 'German',
        score: 85,
        speedScore: 90,
        cluster: 'b'
      };

      const sorted = [serverB, serverC].sort((a, b) => compareStreams(a, b, config));
      expect(sorted[0].cluster).toBe('c');
      expect(sorted[1].cluster).toBe('b');
    });

    it('does not falsely elevate a low-scoring Vavoo RAW feed over a high-scoring other provider stream', () => {
      const config = parseLanguagePriority({});
      const daddylive = {
        name: 'DaddyLive',
        title: 'DaddyLive 1080p',
        score: 95,
        speedScore: 90,
        language: 'German'
      };
      const vavooRaw = {
        name: 'Vavoo',
        title: 'Vavoo (Sky Sport 1 HD) [RAW]',
        cluster: 'raw',
        score: 79,
        speedScore: 90,
        language: 'German'
      };

      // compareStreams returns negative if first arg outranks second
      expect(compareStreams(daddylive, vavooRaw, config)).toBeLessThan(0);
      expect(compareStreams(vavooRaw, daddylive, config)).toBeGreaterThan(0);
    });
  });

  describe('4. Dynamic Real-Time Catalog Fallback in VavooProvider', () => {
    it('recovers play URL from mediahubmx-catalog.json when resolve returns 404 or Not found', async () => {
      const mockTokenManager = {
        getOrRefreshSig: jest.fn().mockResolvedValue('valid_sig')
      };
      const provider = new VavooProvider({ tokenManager: mockTokenManager });

      const freshCdnUrl = 'https://37.49.225.28:8008/sunshine/play/sky1_new/index.m3u8';

      provider.proxyFetch = jest.fn().mockImplementation((url, opts) => {
        // Initial resolve endpoint with expired play ID returns 404 / Not found
        if (url.includes('mediahubmx-resolve.json')) {
          const body = JSON.parse(opts.body);
          if (body.url.includes('expired_id')) {
            return Promise.resolve({
              ok: false,
              status: 404,
              json: () => Promise.resolve({ error: 'Not found' })
            });
          }
          if (body.url.includes('fresh_live_id')) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve([{ url: freshCdnUrl }])
            });
          }
        }

        // Real-time catalog fallback query
        if (url.includes('mediahubmx-catalog.json')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              items: [
                {
                  name: 'SKY SPORT 1 HD .c',
                  url: 'https://vavoo.to/vavoo-iptv/play/fresh_live_id',
                  group: 'Germany'
                }
              ]
            })
          });
        }

        return Promise.resolve({ ok: false, status: 500 });
      });

      const streams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/expired_id',
        'networks',
        'SKY SPORT 1 HD .c',
        { id: 'https://vavoo.to/vavoo-iptv/play/expired_id', channelName: 'SKY SPORT 1 HD .c', group: 'Germany', language: 'de' }
      );

      expect(streams).toHaveLength(1);
      expect(streams[0].url).toContain(encodeURIComponent(freshCdnUrl));
      expect(streams[0].cluster).toBe('c');
      expect(streams[0].title).toBe('Vavoo (SKY SPORT 1 HD) [Server C - 1080p]');
    });

    it('retries without group filter if group-filtered catalog search returns 0 items', async () => {
      const mockTokenManager = {
        getOrRefreshSig: jest.fn().mockResolvedValue('valid_sig')
      };
      const provider = new VavooProvider({ tokenManager: mockTokenManager });
      const freshCdnUrl = 'https://37.49.225.28:8008/sunshine/play/sky1_fallback/index.m3u8';

      provider.proxyFetch = jest.fn().mockImplementation((url, opts) => {
        if (url.includes('mediahubmx-resolve.json')) {
          const body = JSON.parse(opts.body);
          if (body.url.includes('expired_group_id')) {
            return Promise.resolve({
              ok: false,
              status: 404,
              json: () => Promise.resolve({ error: 'Not found' })
            });
          }
          if (body.url.includes('resolved_live_id')) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve([{ url: freshCdnUrl }])
            });
          }
        }

        if (url.includes('mediahubmx-catalog.json')) {
          const body = JSON.parse(opts.body);
          // If group filter is present, simulate zero results due to category mismatch upstream
          if (body.filter && body.filter.group) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ items: [] })
            });
          }
          // Retry without group filter returns the active channel
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              items: [
                {
                  name: 'SKY SPORT 1 HD .b',
                  url: 'https://vavoo.to/vavoo-iptv/play/resolved_live_id',
                  group: 'Live TV'
                }
              ]
            })
          });
        }

        return Promise.resolve({ ok: false, status: 500 });
      });

      const streams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/expired_group_id',
        'networks',
        'SKY SPORT 1 HD .b',
        { id: 'https://vavoo.to/vavoo-iptv/play/expired_group_id', channelName: 'SKY SPORT 1 HD .b', group: 'Germany', language: 'de' }
      );

      expect(streams).toHaveLength(1);
      expect(streams[0].url).toContain(encodeURIComponent(freshCdnUrl));
      expect(streams[0].cluster).toBe('b');
    });
  });

  describe('5. ExoPlayer Upstream Manifest Fetch Remediation', () => {
    it('applies User-Agent: MediaHubMX/2 and Referer: https://vavoo.to/ for Sunshine CDN manifests', async () => {
      const sunshineManifestUrl = 'http://37.49.225.28:8008/sunshine/sky1/index.m3u8';
      impitClient.safeFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('#EXTM3U\n#EXTINF:-1,Sky Sport 1\nsegment001.ts')
      });

      const manifestContent = await fetchUpstreamManifest(sunshineManifestUrl);

      expect(manifestContent).toContain('#EXTM3U');
      expect(impitClient.safeFetch).toHaveBeenCalledTimes(1);

      const [calledUrl, options] = impitClient.safeFetch.mock.calls[0];
      expect(calledUrl).toBe(sunshineManifestUrl);
      expect(options.headers['User-Agent']).toBe('MediaHubMX/2');
      expect(options.headers['Referer']).toBe('https://vavoo.to/');
      expect(options.headers['Origin']).toBe('https://vavoo.to');
    });
  });
});
