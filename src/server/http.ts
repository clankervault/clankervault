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

class BodyTooLargeError extends Error {
  constructor() {
    super('body too large');
    this.name = 'BodyTooLargeError';
  }
}

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

/** true when the client's declared Content-Length alone already exceeds the limit,
 *  so we can reject before reading a single byte of a body we know is oversized */
function contentLengthTooLarge(req: IncomingMessage): boolean {
  const header = req.headers['content-length'];
  if (typeof header !== 'string') return false;
  const n = Number(header);
  return Number.isFinite(n) && n > BODY_LIMIT;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > BODY_LIMIT) {
        failed = true;
        // do not destroy the socket (that resets the connection and the client
        // never sees our response) - stop accumulating and drain the rest instead,
        // so the connection stays healthy enough to deliver the 413 body
        req.removeAllListeners('data');
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!failed) reject(err); });
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
          if (Array.isArray(ifMatch)) return sendJson(res, 400, { error: 'invalid if-match' });
          if (contentLengthTooLarge(req)) return sendJson(res, 413, { error: 'body too large' });
          const body = await readBody(req);
          try {
            const version = await store.putManifest(body, typeof ifMatch === 'string' ? ifMatch : null);
            return sendJson(res, 200, { version });
          } catch (err) {
            if (err instanceof VersionConflictError) return sendJson(res, 412, { error: 'manifest version conflict' });
            throw err;
          }
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      const object = path.match(OBJECT_RE);
      if (object) {
        const key = object[1];
        if (req.method === 'GET') {
          try { return sendBytes(res, await store.getObject(key)); }
          catch { return sendJson(res, 404, { error: 'object not found' }); }
        }
        if (req.method === 'PUT') {
          if (contentLengthTooLarge(req)) return sendJson(res, 413, { error: 'body too large' });
          await store.putObject(key, await readBody(req));
          res.writeHead(204);
          return res.end();
        }
        if (req.method === 'DELETE') { await store.deleteObject(key); res.writeHead(204); return res.end(); }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof BodyTooLargeError) return sendJson(res, 413, { error: 'body too large' });
      // never put filesystem paths, stack traces, or other internal detail in the response body -
      // the real error (which may embed on-disk paths from fs failures) is for the server log only
      console.error('vault server error:', err);
      sendJson(res, 500, { error: 'internal error' });
    }
  });
}
