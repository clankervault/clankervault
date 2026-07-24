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
