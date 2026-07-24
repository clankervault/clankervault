import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { initVault } from '../src/vault.js';
import { deriveKey } from '../src/sync/crypto.js';
import { emptyManifest, encodeManifest, decodeManifest } from '../src/sync/manifest.js';
import { isExcluded, scanLocal, readSyncState, writeSyncState } from '../src/sync/engine.js';
import { tmpDir } from './helpers.js';

describe('manifest', () => {
  it('encrypts and round-trips', () => {
    const key = deriveKey('p', randomBytes(16));
    const m = emptyManifest();
    m.seq = 3;
    m.files['a.md'] = { hash: 'h', size: 1, mtimeMs: 2, modifiedBy: 'macbook' };
    const blob = encodeManifest(m, key);
    expect(blob.toString()).not.toContain('macbook');
    expect(decodeManifest(blob, key)).toEqual(m);
  });
});

describe('scanLocal', () => {
  it('walks the vault, hashes files, excludes per-device paths', () => {
    const dir = tmpDir();
    initVault(dir);
    mkdirSync(join(dir, 'projects', 'demo', 'records'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'demo', 'records', 'r.md'), 'rec');
    mkdirSync(join(dir, '.sync'), { recursive: true });
    writeFileSync(join(dir, '.sync', 'state.json'), '{}');
    writeFileSync(join(dir, '.DS_Store'), 'junk');
    const local = scanLocal(dir);
    expect(local['projects/demo/records/r.md']).toBeDefined();
    expect(local['vault.yaml']).toBeDefined();
    expect(local['me/profile.md']).toBeDefined();
    expect(local['device.yaml']).toBeUndefined();
    expect(Object.keys(local).some((p) => p.includes('.sync'))).toBe(false);
    expect(local['.DS_Store']).toBeUndefined();
    expect(local['projects/demo/records/r.md'].hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sync state', () => {
  it('round-trips and defaults to empty', () => {
    const dir = tmpDir();
    initVault(dir);
    expect(readSyncState(dir)).toEqual({ files: {} });
    writeSyncState(dir, { files: { 'a.md': 'h1' } });
    expect(readSyncState(dir)).toEqual({ files: { 'a.md': 'h1' } });
  });
});

describe('isExcluded', () => {
  it('excludes by any path segment', () => {
    expect(isExcluded('device.yaml')).toBe(true);
    expect(isExcluded('.sync/state.json')).toBe(true);
    expect(isExcluded('.mine/offsets.json')).toBe(true);
    expect(isExcluded('projects/demo/state.md')).toBe(false);
  });
});
