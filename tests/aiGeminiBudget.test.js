'use strict';

/**
 * AiParserGeneratorService LLM call bounds:
 *  - one overall deadline per queryLlm (AI_TOTAL_TIMEOUT_MS) that clamps every
 *    attempt and stops the Gemini cascade once spent;
 *  - the native Gemini endpoint gets the key in `x-goog-api-key`, never `?key=`;
 *  - the Gemini candidate list is configurable via AI_GEMINI_MODELS;
 *  - an explicitly requested gemini-2.* model is tried, not silently dropped.
 */

const AiParserGeneratorService = require('../src/services/AiParserGeneratorService');

const GEMINI_KEY = 'AIzaSyBudgetTestKey';
const ENV_KEYS = ['AI_TOTAL_TIMEOUT_MS', 'AI_GEMINI_MODELS'];
const savedEnv = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

const modelOf = (url, opts) => {
  if (url.includes(':generateContent')) return `native:${decodeURIComponent(url.split('models/')[1].split(':')[0])}`;
  return JSON.parse(opts.body).model;
};
const failing = (status, text = 'error') => ({ ok: false, status, text: async () => text });
const okOpenAi = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

describe('overall deadline per queryLlm', () => {
  test('defaults to 60000ms and honours AI_TOTAL_TIMEOUT_MS', () => {
    expect(new AiParserGeneratorService().totalTimeoutMs).toBe(60000);
    process.env.AI_TOTAL_TIMEOUT_MS = '1234';
    expect(new AiParserGeneratorService().totalTimeoutMs).toBe(1234);
    process.env.AI_TOTAL_TIMEOUT_MS = 'garbage';
    expect(new AiParserGeneratorService().totalTimeoutMs).toBe(60000);
  });

  test('every attempt timeout is clamped to the remaining budget', async () => {
    const timeouts = [];
    const svc = new AiParserGeneratorService({
      totalTimeoutMs: 5000,
      fetchFn: async (url, opts) => {
        timeouts.push(opts.timeoutMs);
        return okOpenAi('{}');
      },
    });
    await svc.queryLlm({ prompt: 'p', systemPrompt: 's', config: { apiKey: GEMINI_KEY } });
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(5000);
    expect(timeouts[0]).toBeGreaterThan(4000);
  });

  test('a cascade that keeps failing stops at the deadline instead of running every model', async () => {
    const attempts = [];
    const svc = new AiParserGeneratorService({
      totalTimeoutMs: 400,
      fetchFn: async (url, opts) => {
        attempts.push({ model: modelOf(url, opts), timeoutMs: opts.timeoutMs });
        await new Promise((r) => setTimeout(r, 60));
        return failing(503, 'high demand');
      },
    });

    const started = Date.now();
    await expect(svc.queryLlm({ prompt: 'p', systemPrompt: 's', config: { apiKey: GEMINI_KEY } }))
      .rejects.toThrow(/budget of 400ms exhausted/);
    const elapsed = Date.now() - started;

    // Unbounded, this config is 3 models x 2 attempts + 3 native calls with
    // 1200ms 503 back-offs (~4s+). With the budget it ends shortly after 400ms.
    expect(elapsed).toBeLessThan(1500);
    expect(attempts.length).toBeLessThan(9);
    for (const a of attempts) expect(a.timeoutMs).toBeLessThanOrEqual(400);
  });

  test('OpenAI-compatible request timeout is clamped to the budget too', async () => {
    let timeoutMs = null;
    const svc = new AiParserGeneratorService({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'k',
      totalTimeoutMs: 3000,
      fetchFn: async (url, opts) => { timeoutMs = opts.timeoutMs; return okOpenAi('{}'); },
    });
    await svc.queryLlm({ prompt: 'p', systemPrompt: 's' });
    expect(timeoutMs).toBeLessThanOrEqual(3000);
  });
});

describe('native Gemini endpoint', () => {
  test('sends the key in x-goog-api-key, never in the URL', async () => {
    const nativeCalls = [];
    const svc = new AiParserGeneratorService({
      fetchFn: async (url, opts) => {
        if (url.includes('/openai/')) return failing(404, 'not found');
        nativeCalls.push({ url, headers: opts.headers });
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":1}' }] } }] }) };
      },
    });
    const out = await svc.queryLlm({ prompt: 'p', systemPrompt: 's', config: { apiKey: GEMINI_KEY } });
    expect(out).toBe('{"ok":1}');
    expect(nativeCalls).toHaveLength(1);
    expect(nativeCalls[0].url).not.toContain('key=');
    expect(nativeCalls[0].url).not.toContain(GEMINI_KEY);
    expect(nativeCalls[0].headers['x-goog-api-key']).toBe(GEMINI_KEY);
  });
});

describe('Gemini candidate list', () => {
  function recordingService(opts = {}) {
    const models = [];
    const svc = new AiParserGeneratorService({
      ...opts,
      fetchFn: async (url, o) => {
        models.push(modelOf(url, o));
        return failing(404, 'not found');
      },
    });
    return { svc, models };
  }

  test('defaults are unchanged', async () => {
    const { svc, models } = recordingService();
    await expect(svc.queryLlm({ prompt: 'p', systemPrompt: 's', config: { apiKey: GEMINI_KEY } })).rejects.toThrow();
    expect(models).toEqual([
      'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash',
      'native:gemini-3.8-flash', 'native:gemini-3.5-flash-lite', 'native:gemini-3.5-flash',
    ]);
  });

  test('AI_GEMINI_MODELS overrides the cascade', async () => {
    process.env.AI_GEMINI_MODELS = ' gemini-x-one , gemini-x-two ,';
    const { svc, models } = recordingService();
    await expect(svc.queryLlm({ prompt: 'p', systemPrompt: 's', config: { apiKey: GEMINI_KEY } })).rejects.toThrow();
    expect(models).toEqual(['gemini-x-one', 'gemini-x-two', 'native:gemini-x-one', 'native:gemini-x-two']);
  });

  test('an explicitly requested gemini-2.* model is tried first, not dropped', async () => {
    const { svc, models } = recordingService();
    await expect(svc.queryLlm({
      prompt: 'p', systemPrompt: 's', config: { apiKey: GEMINI_KEY, model: 'gemini-2.5-flash' },
    })).rejects.toThrow(/gemini-2\.5-flash/);
    expect(models[0]).toBe('gemini-2.5-flash');
    expect(models).toContain('native:gemini-2.5-flash');
  });
});
