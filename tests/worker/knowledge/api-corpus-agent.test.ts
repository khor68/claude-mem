import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { ApiCorpusAgent } from '../../../src/services/worker/knowledge/ApiCorpusAgent.js';
import { createCorpusAgent } from '../../../src/services/worker/knowledge/CorpusAgent.js';
import { CorpusRoutes } from '../../../src/services/worker/http/routes/CorpusRoutes.js';
import { AppError } from '../../../src/services/server/ErrorHandler.js';
import { logger } from '../../../src/utils/logger.js';
import type { CorpusStore } from '../../../src/services/worker/knowledge/CorpusStore.js';
import type { CorpusFile } from '../../../src/services/worker/knowledge/types.js';

const OPENROUTER_SETTINGS = {
  CLAUDE_MEM_PROVIDER: 'openrouter',
  CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-test',
  CLAUDE_MEM_OPENROUTER_MODEL: 'vendor/model',
};

const CLAUDE_SETTINGS = { CLAUDE_MEM_PROVIDER: 'claude' };

interface FetchCall { url: string; headers: Record<string, string>; body: Record<string, any> }

/** Replace global fetch with a recorder that answers with the given replies in order. */
function fakeFetch(replies: Array<{ status?: number; body?: unknown; text?: string }>): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({ url: String(input), headers: init.headers ?? {}, body: JSON.parse(String(init.body ?? '{}')) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    const status = reply.status ?? 200;
    const text = reply.text ?? JSON.stringify(reply.body ?? { choices: [{ message: { content: 'the answer' } }] });
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const chatAnswer = (content: string) => ({ body: { choices: [{ message: { content } }] } });
const providerRefusal = (status: number, message: string) => ({ status, text: JSON.stringify({ error: { message } }) });

function createObservation(id: number, title: string, extra: Partial<CorpusFile['observations'][number]> = {}) {
  return {
    id,
    type: 'decision',
    title,
    subtitle: null,
    narrative: null,
    facts: [],
    concepts: [],
    files_read: [],
    files_modified: [],
    project: 'cmem',
    created_at: '2026-04-14T00:00:00.000Z',
    created_at_epoch: 1776038400000 + id,
    ...extra,
  };
}

function createCorpus(overrides: Partial<CorpusFile> = {}): CorpusFile {
  return {
    version: 1,
    name: 'alpha',
    description: 'A corpus',
    created_at: '2026-04-14T00:00:00.000Z',
    updated_at: '2026-04-14T00:00:00.000Z',
    filter: {},
    stats: { observation_count: 3, token_estimate: 120, date_range: { earliest: '2026-04-14T00:00:00.000Z', latest: '2026-04-16T00:00:00.000Z' }, type_breakdown: { decision: 3 } },
    system_prompt: 'Answer questions using ONLY the observations provided in this corpus.',
    session_id: null,
    observations: [
      createObservation(1, 'Corpus questions run on the selected provider', {
        concepts: ['provider', 'corpus'],
        facts: ['The corpus agent follows the settings, not the code.'],
      }),
      createObservation(2, 'Observer timeout raised to thirty seconds', {
        narrative: 'The observer gave up too early on long transcripts.',
      }),
      createObservation(3, 'Search result ranking tuned', {
        facts: ['Hybrid search weighs the semantic score against the lexical one.'],
      }),
    ],
    ...overrides,
  };
}

/** A store that keeps what was written, so the test can see what a call persisted. */
function createStore(seed: CorpusFile | null = null) {
  const written: CorpusFile[] = [];
  const store = {
    write: (corpus: CorpusFile) => { written.push(corpus); },
    read: (name: string) => (written.find(entry => entry.name === name) ?? (seed?.name === name ? seed : null)),
    list: () => (seed ? [{ name: seed.name }] : []),
    delete: () => false,
  } as unknown as CorpusStore;
  return { store, written };
}

/**
 * A settings file in a temp dir, with every CLAUDE_MEM_* env var out of the
 * way (an env var would override the file and change what is under test).
 */
async function withSettings<T>(file: Record<string, string>, body: (path: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'api-corpus-'));
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('CLAUDE_MEM_')) delete process.env[key];
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify(file));
    return await body(path);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith('CLAUDE_MEM_')) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the API corpus agent answers on the selected provider', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => { restoreFetch = null; });
  afterEach(() => { restoreFetch?.(); restoreFetch = null; });

  it('primes with one bounded call and a synthetic session id', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('Corpus loaded.')]);
      restoreFetch = fetchMock.restore;
      const { store, written } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();

      const sessionId = await agent.prime(corpus);

      expect(sessionId).toMatch(/^api:openrouter:[0-9a-f]{16}$/);
      expect(corpus.session_id).toBe(sessionId);
      expect(written.map(entry => entry.session_id)).toEqual([sessionId]);
      // One call, and it carries the corpus summary rather than the corpus.
      expect(fetchMock.calls).toHaveLength(1);
      const prompt = String(fetchMock.calls[0].body.messages[1].content);
      expect(prompt).toContain('alpha');
      expect(prompt).not.toContain('Search result ranking tuned');
    });
  });

  it('answers a question from the corpus and sends only the matching observations', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('Corpus loaded.'), chatAnswer('Corpus questions run on the selected provider.')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();
      await agent.prime(corpus);

      const result = await agent.query(corpus, 'which provider answers corpus questions?');

      expect(result.answer).toBe('Corpus questions run on the selected provider.');
      expect(result.session_id).toBe(corpus.session_id);
      const prompt = String(fetchMock.calls.at(-1)!.body.messages[1].content);
      expect(prompt).toContain('Corpus questions run on the selected provider');
      expect(prompt).not.toContain('Observer timeout raised to thirty seconds');
      // The question itself reaches the provider.
      expect(prompt).toContain('which provider answers corpus questions?');
      expect(fetchMock.calls.at(-1)!.body.messages[0].content).toContain('ONLY the observations');
    });
  });

  it('reports a corpus that was never primed as not primed', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('never used')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);

      const error = await agent.query(createCorpus(), 'anything?').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(409);
      expect((error as AppError).code).toBe('CORPUS_NOT_PRIMED');
      // A corpus that is not primed costs the provider nothing.
      expect(fetchMock.calls).toHaveLength(0);
    });
  });

  it('reports a corpus primed by the Claude agent as not primed', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('never used')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus({ session_id: 'a-claude-sdk-session-id' });

      const error = await agent.query(corpus, 'anything?').catch((e: unknown) => e);

      expect((error as AppError).statusCode).toBe(409);
      expect((error as AppError).code).toBe('CORPUS_NOT_PRIMED');
      expect(fetchMock.calls).toHaveLength(0);
    });
  });

  it('invalidates the session id when the corpus is rebuilt', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('loaded')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();
      await agent.prime(corpus);
      const primedId = corpus.session_id;

      // A rebuild writes a new version of the corpus.
      const rebuilt = { ...corpus, updated_at: '2026-05-01T00:00:00.000Z' };
      const error = await agent.query(rebuilt, 'which provider answers corpus questions?').catch((e: unknown) => e);

      expect((error as AppError).statusCode).toBe(409);
      expect((error as AppError).code).toBe('CORPUS_NOT_PRIMED');
      expect(primedId).toMatch(/^api:openrouter:[0-9a-f]{16}$/);
      // Only the prime was ever paid for.
      expect(fetchMock.calls).toHaveLength(1);
    });
  });

  it('primes again on reprime', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('loaded')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();

      const sessionId = await agent.reprime(corpus);

      expect(sessionId).toMatch(/^api:openrouter:[0-9a-f]{16}$/);
      expect(corpus.session_id).toBe(sessionId);
      expect(fetchMock.calls).toHaveLength(1);
    });
  });

  it('answers a 401 as PROVIDER_NOT_AUTHENTICATED and never asks anyone else', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('loaded'), providerRefusal(401, 'invalid api key')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();
      await agent.prime(corpus);
      const callsAfterPrime = fetchMock.calls.length;

      const error = await agent.query(corpus, 'which provider answers corpus questions?').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(401);
      expect((error as AppError).code).toBe('PROVIDER_NOT_AUTHENTICATED');
      // One request to the provider that refused, and no second account.
      expect(fetchMock.calls).toHaveLength(callsAfterPrime + 1);
      expect(fetchMock.calls.every(call => call.url.includes('openrouter.ai'))).toBe(true);
    });
  });

  it('answers an exhausted quota as PROVIDER_QUOTA_EXHAUSTED', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([providerRefusal(429, 'rate limited')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();

      const error = await agent.prime(corpus).catch((e: unknown) => e);

      expect((error as AppError).statusCode).toBe(429);
      expect((error as AppError).code).toBe('PROVIDER_QUOTA_EXHAUSTED');
      // A refused prime writes nothing, so no later query can spend on it.
      expect(corpus.session_id).toBeNull();
    });
  });

  it('spends nothing after a refusal: no retry, no replay, nothing persisted', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('loaded'), providerRefusal(429, 'rate limited')]);
      restoreFetch = fetchMock.restore;
      const { store, written } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();
      await agent.prime(corpus);
      const primedId = corpus.session_id;

      const error = await agent.query(corpus, 'which provider answers corpus questions?').catch((e: unknown) => e);
      expect((error as AppError).code).toBe('PROVIDER_QUOTA_EXHAUSTED');
      const callsAfterFailure = fetchMock.calls.length;

      // An outage must not create later, unrequested inference spend: nothing
      // runs on its own after the refusal.
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(fetchMock.calls).toHaveLength(callsAfterFailure);
      // The failed query persisted nothing: the corpus is still the primed one.
      expect(written).toHaveLength(1);
      expect(corpus.session_id).toBe(primedId);
    });
  });

  it('fails with PROVIDER_NOT_AUTHENTICATED when the provider has no key', async () => {
    await withSettings({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_MODEL: 'vendor/model' }, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('never used')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);

      const error = await agent.prime(createCorpus()).catch((e: unknown) => e);

      expect((error as AppError).statusCode).toBe(401);
      expect((error as AppError).code).toBe('PROVIDER_NOT_AUTHENTICATED');
      expect(fetchMock.calls).toHaveLength(0);
    });
  });
});

describe('CorpusRoutes with the API corpus agent', () => {
  class FakeResponse extends EventEmitter {
    statusCode = 200;
    jsonBodies: unknown[] = [];
    headersSent = false;
    ended = false;
    status(code: number) { this.statusCode = code; return this; }
    setHeader() {}
    write() { this.headersSent = true; return true; }
    json(body: unknown) { this.headersSent = true; this.jsonBodies.push(body); this.ended = true; return this; }
    end() { this.ended = true; return this; }
  }

  function createRequest(name: string, body: any = {}) {
    return {
      body,
      params: { name },
      path: `/api/corpus/${name}/query`,
      query: {},
      headers: {},
      socket: new EventEmitter(),
    } as unknown as Request;
  }

  function captureHandler(routes: CorpusRoutes, targetPath: string): (req: Request, res: Response) => void {
    let handler: ((req: Request, res: Response) => void) | undefined;
    const mockApp: any = {
      get: mock(() => {}),
      delete: mock(() => {}),
      post: mock((path: string, ...rest: any[]) => {
        if (path === targetPath) handler = rest[rest.length - 1];
      }),
    };
    routes.setupRoutes(mockApp);
    if (!handler) throw new Error(`${targetPath} not registered`);
    return handler;
  }

  async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const startedAt = Date.now();
    while (!condition()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  it('answers 409 CORPUS_NOT_PRIMED for a corpus that was never primed', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('never used')]);
      try {
        const corpus = createCorpus();
        const { store } = createStore(corpus);
        const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
        const routes = new CorpusRoutes(store, { build: mock(() => Promise.resolve(corpus)) } as any, agent);
        const handler = captureHandler(routes, '/api/corpus/:name/query');
        const res = new FakeResponse();

        handler(createRequest('alpha', { question: 'why?' }), res as unknown as Response);
        await waitFor(() => res.ended);

        expect(res.statusCode).toBe(409);
        expect(res.jsonBodies).toEqual([{ error: 'Corpus "alpha" has no session — call prime first', code: 'CORPUS_NOT_PRIMED' }]);
        expect(fetchMock.calls).toHaveLength(0);
      } finally {
        fetchMock.restore();
      }
    });
  });

  it('answers 401 PROVIDER_NOT_AUTHENTICATED when the provider refuses', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('loaded'), providerRefusal(401, 'invalid api key')]);
      const errorSink = mock(() => {});
      logger.setErrorSink(errorSink);
      try {
        const corpus = createCorpus();
        const { store } = createStore(corpus);
        const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
        await agent.prime(corpus);
        const routes = new CorpusRoutes(store, { build: mock(() => Promise.resolve(corpus)) } as any, agent);
        const handler = captureHandler(routes, '/api/corpus/:name/query');
        const res = new FakeResponse();

        handler(createRequest('alpha', { question: 'why?' }), res as unknown as Response);
        await waitFor(() => res.ended);

        expect(res.statusCode).toBe(401);
        expect((res.jsonBodies[0] as { code?: string }).code).toBe('PROVIDER_NOT_AUTHENTICATED');
        // A provider that refuses is the owner's problem, not a server fault.
        expect(errorSink).not.toHaveBeenCalled();
        expect(fetchMock.calls).toHaveLength(2);
      } finally {
        logger.setErrorSink(null);
        fetchMock.restore();
      }
    });
  });
});

describe('the Anthropic SDK is not loaded on the API provider path', () => {
  const fixture = String.raw`
    import { mock } from 'bun:test';
    const sdkLoads = [];
    // The Anthropic SDK module is replaced by a recorder: if anything imports
    // it, the recorder knows, and the real SDK never runs.
    mock.module('@anthropic-ai/claude-agent-sdk', () => {
      sdkLoads.push('anthropic-sdk');
      return { query: () => { throw new Error('the Anthropic SDK must not run in this test'); } };
    });
    const { createCorpusAgent } = await import('./src/services/worker/knowledge/CorpusAgent.ts');
    const store = { write: () => {}, read: () => null };
    const apiAgent = await createCorpusAgent(store, process.env.API_SETTINGS);
    const apiName = (await apiAgent.current()).constructor.name;
    const afterApi = sdkLoads.length;
    const claudeAgent = await createCorpusAgent(store, process.env.CLAUDE_SETTINGS);
    const claudeName = (await claudeAgent.current()).constructor.name;
    console.log(JSON.stringify({
      afterApi,
      afterClaude: sdkLoads.length,
      apiAgent: apiName,
      claudeAgent: claudeName,
    }));
  `;

  it('loads the Claude agent only when the settings do not name an API provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-corpus-sdk-'));
    try {
      const apiSettings = join(dir, 'api.json');
      const claudeSettings = join(dir, 'claude.json');
      writeFileSync(apiSettings, JSON.stringify(OPENROUTER_SETTINGS));
      writeFileSync(claudeSettings, JSON.stringify(CLAUDE_SETTINGS));
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...process.env, API_SETTINGS: apiSettings, CLAUDE_SETTINGS: claudeSettings },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const outcome = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);

      // The API provider: the Anthropic SDK module was never loaded.
      expect(outcome.afterApi).toBe(0);
      expect(outcome.apiAgent).toBe('ApiCorpusAgent');
      // The Claude provider: the dynamic import loaded it (and with it the SDK).
      expect(outcome.afterClaude).toBe(1);
      expect(outcome.claudeAgent).toBe('KnowledgeAgent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the corpus agent factory follows the selected provider', () => {
  it('returns the API agent for an OpenAI-compatible provider', async () => {
    await withSettings({ CLAUDE_MEM_PROVIDER: 'openai-compatible', CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'https://llm.test/v1', CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'local/model' }, async (settingsPath) => {
      const { store } = createStore();
      const agent = await createCorpusAgent(store, settingsPath);
      expect((await agent.current()).constructor.name).toBe('ApiCorpusAgent');
    });
  });

  it('returns the API agent for the legacy cmem spelling', async () => {
    await withSettings({ CLAUDE_MEM_PROVIDER: 'cmem' }, async (settingsPath) => {
      const { store } = createStore();
      const agent = await createCorpusAgent(store, settingsPath);
      expect((await agent.current()).constructor.name).toBe('ApiCorpusAgent');
    });
  });

  it('returns the Claude agent when the settings name Claude', async () => {
    await withSettings(CLAUDE_SETTINGS, async (settingsPath) => {
      const { store } = createStore();
      const agent = await createCorpusAgent(store, settingsPath);
      expect((await agent.current()).constructor.name).toBe('KnowledgeAgent');
    });
  });
});

describe('the corpus agent follows a provider switch without a restart', () => {
  it('answers on the API provider after the settings leave Claude', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-corpus-switch-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify(CLAUDE_SETTINGS));
      const { store } = createStore();
      const agent = await createCorpusAgent(store, settingsPath);
      expect((await agent.current()).constructor.name).toBe('KnowledgeAgent');
      writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter' }));
      expect((await agent.current()).constructor.name).toBe('ApiCorpusAgent');
      // No key is configured, so the call fails on the provider's own error and never reaches the Claude agent.
      await expect(agent.query({ name: 'c', session_id: null, observations: [] } as never, 'q')).rejects.toMatchObject({ code: 'CORPUS_NOT_PRIMED' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
