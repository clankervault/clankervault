import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DirBackend, VersionConflictError } from '../sync/backend.js';
import { Replica } from './replica.js';
import { buildServer } from '../mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export interface VaultServerOptions {
  dataDir: string;
  token: string;
  passphrase?: string;
}

const BODY_LIMIT = 32 * 1024 * 1024;
const OBJECT_RE = /^\/v1\/sync\/objects\/([0-9a-f]{64})$/;
const MCP_SESSION_IDLE_MS = 30 * 60 * 1000;

interface McpSession {
  server: ReturnType<typeof buildServer>;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
}

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

/** wrong-passphrase decryption failures surface as a raw AES-GCM error (same signal
 *  the client side already recognizes in cli.ts's friendlySyncError) */
function isDecryptFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Unsupported state') || msg.includes('unable to authenticate');
}

/** drop sessions nobody has used in 30 minutes; swept lazily on each request
 *  instead of on a timer, so an idle server does no background work */
function sweepIdleMcpSessions(sessions: Map<string, McpSession>): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsed <= MCP_SESSION_IDLE_MS) continue;
    sessions.delete(id);
    session.transport.close().catch(() => {});
    session.server.close().catch(() => {});
  }
}

/**
 * Handle one /v1/mcp request: session routing (create on `initialize`, else look up
 * by the `mcp-session-id` header), then a fresh replica read before and an
 * unconditional push back to the ciphertext store after, so a write this request
 * made reaches the remote immediately rather than waiting out the freshness window.
 * Callers must run this serialized per server (see mcpQueue in createVaultServer):
 * this function alone does not guard against two of its own invocations racing.
 *
 * Any error other than a caught decrypt failure propagates to the caller, which MUST
 * turn it into a response itself (see the .catch() at the /v1/mcp call site) - this
 * function only ever resolves or rejects, it never lets an exception fall through
 * to Node with no response sent and no handler watching.
 */
async function handleMcpRequest(
  replica: Replica,
  sessions: Map<string, McpSession>,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  sweepIdleMcpSessions(sessions);
  // set once a NEW session gets registered by onsessioninitialized; if anything
  // later in this same request throws, that half-initialized session (registered,
  // but its own initialize response never finished) must not be left behind for a
  // later request bearing its session ID to stumble into
  let newSessionId: string | undefined;

  try {
    try {
      await replica.fresh();
    } catch (err) {
      if (isDecryptFailure(err)) {
        return sendJson(res, 500, { error: 'server cannot decrypt the store (check VAULT_PASSPHRASE on the server)' });
      }
      throw err;
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;

    let transport: StreamableHTTPServerTransport;
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.lastUsed = Date.now();
      transport = session.transport;
    } else if (!sessionId && isInitializeRequest(body)) {
      const server = buildServer(replica.dir);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => { newSessionId = id; sessions.set(id, { server, transport, lastUsed: Date.now() }); },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };
      await server.connect(transport);
    } else {
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
    }

    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (newSessionId) sessions.delete(newSessionId);
    throw err; // the call site's .catch() is what actually produces a response
  }

  // the response is already sent by this point, so a push failure here (decrypt or
  // otherwise) can only be logged, never reported back to this client
  try {
    await replica.push();
  } catch (err) {
    console.error(
      isDecryptFailure(err)
        ? 'clankervault server error: mcp write-back failed to decrypt (check VAULT_PASSPHRASE)'
        : `clankervault server error (mcp write-back): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function createVaultServer(opts: VaultServerOptions): Server {
  const store = new DirBackend(join(opts.dataDir, 'store'));
  const replica = opts.passphrase ? new Replica(opts.dataDir, opts.passphrase) : null;
  const mcpSessions = new Map<string, McpSession>();
  // every /v1/mcp request is chained onto this promise, so a concurrent write can
  // never interleave with another request's replica sync (defense in depth alongside
  // Replica's own in-flight guard, which protects even against callers outside this queue)
  let mcpQueue: Promise<void> = Promise.resolve();
  const expected = Buffer.from(opts.token);

  const authed = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const got = Buffer.from(header.slice(7));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const server = createServer(async (req, res) => {
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

      if (path === '/v1/mcp' && req.method === 'POST') {
        if (!opts.passphrase) {
          return sendJson(res, 503, { error: 'Remote MCP needs VAULT_PASSPHRASE on the server. Without it this server is a pure encrypted sync store.' });
        }
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const task = mcpQueue.then(() => handleMcpRequest(replica!, mcpSessions, req, res, body));
        mcpQueue = task.then(() => undefined, () => undefined);
        // a bare `return task` would hand the outer async handler's own completion
        // promise straight to the mcp queue, and Node never awaits or catches a
        // request listener's return value - an mcp failure other than the
        // already-handled decrypt case would become an unhandled rejection and
        // could take the whole process down. Catching right here, on the exact
        // promise being returned, is what actually keeps this response (and the
        // process) alive.
        return task.catch((err) => {
          console.error('clankervault server error:', err);
          if (res.headersSent) return;
          sendJson(res, 500, isDecryptFailure(err)
            ? { error: 'server cannot decrypt the store (check VAULT_PASSPHRASE on the server)' }
            : { error: 'internal error' });
        });
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof BodyTooLargeError) return sendJson(res, 413, { error: 'body too large' });
      // never put filesystem paths, stack traces, or other internal detail in the response body -
      // the real error (which may embed on-disk paths from fs failures) is for the server log only
      console.error('clankervault server error:', err);
      sendJson(res, 500, { error: 'internal error' });
    }
    });
  // serialized MCP queue processing can hold a client's keep-alive socket idle for
  // longer than node's 5s default; closing it mid-POST surfaces as ECONNRESET on
  // slow machines, and POSTs are never retried. Keep sockets alive well past that.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  return server;
}
