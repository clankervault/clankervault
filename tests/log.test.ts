import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initVault } from '../src/vault.js';
import { logAccess } from '../src/log.js';
import { isExcluded } from '../src/sync/engine.js';
import { tmpDir } from './helpers.js';

describe('access log', () => {
  it('appends JSONL lines with timestamp and op', () => {
    const dir = tmpDir();
    initVault(dir);
    logAccess(dir, 'compile', { project: 'demo', tools: 'claude' });
    logAccess(dir, 'search', { query: 'ffmpeg' });
    const lines = readFileSync(join(dir, '.log', 'access.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.op).toBe('compile');
    expect(first.project).toBe('demo');
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(lines[1]).query).toBe('ffmpeg');
  });

  it('never throws even when the vault dir is not writable', () => {
    expect(() => logAccess('/nonexistent-root-path/x', 'compile')).not.toThrow();
  });

  it('the log dir is excluded from sync', () => {
    expect(isExcluded('.log/access.jsonl')).toBe(true);
  });
});
