# Vault Phase 5 (Self-Hostable Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `vault serve`: one self-hostable server that is (a) an HTTP sync remote (stores only ciphertext, bearer-token auth) and (b) a remote MCP endpoint for chat assistants (Streamable HTTP), plus the client side: `HttpBackend` and `vault sync setup --url --token`. This is the code half of the paid tier (spec §9); deploy + billing stay manual.

**Architecture:** The server wraps the existing `DirBackend` behind a tiny `node:http` API (CAS and atomicity stay single-sourced). The MCP endpoint reuses `buildServer()` over a server-side decrypted replica that the server refreshes by running the SAME client `syncOnce` against its own store; the replica exists only when `VAULT_PASSPHRASE` is provided (documented E2E tradeoff for self-host). The client gets `HttpBackend implements Backend`, so the whole sync engine works over HTTP unchanged.

**Tech Stack:** node:http + global fetch (Node 22), existing @modelcontextprotocol/sdk (StreamableHTTPServerTransport). No new dependencies. Dockerfile for Coolify-style deploys.

## Global Constraints

- The sync store holds ONLY ciphertext + salt; the server never receives the passphrase through the sync API. The decrypted replica exists only under `<data>/replica` (mode 0700) and only when `VAULT_PASSPHRASE` is set; without it, `/v1/mcp` returns 503 with a one-line explanation.
- Auth: `Authorization: Bearer <token>` on every `/v1/*` route except none; 401 JSON on failure; token comparison timing-safe. Token sources in order: `--token` flag, `VAULT_SERVER_TOKEN` env, `<data>/token` file (generated 32-hex on first run, printed once, mode 0600).
- HTTP API (normative): `GET /v1/health` -> `{ok:true}`; `GET /v1/sync/salt` -> octet-stream; `GET /v1/sync/manifest` -> `{version, payload(b64)}` | 404; `PUT /v1/sync/manifest` with `If-Match: <version>` header (absent = expect none) -> `{version}` | 412 on CAS conflict; `GET|PUT|DELETE /v1/sync/objects/<64-hex>` -> octet-stream | 204; invalid key -> 404. Body limit 32 MB.
- Client `HttpBackend` maps 412 to `VersionConflictError`, 401 to a clean "token rejected" error; `ensure()` performs the health check so failures surface before any merge work.
- `DeviceSyncConfig` becomes a union: `{ backend: 'dir'; path; passphrase? }` | `{ backend: 'http'; url; token; passphrase? }`. `vault sync setup` accepts either `--path` or `--url <u> --token <t>` (mutually exclusive, validated).
- **First-contact rule (engine amendment, fixes a real phase-2 gap):** when a path has NO last-synced hash on this device and both local and remote exist with different content, the REMOTE wins regardless of mtime and the local content is saved as a conflict copy. Rationale: a fresh device's local file is almost always the init template; mtime-LWW would let the template overwrite the user's established remote content. Nothing is ever lost (conflict copy).
- MCP over HTTP reuses `buildServer(replicaDir)` per request with a stateless StreamableHTTPServerTransport (JSON responses). If the installed SDK's stateless API differs from the sketch, adapt the wiring; the raw-protocol tests are the source of truth.
- Replica freshness: refresh via `syncOnce(replica, storeBackend, passphrase, 'server')` when older than 15 s (per-process timestamp); first refresh creates the replica via `initVault` then pulls.
- NO em/en dashes anywhere. Commit messages: technical, never reference AI/Claude/assistant, no co-author trailers. README factual.

---

## File Structure

```
src/server/http.ts      # createVaultServer(opts): node:http server (auth + sync routes + /v1/mcp mount)
src/server/replica.ts   # Replica: lazy decrypted working copy for MCP
src/cli.ts              # + `vault serve`, sync setup --url/--token, backend selection by config
src/sync/backend.ts     # + HttpBackend
src/sync/engine.ts      # first-contact rule in the both-changed branch
src/types.ts            # DeviceSyncConfig union
Dockerfile
tests/server-sync.test.ts   # raw-fetch API contract tests
tests/server-e2e.test.ts    # two devices over a real spawned server + first-contact + MCP-over-HTTP
```

---

### Task 1: Server sync API (`createVaultServer`) + raw contract tests

**Files:**
- Create: `src/server/http.ts`, `tests/server-sync.test.ts`
- Modify: `src/cli.ts` (add a minimal `serve` command: sync API only; MCP mount lands in Task 3)

**Interfaces:**
- Produces:
  - `interface VaultServerOptions { dataDir: string; token: string; passphrase?: string; }`
  - `createVaultServer(opts: VaultServerOptions): import('node:http').Server` (does not listen; caller listens)
  - `resolveServerToken(dataDir: string, flag?: string): { token: string; generated: boolean }` (flag > `VAULT_SERVER_TOKEN` env > `<data>/token` file, generating 32-hex with mode 0600 when absent)
  - CLI: `vault serve --data <dir> [--port <n>=8484] [--token <t>]`; prints port, whether MCP is enabled (it is not until Task 3: print "MCP: coming from VAULT_PASSPHRASE" only in Task 3), and the token ONLY when freshly generated.

- [ ] **Step 1: Write failing tests**

`tests/server-sync.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createVaultServer } from '../src/server/http.js';
import { tmpDir } from './helpers.js';

let server: Server;
let base: string;
const TOKEN = 'a'.repeat(32);

function req(path: string, init: RequestInit = {}, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(base + path, { ...init, headers });
}

beforeAll(async () => {
  server = createVaultServer({ dataDir: tmpDir(), token: TOKEN });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('auth', () => {
  it('rejects missing and wrong tokens with 401', async () => {
    expect((await req('/v1/health', {}, null)).status).toBe(401);
    expect((await req('/v1/health', {}, 'b'.repeat(32))).status).toBe(401);
    expect((await req('/v1/health')).status).toBe(200);
  });
});

describe('sync API contract', () => {
  it('serves a stable salt', async () => {
    const s1 = Buffer.from(await (await req('/v1/sync/salt')).arrayBuffer());
    const s2 = Buffer.from(await (await req('/v1/sync/salt')).arrayBuffer());
    expect(s1.length).toBe(16);
    expect(s1.equals(s2)).toBe(true);
  });

  it('manifest CAS over HTTP: If-Match mismatch is 412', async () => {
    expect((await req('/v1/sync/manifest')).status).toBe(404);
    const p1 = await req('/v1/sync/manifest', { method: 'PUT', body: Buffer.from('m1') });
    expect(p1.status).toBe(200);
    const { version: v1 } = await p1.json();
    const got = await (await req('/v1/sync/manifest')).json();
    expect(Buffer.from(got.payload, 'base64').toString()).toBe('m1');
    expect(got.version).toBe(v1);
    const p2 = await req('/v1/sync/manifest', { method: 'PUT', body: Buffer.from('m2'), headers: { 'if-match': v1 } });
    expect(p2.status).toBe(200);
    const stale = await req('/v1/sync/manifest', { method: 'PUT', body: Buffer.from('m3'), headers: { 'if-match': v1 } });
    expect(stale.status).toBe(412);
    const again = await req('/v1/sync/manifest', { method: 'PUT', body: Buffer.from('m3') });   // expect-none but one exists
    expect(again.status).toBe(412);
  });

  it('objects round-trip and invalid keys are 404', async () => {
    const key = 'c'.repeat(64);
    expect((await req(`/v1/sync/objects/${key}`, { method: 'PUT', body: Buffer.from('blob') })).status).toBe(204);
    const got = await req(`/v1/sync/objects/${key}`);
    expect(Buffer.from(await got.arrayBuffer()).toString()).toBe('blob');
    expect((await req(`/v1/sync/objects/${key}`, { method: 'DELETE' })).status).toBe(204);
    expect((await req(`/v1/sync/objects/${key}`)).status).toBe(404);
    expect((await req('/v1/sync/objects/../evil', { method: 'PUT', body: Buffer.from('x') })).status).toBe(404);
    expect((await req('/v1/sync/objects/shortkey')).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify fail** - `npx vitest run tests/server-sync.test.ts`

- [ ] **Step 3: Implement**

`src/server/http.ts`:
```ts
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DirBackend, VersionConflictError } from '../sync/backend.js';

export interface VaultServerOptions {
  dataDir: string;
  token: string;
  passphrase?: string;
}

const BODY_LIMIT = 32 * 1024 * 1024;
const OBJECT_RE = /^\/v1\/sync\/objects\/([0-9a-f]{64})$/;

export function resolveServerToken(dataDir: string, flag?: string): { token: string; generated: boolean } {
  if (flag) return { token: flag, generated: false };
  if (process.env.VAULT_SERVER_TOKEN) return { token: process.env.VAULT_SERVER_TOKEN, generated: false };
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'token');
  if (existsSync(file)) return { token: readFileSync(file, 'utf8').trim(), generated: false };
  const token = randomBytes(16).toString('hex');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  return { token, generated: true };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

function sendBytes(res: ServerResponse, data: Buffer): void {
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.end(data);
}

export function createVaultServer(opts: VaultServerOptions): Server {
  const store = new DirBackend(join(opts.dataDir, 'store'));
  const expected = Buffer.from(opts.token);

  const authed = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const got = Buffer.from(header.slice(7));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!path.startsWith('/v1/')) return sendJson(res, 404, { error: 'not found' });
      if (!authed(req)) return sendJson(res, 401, { error: 'unauthorized' });
      await store.ensure();

      if (path === '/v1/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });

      if (path === '/v1/sync/salt' && req.method === 'GET') return sendBytes(res, await store.getSalt());

      if (path === '/v1/sync/manifest') {
        if (req.method === 'GET') {
          const m = await store.getManifest();
          if (!m) return sendJson(res, 404, { error: 'no manifest yet' });
          return sendJson(res, 200, { version: m.version, payload: m.data.toString('base64') });
        }
        if (req.method === 'PUT') {
          const ifMatch = req.headers['if-match'];
          const body = await readBody(req);
          try {
            const version = await store.putManifest(body, typeof ifMatch === 'string' ? ifMatch : null);
            return sendJson(res, 200, { version });
          } catch (err) {
            if (err instanceof VersionConflictError) return sendJson(res, 412, { error: 'manifest version conflict' });
            throw err;
          }
        }
      }

      const object = path.match(OBJECT_RE);
      if (object) {
        const key = object[1];
        if (req.method === 'GET') {
          try { return sendBytes(res, await store.getObject(key)); }
          catch { return sendJson(res, 404, { error: 'object not found' }); }
        }
        if (req.method === 'PUT') { await store.putObject(key, await readBody(req)); res.writeHead(204); return res.end(); }
        if (req.method === 'DELETE') { await store.deleteObject(key); res.writeHead(204); return res.end(); }
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
```

CLI `serve` (Task 1 version; Task 3 extends it with MCP status):
```ts
program
  .command('serve')
  .requiredOption('--data <dir>', 'server data directory (ciphertext store, token, replica)')
  .option('--port <n>', 'port to listen on', '8484')
  .option('--token <t>', 'bearer token (default: VAULT_SERVER_TOKEN env or <data>/token file)')
  .description('run the self-hostable vault server (encrypted sync remote + remote MCP)')
  .action((opts: { data: string; port: string; token?: string }) => {
    try {
      const port = Number(opts.port);
      if (!Number.isFinite(port) || port <= 0) { console.error(`Invalid --port "${opts.port}"`); process.exit(1); }
      const { token, generated } = resolveServerToken(resolve(opts.data), opts.token);
      if (generated) console.log(`Generated token (share with your devices, shown once): ${token}`);
      const server = createVaultServer({ dataDir: resolve(opts.data), token, passphrase: process.env.VAULT_PASSPHRASE });
      server.listen(port, () => console.log(`vault server listening on :${port} (sync API ready)`));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
```

- [ ] **Step 4: Run tests, FULL suite, tsc** - `npx vitest run tests/server-sync.test.ts && npx vitest run && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add self-hostable server with authenticated encrypted sync API"
```

---

### Task 2: HttpBackend + CLI http sync config + first-contact rule

**Files:**
- Modify: `src/sync/backend.ts` (append `HttpBackend`), `src/types.ts` (DeviceSyncConfig union), `src/cli.ts` (`sync setup --url/--token`, backend selection), `src/sync/engine.ts` (first-contact rule)
- Test: `tests/server-e2e.test.ts` (spawned real server; MCP part comes in Task 3), plus engine test appended to `tests/sync-engine.test.ts`

**Interfaces:**
- Produces:
  - `class HttpBackend implements Backend { constructor(url: string, token: string) }` (trailing slashes normalized; 401 anywhere -> `Error('sync server rejected the token (check --token / VAULT_SERVER_TOKEN)')`; `putManifest` maps 412 -> `VersionConflictError`; `ensure()` = health check with clean unreachable error)
  - `src/types.ts`: `type DeviceSyncConfig = { backend: 'dir'; path: string; passphrase?: string } | { backend: 'http'; url: string; token: string; passphrase?: string }`
  - CLI `sync setup`: `--path` OR (`--url` AND `--token`), mutually exclusive with clean errors; the merge-preserve-passphrase behavior stays. The sync action picks `DirBackend` or `HttpBackend` from the config.
  - Engine: in the both-changed branch, BEFORE the mtime comparison: `if (lastHash === undefined) { remote wins: save local content to conflictPath(rel, deviceName, stamp), upload that copy, download remote; count as conflict; continue; }` with the comment: `// first contact: this device never synced this path; the shared remote is the established truth and a fresh init template must not overwrite it`

- [ ] **Step 1: Write failing tests**

Append to `tests/sync-engine.test.ts`:
```ts
describe('first contact', () => {
  it('a fresh device must not overwrite established remote content with its init template', async () => {
    const remote = tmpDir();
    const A = newDevice('macbook');
    const backend = () => new DirBackend(remote);
    writeFileSync(join(A, 'me', 'profile.md'), '# Profile\n\nJsem Tadeas, strihac a dev.\n');
    await syncOnce(A, backend(), 'pass', 'macbook');

    const B = newDevice('mini');            // fresh init: template profile.md, NEWER mtime than A's
    await syncOnce(B, backend(), 'pass', 'mini');
    expect(rf(join(B, 'me', 'profile.md'), 'utf8')).toContain('Jsem Tadeas');       // remote won
    const copies = readdirSync(join(B, 'me')).filter((f) => f.startsWith('profile.conflict-mini'));
    expect(copies).toHaveLength(1);                                                  // template preserved

    await syncOnce(A, backend(), 'pass', 'macbook');
    expect(rf(join(A, 'me', 'profile.md'), 'utf8')).toContain('Jsem Tadeas');       // A untouched
  });
});
```

`tests/server-e2e.test.ts` (Task 2 half):
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';

let proc: ChildProcess;
let base: string;
const TOKEN = 't'.repeat(32);

function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), ...args], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

beforeAll(async () => {
  const data = tmpDir();
  proc = spawn('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), 'serve', '--data', data, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VAULT_SERVER_TOKEN: TOKEN },
  });
  base = await new Promise<string>((resolve, reject) => {
    let buf = '';
    proc.stdout!.on('data', (c: Buffer) => {
      buf += c.toString();
      const m = buf.match(/listening on :(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    setTimeout(() => reject(new Error(`server did not start: ${buf}`)), 30000);
  });
}, 60000);
afterAll(() => { proc?.kill(); });

describe('two devices through the HTTP server', () => {
  it('sync setup --url + full round trip', () => {
    const vaultA = join(tmpDir(), 'a');
    const vaultB = join(tmpDir(), 'b');
    cli(['init', vaultA]);
    cli(['init', vaultB]);
    expect(cli(['--vault', vaultA, 'sync', 'setup', '--url', base, '--token', TOKEN, '--passphrase', 'p']).code).toBe(0);
    expect(cli(['--vault', vaultB, 'sync', 'setup', '--url', base, '--token', TOKEN, '--passphrase', 'p']).code).toBe(0);
    cli(['--vault', vaultA, 'project', 'new', 'Demo']);
    cli(['--vault', vaultA, 'add', 'fact', 'Server round trip', '-p', 'demo']);
    expect(cli(['--vault', vaultA, 'sync']).out).toMatch(/synced:/);
    expect(cli(['--vault', vaultB, 'sync']).code).toBe(0);
    expect(cli(['--vault', vaultB, 'list', '-p', 'demo']).out).toContain('Server round trip');
  });

  it('a wrong token fails cleanly, no stack trace', () => {
    const vault = join(tmpDir(), 'v');
    cli(['init', vault]);
    cli(['--vault', vault, 'sync', 'setup', '--url', base, '--token', 'wrong'.padEnd(32, 'x'), '--passphrase', 'p']);
    const r = cli(['--vault', vault, 'sync']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/token/i);
    expect(r.out).not.toMatch(/^\s+at /m);
  });

  it('rejects mixing --path and --url in setup', () => {
    const vault = join(tmpDir(), 'v2');
    cli(['init', vault]);
    const r = cli(['--vault', vault, 'sync', 'setup', '--path', tmpDir(), '--url', base, '--token', TOKEN]);
    expect(r.code).toBe(1);
  });
});
```
Note for the implementer: `serve --port 0` must print the REAL bound port (use `server.address()` in the listen callback, not the flag value).

- [ ] **Step 2: Run to verify fail, implement**

`HttpBackend` (append to `src/sync/backend.ts`):
```ts
/** client side of the vault server's /v1/sync API; ciphertext in, ciphertext out */
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
```

CLI: `sync setup` gains `--url <u>` and `--token <t>`; validation: exactly one of `--path` / `--url` (with `--url` requiring `--token`); writes the matching union variant (merge-preserving passphrase as today). The sync/watch action builds the backend:
```ts
const backend = device.sync.backend === 'http'
  ? new HttpBackend(device.sync.url, device.sync.token)
  : new DirBackend(device.sync.path);
```
TypeScript narrows the union by the `backend` discriminant; adjust the setup action to build the object per variant.

Engine first-contact rule: insert at the TOP of the both-changed branch (before the `localHash === remoteHash` check keep order: converged check first, THEN first-contact, then delete-vs-edit rules, then mtime LWW).

- [ ] **Step 3: Run tests, FULL suite, tsc** - `npx vitest run tests/sync-engine.test.ts tests/server-e2e.test.ts && npx vitest run && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Add HTTP sync backend with first-contact protection for fresh devices"
```

---

### Task 3: Remote MCP endpoint + replica + Dockerfile + docs

**Files:**
- Create: `src/server/replica.ts`, `Dockerfile`
- Modify: `src/server/http.ts` (mount `/v1/mcp`), `src/cli.ts` (serve prints MCP status), `README.md` (Self-hosting section)
- Test: `tests/server-e2e.test.ts` (append MCP-over-HTTP tests)

**Interfaces:**
- Produces:
  - `class Replica { constructor(dataDir: string, passphrase: string); dir: string; fresh(maxAgeMs?: number): Promise<void> }` - `dir` = `<data>/replica`; `fresh()` no-ops within 15 s of the last refresh; otherwise `initVault(dir)` if missing (then `chmodSync(dir, 0o700)`), and `syncOnce(dir, new DirBackend(join(dataDir,'store')), passphrase, 'server')`.
  - `/v1/mcp` route in `createVaultServer`: bearer-auth like everything else; when `opts.passphrase` is absent -> 503 `{ error: 'Remote MCP needs VAULT_PASSPHRASE on the server. Without it this server is a pure encrypted sync store.' }`; otherwise `await replica.fresh()` then serve MCP via a per-request `buildServer(replica.dir)` + stateless `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), passing the parsed JSON body to `transport.handleRequest(req, res, body)`. Adapt to the installed SDK if the stateless API differs; the tests below are normative.
  - `vault serve` startup line gains MCP status: `MCP endpoint: enabled at /v1/mcp` or `MCP endpoint: disabled (set VAULT_PASSPHRASE to enable)`.
  - `Dockerfile` (normative content):
    ```dockerfile
    FROM node:22-alpine
    WORKDIR /app
    COPY package.json package-lock.json ./
    RUN npm ci
    COPY tsconfig.json ./
    COPY src ./src
    RUN npm run build && npm prune --omit=dev
    ENV NODE_ENV=production
    VOLUME /data
    EXPOSE 8484
    CMD ["node", "dist/cli.js", "serve", "--data", "/data", "--port", "8484"]
    ```

- [ ] **Step 1: Write failing tests (append to tests/server-e2e.test.ts)**

```ts
async function mcp(base: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/v1/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text.replace(/^data: /m, '').trim().split('\n').pop()!); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

describe('remote MCP endpoint', () => {
  it('answers initialize and serves synced context from the decrypted replica', async () => {
    // NOTE: this describe block spawns its OWN server with VAULT_PASSPHRASE (see beforeAll below)
    const init = await mcp(mcpBase, TOKEN, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'remote-test', version: '1.0.0' } },
    });
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe('vault');

    const call = await mcp(mcpBase, TOKEN, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_context', arguments: { project: 'demo' } },
    });
    expect(call.status).toBe(200);
    expect(call.json.result.content[0].text).toContain('Server round trip');
  });

  it('refuses without a token', async () => {
    const res = await fetch(`${mcpBase}/v1/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('returns 503 when the server has no passphrase', async () => {
    const r = await mcp(base, TOKEN, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    expect(r.status).toBe(503);
  });
});
```
Test scaffolding for this block: a second spawned server (`mcpBase`) sharing the SAME data dir as the Task 2 server would race its CAS; instead spawn it with its own data dir, run one client vault through `sync setup --url` + `add` + `sync` against it in the block's `beforeAll` (creating the 'demo' project and the 'Server round trip' record there), with env `VAULT_PASSPHRASE: 'p'` on the spawned process and the same passphrase in the client's setup. The 503 test reuses the Task 2 server (`base`), which was spawned WITHOUT a passphrase.

- [ ] **Step 2: Implement replica + mount + Dockerfile until green**

`src/server/replica.ts`:
```ts
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { initVault, isVault } from '../vault.js';
import { DirBackend } from '../sync/backend.js';
import { syncOnce } from '../sync/engine.js';

/**
 * Server-side decrypted working copy for the remote MCP endpoint.
 * Exists only when the operator provides VAULT_PASSPHRASE: the documented
 * self-host tradeoff (your box, your trust domain). Never synced itself,
 * refreshed lazily from the ciphertext store.
 */
export class Replica {
  readonly dir: string;
  private lastSync = 0;

  constructor(private dataDir: string, private passphrase: string) {
    this.dir = join(dataDir, 'replica');
  }

  async fresh(maxAgeMs = 15000): Promise<void> {
    if (Date.now() - this.lastSync < maxAgeMs) return;
    if (!isVault(this.dir)) {
      initVault(this.dir);
      chmodSync(this.dir, 0o700);
    }
    await syncOnce(this.dir, new DirBackend(join(this.dataDir, 'store')), this.passphrase, 'server');
    this.lastSync = Date.now();
  }
}
```

Mount in `createVaultServer` (before the 404 fallthrough):
```ts
if (path === '/v1/mcp' && req.method === 'POST') {
  if (!opts.passphrase) {
    return sendJson(res, 503, { error: 'Remote MCP needs VAULT_PASSPHRASE on the server. Without it this server is a pure encrypted sync store.' });
  }
  await replica!.fresh();
  const body = JSON.parse((await readBody(req)).toString('utf8'));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const mcpServer = buildServer(replica!.dir);
  await mcpServer.connect(transport);
  return transport.handleRequest(req, res, body);
}
```
with `const replica = opts.passphrase ? new Replica(opts.dataDir, opts.passphrase) : null;` at server construction. Import `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js` and `buildServer` from `../mcp.js`. If the installed SDK requires a different stateless invocation, adapt; the tests are normative.

- [ ] **Step 3: README + serve status line**

README `## Self-hosting` section: what `vault serve` gives you (encrypted sync remote + remote MCP for chat assistants), the token model, the E2E tradeoff paragraph (sync-only mode keeps zero-knowledge; setting VAULT_PASSPHRASE enables MCP by letting YOUR server decrypt), client setup (`vault sync setup --url https://... --token ...`), Docker deploy (build + run with a /data volume, VAULT_SERVER_TOKEN and optional VAULT_PASSPHRASE env), and a note that hosted multi-tenant service with billing is the future paid tier. Factual, no em dashes.

- [ ] **Step 4: FULL suite + build, commit**

```bash
npx vitest run && npm run build
git add -A && git commit -m "Add remote MCP endpoint with server-side replica and Docker deploy"
```

---

## Self-Review Notes

- Spec §9 paid-tier code half: hosted sync (HTTP backend + server) and hosted MCP endpoint delivered self-hostable; billing/multi-tenant/hosting remain the operator's manual steps by design.
- Spec §8.1 preserved: the sync path stays zero-knowledge; MCP-over-HTTP requires an explicit operator opt-in (VAULT_PASSPHRASE) and the tradeoff is printed and documented, never silent.
- First-contact rule fixes a real phase-2 onboarding gap (fresh device template vs established remote) and is regression-tested at the engine level.
- CAS/atomicity single-sourced: the server reuses DirBackend verbatim; HttpBackend is a thin protocol mapping, so all 12 existing engine scenarios apply unchanged over HTTP via the e2e round trip.
