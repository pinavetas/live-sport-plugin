const { mapMatchToMetaPreview } = require('../src/catalog');
const LeafProvider = require('../src/providers/LeafProvider');

describe('Fixture vs 24/7 Channel Classification', () => {
  test('live match with date="0" and matchup teams is NOT branded as 24/7', () => {
    const match = {
      id: 'ak47_utah_mammoth_vs_tampa_bay_lightning',
      title: 'Utah Mammoth vs Tampa Bay Lightning',
      category: 'hockey',
      league: 'NHL Hockey',
      date: '0',
      status: 'LIVE',
      team1: { name: 'Utah Mammoth' },
      team2: { name: 'Tampa Bay Lightning' },
      sources: [{ source: 'ak47live', id: 'https://example.com/stream.m3u8' }]
    };

    const metaPreview = mapMatchToMetaPreview(match, {});
    expect(metaPreview.releaseInfo).toBe('LIVE');
    expect(metaPreview.name).toMatch(/^🔴 LIVE:/);
    expect(metaPreview.name).not.toContain('📺');
    expect(metaPreview.description).toContain('🔴 LIVE NOW');
    expect(metaPreview.description).not.toContain('24/7 Live Network');
  });

  test('Leaf match without explicit date is NOT branded as 24/7', () => {
    const match = {
      id: 'leaf_football-philadelphia-union-new-england-revolution-20750',
      title: 'Philadelphia Union vs New England Revolution',
      category: 'football',
      date: '0',
      status: 'live',
      team1: { name: 'Philadelphia Union' },
      team2: { name: 'New England Revolution' },
      sources: [{ source: 'leaf', id: 'streamed:20750' }]
    };

    const metaPreview = mapMatchToMetaPreview(match, {});
    expect(metaPreview.releaseInfo).toBe('LIVE');
    expect(metaPreview.name).toMatch(/^🔴 LIVE:/);
    expect(metaPreview.description).toContain('🔴 LIVE NOW');
    expect(metaPreview.description).not.toContain('24/7 Live Network');
  });

  test('genuine 24/7 channel with networks category IS branded as 24/7', () => {
    const channel = {
      id: 'cdn_ch_xx_fox_cricket',
      title: 'Fox Cricket 501',
      category: 'networks',
      date: '0',
      status: 'live',
      sources: [{ source: 'cdnlive', id: 'fox_cricket' }]
    };

    const metaPreview = mapMatchToMetaPreview(channel, {});
    expect(metaPreview.releaseInfo).toBe('24/7');
    expect(metaPreview.name).toMatch(/^📺/);
    expect(metaPreview.description).toContain('24/7 Live Network');
  });

  test('genuine 24/7 channel with dlv_ch_ prefix IS branded as 24/7', () => {
    const channel = {
      id: 'dlv_ch_105',
      title: 'Sky Sports Premier League',
      category: 'networks',
      isChannel: true,
      date: '0',
      status: 'live',
      sources: [{ source: 'daddylive', id: '105' }]
    };

    const metaPreview = mapMatchToMetaPreview(channel, {});
    expect(metaPreview.releaseInfo).toBe('24/7');
    expect(metaPreview.name).toMatch(/^📺/);
    expect(metaPreview.description).toContain('24/7 Live Network');
  });

  test('LeafProvider parses releaseInfo timestamp when present', async () => {
    const provider = new LeafProvider();
    // Simulate upstream item
    const metas = [{
      id: 'streamed:football-philadelphia-union-new-england-revolution-20750',
      type: 'sport',
      name: 'Philadelphia Union vs New England Revolution',
      releaseInfo: '24 Oct 2026 · 23:30 UTC',
      category: 'football'
    }];

    // Mock safeFetch
    jest.spyOn(require('../src/impitClient'), 'safeFetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ metas })
    });

    const matches = await provider._fetchLiveMatchesInternal();
    expect(matches.length).toBe(1);
    expect(matches[0].date).not.toBe('0');
    expect(Number(matches[0].date)).toBeGreaterThan(0);
    const d = new Date(Number(matches[0].date));
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(9); // Oct (0-indexed)
    expect(d.getUTCDate()).toBe(24);
  });
});
