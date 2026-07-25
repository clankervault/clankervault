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

/** client side of the clankervault server's /v1/sync API; ciphertext in, ciphertext out */
export class HttpBackend implements Backend {
  private base: string;
  constructor(url: string, private token: string) {
    this.base = url.replace(/\/+$/, '');
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      throw new Error(`sync server unreachable at ${this.base} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.status === 401) throw new Error('sync server rejected the token (check --token / VAULT_SERVER_TOKEN)');
    return res;
  }

  async ensure(): Promise<void> {
    const res = await this.request('/v1/health');
    if (!res.ok) throw new Error(`sync server error: health check returned ${res.status}`);
  }

  async getSalt(): Promise<Buffer> {
    const res = await this.request('/v1/sync/salt');
    if (!res.ok) throw new Error(`sync server error: salt returned ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async getManifest(): Promise<{ data: Buffer; version: string } | null> {
    const res = await this.request('/v1/sync/manifest');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`sync server error: manifest returned ${res.status}`);
    const { version, payload } = await res.json() as { version: string; payload: string };
    return { version, data: Buffer.from(payload, 'base64') };
  }

  async putManifest(data: Buffer, expectedVersion: string | null): Promise<string> {
    const headers: Record<string, string> = {};
    if (expectedVersion !== null) headers['if-match'] = expectedVersion;
    const res = await this.request('/v1/sync/manifest', { method: 'PUT', body: new Uint8Array(data), headers });
    if (res.status === 412) throw new VersionConflictError();
    if (!res.ok) throw new Error(`sync server error: manifest write returned ${res.status}`);
    return (await res.json() as { version: string }).version;
  }

  async getObject(key: string): Promise<Buffer> {
    const res = await this.request(`/v1/sync/objects/${key}`);
    if (!res.ok) throw new Error(`sync server error: object ${key.slice(0, 8)} returned ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async putObject(key: string, data: Buffer): Promise<void> {
    const res = await this.request(`/v1/sync/objects/${key}`, { method: 'PUT', body: new Uint8Array(data) });
    if (!res.ok && res.status !== 204) throw new Error(`sync server error: object write returned ${res.status}`);
  }

  async deleteObject(key: string): Promise<void> {
    const res = await this.request(`/v1/sync/objects/${key}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`sync server error: object delete returned ${res.status}`);
  }
}
