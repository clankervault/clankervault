import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync as rf, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { initVault } from '../src/vault.js';
import { deriveKey } from '../src/sync/crypto.js';
import { emptyManifest, encodeManifest, decodeManifest } from '../src/sync/manifest.js';
import { isExcluded, scanLocal, readSyncState, writeSyncState, syncOnce, conflictPath } from '../src/sync/engine.js';
import { DirBackend } from '../src/sync/backend.js';
import type { Backend } from '../src/sync/backend.js';
import { createProject } from '../src/project.js';
import { createRecord, listRecords } from '../src/records.js';
import { tmpDir } from './helpers.js';

function newDevice(name: string): string {
  const dir = tmpDir();
  initVault(dir);
  writeFileSync(join(dir, 'device.yaml'), `device: ${name}\nanchors: {}\nprojects: {}\n`);
  return dir;
}

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

describe('syncOnce: two simulated devices', () => {
  it('propagates records from A to B and back (append-only merge)', async () => {
    const remote = tmpDir();
    const A = newDevice('macbook');
    const B = newDevice('mini');
    const backend = () => new DirBackend(remote);

    const p = createProject(A, 'Demo');
    createRecord(A, p.id, { type: 'fact', title: 'Deploy on Vercel' });
    await syncOnce(A, backend(), 'pass', 'macbook');
    const r1 = await syncOnce(B, backend(), 'pass', 'mini');
    expect(r1.downloaded.length).toBeGreaterThan(0);
    expect(listRecords(B, p.id).map((r) => r.title)).toContain('Deploy on Vercel');

    createRecord(B, p.id, { type: 'recipe', title: 'Export shorts' });
    await syncOnce(B, backend(), 'pass', 'mini');
    await syncOnce(A, backend(), 'pass', 'macbook');
    expect(listRecords(A, p.id).map((r) => r.title)).toContain('Export shorts');
    expect(listRecords(A, p.id)).toHaveLength(2);
  });

  it('state.md conflict: last write wins, loser preserved as conflict copy', async () => {
    const remote = tmpDir();
    const A = newDevice('macbook');
    const B = newDevice('mini');
    const backend = () => new DirBackend(remote);
    const p = createProject(A, 'Demo');
    await syncOnce(A, backend(), 'pass', 'macbook');
    await syncOnce(B, backend(), 'pass', 'mini');

    const stateA = join(A, 'projects', p.id, 'state.md');
    const stateB = join(B, 'projects', p.id, 'state.md');
    writeFileSync(stateA, '# State\n\nEditing on macbook.\n');
    writeFileSync(stateB, '# State\n\nEditing on mini.\n');
    // make B's edit decisively newer
    const now = Date.now() / 1000;
    utimesSync(stateA, now - 60, now - 60);
    utimesSync(stateB, now, now);

    await syncOnce(A, backend(), 'pass', 'macbook');   // A pushes its edit
    const rB = await syncOnce(B, backend(), 'pass', 'mini');  // B sees conflict, B is newer, B wins
    expect(rB.conflicts).toContain(`projects/${p.id}/state.md`);
    await syncOnce(A, backend(), 'pass', 'macbook');   // A pulls the outcome

    expect(rf(stateA, 'utf8')).toContain('mini');       // winner content everywhere
    expect(rf(stateB, 'utf8')).toContain('mini');
    const conflictNameRe = /^state\.conflict-macbook-\d{17}\.md$/;
    const projDirB = join(B, 'projects', p.id);
    const copyNameB = readdirSync(projDirB).find((n) => conflictNameRe.test(n));
    expect(copyNameB).toBeDefined();                    // loser content preserved, timestamped
    expect(rf(join(projDirB, copyNameB!), 'utf8')).toContain('macbook');
    // and the conflict copy itself syncs back to A
    const projDirA = join(A, 'projects', p.id);
    const copyNameA = readdirSync(projDirA).find((n) => conflictNameRe.test(n));
    expect(copyNameA).toBeDefined();
  });

  it('two conflict rounds back to back both keep their conflict copy (no same-stamp overwrite)', async () => {
    const remote = tmpDir();
    const A = newDevice('macbook');
    const B = newDevice('mini');
    const backend = () => new DirBackend(remote);
    const p = createProject(A, 'Demo');
    await syncOnce(A, backend(), 'pass', 'macbook');
    await syncOnce(B, backend(), 'pass', 'mini');

    const stateA = join(A, 'projects', p.id, 'state.md');
    const stateB = join(B, 'projects', p.id, 'state.md');
    const projDirB = join(B, 'projects', p.id);

    // one full edit-both-sides / sync-both-sides conflict round; B always wins (newer mtime)
    // so the loser (macbook's edit) is preserved as a timestamped conflict copy each time
    const conflictRound = async (n: number) => {
      writeFileSync(stateA, `# State\n\nRound ${n} on macbook.\n`);
      writeFileSync(stateB, `# State\n\nRound ${n} on mini.\n`);
      const now = Date.now() / 1000;
      utimesSync(stateA, now - 60, now - 60);
      utimesSync(stateB, now, now);
      await syncOnce(A, backend(), 'pass', 'macbook');            // A pushes its edit
      const rB = await syncOnce(B, backend(), 'pass', 'mini');    // B sees conflict, B wins
      expect(rB.conflicts).toContain(`projects/${p.id}/state.md`);
      await syncOnce(A, backend(), 'pass', 'macbook');            // A pulls the outcome
    };

    await conflictRound(1);
    await conflictRound(2);

    // this is the exact data-loss class the ms-stamp fix closes: two conflicts on the
    // same path/device pair within the same second must not collide on one filename
    const conflictNameRe = /^state\.conflict-macbook-\d{17}\.md$/;
    const copies = readdirSync(projDirB).filter((n) => conflictNameRe.test(n));
    expect(copies.length).toBeGreaterThanOrEqual(2);
  });

  it('retries and succeeds through a live concurrent manifest race', async () => {
    const remote = tmpDir();
    const A = newDevice('macbook');
    const B = newDevice('mini');
    const C = newDevice('desktop');
    const p = createProject(A, 'Demo');
    await syncOnce(A, new DirBackend(remote), 'pass', 'macbook');
    await syncOnce(B, new DirBackend(remote), 'pass', 'mini');
    await syncOnce(C, new DirBackend(remote), 'pass', 'desktop');

    // A queues a local change to push.
    createRecord(A, p.id, { type: 'fact', title: 'Race winner' });

    // Wraps a real DirBackend; on its FIRST putManifest call only, it lets a second
    // device genuinely push through its own DirBackend first (a real concurrent
    // manifest update, not a fabricated one), so the delegated call is guaranteed
    // to see a stale expectedVersion and throw VersionConflictError for real.
    class RacingBackend implements Backend {
      putManifestCalls = 0;
      constructor(private inner: Backend) {}
      async ensure(): Promise<void> { return this.inner.ensure(); }
      async getSalt(): Promise<Buffer> { return this.inner.getSalt(); }
      async getManifest() { return this.inner.getManifest(); }
      async putManifest(data: Buffer, expectedVersion: string | null): Promise<string> {
        this.putManifestCalls++;
        if (this.putManifestCalls === 1) {
          createRecord(C, p.id, { type: 'recipe', title: 'Concurrent push' });
          await syncOnce(C, new DirBackend(remote), 'pass', 'desktop');
        }
        return this.inner.putManifest(data, expectedVersion);
      }
      async getObject(k: string) { return this.inner.getObject(k); }
      async putObject(k: string, d: Buffer) { return this.inner.putObject(k, d); }
      async deleteObject(k: string) { return this.inner.deleteObject(k); }
    }

    const racing = new RacingBackend(new DirBackend(remote));
    const result = await syncOnce(A, racing, 'pass', 'macbook');
    expect(result.uploaded.length).toBeGreaterThan(0);
    expect(racing.putManifestCalls).toBeGreaterThanOrEqual(2);

    // both A's push and C's concurrent push must have landed on the shared remote
    await syncOnce(B, new DirBackend(remote), 'pass', 'mini');
    const titles = listRecords(B, p.id).map((r) => r.title);
    expect(titles).toContain('Race winner');
    expect(titles).toContain('Concurrent push');
  });

  it('deletion propagates', async () => {
    const remote = tmpDir();
    const A = newDevice('macbook');
    const B = newDevice('mini');
    const backend = () => new DirBackend(remote);
    const p = createProject(A, 'Demo');
    const rec = createRecord(A, p.id, { type: 'fact', title: 'Temp' });
    await syncOnce(A, backend(), 'pass', 'macbook');
    await syncOnce(B, backend(), 'pass', 'mini');
    rmSync(rec.path);
    await syncOnce(A, backend(), 'pass', 'macbook');
    const r = await syncOnce(B, backend(), 'pass', 'mini');
    expect(r.deletedLocal.length).toBe(1);
    expect(listRecords(B, p.id)).toHaveLength(0);
  });

  it('remote stores no plaintext content or readable paths', async () => {
    const remote = tmpDir();
    const A = newDevice('macbook');
    const backend = () => new DirBackend(remote);
    const p = createProject(A, 'Secret Project');
    createRecord(A, p.id, { type: 'fact', title: 'Deploy on Vercel' });
    await syncOnce(A, backend(), 'pass', 'macbook');
    const names = readdirSync(join(remote, 'objects'));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n).toMatch(/^[0-9a-f]{64}$/);
    for (const n of names) {
      expect(rf(join(remote, 'objects', n)).toString('latin1')).not.toContain('Vercel');
    }
    const manifestRaw = rf(join(remote, 'manifest.json')).toString('latin1');
    expect(manifestRaw).not.toContain('secret-project');
    expect(Buffer.from(JSON.parse(manifestRaw).payload, 'base64').toString('latin1')).not.toContain('secret-project');
  });

  it('device.yaml never reaches the remote', async () => {
    const remote = tmpDir();
    const A = newDevice('macbook');
    await syncOnce(A, new DirBackend(remote), 'pass', 'macbook');
    const B = newDevice('mini');
    await syncOnce(B, new DirBackend(remote), 'pass', 'mini');
    expect(rf(join(B, 'device.yaml'), 'utf8')).toContain('device: mini');  // untouched
  });

  it('wrong passphrase fails loudly, not with silent corruption', async () => {
    const remote = tmpDir();
    const A = newDevice('macbook');
    await syncOnce(A, new DirBackend(remote), 'good', 'macbook');
    const B = newDevice('mini');
    await expect(syncOnce(B, new DirBackend(remote), 'bad', 'mini')).rejects.toThrow();
  });
});

describe('conflictPath', () => {
  it('inserts the device and a timestamp before the extension', () => {
    expect(conflictPath('projects/x/state.md', 'mini', '20260724142530123'))
      .toBe('projects/x/state.conflict-mini-20260724142530123.md');
    expect(conflictPath('vault.yaml', 'mini', '20260724142530123'))
      .toBe('vault.conflict-mini-20260724142530123.yaml');
  });
});
