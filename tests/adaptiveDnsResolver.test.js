'use strict';

const { AdaptiveDnsResolver } = require('../src/services/AdaptiveDnsResolver');
const dns = require('node:dns');

describe('AdaptiveDnsResolver & Anti-Censorship Circuit Breaker', () => {
  let resolver;

  beforeEach(() => {
    resolver = new AdaptiveDnsResolver({
      circuitResetMs: 1000, // 1s for fast test resets
      cacheTtlMs: 500,
      maxEntries: 10
    });
  });

  describe('isLocalOrReserved', () => {
    test('correctly identifies localhost and local dev environments', () => {
      expect(resolver.isLocalOrReserved('localhost')).toBe(true);
      expect(resolver.isLocalOrReserved('my-app.localhost')).toBe(true);
      expect(resolver.isLocalOrReserved('api.local')).toBe(true);
      expect(resolver.isLocalOrReserved('cluster.internal')).toBe(true);
    });

    test('correctly identifies IP literals as reserved', () => {
      expect(resolver.isLocalOrReserved('127.0.0.1')).toBe(true);
      expect(resolver.isLocalOrReserved('192.168.1.10')).toBe(true);
      expect(resolver.isLocalOrReserved('::1')).toBe(true);
      expect(resolver.isLocalOrReserved('fe80::1')).toBe(true);
    });

    test('identifies public external hostnames as not local', () => {
      expect(resolver.isLocalOrReserved('dlive.sx')).toBe(false);
      expect(resolver.isLocalOrReserved('fullraces.com')).toBe(false);
      expect(resolver.isLocalOrReserved('streamed.pk')).toBe(false);
      expect(resolver.isLocalOrReserved('google.com')).toBe(false);
    });

    test('handles null, undefined and invalid types safely', () => {
      expect(resolver.isLocalOrReserved(null)).toBe(true);
      expect(resolver.isLocalOrReserved(undefined)).toBe(true);
      expect(resolver.isLocalOrReserved('')).toBe(true);
    });
  });

  describe('isSinkholedIp', () => {
    test('detects loopback and unspecified sinkhole patterns', () => {
      expect(resolver.isSinkholedIp('127.0.0.1')).toBe(true);
      expect(resolver.isSinkholedIp('127.255.0.1')).toBe(true);
      expect(resolver.isSinkholedIp('0.0.0.0')).toBe(true);
      expect(resolver.isSinkholedIp('::1')).toBe(true);
      expect(resolver.isSinkholedIp('::')).toBe(true);
    });

    test('accepts valid public IPs as not sinkholed', () => {
      expect(resolver.isSinkholedIp('213.21.239.30')).toBe(false);
      expect(resolver.isSinkholedIp('1.1.1.1')).toBe(false);
      expect(resolver.isSinkholedIp('8.8.8.8')).toBe(false);
      expect(resolver.isSinkholedIp('188.114.97.5')).toBe(false);
    });
  });

  describe('Circuit Breaker state transitions', () => {
    test('starts with CLOSED circuit for unknown hosts', () => {
      expect(resolver.isPoisonedHost('dlive.sx')).toBe(false);
    });

    test('trips to OPEN when markPoisoned is called', () => {
      resolver.markPoisoned('dlive.sx', 'ISP sinkhole to 127.0.0.1');
      expect(resolver.isPoisonedHost('dlive.sx')).toBe(true);
    });

    test('never marks local or reserved hosts', () => {
      resolver.markPoisoned('localhost', 'test');
      expect(resolver.isPoisonedHost('localhost')).toBe(false);
      resolver.markPoisoned('127.0.0.1', 'test');
      expect(resolver.isPoisonedHost('127.0.0.1')).toBe(false);
    });

    test('transitions to HALF-OPEN after circuitResetMs expires', async () => {
      resolver.markPoisoned('dlive.sx', 'test');
      expect(resolver.isPoisonedHost('dlive.sx')).toBe(true);

      // Advance past reset timer
      await new Promise(r => setTimeout(r, 1050));
      expect(resolver.isPoisonedHost('dlive.sx')).toBe(false);
    });

    test('evicts oldest entries when maxEntries is reached', () => {
      for (let i = 0; i < 15; i++) {
        resolver.markPoisoned(`host-${i}.com`, 'sinkholed');
      }
      expect(resolver.poisonedHosts.size).toBeLessThanOrEqual(10);
      expect(resolver.isPoisonedHost('host-0.com')).toBe(false); // Evicted
      expect(resolver.isPoisonedHost('host-14.com')).toBe(true); // Retained
    });
  });

  describe('lookup integration', () => {
    let origLookup;

    beforeEach(() => {
      origLookup = dns.lookup;
    });

    afterEach(() => {
      dns.lookup = origLookup;
    });

    test('normal path: passes through directly when system DNS returns clean IP', (done) => {
      dns.lookup = jest.fn((host, opts, cb) => {
        cb(null, '93.184.216.34', 4);
      });

      resolver.lookup('example.com', (err, addr, family) => {
        expect(err).toBeNull();
        expect(addr).toBe('93.184.216.34');
        expect(family).toBe(4);
        expect(resolver.isPoisonedHost('example.com')).toBe(false);
        done();
      });
    });

    test('fallback path: recovers via secure DNS when system DNS returns 127.0.0.1 sinkhole', (done) => {
      dns.lookup = jest.fn((host, opts, cb) => {
        cb(null, '127.0.0.1', 4); // Simulated ISP DNS sinkhole
      });

      jest.spyOn(resolver, 'resolveSecure').mockResolvedValue(['213.21.239.30']);

      resolver.lookup('dlive.sx', (err, addr, family) => {
        expect(err).toBeNull();
        expect(addr).toBe('213.21.239.30');
        expect(family).toBe(4);
        expect(resolver.isPoisonedHost('dlive.sx')).toBe(true); // Circuit breaker tripped
        done();
      });
    });

    test('fast-path: bypasses system DNS when circuit breaker is already OPEN', (done) => {
      resolver.markPoisoned('dlive.sx', 'cached sinkhole');

      dns.lookup = jest.fn(); // Should NOT be called
      jest.spyOn(resolver, 'resolveSecure').mockResolvedValue(['213.21.239.30']);

      resolver.lookup('dlive.sx', (err, addr, family) => {
        expect(err).toBeNull();
        expect(addr).toBe('213.21.239.30');
        expect(dns.lookup).not.toHaveBeenCalled();
        done();
      });
    });

    test('supports options.all = true correctly with array results', (done) => {
      dns.lookup = jest.fn((host, opts, cb) => {
        cb(null, [{ address: '127.0.0.1', family: 4 }]);
      });

      jest.spyOn(resolver, 'resolveSecure').mockResolvedValue(['213.21.239.30', '213.21.239.31']);

      resolver.lookup('dlive.sx', { all: true }, (err, addresses) => {
        expect(err).toBeNull();
        expect(addresses).toEqual([
          { address: '213.21.239.30', family: 4 },
          { address: '213.21.239.31', family: 4 }
        ]);
        done();
      });
    });

    test('recovers when system DNS returns ENOTFOUND', (done) => {
      dns.lookup = jest.fn((host, opts, cb) => {
        const error = new Error('getaddrinfo ENOTFOUND api.watchfooty.st');
        error.code = 'ENOTFOUND';
        cb(error);
      });

      jest.spyOn(resolver, 'resolveSecure').mockResolvedValue(['104.21.45.67']);

      resolver.lookup('api.watchfooty.st', (err, addr) => {
        expect(err).toBeNull();
        expect(addr).toBe('104.21.45.67');
        expect(resolver.isPoisonedHost('api.watchfooty.st')).toBe(true);
        done();
      });
    });

    test('always passes through localhost without interception even on error', (done) => {
      dns.lookup = jest.fn((host, opts, cb) => {
        cb(null, '127.0.0.1', 4);
      });

      const spySecure = jest.spyOn(resolver, 'resolveSecure');

      resolver.lookup('localhost', (err, addr) => {
        expect(err).toBeNull();
        expect(addr).toBe('127.0.0.1');
        expect(spySecure).not.toHaveBeenCalled();
        expect(resolver.isPoisonedHost('localhost')).toBe(false);
        done();
      });
    });
  });

  describe('hardening (timeouts, caches, DoH, validation)', () => {
    let origLookup;

    function makeResolver(overrides = {}) {
      const resolve4 = overrides.resolve4 || jest.fn();
      const fetchFn = overrides.fetchFn || jest.fn();
      const r = new AdaptiveDnsResolver({
        resolver: { resolve4 },
        fetchFn,
        negativeCacheTtlMs: overrides.negativeCacheTtlMs ?? 60000,
        cacheTtlMs: 60000,
      });
      return { r, resolve4, fetchFn };
    }

    function dohResponse(ips) {
      return {
        ok: true,
        json: async () => ({ Answer: ips.map(ip => ({ type: 1, data: ip })) }),
      };
    }

    beforeEach(() => {
      origLookup = dns.lookup;
    });

    afterEach(() => {
      dns.lookup = origLookup;
    });

    test('default secure resolver is built with a short timeout and a single try', () => {
      const RealResolver = dns.promises.Resolver;
      const spy = jest.spyOn(dns.promises, 'Resolver').mockImplementation((opts) => new RealResolver(opts));
      try {
        // eslint-disable-next-line no-new
        new AdaptiveDnsResolver();
        expect(spy).toHaveBeenCalledWith({ timeout: 1500, tries: 1 });
        // eslint-disable-next-line no-new
        new AdaptiveDnsResolver({ resolverTimeoutMs: 700, resolverTries: 2 });
        expect(spy).toHaveBeenLastCalledWith({ timeout: 700, tries: 2 });
      } finally {
        spy.mockRestore();
      }
    });

    test('DoH fallback targets an IP endpoint, never a hostname needing DNS itself', async () => {
      const { r, resolve4, fetchFn } = makeResolver();
      resolve4.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }));
      fetchFn.mockResolvedValue(dohResponse(['104.21.45.67']));

      await expect(r.resolveSecure('dlive.sx')).resolves.toEqual(['104.21.45.67']);
      const url = new URL(fetchFn.mock.calls[0][0]);
      expect(url.hostname).toBe('1.1.1.1');
      expect(r.isLocalOrReserved(url.hostname)).toBe(true);
      expect(url.searchParams.get('name')).toBe('dlive.sx');
    });

    test('dead domain is negatively cached: secure DNS + DoH are not retried within the TTL', async () => {
      const { r, resolve4, fetchFn } = makeResolver();
      resolve4.mockRejectedValue(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
      fetchFn.mockResolvedValue({ ok: true, json: async () => ({ Status: 3 }) });

      await expect(r.resolveSecure('dead.example')).rejects.toThrow(/failed to resolve/);
      await expect(r.resolveSecure('dead.example')).rejects.toThrow(/failed to resolve/);
      await expect(r.resolveSecure('DEAD.example')).rejects.toThrow(/failed to resolve/);
      expect(resolve4).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    test('negative cache expires after negativeCacheTtlMs', async () => {
      const { r, resolve4, fetchFn } = makeResolver({ negativeCacheTtlMs: 20 });
      resolve4.mockRejectedValue(new Error('nx'));
      fetchFn.mockRejectedValue(new Error('offline'));

      await expect(r.resolveSecure('dead.example')).rejects.toThrow();
      await new Promise(res => setTimeout(res, 40));
      await expect(r.resolveSecure('dead.example')).rejects.toThrow();
      expect(resolve4).toHaveBeenCalledTimes(2);
    });

    test('concurrent resolveSecure calls for one host share a single query', async () => {
      let release;
      const { r, resolve4 } = makeResolver();
      resolve4.mockImplementation(() => new Promise(res => { release = res; }));

      const calls = [r.resolveSecure('dlive.sx'), r.resolveSecure('dlive.sx'), r.resolveSecure('dlive.sx')];
      expect(resolve4).toHaveBeenCalledTimes(1);
      release(['213.21.239.30']);
      const results = await Promise.all(calls);
      expect(results).toEqual([['213.21.239.30'], ['213.21.239.30'], ['213.21.239.30']]);
      expect(r.inFlight.size).toBe(0);
    });

    test('sinkhole addresses from secure DNS are discarded and DoH is consulted', async () => {
      const { r, resolve4, fetchFn } = makeResolver();
      resolve4.mockResolvedValue(['127.0.0.1', '0.0.0.0']);
      fetchFn.mockResolvedValue(dohResponse(['0.0.0.0', '213.21.239.30']));

      await expect(r.resolveSecure('dlive.sx')).resolves.toEqual(['213.21.239.30']);
    });

    test('secure answers made only of sinkhole IPs are a failure: nothing cached, nothing poisoned', (done) => {
      const { r, resolve4, fetchFn } = makeResolver();
      resolve4.mockResolvedValue(['127.0.0.1']);
      fetchFn.mockResolvedValue(dohResponse(['0.0.0.0']));
      dns.lookup = jest.fn((host, opts, cb) => cb(null, '127.0.0.1', 4));
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});

      r.lookup('blocked.example', {}, (err, addr) => {
        try {
          expect(err).toBeNull();
          expect(addr).toBe('127.0.0.1'); // original system answer, not a fake "route"
          expect(r.dnsCache.has('blocked.example')).toBe(false);
          expect(r.isPoisonedHost('blocked.example')).toBe(false);
          expect(log).not.toHaveBeenCalled();
          done();
        } catch (e) {
          done(e);
        } finally {
          log.mockRestore();
        }
      });
    });

    test('family 6 callers are never handed an IPv4 answer from secure DNS', (done) => {
      const { r, resolve4 } = makeResolver();
      resolve4.mockResolvedValue(['213.21.239.30']);
      const sysErr = Object.assign(new Error('getaddrinfo ENOTFOUND v6only.example'), { code: 'ENOTFOUND' });
      dns.lookup = jest.fn((host, opts, cb) => cb(sysErr));

      r.lookup('v6only.example', { family: 6 }, (err, addr) => {
        try {
          expect(err).toBe(sysErr);
          expect(addr).toBeUndefined();
          expect(resolve4).not.toHaveBeenCalled();
          done();
        } catch (e) {
          done(e);
        }
      });
    });

    test('family 6 callers on a poisoned host fall back to the system lookup', (done) => {
      const { r, resolve4 } = makeResolver();
      r.markPoisoned('dlive.sx', 'test');
      dns.lookup = jest.fn((host, opts, cb) => cb(null, '2606:4700::1', 6));

      r.lookup('dlive.sx', { family: 6 }, (err, addr, family) => {
        try {
          expect(err).toBeNull();
          expect(addr).toBe('2606:4700::1');
          expect(family).toBe(6);
          expect(resolve4).not.toHaveBeenCalled();
          done();
        } catch (e) {
          done(e);
        }
      });
    });

    describe('confirmSinkhole', () => {
      test('connection refused to a loopback address is direct evidence', async () => {
        const { r } = makeResolver();
        dns.lookup = jest.fn();
        await expect(r.confirmSinkhole('dlive.sx', 'ConnectionRefused: 127.0.0.1:443')).resolves.toBe(true);
        expect(dns.lookup).not.toHaveBeenCalled();
      });

      test('system lookup returning a sinkhole IP confirms poisoning', async () => {
        const { r } = makeResolver();
        dns.lookup = jest.fn((host, opts, cb) => cb(null, [{ address: '0.0.0.0', family: 4 }]));
        await expect(r.confirmSinkhole('dlive.sx', 'dns error: failed to lookup')).resolves.toBe(true);
      });

      test('NXDOMAIN everywhere (genuinely dead domain) is NOT sinkholing', async () => {
        const { r, resolve4, fetchFn } = makeResolver();
        dns.lookup = jest.fn((host, opts, cb) => cb(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })));
        resolve4.mockRejectedValue(new Error('nx'));
        fetchFn.mockResolvedValue({ ok: true, json: async () => ({ Status: 3 }) });
        await expect(r.confirmSinkhole('dead.example', 'dns error: Host desconocido')).resolves.toBe(false);
      });

      test('system NXDOMAIN while secure DNS resolves is NXDOMAIN-style blocking', async () => {
        const { r, resolve4 } = makeResolver();
        dns.lookup = jest.fn((host, opts, cb) => cb(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })));
        resolve4.mockResolvedValue(['213.21.239.30']);
        await expect(r.confirmSinkhole('dlive.sx', 'dns error')).resolves.toBe(true);
      });

      test('system lookup returning a clean public IP is not sinkholing', async () => {
        const { r } = makeResolver();
        dns.lookup = jest.fn((host, opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]));
        await expect(r.confirmSinkhole('example.com', 'ConnectionRefused')).resolves.toBe(false);
      });
    });
  });
});
