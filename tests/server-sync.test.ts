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
