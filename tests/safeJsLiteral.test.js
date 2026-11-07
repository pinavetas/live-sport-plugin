'use strict';

/**
 * Scraped `window.ftbPageData = {...}` payloads used to be evaluated with
 * `new Function('return ' + text)()`, i.e. remote code execution on third-party HTML.
 * These tests pin the literal-only replacement: data still decodes, code never runs.
 */

jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));
jest.mock('../src/container', () => ({ resolve: () => null }));

const { parseJsLiteral } = require('../src/services/safeJsLiteral');
const SpaHydrator = require('../src/services/SpaHydrator');
const DynamicCustomProvider = require('../src/services/DynamicCustomProvider');
const { safeFetch } = require('../src/impitClient');

afterEach(() => {
  delete globalThis.__pwned;
  safeFetch.mockReset();
});

describe('parseJsLiteral', () => {
  test('decodes the FootyBite / SoccerStreams payload shape (unquoted keys, JSON-string links)', () => {
    const data = parseJsLiteral(`{
      sports: {"id":3,"name":"Football","slug":"football-sports"},
      schedule: [
        {id: 1001, name: 'Arsenal vs Chelsea', start: "1792621800", links: "[{\\"url\\":\\"https://h/x\\"}]"},
        {id: -2, name: \`Plain template\`, start: undefined, extra: null, ok: true, n: 1.5e3,},
      ],
    }`);
    expect(data.sports.slug).toBe('football-sports');
    expect(data.schedule).toHaveLength(2);
    expect(data.schedule[0].name).toBe('Arsenal vs Chelsea');
    expect(JSON.parse(data.schedule[0].links)[0].url).toBe('https://h/x');
    expect(data.schedule[1]).toEqual({
      id: -2, name: 'Plain template', start: undefined, extra: null, ok: true, n: 1500,
    });
  });

  test.each([
    ['function call', '{ a: (function(){ globalThis.__pwned = 1; })() }'],
    ['process access', '{ a: process.mainModule }'],
    ['global identifier', '{ a: globalThis }'],
    ['assignment', '{ a: globalThis.__pwned = 1 }'],
    ['template expression', '{ a: `${globalThis.__pwned = 1}` }'],
    ['getter', '{ get a() { globalThis.__pwned = 1; return 1; } }'],
    ['method', '{ a() {} }'],
    ['computed key', '{ [globalThis.__pwned = 1]: 1 }'],
    ['spread', '{ ...globalThis }'],
    ['arrow function', '{ a: () => 1 }'],
    ['sequence / trailing code', '{ a: 1 }, globalThis.__pwned = 1'],
    ['trailing statement', '{ a: 1 }; globalThis.__pwned = 1'],
    ['regex literal', '{ a: /x/ }'],
    ['new expression', '{ a: new Date() }'],
  ])('rejects %s without executing it', (_label, src) => {
    expect(() => parseJsLiteral(src)).toThrow();
    expect(globalThis.__pwned).toBeUndefined();
  });

  test('__proto__ key stays an own data property (no prototype pollution)', () => {
    const data = parseJsLiteral('{ "__proto__": { polluted: true } }');
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(data.polluted).toBeUndefined();
    expect({}.polluted).toBeUndefined();
  });
});

describe('SpaHydrator does not execute ftbPageData', () => {
  test('malicious payload is ignored and never runs', () => {
    const html = `<html><body><section class="ft-sch"></section><script>
      window.ftbPageData = { schedule: [{ id: 1, name: (function(){ globalThis.__pwned = true; return 'x'; })() }] };
    </script></body></html>`;
    const out = SpaHydrator.hydrate(html);
    expect(globalThis.__pwned).toBeUndefined();
    expect(out).not.toContain('ft-sch-game-item');
  });

  test('valid payload still hydrates', () => {
    const html = `<html><body><section class="ft-sch"></section><script>
      window.ftbPageData = { sports: {slug: 'football'}, schedule: [{ id: 7, name: 'A vs B', start: '1' }] };
    </script></body></html>`;
    const out = SpaHydrator.hydrate(html);
    expect(out).toContain('ft-sch-game-item');
    expect(out).toContain('/sports/football/a-vs-b/7/');
  });
});

describe('DynamicCustomProvider.resolveStream does not execute ftbPageData', () => {
  const provider = () => new DynamicCustomProvider({ name: 'test', baseUrl: 'https://example.test' });
  const page = (body) => ({ ok: true, status: 200, text: async () => body });

  test('malicious payload never runs', async () => {
    safeFetch.mockResolvedValueOnce(page(`<html><body><script>
      window.ftbPageData = { schedule: [{ links: (globalThis.__pwned = true, '[]') }] };
    </script></body></html>`));
    safeFetch.mockResolvedValue({ ok: false, status: 404, text: async () => '' });

    await provider().resolveStream('https://example.test/match/1', 'football', 'A vs B');
    expect(globalThis.__pwned).toBeUndefined();
  });

  test('valid payload links (JSON string) are still followed', async () => {
    safeFetch.mockResolvedValueOnce(page(`<html><body><script>
      window.ftbPageData = { schedule: [{ id: 1, links: '[{"name":"S1","url":" https://host.test/embed/1 "}]' }] };
    </script></body></html>`));
    safeFetch.mockResolvedValue({ ok: false, status: 404, text: async () => '' });

    await provider().resolveStream('https://example.test/match/1', 'football', 'A vs B');
    const fetched = safeFetch.mock.calls.map((c) => c[0]);
    expect(fetched).toContain('https://host.test/embed/1');
  });
});
