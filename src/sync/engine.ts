import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Backend } from './backend.js';
import { VersionConflictError } from './backend.js';
import { deriveKey, decrypt, encrypt, objectKey } from './crypto.js';
import type { SyncKey } from './crypto.js';
import { decodeManifest, emptyManifest, encodeManifest } from './manifest.js';
import type { Manifest } from './manifest.js';

const EXCLUDED_SEGMENTS = new Set(['device.yaml', '.sync', '.mine', '.log', '.DS_Store']);

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

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  conflicts: string[];
}

/**
 * projects/x/state.md + mini + 20260724142530123 -> projects/x/state.conflict-mini-20260724142530123.md
 * the stamp (including milliseconds) disambiguates repeated conflicts on the same
 * path/device pair so conflict copies never overwrite each other.
 */
export function conflictPath(relpath: string, device: string, stamp: string): string {
  const dot = relpath.lastIndexOf('.');
  const slash = relpath.lastIndexOf('/');
  if (dot > slash) return `${relpath.slice(0, dot)}.conflict-${device}-${stamp}${relpath.slice(dot)}`;
  return `${relpath}.conflict-${device}-${stamp}`;
}

const MAX_ATTEMPTS = 3;

/**
 * Three-way merge per vault-relative path: local hash L, remote manifest hash R
 * (undefined if tombstoned/absent), last-synced hash S. See task-4-brief.md for the
 * full merge rules table. Retries the whole cycle on a concurrent manifest write
 * (CAS version conflict), re-pulling a fresh manifest each attempt.
 *
 * `precomputedKey`, when given, skips both `deriveKey` and the `getSalt` round trip
 * that feeds it (scrypt is deliberately expensive, so a caller that already derived
 * the key for this exact passphrase/salt pair - e.g. the server's Replica, which
 * would otherwise pay that cost on every single mcp request - can reuse it here).
 * `backend.ensure()` always still runs regardless.
 */
export async function syncOnce(
  vaultDir: string, backend: Backend, passphrase: string, deviceName: string,
  precomputedKey?: SyncKey,
): Promise<SyncResult> {
  await backend.ensure();
  const key = precomputedKey ?? deriveKey(passphrase, await backend.getSalt());

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
      // clear content-identifying fields; all readers must still guard on `deleted`, not on hash/size
      manifest.files[rel] = { ...entry, hash: '', size: 0, deleted: true, mtimeMs: Date.now(), modifiedBy: deviceName };
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
      if (lastHash === undefined) {
        // first contact: this device never synced this path; the shared remote is the established truth and a fresh init template must not overwrite it
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
        const copy = conflictPath(rel, deviceName, stamp);
        writeLocal(copy, readLocal(rel));
        await upload(copy);
        await download(rel);
        result.conflicts.push(rel);
        continue;
      }
      if (localHash === undefined) { await download(rel); continue; }   // edit beats delete
      if (remoteHash === undefined) { await upload(rel); continue; }
      // true conflict: last write wins, loser preserved as a timestamped conflict copy;
      // an exact mtime tie deliberately favors local (deterministic, no coin flip)
      const localWins = local[rel].mtimeMs >= entry.mtimeMs;
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
      if (localWins) {
        const remoteContent = decrypt(key, await backend.getObject(objectKey(key, rel)));
        const copy = conflictPath(rel, entry.modifiedBy, stamp);
        writeLocal(copy, remoteContent);
        await upload(copy);
        await upload(rel);
      } else {
        const copy = conflictPath(rel, deviceName, stamp);
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
