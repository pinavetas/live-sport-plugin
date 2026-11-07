'use strict';

const realCron = jest.requireActual('node-cron');

jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
const cron = require('node-cron');
const CronService = require('../src/services/CronService');

describe('CronService scheduled jobs never overlap', () => {
  const prevUrl = process.env.RENDER_EXTERNAL_URL;

  beforeEach(() => {
    cron.schedule.mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (prevUrl === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = prevUrl;
  });

  function startService() {
    jest.useFakeTimers(); // swallow the boot-time runSync setImmediate/setTimeout
    try {
      const svc = new CronService({ matchAggregator: { syncMatches: async () => null } });
      svc.runSync = jest.fn(async () => {});
      svc.start();
      return svc;
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  }

  test('every cron.schedule call (including keep-alive) passes noOverlap: true', () => {
    process.env.RENDER_EXTERNAL_URL = 'https://example.invalid';
    startService();

    expect(cron.schedule).toHaveBeenCalledTimes(4);
    for (const [expr, fn, opts] of cron.schedule.mock.calls) {
      expect(typeof expr).toBe('string');
      expect(typeof fn).toBe('function');
      expect(opts).toEqual(expect.objectContaining({ noOverlap: true }));
      expect(typeof opts.name).toBe('string');
    }
    const names = cron.schedule.mock.calls.map(([, , opts]) => opts.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('the options CronService uses stop the installed node-cron from re-entering a long-running job', async () => {
    delete process.env.RENDER_EXTERNAL_URL;
    startService();
    const prewarm = cron.schedule.mock.calls.find(([, , opts]) => opts.name === 'prewarm');
    const options = { ...prewarm[2] };

    let starts = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const longJob = async () => { starts++; await gate; };

    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-07T12:00:00.500Z'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const task = realCron.schedule('* * * * * *', longJob, options); // every second
    try {
      await jest.advanceTimersByTimeAsync(5000);
      expect(starts).toBe(1); // later ticks were skipped, not stacked

      release();
      await jest.advanceTimersByTimeAsync(2000);
      expect(starts).toBeGreaterThan(1); // runs resume once the job finishes
    } finally {
      task.stop();
      if (typeof task.destroy === 'function') task.destroy();
      warn.mockRestore();
      jest.useRealTimers();
    }
  });
});
