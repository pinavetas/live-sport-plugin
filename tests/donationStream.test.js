'use strict';

const fs = require('fs');
const path = require('path');
const container = require('../src/container');
const { handleStream } = require('../src/streams');

describe('Donation Modal & Pinned Stream Wiring', () => {
  const sampleMatches = [
    {
      id: 'test_match_1',
      title: 'Arsenal vs Chelsea',
      category: 'football',
      sources: [{ source: 'replayzone', id: 'https://example.com/stream', name: 'Stream 1' }]
    }
  ];

  beforeAll(() => {
    container.resolve('matchAggregator').syncMatches = async () => [];
    container.resolve('cronService').syncing = true;
    container.resolve('cacheService').setMatches(sampleMatches);
  });

  test('the web pages ship no donation modal (donations only via DONATION_URL)', () => {
    for (const page of ['configure.html', 'live.html', 'status.html']) {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
      expect(html).not.toContain('donate-modal');
      expect(html).not.toContain('checkDonateParam');
    }
  });

  test('handleStream does not pin a donation link when DONATION_URL is unset', async () => {
    delete process.env.DONATION_URL;
    jest.spyOn(container.resolve('replayzoneProvider'), 'resolveStream').mockResolvedValue([
      { name: '1080p Stream', title: 'Stream 1', url: '/api/fastmp4?url=test', behaviorHints: { notWebReady: false } }
    ]);

    const res = await handleStream('tv', 'nuvio_sport_test_match_1', {});
    expect(res).toBeDefined();
    expect(Array.isArray(res.streams)).toBe(true);
    expect(res.streams.length).toBe(1);
    expect(res.streams[0].name).toBe('⚡ Direct Stream');
  });

  test('handleStream ignores a non-absolute DONATION_URL', async () => {
    process.env.DONATION_URL = '/donate';
    jest.spyOn(container.resolve('replayzoneProvider'), 'resolveStream').mockResolvedValue([
      { name: '1080p Stream', title: 'Stream 1', url: '/api/fastmp4?url=test', behaviorHints: { notWebReady: false } }
    ]);

    const res = await handleStream('tv', 'nuvio_sport_test_match_1', {});
    expect(res.streams.length).toBe(1);
    expect(res.streams[0].name).toBe('⚡ Direct Stream');
    delete process.env.DONATION_URL;
  });

  test('handleStream respects custom DONATION_URL environment variable', async () => {
    process.env.DONATION_URL = 'https://ko-fi.com/rajodedara';
    jest.spyOn(container.resolve('replayzoneProvider'), 'resolveStream').mockResolvedValue([
      { name: '1080p Stream', title: 'Stream 1', url: '/api/fastmp4?url=test', behaviorHints: { notWebReady: false } }
    ]);

    const res = await handleStream('tv', 'nuvio_sport_test_match_1', {});
    expect(res.streams[0].name).toBe('🧿 Support Us');
    expect(res.streams[0].externalUrl).toBe('https://ko-fi.com/rajodedara');
    delete process.env.DONATION_URL;
  });

  test('handleStream omits donation link when DONATION_URL is disabled', async () => {
    process.env.DONATION_URL = 'disabled';
    jest.spyOn(container.resolve('replayzoneProvider'), 'resolveStream').mockResolvedValue([
      { name: '1080p Stream', title: 'Stream 1', url: '/api/fastmp4?url=test', behaviorHints: { notWebReady: false } }
    ]);

    const res = await handleStream('tv', 'nuvio_sport_test_match_1', {});
    expect(res.streams.length).toBe(1);
    expect(res.streams[0].name).toBe('⚡ Direct Stream');
    delete process.env.DONATION_URL;
  });
});
