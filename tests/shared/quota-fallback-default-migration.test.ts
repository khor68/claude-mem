import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

/**
 * Provider dispatch tells "no backup chosen" from an explicit 'claude' by the
 * SAVED value. A loader that seeds 'claude' makes every install look like it
 * asked for the Anthropic plan as its backup.
 */
const KEY = 'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER';

function withDir(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'quota-default-'));
  const saved = process.env[KEY];
  delete process.env[KEY];
  try { run(join(dir, 'settings.json')); }
  finally {
    if (saved !== undefined) process.env[KEY] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

const saved = (path: string): string => JSON.parse(readFileSync(path, 'utf8'))[KEY];

describe('the quota fallback default is empty, not claude', () => {
  it('seeds an empty value in a fresh settings file', () => {
    withDir((path) => {
      SettingsDefaultsManager.loadFromFile(path);
      expect(saved(path)).toBe('');
    });
  });

  it('moves a seeded claude to empty once, on a writable load', () => {
    withDir((path) => {
      writeFileSync(path, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter', [KEY]: 'claude' }));
      SettingsDefaultsManager.loadFromFile(path);
      expect(saved(path)).toBe('');
    });
  });

  it('keeps a claude the owner saves after the move', () => {
    withDir((path) => {
      writeFileSync(path, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter', [KEY]: 'claude' }));
      SettingsDefaultsManager.loadFromFile(path);
      writeFileSync(path, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter', [KEY]: 'claude' }));
      SettingsDefaultsManager.loadFromFile(path);
      expect(saved(path)).toBe('claude');
    });
  });

  it('never rewrites on a read-only load', () => {
    withDir((path) => {
      writeFileSync(path, JSON.stringify({ [KEY]: 'claude' }));
      SettingsDefaultsManager.loadFromFile(path, true, { readOnly: true });
      expect(saved(path)).toBe('claude');
    });
  });
});
