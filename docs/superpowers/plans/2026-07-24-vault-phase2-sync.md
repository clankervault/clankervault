# Vault Phase 2 (Sync) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `vault sync`: E2E-encrypted, multi-device synchronization of the vault through a pluggable backend (first backend: a plain directory, which covers iCloud Drive / NAS / USB / any mounted folder), with append-only-friendly merge, last-write-wins + conflict copies for mutable files, and a `--watch` daemon mode. No git anywhere.

**Architecture:** A three-way diff engine (local scan vs remote manifest vs last-synced state) over encrypted content-addressed objects. The remote stores only ciphertext: AES-256-GCM objects named by HMAC of their path (paths are hidden), plus one encrypted manifest with a compare-and-swap version. Per-device sync config lives in `device.yaml` (never synced); local sync state lives in `<vault>/.sync/` (excluded from sync).

**Tech Stack:** Node crypto (scrypt, AES-256-GCM, HMAC), no new dependencies. vitest.

## Global Constraints

- Sync must not assume git (spec §6). Backend = pluggable module; v1 ships `dir`.
- E2E: remote never sees plaintext content NOR readable file paths. Object names = HMAC-SHA256(mac-key, relpath). Manifest is encrypted too. Only `salt` is plaintext on the remote.
- `device.yaml`, `.sync/`, `.mine/`, `.DS_Store` are NEVER uploaded (spec §7: per-device files don't sync).
- Append-only record files merge trivially (distinct filenames); any true content conflict on the same path resolves last-write-wins by mtime, and the LOSER's content is preserved as `<name>.conflict-<device>.md` next to the file - never silently discarded (spec §1).
- Continuous mode: small diffs after each change (watch + debounce), plus a periodic pull; a closed laptop lid loses at most seconds of unsynced changes (spec §6).
- NO em/en dashes anywhere in code or output. Commit messages: technical, never reference AI/Claude/assistant, no co-author trailers.
- Repo: /Users/mac/Development/vault. Follow existing code style (ESM NodeNext, small focused modules, tests against real temp dirs).
- Known documented limitations (state them in README, do not solve): mtime LWW assumes roughly sane clocks across devices; DirBackend CAS is best-effort (not atomic across processes); passphrase in device.yaml is plaintext-on-device by design.

---

## File Structure

```
src/sync/
├── crypto.ts     # key derivation, encrypt/decrypt, object naming
├── backend.ts    # Backend interface + VersionConflictError + DirBackend
├── manifest.ts   # Manifest types, encode/decode, empty
└── engine.ts     # scanLocal, sync state io, syncOnce (three-way merge)
src/cli.ts        # + sync command (setup / one-shot / --watch)
src/types.ts      # DeviceConfig gains optional sync block
src/vault.ts      # readDeviceConfig passes sync block through
tests/sync-crypto.test.ts
tests/sync-backend.test.ts
tests/sync-engine.test.ts   # the two-simulated-devices scenarios
tests/cli-sync.test.ts
```

---

### Task 1: Sync crypto + DeviceConfig extension

**Files:**
- Create: `src/sync/crypto.ts`
- Modify: `src/types.ts` (add `DeviceSyncConfig`, extend `DeviceConfig`), `src/vault.ts` (pass `sync` through in `readDeviceConfig`)
- Test: `tests/sync-crypto.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface SyncKey { enc: Buffer; mac: Buffer }`
  - `deriveKey(passphrase: string, salt: Buffer): SyncKey`
  - `encrypt(key: SyncKey, plaintext: Buffer): Buffer` and `decrypt(key: SyncKey, blob: Buffer): Buffer` (iv 12B + tag 16B + ciphertext)
  - `objectKey(key: SyncKey, relpath: string): string` (64 hex chars)
  - In types.ts: `interface DeviceSyncConfig { backend: 'dir'; path: string; passphrase?: string }` and `DeviceConfig` gains `sync?: DeviceSyncConfig`.

- [ ] **Step 1: Write failing tests**

`tests/sync-crypto.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { deriveKey, encrypt, decrypt, objectKey } from '../src/sync/crypto.js';

const salt = randomBytes(16);

describe('sync crypto', () => {
  it('round-trips content', () => {
    const key = deriveKey('correct horse', salt);
    const blob = encrypt(key, Buffer.from('vault content'));
    expect(decrypt(key, blob).toString()).toBe('vault content');
    expect(blob.toString()).not.toContain('vault content');
  });
  it('fails to decrypt with the wrong passphrase', () => {
    const a = deriveKey('right', salt);
    const b = deriveKey('wrong', salt);
    const blob = encrypt(a, Buffer.from('secret'));
    expect(() => decrypt(b, blob)).toThrow();
  });
  it('derives different keys from different salts', () => {
    const a = deriveKey('same', salt);
    const b = deriveKey('same', randomBytes(16));
    expect(a.enc.equals(b.enc)).toBe(false);
  });
  it('object keys hide the path but are stable', () => {
    const key = deriveKey('p', salt);
    const k = objectKey(key, 'projects/demo/records/2026-07-24-x.md');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(objectKey(key, 'projects/demo/records/2026-07-24-x.md')).toBe(k);
    expect(objectKey(key, 'projects/demo/state.md')).not.toBe(k);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/sync-crypto.test.ts` (expected: FAIL, module not found)

- [ ] **Step 3: Implement**

`src/sync/crypto.ts`:
```ts
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto';

export interface SyncKey { enc: Buffer; mac: Buffer }

/** one scrypt call yields both the AES key and the path-hiding HMAC key */
export function deriveKey(passphrase: string, salt: Buffer): SyncKey {
  const buf = scryptSync(passphrase, salt, 64);
  return { enc: buf.subarray(0, 32), mac: buf.subarray(32, 64) };
}

/** blob layout: 12B iv, 16B auth tag, ciphertext */
export function encrypt(key: SyncKey, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.enc, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decrypt(key: SyncKey, blob: Buffer): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key.enc, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** remote object name for a vault-relative path; hides the path from the storage provider */
export function objectKey(key: SyncKey, relpath: string): string {
  return createHmac('sha256', key.mac).update(relpath).digest('hex');
}
```

In `src/types.ts` add (near DeviceConfig):
```ts
export interface DeviceSyncConfig {
  backend: 'dir';
  path: string;              // where the encrypted remote lives (mounted folder)
  passphrase?: string;       // or env VAULT_PASSPHRASE
}
```
and extend `DeviceConfig` with `sync?: DeviceSyncConfig;`.

In `src/vault.ts` `readDeviceConfig` return object add: `sync: raw.sync ?? undefined,`.

- [ ] **Step 4: Run tests to verify pass, full suite, tsc**

Run: `npx vitest run tests/sync-crypto.test.ts && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add sync crypto layer and per-device sync config"
```

---

### Task 2: Backend interface + DirBackend

**Files:**
- Create: `src/sync/backend.ts`
- Test: `tests/sync-backend.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (backend is ciphertext-agnostic).
- Produces:
  - `class VersionConflictError extends Error`
  - `interface Backend { ensure(): Promise<void>; getSalt(): Promise<Buffer>; getManifest(): Promise<{ data: Buffer; version: string } | null>; putManifest(data: Buffer, expectedVersion: string | null): Promise<string>; getObject(key: string): Promise<Buffer>; putObject(key: string, data: Buffer): Promise<void>; deleteObject(key: string): Promise<void> }`
  - `class DirBackend implements Backend` with `constructor(root: string)`

- [ ] **Step 1: Write failing tests**

`tests/sync-backend.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DirBackend, VersionConflictError } from '../src/sync/backend.js';
import { tmpDir } from './helpers.js';

describe('DirBackend', () => {
  it('creates a stable salt on first use', async () => {
    const b = new DirBackend(tmpDir());
    await b.ensure();
    const s1 = await b.getSalt();
    const s2 = await b.getSalt();
    expect(s1.equals(s2)).toBe(true);
    expect(s1.length).toBe(16);
  });

  it('stores and retrieves objects by key', async () => {
    const b = new DirBackend(tmpDir());
    await b.ensure();
    await b.putObject('a'.repeat(64), Buffer.from('blob'));
    expect((await b.getObject('a'.repeat(64))).toString()).toBe('blob');
    await b.deleteObject('a'.repeat(64));
    await expect(b.getObject('a'.repeat(64))).rejects.toThrow();
  });

  it('manifest CAS: rejects a stale expected version', async () => {
    const b = new DirBackend(tmpDir());
    await b.ensure();
    expect(await b.getManifest()).toBeNull();
    const v1 = await b.putManifest(Buffer.from('m1'), null);
    const got = await b.getManifest();
    expect(got!.data.toString()).toBe('m1');
    expect(got!.version).toBe(v1);
    // concurrent writer moved the version forward
    const v2 = await b.putManifest(Buffer.from('m2'), v1);
    await expect(b.putManifest(Buffer.from('stale'), v1)).rejects.toThrow(VersionConflictError);
    expect((await b.getManifest())!.version).toBe(v2);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/sync-backend.test.ts` (expected: FAIL)

- [ ] **Step 3: Implement**

`src/sync/backend.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class VersionConflictError extends Error {
  constructor() { super('sync: remote manifest changed underneath us'); }
}

/** storage abstraction; v1 ships DirBackend, cloud backends implement the same surface */
export interface Backend {
  ensure(): Promise<void>;
  getSalt(): Promise<Buffer>;
  getManifest(): Promise<{ data: Buffer; version: string } | null>;
  /** compare-and-swap: expectedVersion must match the current one (null = no manifest yet) */
  putManifest(data: Buffer, expectedVersion: string | null): Promise<string>;
  getObject(key: string): Promise<Buffer>;
  putObject(key: string, data: Buffer): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

export class DirBackend implements Backend {
  constructor(private root: string) {}
  private p(...seg: string[]): string { return join(this.root, ...seg); }

  async ensure(): Promise<void> {
    mkdirSync(this.p('objects'), { recursive: true });
  }

  async getSalt(): Promise<Buffer> {
    const f = this.p('salt');
    if (!existsSync(f)) writeFileSync(f, randomBytes(16));
    return readFileSync(f);
  }

  async getManifest(): Promise<{ data: Buffer; version: string } | null> {
    const f = this.p('manifest.bin');
    if (!existsSync(f)) return null;
    return { data: readFileSync(f), version: readFileSync(this.p('manifest.version'), 'utf8') };
  }

  async putManifest(data: Buffer, expectedVersion: string | null): Promise<string> {
    const vf = this.p('manifest.version');
    const current = existsSync(vf) ? readFileSync(vf, 'utf8') : null;
    if (current !== expectedVersion) throw new VersionConflictError();
    const next = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const tmp = this.p('manifest.bin.tmp');
    writeFileSync(tmp, data);
    renameSync(tmp, this.p('manifest.bin'));
    writeFileSync(vf, next);
    return next;
  }

  async getObject(key: string): Promise<Buffer> {
    return readFileSync(this.p('objects', key));
  }

  async putObject(key: string, data: Buffer): Promise<void> {
    const tmp = this.p('objects', `${key}.tmp`);
    writeFileSync(tmp, data);
    renameSync(tmp, this.p('objects', key));
  }

  async deleteObject(key: string): Promise<void> {
    rmSync(this.p('objects', key), { force: true });
  }
}
```

- [ ] **Step 4: Run tests, full suite, tsc**

Run: `npx vitest run tests/sync-backend.test.ts && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add sync backend interface with directory backend and manifest CAS"
```

---

### Task 3: Manifest + local scan + sync state

**Files:**
- Create: `src/sync/manifest.ts`, and the scan/state half of `src/sync/engine.ts`
- Test: `tests/sync-engine.test.ts` (scan/state cases only; merge scenarios come in Task 4)

**Interfaces:**
- Consumes: `SyncKey`, `encrypt`, `decrypt` from crypto.
- Produces (manifest.ts):
  - `interface ManifestEntry { hash: string; size: number; mtimeMs: number; modifiedBy: string; deleted?: boolean }`
  - `interface Manifest { seq: number; files: Record<string, ManifestEntry> }`
  - `emptyManifest(): Manifest`
  - `encodeManifest(m: Manifest, key: SyncKey): Buffer` / `decodeManifest(blob: Buffer, key: SyncKey): Manifest`
- Produces (engine.ts, this task):
  - `isExcluded(relpath: string): boolean` (any path segment in {device.yaml, .sync, .mine, .DS_Store})
  - `interface LocalFile { hash: string; size: number; mtimeMs: number }`
  - `scanLocal(vaultDir: string): Record<string, LocalFile>` (relpaths use forward slashes)
  - `interface SyncState { files: Record<string, string> }` (relpath to hash at last sync)
  - `readSyncState(vaultDir: string): SyncState` / `writeSyncState(vaultDir: string, s: SyncState): void` (stored at `<vault>/.sync/state.json`)
  - `sha256(data: Buffer): string`

- [ ] **Step 1: Write failing tests**

`tests/sync-engine.test.ts` (initial content):
```ts
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
```

- [ ] **Step 2: Run to verify fail** - `npx vitest run tests/sync-engine.test.ts`

- [ ] **Step 3: Implement**

`src/sync/manifest.ts`:
```ts
import type { SyncKey } from './crypto.js';
import { decrypt, encrypt } from './crypto.js';

export interface ManifestEntry {
  hash: string;
  size: number;
  mtimeMs: number;
  modifiedBy: string;   // device name that last wrote this entry
  deleted?: boolean;    // tombstone
}

export interface Manifest {
  seq: number;
  files: Record<string, ManifestEntry>;
}

export function emptyManifest(): Manifest {
  return { seq: 0, files: {} };
}

export function encodeManifest(m: Manifest, key: SyncKey): Buffer {
  return encrypt(key, Buffer.from(JSON.stringify(m)));
}

export function decodeManifest(blob: Buffer, key: SyncKey): Manifest {
  return JSON.parse(decrypt(key, blob).toString('utf8'));
}
```

`src/sync/engine.ts` (this task's half):
```ts
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const EXCLUDED_SEGMENTS = new Set(['device.yaml', '.sync', '.mine', '.DS_Store']);

export function isExcluded(relpath: string): boolean {
  return relpath.split('/').some((part) => EXCLUDED_SEGMENTS.has(part));
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface LocalFile { hash: string; size: number; mtimeMs: number }

export function scanLocal(vaultDir: string): Record<string, LocalFile> {
  const out: Record<string, LocalFile> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(vaultDir, abs).split(sep).join('/');
      if (isExcluded(rel)) continue;
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.isFile()) continue;
      const content = readFileSync(abs);
      const st = statSync(abs);
      out[rel] = { hash: sha256(content), size: st.size, mtimeMs: st.mtimeMs };
    }
  };
  walk(vaultDir);
  return out;
}

export interface SyncState { files: Record<string, string> }

function statePath(vaultDir: string): string {
  return join(vaultDir, '.sync', 'state.json');
}

export function readSyncState(vaultDir: string): SyncState {
  const f = statePath(vaultDir);
  if (!existsSync(f)) return { files: {} };
  return JSON.parse(readFileSync(f, 'utf8'));
}

export function writeSyncState(vaultDir: string, s: SyncState): void {
  mkdirSync(join(vaultDir, '.sync'), { recursive: true });
  writeFileSync(statePath(vaultDir), JSON.stringify(s, null, 2));
}
```

- [ ] **Step 4: Run tests, full suite, tsc** - `npx vitest run tests/sync-engine.test.ts && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add sync manifest format, local scan and per-device sync state"
```

---

### Task 4: syncOnce three-way merge engine

**Files:**
- Modify: `src/sync/engine.ts` (append `syncOnce`, `conflictPath`)
- Test: `tests/sync-engine.test.ts` (append the two-device scenarios)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces:
  - `interface SyncResult { uploaded: string[]; downloaded: string[]; deletedLocal: string[]; deletedRemote: string[]; conflicts: string[] }`
  - `syncOnce(vaultDir: string, backend: Backend, passphrase: string, deviceName: string): Promise<SyncResult>`
  - `conflictPath(relpath: string, device: string): string` (`projects/x/state.md` + `mini` = `projects/x/state.conflict-mini.md`; non-md files get `.conflict-<device>` before their extension)

**Merge rules (three-way per path: local hash L, remote manifest hash R (undefined if tombstoned/absent), last-synced hash S):**
1. L == S and R == S: nothing.
2. Only local changed: upload (or tombstone remote + delete object if L is undefined).
3. Only remote changed: download (or delete local file if R is undefined).
4. Both changed, L == R: converged, just record.
5. Both changed, L undefined (local delete vs remote edit): edit wins, download.
6. Both changed, R undefined (remote delete vs local edit): edit wins, upload.
7. Both changed, L != R, both defined: TRUE CONFLICT. Compare local mtimeMs vs remote entry mtimeMs. Winner's content stays at the path; the loser's content is written to `conflictPath(path, loserDevice)` (loserDevice = local device name if local lost, else remote entry's modifiedBy) and the conflict copy is uploaded too. Winner is uploaded if local won.
- After the loop: if anything was uploaded/tombstoned, `manifest.seq++` and `putManifest` with CAS; on `VersionConflictError` retry the whole cycle from a fresh pull (max 3 attempts, then throw). Finally, rescan local and write sync state as `{relpath: hash}`.

- [ ] **Step 1: Write failing tests (append to tests/sync-engine.test.ts)**

```ts
import { DirBackend } from '../src/sync/backend.js';
import { syncOnce, conflictPath } from '../src/sync/engine.js';
import { createProject } from '../src/project.js';
import { createRecord, listRecords } from '../src/records.js';
import { existsSync, readdirSync, rmSync, utimesSync, readFileSync as rf } from 'node:fs';

function newDevice(name: string): string {
  const dir = tmpDir();
  initVault(dir);
  writeFileSync(join(dir, 'device.yaml'), `device: ${name}\nanchors: {}\nprojects: {}\n`);
  return dir;
}

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
    const conflictFile = join(B, 'projects', p.id, 'state.conflict-macbook.md');
    expect(existsSync(conflictFile)).toBe(true);        // loser content preserved
    expect(rf(conflictFile, 'utf8')).toContain('macbook');
    // and the conflict copy itself syncs back to A
    expect(existsSync(join(A, 'projects', p.id, 'state.conflict-macbook.md'))).toBe(true);
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
  it('inserts the device before the extension', () => {
    expect(conflictPath('projects/x/state.md', 'mini')).toBe('projects/x/state.conflict-mini.md');
    expect(conflictPath('vault.yaml', 'mini')).toBe('vault.conflict-mini.yaml');
  });
});
```

- [ ] **Step 2: Run to verify fail** - `npx vitest run tests/sync-engine.test.ts`

- [ ] **Step 3: Implement (append to src/sync/engine.ts)**

```ts
import { dirname } from 'node:path';
import { rmSync } from 'node:fs';
import type { Backend } from './backend.js';
import { VersionConflictError } from './backend.js';
import { deriveKey, decrypt, encrypt, objectKey } from './crypto.js';
import { decodeManifest, emptyManifest, encodeManifest } from './manifest.js';
import type { Manifest } from './manifest.js';

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  conflicts: string[];
}

export function conflictPath(relpath: string, device: string): string {
  const dot = relpath.lastIndexOf('.');
  const slash = relpath.lastIndexOf('/');
  if (dot > slash) return `${relpath.slice(0, dot)}.conflict-${device}${relpath.slice(dot)}`;
  return `${relpath}.conflict-${device}`;
}

const MAX_ATTEMPTS = 3;

export async function syncOnce(
  vaultDir: string, backend: Backend, passphrase: string, deviceName: string,
): Promise<SyncResult> {
  await backend.ensure();
  const key = deriveKey(passphrase, await backend.getSalt());

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const remote = await backend.getManifest();
    const manifest: Manifest = remote ? decodeManifest(remote.data, key) : emptyManifest();
    const baseVersion = remote?.version ?? null;
    const local = scanLocal(vaultDir);
    const last = readSyncState(vaultDir);
    const result: SyncResult = { uploaded: [], downloaded: [], deletedLocal: [], deletedRemote: [], conflicts: [] };
    let dirty = false;

    const readLocal = (rel: string) => readFileSync(join(vaultDir, rel));
    const writeLocal = (rel: string, data: Buffer) => {
      mkdirSync(dirname(join(vaultDir, rel)), { recursive: true });
      writeFileSync(join(vaultDir, rel), data);
    };
    const upload = async (rel: string) => {
      const content = readLocal(rel);
      await backend.putObject(objectKey(key, rel), encrypt(key, content));
      manifest.files[rel] = {
        hash: sha256(content), size: content.length,
        mtimeMs: statSync(join(vaultDir, rel)).mtimeMs, modifiedBy: deviceName,
      };
      dirty = true;
      result.uploaded.push(rel);
    };
    const download = async (rel: string) => {
      writeLocal(rel, decrypt(key, await backend.getObject(objectKey(key, rel))));
      result.downloaded.push(rel);
    };
    const tombstone = async (rel: string) => {
      const entry = manifest.files[rel];
      manifest.files[rel] = { ...entry, deleted: true, mtimeMs: Date.now(), modifiedBy: deviceName };
      await backend.deleteObject(objectKey(key, rel));
      dirty = true;
      result.deletedRemote.push(rel);
    };

    const paths = new Set([...Object.keys(local), ...Object.keys(manifest.files), ...Object.keys(last.files)]);
    for (const rel of paths) {
      const entry = manifest.files[rel];
      const localHash: string | undefined = local[rel]?.hash;
      const remoteHash: string | undefined = entry && !entry.deleted ? entry.hash : undefined;
      const lastHash: string | undefined = last.files[rel];
      const localChanged = localHash !== lastHash;
      const remoteChanged = remoteHash !== lastHash;

      if (!localChanged && !remoteChanged) continue;
      if (localChanged && !remoteChanged) {
        if (localHash === undefined) { if (entry && !entry.deleted) await tombstone(rel); }
        else await upload(rel);
        continue;
      }
      if (!localChanged && remoteChanged) {
        if (remoteHash === undefined) {
          if (localHash !== undefined) { rmSync(join(vaultDir, rel)); result.deletedLocal.push(rel); }
        } else await download(rel);
        continue;
      }
      // both changed
      if (localHash === remoteHash) continue;                    // converged independently
      if (localHash === undefined) { await download(rel); continue; }   // edit beats delete
      if (remoteHash === undefined) { await upload(rel); continue; }
      // true conflict: last write wins, loser preserved
      const localWins = local[rel].mtimeMs >= entry.mtimeMs;
      if (localWins) {
        const remoteContent = decrypt(key, await backend.getObject(objectKey(key, rel)));
        const copy = conflictPath(rel, entry.modifiedBy);
        writeLocal(copy, remoteContent);
        await upload(copy);
        await upload(rel);
      } else {
        const copy = conflictPath(rel, deviceName);
        writeLocal(copy, readLocal(rel));
        await upload(copy);
        await download(rel);
      }
      result.conflicts.push(rel);
    }

    if (dirty) {
      manifest.seq++;
      try {
        await backend.putManifest(encodeManifest(manifest, key), baseVersion);
      } catch (err) {
        if (err instanceof VersionConflictError) continue;   // fresh pull, re-merge
        throw err;
      }
    }
    const finalScan = scanLocal(vaultDir);
    writeSyncState(vaultDir, { files: Object.fromEntries(Object.entries(finalScan).map(([p, f]) => [p, f.hash])) });
    return result;
  }
  throw new Error('sync: remote kept changing, giving up after 3 attempts (run again)');
}
```
(Adjust the top-of-file imports so everything referenced is imported exactly once; `readFileSync`, `writeFileSync`, `statSync`, `mkdirSync`, `join` are already imported by the Task 3 half.)

- [ ] **Step 4: Run tests, full suite, tsc** - `npx vitest run tests/sync-engine.test.ts && npx vitest run && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add three-way sync engine with conflict copies and CAS retry"
```

---

### Task 5: CLI sync command (setup / once / watch) + docs

**Files:**
- Modify: `src/cli.ts` (add `sync` command), `README.md` (Sync section)
- Test: `tests/cli-sync.test.ts`

**Interfaces:**
- Consumes: `syncOnce`, `DirBackend`, `readDeviceConfig`; device.yaml `sync` block from Task 1.
- Produces CLI:
  - `vault sync setup --path <remoteDir> [--passphrase <p>]`: writes the `sync:` block into device.yaml (backend `dir`), preserving existing keys. Prints a reminder that the passphrase must be identical on every device and is stored in plaintext in device.yaml (or use env `VAULT_PASSPHRASE` and omit `--passphrase`).
  - `vault sync`: one-shot; resolves passphrase from `VAULT_PASSPHRASE` env, else device.yaml `sync.passphrase`; errors with guidance if no sync config or passphrase. Prints a one-line summary: `synced: 3 up, 1 down, 0 conflicts`.
  - `vault sync --watch [--interval <s>]`: initial sync, then `fs.watch(vaultDir, { recursive: true })` with 1.5s debounce (ignoring paths under `.sync/`), plus a periodic sync every `--interval` seconds (default 30). Runs until killed; prints one line per non-empty sync.

**Implementation sketch for the CLI action (write it exactly like this):**
```ts
const sync = program.command('sync').description('sync the vault with the configured remote (E2E encrypted)');
sync
  .command('setup')
  .requiredOption('--path <dir>', 'remote directory (mounted cloud folder, NAS, USB)')
  .option('--passphrase <p>', 'encryption passphrase (or set VAULT_PASSPHRASE)')
  .action((opts: { path: string; passphrase?: string }) => {
    const dir = requireVault(vaultDir());
    const file = join(dir, 'device.yaml');
    const raw = existsSync(file) ? parseYaml(readFileSync(file, 'utf8')) ?? {} : {};
    raw.sync = { backend: 'dir', path: resolve(opts.path), ...(opts.passphrase ? { passphrase: opts.passphrase } : {}) };
    writeFileSync(file, stringifyYaml(raw));
    console.log(`Sync configured: ${resolve(opts.path)}`);
    console.log('Use the SAME passphrase on every device. It never leaves your machines.');
    if (!opts.passphrase) console.log('No passphrase saved: set VAULT_PASSPHRASE before running `vault sync`.');
  });
sync
  .option('--watch', 'keep running and sync on changes')
  .option('--interval <s>', 'periodic sync interval in watch mode (seconds)', '30')
  .action(async (opts: { watch?: boolean; interval: string }) => {
    const dir = requireVault(vaultDir());
    const device = readDeviceConfig(dir);
    if (!device.sync) {
      console.error('Sync is not configured on this device. Run: vault sync setup --path <remoteDir>');
      process.exit(1);
    }
    const passphrase = process.env.VAULT_PASSPHRASE ?? device.sync.passphrase;
    if (!passphrase) {
      console.error('No passphrase. Set VAULT_PASSPHRASE or run `vault sync setup` with --passphrase.');
      process.exit(1);
    }
    const backend = new DirBackend(device.sync.path);
    const runOnce = async () => {
      const r = await syncOnce(dir, backend, passphrase, device.device);
      const total = r.uploaded.length + r.downloaded.length + r.deletedLocal.length + r.deletedRemote.length;
      if (total > 0 || r.conflicts.length > 0 || !opts.watch) {
        console.log(`synced: ${r.uploaded.length} up, ${r.downloaded.length} down, ${r.conflicts.length} conflicts`);
      }
      for (const c of r.conflicts) console.log(`conflict on ${c}: losing version saved next to it as a .conflict-<device> file`);
    };
    await runOnce();
    if (!opts.watch) return;
    let timer: NodeJS.Timeout | null = null;
    let running = false;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (running) return trigger();
        running = true;
        try { await runOnce(); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); }
        running = false;
      }, 1500);
    };
    watch(dir, { recursive: true }, (_event, filename) => {
      if (filename && (filename.startsWith('.sync') || filename.includes('/.sync'))) return;
      trigger();
    });
    setInterval(trigger, Number(opts.interval) * 1000);
    console.log(`watching ${dir} (interval ${opts.interval}s), Ctrl+C to stop`);
  });
```
Note: commander turns an async action into a floating promise; that is fine here. Add imports: `watch` from node:fs, `parse as parseYaml, stringify as stringifyYaml` from 'yaml', `DirBackend`, `syncOnce`, `readDeviceConfig`. The `sync` command's own action must be registered via `.action` on the `sync` command itself while `setup` is a subcommand; commander supports a default action on a command with subcommands only if the subcommand is not matched - verify with `vault sync` and `vault sync setup` both working; if commander's default-action behavior fights the subcommand, register the one-shot as `sync run` alias and make bare `vault sync` map to it via `sync.action(...)` which commander does support when arguments don't match a subcommand name.

- [ ] **Step 1: Write failing tests**

`tests/cli-sync.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), ...args], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('vault sync CLI', () => {
  it('setup writes the device sync block and sync round-trips between two vaults', () => {
    const vaultA = join(tmpDir(), 'a');
    const vaultB = join(tmpDir(), 'b');
    const remote = tmpDir();

    run(['init', vaultA]);
    run(['init', vaultB]);
    expect(run(['--vault', vaultA, 'sync', 'setup', '--path', remote, '--passphrase', 'p']).code).toBe(0);
    expect(readFileSync(join(vaultA, 'device.yaml'), 'utf8')).toContain('backend: dir');
    expect(run(['--vault', vaultB, 'sync', 'setup', '--path', remote, '--passphrase', 'p']).code).toBe(0);

    run(['--vault', vaultA, 'project', 'new', 'Demo']);
    const s1 = run(['--vault', vaultA, 'sync']);
    expect(s1.code).toBe(0);
    expect(s1.out).toMatch(/synced:/);
    const s2 = run(['--vault', vaultB, 'sync']);
    expect(s2.code).toBe(0);
    const list = run(['--vault', vaultB, 'project', 'list']);
    expect(list.out).toContain('Demo');
  });

  it('fails with guidance when sync is not configured', () => {
    const vault = join(tmpDir(), 'v');
    run(['init', vault]);
    const r = run(['--vault', vault, 'sync']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/vault sync setup/);
  });
});
```

- [ ] **Step 2: Run to verify fail** - `npx vitest run tests/cli-sync.test.ts`

- [ ] **Step 3: Implement per the sketch above; wire imports; keep every other command untouched**

- [ ] **Step 4: README**

Add a `## Sync` section to README.md: what it is (E2E encrypted, no git, any mounted folder as remote v1: iCloud Drive, NAS, USB), setup on two devices (same remote path + same passphrase), `vault sync` / `vault sync --watch`, conflict semantics (append-only records merge; state.md LWW + `.conflict-<device>.md` copy), what is never synced (device.yaml, .sync, .mine), and the documented limitations from Global Constraints. No em dashes.

- [ ] **Step 5: Run full suite + build, commit**

```bash
npx vitest run && npm run build
git add -A && git commit -m "Add vault sync command with setup, one-shot and watch modes"
```

---

## Post-Review Amendments

- Task 2 amended after review: manifest is ONE atomic file `manifest.json` (`{"version", "payload": base64}`) written via tmp+rename, so version and data cannot diverge on crash; object keys validated against `/^[0-9a-f]{64}$/`; `VersionConflictError.name` set. Interface signatures unchanged.

## Self-Review Notes

- Spec §6 sync line + §7 device rules covered: continuous small diffs (watch+debounce), no git, E2E, per-device exclusions, state conflict copies, append-only merge.
- Cloud/HTTP backend intentionally not in this phase: `Backend` interface is the plug point; DirBackend over a mounted cloud folder already gives real multi-device sync without any server.
- Types used consistently: `SyncKey`, `Backend`, `Manifest`/`ManifestEntry`, `SyncResult`, `DeviceSyncConfig`.
