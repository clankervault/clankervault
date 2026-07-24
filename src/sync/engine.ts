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
