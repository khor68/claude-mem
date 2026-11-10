// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The interactive provider menu and the API-key prompt that can follow it.
//
// Two defects are pinned here:
//  1. The menu offered only CMEM Pro and Claude, so an owner who runs their
//     memory through OpenRouter (or a custom OpenAI-compatible endpoint) could
//     neither pick their provider nor keep the one they already have.
//  2. Cancelling the API-key prompt silently wrote CLAUDE_MEM_PROVIDER='claude':
//     an owner who deliberately chose OpenRouter ended up on the Anthropic
//     subscription without being asked.
//
// install.ts caches isInteractive at import time, so the cases run in a fresh
// Bun process (the same pattern as install-email-optin.test.ts).

if (process.env.CLAUDE_MEM_PROVIDER_PROMPT_FIXTURE_CHILD !== import.meta.path) {
  describe('isolated provider prompt fixture', () => {
    it('passes every case in a fresh Bun process', () => {
      const child = Bun.spawnSync({
        cmd: [process.execPath, 'test', '--timeout', '30000', import.meta.path],
        cwd: join(import.meta.dir, '..', '..'),
        env: { ...process.env, CLAUDE_MEM_PROVIDER_PROMPT_FIXTURE_CHILD: import.meta.path },
        stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
      });
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
      expect(child.exitCode).toBe(0);
    }, 150_000);
  });
} else {
// Project-local scratch (gitignored), never the system temp folder.
const scratchRoot = join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
mkdirSync(scratchRoot, { recursive: true });
const fixture = mkdtempSync(join(scratchRoot, 'install-provider-prompt-'));
const data = join(fixture, 'data');
mkdirSync(data, { recursive: true });
const settingsPath = join(data, 'settings.json');

Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
process.env.CLAUDE_MEM_DATA_DIR = data;
process.env.CLAUDE_MEM_ENV_FILE = join(data, '.env');
process.env.DO_NOT_TRACK = '1';
delete process.env.CI;

/** What @clack/prompts hands back when the owner cancels a prompt. */
const CANCELLED = Symbol('clack:cancel');

interface MultiselectCall {
  message: string;
  options: Array<{ value: string }>;
  initialValues: string[];
}
let multiselectCalls: MultiselectCall[] = [];
let multiselectAnswer: string[] = ['openrouter'];
let passwordAnswer: unknown = 'sk-or-v1-test-key';

const prompts = { ...await import('@clack/prompts') };
mock.module('@clack/prompts', () => ({
  ...prompts,
  isCancel: (value: unknown) => value === CANCELLED,
  multiselect: async (options: MultiselectCall) => {
    multiselectCalls.push(options);
    return multiselectAnswer;
  },
  password: async () => passwordAnswer,
  log: Object.fromEntries(['info', 'success', 'warn', 'error', 'message', 'step'].map(key => [key, (value: string) => { /* collected, unused */ }])),
}));

const { promptProvider } = await import('../../src/npx-cli/commands/install.js');
const { InstallAbortError } = await import('../../src/npx-cli/install/error-reporter.js');

const stored = (): Record<string, unknown> => (existsSync(settingsPath)
  ? JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
  : {});

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('the interactive provider menu', () => {
  beforeEach(() => {
    rmSync(settingsPath, { force: true });
    multiselectCalls = [];
    multiselectAnswer = ['openrouter'];
    passwordAnswer = 'sk-or-v1-test-key';
  });

  it('offers openrouter and openai-compatible beside CMEM Pro and Claude', async () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter' }, null, 2));

    expect(await promptProvider({}, null, '1.0.0-test')).toBe('openrouter');

    expect(multiselectCalls).toHaveLength(1);
    expect(multiselectCalls[0].options.map(option => option.value)).toEqual([
      'cmem',
      'claude',
      'openrouter',
      'openai-compatible',
    ]);
  });

  it('opens on the provider the owner already has configured', async () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter' }, null, 2));

    await promptProvider({}, null, '1.0.0-test');

    expect(multiselectCalls[0].initialValues).toEqual(['openrouter']);
  });

  it('opens on CMEM Pro when nothing is configured yet', async () => {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
    multiselectAnswer = ['claude'];

    await promptProvider({}, null, '1.0.0-test');

    expect(multiselectCalls[0].initialValues).toEqual(['cmem']);
  });

  it('keeps a configured openai-compatible provider without touching it', async () => {
    const before = JSON.stringify({
      CLAUDE_MEM_PROVIDER: 'openai-compatible',
      CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'nvidia-nim',
      CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'nvapi-test',
    }, null, 2);
    writeFileSync(settingsPath, before);
    multiselectAnswer = ['openai-compatible'];

    expect(await promptProvider({}, null, '1.0.0-test')).toBe('openai-compatible');
    expect(multiselectCalls[0].initialValues).toEqual(['openai-compatible']);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });
});

describe('cancelling the API-key prompt', () => {
  beforeEach(() => {
    rmSync(settingsPath, { force: true });
    multiselectCalls = [];
    multiselectAnswer = ['openrouter'];
    passwordAnswer = CANCELLED;
  });

  it('aborts the install instead of switching the owner to the Claude provider', async () => {
    const before = JSON.stringify({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    }, null, 2);
    writeFileSync(settingsPath, before);

    const thrown = await promptProvider({}, null, '1.0.0-test').then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(InstallAbortError);
    const abort = thrown as InstanceType<typeof InstallAbortError>;
    expect(abort.message).toContain('API key prompt was cancelled');
    expect(abort.remediation).toContain('Nothing was changed');
  });

  it('leaves the owner\'s settings exactly as they were', async () => {
    const before = JSON.stringify({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    }, null, 2);
    writeFileSync(settingsPath, before);

    await expect(promptProvider({}, null, '1.0.0-test')).rejects.toBeInstanceOf(InstallAbortError);

    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
    expect(stored().CLAUDE_MEM_PROVIDER).toBe('openrouter');
    expect(stored().CLAUDE_MEM_CLAUDE_AUTH_METHOD).toBeUndefined();
  });
});
}
