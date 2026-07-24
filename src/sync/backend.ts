import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class VersionConflictError extends Error {
  constructor() {
    super('sync: remote manifest changed underneath us');
    this.name = 'VersionConflictError';
  }
}

const OBJECT_KEY_RE = /^[0-9a-f]{64}$/;

function checkObjectKey(key: string): void {
  if (!OBJECT_KEY_RE.test(key)) throw new Error('backend: invalid object key');
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
    const f = this.p('manifest.json');
    if (!existsSync(f)) return null;
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as { version: string; payload: string };
    return { data: Buffer.from(parsed.payload, 'base64'), version: parsed.version };
  }

  async putManifest(data: Buffer, expectedVersion: string | null): Promise<string> {
    const f = this.p('manifest.json');
    const current = existsSync(f)
      ? (JSON.parse(readFileSync(f, 'utf8')) as { version: string }).version
      : null;
    if (current !== expectedVersion) throw new VersionConflictError();
    const next = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const tmp = this.p('manifest.json.tmp');
    writeFileSync(tmp, JSON.stringify({ version: next, payload: data.toString('base64') }));
    renameSync(tmp, f);
    return next;
  }

  async getObject(key: string): Promise<Buffer> {
    checkObjectKey(key);
    return readFileSync(this.p('objects', key));
  }

  async putObject(key: string, data: Buffer): Promise<void> {
    checkObjectKey(key);
    const tmp = this.p('objects', `${key}.tmp`);
    writeFileSync(tmp, data);
    renameSync(tmp, this.p('objects', key));
  }

  async deleteObject(key: string): Promise<void> {
    checkObjectKey(key);
    rmSync(this.p('objects', key), { force: true });
  }
}
