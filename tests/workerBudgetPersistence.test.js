'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkerPool, resolveBudgetFile } = require('../src/services/WorkerBudget');

const FREE = ['https://free-a.example.invalid', 'https://free-b.example.invalid'];
const PAID = 'https://paid.example.invalid';
const ENV = { CF_WORKER_POOL: FREE.join(','), CF_PAID_WORKER_URL: PAID, WORKER_POOL_LOG: 'off' };

describe('WorkerBudget counter persistence', () => {
  let dir;
  let file;
  let clock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-budget-'));
    file = path.join(dir, 'worker_budget.json');
    clock = new Date('2026-11-07T10:00:00Z');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makePool(overrides = {}) {
    return createWorkerPool({
      env: ENV,
      now: () => clock,
      random: () => 0,
      persistPath: file,
      persistDebounceMs: 10000,
      overrides: { freeCapPerProcess: 2, paidSoftCapPerProcess: 100, paidCapPerProcess: 3, probeThreshold: 1, ...overrides },
    });
  }

  test('a restart keeps the paid monthly hard cap spent', () => {
    const first = makePool();
    // 4 free picks exhaust both free workers, then 3 paid picks hit the hard cap.
    for (let i = 0; i < 7; i++) expect(first.pick(null)).not.toBeNull();
    expect(first.pick(null)).toBeNull();
    first.stop();

    const restarted = makePool();
    const snap = restarted.snapshot();
    expect(snap.paid.used).toBe(3);
    expect(snap.free.map((w) => w.used)).toEqual([2, 2]);
    expect(restarted.pick(null)).toBeNull();
    restarted.stop();
  });

  test('restored daily counters reset on a new UTC day, monthly ones on a new month', () => {
    const first = makePool();
    for (let i = 0; i < 5; i++) first.pick(null);
    first.stop();

    clock = new Date('2026-11-08T00:00:01Z');
    const nextDay = makePool();
    expect(nextDay.snapshot().free.map((w) => w.used)).toEqual([0, 0]);
    expect(nextDay.snapshot().paid.used).toBe(1);
    nextDay.stop();

    clock = new Date('2026-12-01T00:00:01Z');
    const nextMonth = makePool();
    expect(nextMonth.snapshot().paid.used).toBe(0);
    nextMonth.stop();
  });

  test('writes are debounced and atomic (no tmp files left behind)', () => {
    jest.useFakeTimers({ now: clock });
    try {
      const pool = makePool();
      pool.pick(null);
      pool.pick(null);
      expect(fs.existsSync(file)).toBe(false);

      jest.advanceTimersByTime(10000);
      expect(fs.existsSync(file)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(saved.free[FREE[0]]).toEqual({ day: '2026-11-07', used: 2 });
      expect(fs.readdirSync(dir)).toEqual(['worker_budget.json']);
      pool.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a corrupted file is ignored and then replaced', () => {
    fs.writeFileSync(file, '{"version":1,"free":{"https://free-a', 'utf8');
    const pool = makePool();
    expect(pool.snapshot().free.map((w) => w.used)).toEqual([0, 0]);
    pool.pick(null);
    pool.stop();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).free[FREE[0]].used).toBe(1);
  });

  test('invalid entries in an otherwise valid file are skipped', () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      free: { [FREE[0]]: { day: '2026-11-07', used: -5 }, [FREE[1]]: { day: '2026-11-07', used: 1 } },
      paid: { month: '2026-11', used: 'lots' },
    }), 'utf8');
    const pool = makePool();
    const snap = pool.snapshot();
    expect(snap.free.map((w) => w.used)).toEqual([0, 1]);
    expect(snap.paid.used).toBe(0);
    pool.stop();
  });

  test('pools without a persistPath stay in memory only', () => {
    const pool = createWorkerPool({ env: ENV, now: () => clock, overrides: { probeThreshold: 1 } });
    pool.pick(null);
    expect(pool.flush()).toBe(false);
    pool.stop();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('resolveBudgetFile', () => {
  test('is disabled under Jest so parallel test workers never share budget state', () => {
    expect(resolveBudgetFile({ JEST_WORKER_ID: '3', DATA_DIR: '/tmp/x' })).toBeNull();
  });

  test('uses DATA_DIR, one file per PM2 instance', () => {
    expect(resolveBudgetFile({ DATA_DIR: path.join('srv', 'data') })).toBe(path.join('srv', 'data', 'worker_budget.json'));
    expect(resolveBudgetFile({ DATA_DIR: 'd', NODE_APP_INSTANCE: '2' })).toBe(path.join('d', 'worker_budget.2.json'));
  });

  test('falls back to ./data', () => {
    expect(resolveBudgetFile({})).toBe(path.join(process.cwd(), 'data', 'worker_budget.json'));
  });
});
