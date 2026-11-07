'use strict';

jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));

const { safeFetch } = require('../src/impitClient');
const DynamicCustomProvider = require('../src/services/DynamicCustomProvider');
const { stableMatchId } = require('../src/services/DynamicCustomProvider');
const { isMatchLive, isReplayMatch, REPLAY_SOURCES } = require('../src/catalog');

const BASE = 'https://soccer-replays.example.com/';

function page(cards) {
  return `<html><body><div class="list">${cards.map(c => `
    <article class="card">
      <h2 class="t">${c.title}</h2>
      <a class="go" href="${c.href}">watch</a>
      ${c.time !== undefined ? `<time class="when" ${c.datetime ? `datetime="${c.datetime}"` : ''}>${c.time}</time>` : ''}
    </article>`).join('')}</div></body></html>`;
}

function serve(html) {
  safeFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => html });
}

function makeProvider(selectors = {}) {
  return new DynamicCustomProvider({
    name: 'Soccer Replays',
    baseUrl: BASE,
    category: 'football',
    selectors: { matches: 'article.card', title: 'h2.t', link: 'a.go -> href', ...selectors }
  });
}

describe('DynamicCustomProvider match identity', () => {
  beforeEach(() => safeFetch.mockReset());
  afterEach(() => jest.restoreAllMocks());
  const setNow = (ms) => jest.spyOn(Date, 'now').mockReturnValue(ms);

  test('ids derive from the full link, not the list position', async () => {
    const provider = makeProvider();
    const a = { title: 'Arsenal vs Chelsea', href: '/replay/arsenal-chelsea-2026-11-01' };
    const b = { title: 'Milan vs Inter', href: '/replay/milan-inter-2026-11-01' };

    serve(page([a, b]));
    const first = await provider.getMatches();
    serve(page([b, a])); // site reorders its list
    const second = await provider.getMatches();

    const idOf = (list, title) => list.find(m => m.title === title).id;
    expect(idOf(second, a.title)).toBe(idOf(first, a.title));
    expect(idOf(second, b.title)).toBe(idOf(first, b.title));
    // Two links on the same site must not collapse onto the same id prefix.
    expect(idOf(first, a.title)).not.toBe(idOf(first, b.title));
    expect(idOf(first, a.title)).toBe(stableMatchId('soccerreplays', BASE + 'replay/arsenal-chelsea-2026-11-01'));
    expect(idOf(first, a.title)).toMatch(/^soccerreplays_[0-9a-f]{16}$/);
  });

  test('the same link listed twice in one crawl yields one match', async () => {
    const provider = makeProvider();
    const a = { title: 'Arsenal vs Chelsea', href: '/replay/arsenal-chelsea' };
    serve(page([a, { ...a, title: 'Featured: Arsenal vs Chelsea' }, { title: 'Other', href: '/replay/other' }]));

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map(m => m.id)).size).toBe(2);
  });

  test('dateless items keep their first-seen time across syncs', async () => {
    setNow(Date.UTC(2026, 10, 1, 12, 0, 0));
    const provider = makeProvider();
    const a = { title: 'Arsenal vs Chelsea', href: '/replay/a' };
    const b = { title: 'Milan vs Inter', href: '/replay/b' };

    serve(page([a]));
    const [firstA] = await provider.getMatches();
    expect(firstA.date).toBe(String(Date.UTC(2026, 10, 1, 12, 0, 0)));

    setNow(Date.UTC(2026, 10, 1, 18, 0, 0));
    serve(page([b, a]));
    const second = await provider.getMatches();
    expect(second.find(m => m.title === a.title).date).toBe(firstA.date);
    expect(second.find(m => m.title === b.title).date).toBe(String(Date.UTC(2026, 10, 1, 18, 0, 0)));
  });

  test('a parseable selectors.time date is used instead of the crawl time', async () => {
    const provider = makeProvider({ time: 'time.when' });
    serve(page([
      { title: 'By attr', href: '/r/1', time: 'Sunday', datetime: '2026-10-25T15:00:00Z' },
      { title: 'By text', href: '/r/2', time: '2026-10-24T20:00:00Z' },
      { title: 'Junk', href: '/r/3', time: '12' }
    ]));

    const matches = await provider.getMatches();
    const byTitle = Object.fromEntries(matches.map(m => [m.title, m]));
    expect(byTitle['By attr'].date).toBe(String(Date.parse('2026-10-25T15:00:00Z')));
    expect(byTitle['By text'].date).toBe(String(Date.parse('2026-10-24T20:00:00Z')));
    // Implausible value (bare number -> 1970 epoch) falls back to first-seen.
    expect(Number(byTitle['Junk'].date)).toBeGreaterThan(Date.UTC(2020, 0, 1));
  });

  test('an old dated replay is classified as a replay, not live', async () => {
    const provider = makeProvider({ time: 'time.when' });
    serve(page([{ title: 'Old match', href: '/r/old', time: '2025-01-05T15:00:00Z' }]));
    const [match] = await provider.getMatches();

    REPLAY_SOURCES.add(provider.sourceName); // done by DynamicParserRegistry.mountProvider
    try {
      expect(isMatchLive(match)).toBe(false);
      expect(isReplayMatch(match)).toBe(true);
    } finally {
      REPLAY_SOURCES.delete(provider.sourceName);
    }
  });

  test('a dateless item is no longer live once its first-seen window has passed', async () => {
    setNow(Date.UTC(2026, 10, 1, 12, 0, 0));
    const provider = makeProvider();
    const a = { title: 'Arsenal vs Chelsea', href: '/replay/a' };

    serve(page([a]));
    await provider.getMatches();

    // Previously every crawl re-stamped date=now, so the item stayed "live" forever.
    setNow(Date.UTC(2026, 10, 2, 12, 0, 0));
    serve(page([a]));
    const [later] = await provider.getMatches();
    expect(isMatchLive(later)).toBe(false);
  });
});
