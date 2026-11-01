const TeamLogoService = require('../src/services/TeamLogoService');
const fs = require('fs');
const vm = require('vm');

describe('Your Teams filtering and team mapping', () => {
  let parseFavoriteTeams;
  let isFavoriteMatch;
  let logoSvc;

  beforeAll(() => {
    logoSvc = new TeamLogoService();

    const catalogCode = fs.readFileSync('src/catalog.js', 'utf8');
    const sandbox = {
      foldText: (s) => (typeof s !== 'string' ? '' : s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()),
    };
    vm.createContext(sandbox);

    const fnCode = catalogCode.slice(
      catalogCode.indexOf('function parseFavoriteTeams('),
      catalogCode.indexOf('function compareCatalogMatches(')
    );
    vm.runInContext(fnCode, sandbox);
    parseFavoriteTeams = sandbox.parseFavoriteTeams;
    isFavoriteMatch = sandbox.isFavoriteMatch;
  });

  test('parses favorite teams and handles punctuation and abbreviations (jrs -> juniors)', () => {
    const favs = parseFavoriteTeams({ teams: 'River, Boca Jrs.' });
    expect(favs).toEqual([
      { phrase: 'river', tokens: ['river'] },
      { phrase: 'boca jrs ', tokens: ['boca', 'juniors'] },
    ]);
  });

  test('rejects 24/7 channels and non-events', () => {
    const favs = parseFavoriteTeams({ teams: 'River, Boca Jrs.' });

    // 24/7 cooking show channel "A Bocados"
    expect(isFavoriteMatch({ title: 'A Bocados', category: 'networks', date: '0' }, favs)).toBe(false);

    // 24/7 FAST TV channels for "River Monsters"
    expect(isFavoriteMatch({ title: 'LG 535 RIVER MONSTER', category: 'networks', date: '0' }, favs)).toBe(false);
    expect(isFavoriteMatch({ title: 'RIVER MONSTERS', category: 'networks', date: '0' }, favs)).toBe(false);
  });

  test('avoids false substring/prefix word collisions (boca must not match bocados)', () => {
    const favs = parseFavoriteTeams({ teams: 'Boca' });
    // Match event with bocados in title
    expect(isFavoriteMatch({ title: 'Festival de Bocados 2026', category: 'other', date: String(Date.now() + 10000) }, favs)).toBe(false);
  });

  test('matches real upcoming and live team fixtures', () => {
    const favs = parseFavoriteTeams({ teams: 'River, Boca Jrs.' });

    const liveMatch = {
      title: 'Vasco da Gama vs Boca Juniors',
      category: 'football',
      date: String(Date.now() + 7200000),
    };
    expect(isFavoriteMatch(liveMatch, favs)).toBe(true);

    const riverMatch = {
      title: 'River Plate vs Platense',
      category: 'football',
      date: String(Date.now() + 3600000),
    };
    expect(isFavoriteMatch(riverMatch, favs)).toBe(true);
  });

  test('maps "Deportivo" in Spain/La Liga to Deportivo Alavés instead of Deportivo Cali', () => {
    const alavesLogo = logoSvc.getCachedLogo('Deportivo');
    expect(alavesLogo).toBeTruthy();
    expect(alavesLogo).toContain('mfn99h1734673842.png'); // Deportivo Alavés badge

    // Deportivo Cali explicitly queries Cali
    const caliLogo = logoSvc.getCachedLogo('Deportivo Cali');
    expect(caliLogo).toBeTruthy();
    expect(caliLogo).toContain('isc2yu1580833286.png'); // Deportivo Cali badge
  });
});
