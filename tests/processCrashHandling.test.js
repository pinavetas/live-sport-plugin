const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  createUncaughtExceptionHandler,
  createUnhandledRejectionHandler,
  createServerErrorHandler,
  installProcessHandlers,
  attachServerErrorHandler
} = require('../src/services/processGuards');

const GUARDS = path.join(__dirname, '..', 'src', 'services', 'processGuards.js');

describe('processGuards', () => {
  describe('uncaughtException', () => {
    it('logs, sets exitCode and exits(1) on the next tick (after the log is written)', () => {
      const log = jest.fn();
      const exit = jest.fn();
      const deferred = [];
      const proc = {};
      const handler = createUncaughtExceptionHandler({ log, exit, defer: (fn) => deferred.push(fn), proc });

      handler(new Error('boom'));

      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0].join(' ')).toMatch(/boom/);
      expect(proc.exitCode).toBe(1);
      expect(exit).not.toHaveBeenCalled();
      deferred.forEach((fn) => fn());
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('schedules exit only once when several exceptions arrive', () => {
      const exit = jest.fn();
      const deferred = [];
      const handler = createUncaughtExceptionHandler({ log: jest.fn(), exit, defer: (fn) => deferred.push(fn), proc: {} });
      handler(new Error('a'));
      handler(new Error('b'));
      expect(deferred).toHaveLength(1);
    });
  });

  describe('unhandledRejection stays non-fatal', () => {
    it('logs real rejections and ignores expected aborts', () => {
      const log = jest.fn();
      const handler = createUnhandledRejectionHandler({ log });
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      handler(abort);
      handler({ __expected: true });
      expect(log).not.toHaveBeenCalled();
      handler(new Error('real'));
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('installProcessHandlers wires both events on the given process', () => {
      const on = jest.fn();
      installProcessHandlers({ proc: { on } });
      expect(on.mock.calls.map((c) => c[0]).sort()).toEqual(['uncaughtException', 'unhandledRejection']);
    });
  });

  describe('server listen errors', () => {
    it('exits(1) with a clear message on EADDRINUSE', () => {
      const log = jest.fn();
      const exit = jest.fn();
      const proc = {};
      const handler = createServerErrorHandler({ port: 7000, host: '0.0.0.0', log, exit, proc });
      const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
      handler(err);
      expect(log.mock.calls[0][0]).toMatch(/0\.0\.0\.0:7000 is already in use/);
      expect(proc.exitCode).toBe(1);
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('attachServerErrorHandler registers an error listener', () => {
      const on = jest.fn();
      attachServerErrorHandler({ on }, { port: 1 });
      expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('real child processes', () => {
    const run = (code) => spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 20000 });

    it('a thrown exception terminates the process with code 1 instead of leaving a zombie', () => {
      const r = run(`
        require(${JSON.stringify(GUARDS)}).installProcessHandlers();
        setInterval(() => {}, 1000); // simulates cron keeping the loop alive
        setTimeout(() => { throw new Error('kaboom'); }, 10);
      `);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/\[uncaughtException\][\s\S]*kaboom/);
    });

    it('an unhandled rejection does not terminate the process', () => {
      const r = run(`
        require(${JSON.stringify(GUARDS)}).installProcessHandlers();
        Promise.reject(new Error('meh'));
        setTimeout(() => process.exit(0), 100);
      `);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/\[unhandledRejection\][\s\S]*meh/);
    });

    it('EADDRINUSE on listen terminates the process with code 1', async () => {
      const blocker = net.createServer();
      await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      const { port } = blocker.address();
      try {
        const r = await new Promise((resolve) => {
          const { spawn } = require('child_process');
          const child = spawn(process.execPath, ['-e', `
            const http = require('http');
            const g = require(${JSON.stringify(GUARDS)});
            g.installProcessHandlers();
            setInterval(() => {}, 1000); // simulates cron keeping the loop alive
            const server = http.createServer().listen(${port}, '127.0.0.1');
            g.attachServerErrorHandler(server, { port: ${port}, host: '127.0.0.1' });
          `]);
          let stderr = '';
          child.stderr.on('data', (d) => { stderr += d; });
          const t = setTimeout(() => child.kill(), 15000);
          child.on('exit', (status) => { clearTimeout(t); resolve({ status, stderr }); });
        });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/already in use/);
      } finally {
        await new Promise((resolve) => blocker.close(resolve));
      }
    });
  });

  it('index.js installs the guards and attaches the listen error handler', () => {
    const source = fs.readFileSync(require.resolve('../src/index'), 'utf8');
    expect(source).toMatch(/installProcessHandlers\(\)/);
    expect(source).toMatch(/const server = app\.listen\(/);
    expect(source).toMatch(/attachServerErrorHandler\(server,/);
    expect(source).not.toMatch(/process\.on\('uncaughtException'/);
  });
});
