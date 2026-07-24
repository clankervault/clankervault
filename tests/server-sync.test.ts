import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createVaultServer } from '../src/server/http.js';
import { tmpDir } from './helpers.js';

let server: Server;
let base: string;
let port: number;
let dataDir: string;
const TOKEN = 'a'.repeat(32);

function req(path: string, init: RequestInit = {}, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(base + path, { ...init, headers });
}

/** raw node:http request, bypassing undici's fetch (which refuses to send a body whose
 *  length disagrees with a caller-set Content-Length header) - needed to simulate a client
 *  that *declares* an oversized Content-Length without actually sending that many bytes */
function rawPut(path: string, contentLength: number, body: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-length': String(contentLength) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    r.on('error', reject);
    r.end(body);
  });
}

beforeAll(async () => {
  dataDir = tmpDir();
  server = createVaultServer({ dataDir, token: TOKEN });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
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

describe('method handling', () => {
  it('unsupported methods on the manifest resource are 405', async () => {
    const res = await req('/v1/sync/manifest', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'method not allowed' });
  });

  it('unsupported methods on the objects resource are 405', async () => {
    const key = 'e'.repeat(64);
    const res = await req(`/v1/sync/objects/${key}`, { method: 'POST', body: Buffer.from('x') });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'method not allowed' });
  });
});

describe('error handling', () => {
  it('over-limit content-length is rejected with 413 before any body is read', async () => {
    // declares 64MB but only ever sends 5 bytes - if the server waited to read a real
    // 64MB body before rejecting, this would hang instead of resolving quickly
    const { status, body } = await rawPut('/v1/sync/manifest', 64 * 1024 * 1024, Buffer.from('small'));
    expect(status).toBe(413);
    expect(JSON.parse(body)).toEqual({ error: 'body too large' });
  });

  it('internal errors return a generic message, never a filesystem path', async () => {
    // touch the store once first so `store/objects` exists before we lock it down
    await req('/v1/health');
    const objectsDir = join(dataDir, 'store', 'objects');
    const before = statSync(objectsDir).mode;
    chmodSync(objectsDir, 0o500);
    try {
      const key = 'd'.repeat(64);
      const res = await req(`/v1/sync/objects/${key}`, { method: 'PUT', body: Buffer.from('x') });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe(JSON.stringify({ error: 'internal error' }));
      expect(text).not.toMatch(/\/(var|tmp|Users)\//);
    } finally {
      chmodSync(objectsDir, before);
    }
  });
});
