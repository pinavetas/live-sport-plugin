'use strict';

const fs = require('fs');
const path = require('path');

describe('Worker Budget API route wiring', () => {
  test('/api/worker-budget route is registered before createProxyMiddleware mount in src/index.js', () => {
    const code = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
    const routeIdx = code.indexOf("'/api/worker-budget'");
    // Target the proxy middleware registration (not the top-level require)
    const proxyIdx = code.lastIndexOf('createProxyMiddleware');

    expect(routeIdx).toBeGreaterThan(0);
    expect(proxyIdx).toBeGreaterThan(0);
    expect(routeIdx).toBeLessThan(proxyIdx);
  });
});
