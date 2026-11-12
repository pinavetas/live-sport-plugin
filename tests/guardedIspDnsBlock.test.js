'use strict';

// ISPs (e.g. under court-ordered sports blocks) answer blocked names with a
// sinkhole (127.0.0.1 / ::1) or NXDOMAIN. The guarded socket connector must
// resolve like the URL gate: system DNS first, the adaptive DoH resolver only
// on such an answer, and every answer still vetted. Before this, the connector
// used system DNS alone, so blocked provider sites failed as blocked_address.

const dns = require('node:dns');
const adaptiveDnsResolver = require('../src/services/AdaptiveDnsResolver');
const { createGuardedLookup } = require('../src/services/GuardedOutbound');

const SYSTEM = {
  'blocked.sports-site.com': [{ address: '127.0.0.1', family: 4 }],
  'nxdomain.sports-site.com': null,
  'open.sports-site.com': [{ address: '93.184.216.34', family: 4 }],
  'evil-loopback.attacker.com': [{ address: '127.0.0.1', family: 4 }],
};
const DOH = {
  'blocked.sports-site.com': '104.21.11.183',
  'nxdomain.sports-site.com': '172.67.166.239',
  'evil-loopback.attacker.com': '127.0.0.1',
};

let systemSpy;
let dohSpy;
beforeEach(() => {
  systemSpy = jest.spyOn(dns.promises, 'lookup').mockImplementation(async (host) => {
    const answer = SYSTEM[host];
    if (!answer) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return answer;
  });
  dohSpy = jest.spyOn(adaptiveDnsResolver, 'lookup').mockImplementation((host, opts, cb) => {
    const address = DOH[host];
    if (!address) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    return cb(null, [{ address, family: 4 }]);
  });
});
afterEach(() => { systemSpy.mockRestore(); dohSpy.mockRestore(); });

const lookup = (host) => new Promise((resolve, reject) => {
  createGuardedLookup()(host, { all: true }, (err, records) => (err ? reject(err) : resolve(records)));
});

test('a sinkholed name connects to the real address from the adaptive resolver', async () => {
  await expect(lookup('blocked.sports-site.com')).resolves.toEqual([{ address: '104.21.11.183', family: 4 }]);
});

test('an NXDOMAIN answer falls back to the adaptive resolver', async () => {
  await expect(lookup('nxdomain.sports-site.com')).resolves.toEqual([{ address: '172.67.166.239', family: 4 }]);
});

test('an unblocked name uses system DNS and never asks the adaptive resolver', async () => {
  await expect(lookup('open.sports-site.com')).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
  expect(dohSpy).not.toHaveBeenCalled();
});

test('a name that really points at loopback stays blocked after the fallback', async () => {
  await expect(lookup('evil-loopback.attacker.com')).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED', reason: 'blocked_address' });
});
