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
