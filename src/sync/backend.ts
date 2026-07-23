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
