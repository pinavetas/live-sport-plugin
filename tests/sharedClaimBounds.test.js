const { execFileSync } = require('node:child_process');
const path = require('node:path');

function run(body) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import { cacheClaim, cacheGet, cacheSet, cacheStats } from './resolver/src/cache.js';
    let now = 100000; Date.now = () => now;
    ${body}
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000 }));
}

describe('shared claim bounds and vacant publication reservations', () => {
  test('even a finite excessive TTL expires at the two-minute ceiling', () => {
    const result = run(`
      cacheClaim('provider:match:source', 1e12, true);
      now += 119999; const before = cacheGet('provider:match:source');
      now++; console.log(JSON.stringify({ before, after: cacheGet('provider:match:source') }));
    `);
    expect(result.before.status).toBe('minting');
    expect(result.after.status).toBe('miss');
  });

  test('the claim table rejects new keys at 1000 without displacing live owners', () => {
    const result = run(`
      const first = cacheClaim('provider:first:source', 30000, true);
      for (let i = 1; i < 1000; i++) cacheClaim('provider:key-' + i + ':source', 30000, true);
      const excess = cacheClaim('provider:excess:source', 30000, true);
      const write = cacheSet('provider:first:source', [{ url: 'first' }], 60000, 'ok', first.ownerToken);
      console.log(JSON.stringify({ excess, write, stats: cacheStats(), retry: cacheClaim('provider:excess:source', 30000, true) }));
    `);
    expect(result.excess).toEqual({ ok: false, reason: 'claim-capacity' });
    expect(result.write.ok).toBe(true);
    expect(result.stats.claims).toBe(999);
    expect(result.retry.ok).toBe(true);
  });

  test('capacity pressure reclaims expired slots even between scheduled sweeps', () => {
    const result = run(`
      cacheClaim('provider:first:source', 5000, true);
      now += 4500;
      for (let i = 1; i < 1000; i++) cacheClaim('provider:key-' + i + ':source', 30000, true);
      now += 500;
      const fresh = cacheClaim('provider:fresh:source', 30000, true);
      console.log(JSON.stringify({ fresh, stats: cacheStats() }));
    `);
    expect(result.fresh.ok).toBe(true);
    expect(result.stats.claims).toBe(1000);
  });

  test.each(['ok', 'failed'])('vacant-only acquisition preserves a newer cached %s result', status => {
    const result = run(`
      cacheSet('provider:match:source', [{ url: 'newer' }], 60000, '${status}');
      const claim = cacheClaim('provider:match:source', 30000, true, true);
      console.log(JSON.stringify({ claim, current: cacheGet('provider:match:source'), stats: cacheStats() }));
    `);
    expect(result.claim).toEqual({ ok: false, reason: 'cache-present' });
    expect(result.current.status).toBe(status);
    expect(result.stats.claims).toBe(0);
  });

  test('vacant-only acquisition requires fencing and cannot replace a live owner', () => {
    const result = run(`
      const unfenced = cacheClaim('provider:match:source', 30000, false, true);
      const owner = cacheClaim('provider:match:source', 30000, true);
      const next = cacheClaim('provider:match:source', 30000, true, true);
      console.log(JSON.stringify({ unfenced, next, current: cacheGet('provider:match:source') }));
    `);
    expect(result.unfenced.reason).toBe('fence-required');
    expect(result.next.ok).toBe(false);
    expect(result.current.status).toBe('minting');
  });
});
