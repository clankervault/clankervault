import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

/** spawn a real `clanker serve` subprocess on an OS-assigned port and resolve once its
 *  startup line is seen; shared by every test in this file that needs its own server */
async function spawnVaultServer(dataDir: string, env: Record<string, string>): Promise<{ proc: ChildProcess; base: string }> {
  const child = spawn('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), 'serve', '--data', dataDir, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const url = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (c: Buffer) => {
      buf += c.toString();
      const m = buf.match(/listening on :(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    setTimeout(() => reject(new Error(`server did not start: ${buf}`)), 30000);
  });
  return { proc: child, base: url };
}

beforeAll(async () => {
  ({ proc, base } = await spawnVaultServer(tmpDir(), { VAULT_SERVER_TOKEN: TOKEN }));
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

async function mcp(base: string, token: string, body: unknown, sessionId?: string): Promise<{ status: number; json: any; sessionId?: string }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(`${base}/v1/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text.replace(/^data: /m, '').trim().split('\n').pop()!); } catch { /* non-JSON */ }
  return { status: res.status, json, sessionId: res.headers.get('mcp-session-id') ?? undefined };
}

describe('remote MCP endpoint', () => {
  let mcpProc: ChildProcess;
  let mcpBase: string;

  beforeAll(async () => {
    // own data dir and own server process (passphrase-bearing) - sharing the Task 2
    // server's data dir would race its manifest CAS with the round-trip test above
    ({ proc: mcpProc, base: mcpBase } = await spawnVaultServer(tmpDir(), { VAULT_SERVER_TOKEN: TOKEN, VAULT_PASSPHRASE: 'p' }));

    // seed the server through a client vault: setup, create the project and record,
    // then sync so the ciphertext store has something for the server's replica to decrypt
    const client = join(tmpDir(), 'mcp-client');
    cli(['init', client]);
    cli(['--vault', client, 'sync', 'setup', '--url', mcpBase, '--token', TOKEN, '--passphrase', 'p']);
    cli(['--vault', client, 'project', 'new', 'Demo']);
    cli(['--vault', client, 'add', 'fact', 'Server round trip', '-p', 'demo']);
    cli(['--vault', client, 'sync']);
  }, 60000);
  afterAll(() => { mcpProc?.kill(); });

  it('answers initialize and serves synced context from the decrypted replica', async () => {
    const init = await mcp(mcpBase, TOKEN, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'remote-test', version: '1.0.0' } },
    });
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe('clankervault');
    expect(init.sessionId).toBeTruthy();

    const call = await mcp(mcpBase, TOKEN, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_context', arguments: { project: 'demo' } },
    }, init.sessionId);
    expect(call.status).toBe(200);
    expect(call.json.result.content[0].text).toContain('Server round trip');
  });

  it('remember through a session carries real client provenance, not mcp:unknown', async () => {
    const init = await mcp(mcpBase, TOKEN, {
      jsonrpc: '2.0', id: 3, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'remote-test', version: '1.0.0' } },
    });
    const sid = init.sessionId!;

    const res = await mcp(mcpBase, TOKEN, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'remember', arguments: { project: 'demo', type: 'fact', title: 'Provenance check' } },
    }, sid);
    expect(res.status).toBe(200);
    expect(res.json.result.content[0].text).toMatch(/unconfirmed/);

    // read the written record back through an independent client sync (not the
    // server's own replica dir), so this is an end-to-end check of what actually
    // reached the ciphertext store, not just what's sitting in server memory
    const reader = join(tmpDir(), 'provenance-reader');
    cli(['init', reader]);
    cli(['--vault', reader, 'sync', 'setup', '--url', mcpBase, '--token', TOKEN, '--passphrase', 'p']);
    expect(cli(['--vault', reader, 'sync']).code).toBe(0);
    const projDir = readdirSync(join(reader, 'projects')).find((d) => d.startsWith('demo'))!;
    const files = readdirSync(join(reader, 'projects', projDir, 'records'));
    const recFile = files.find((f) => f.includes('provenance-check'))!;
    const raw = readFileSync(join(reader, 'projects', projDir, 'records', recFile), 'utf8');
    expect(raw).toContain('mcp:remote-test');
    expect(raw).not.toContain('mcp:unknown');
  });

  it('serializes concurrent remember calls with no loss and immediate write-back', async () => {
    const init = await mcp(mcpBase, TOKEN, {
      jsonrpc: '2.0', id: 5, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'concurrent-test', version: '1.0.0' } },
    });
    const sid = init.sessionId!;
    const titles = ['Concurrent A', 'Concurrent B', 'Concurrent C', 'Concurrent D', 'Concurrent E'];

    // 5 concurrent writes on the same session: the server's mcp request queue must
    // serialize them (no lost update from two syncOnce scans of the replica
    // interleaving) and push each one to the ciphertext store immediately, not after
    // 15s of otherwise-idle traffic
    await Promise.all(titles.map((title, i) => mcp(mcpBase, TOKEN, {
      jsonrpc: '2.0', id: 100 + i, method: 'tools/call',
      params: { name: 'remember', arguments: { project: 'demo', type: 'fact', title } },
    }, sid)));

    const reader = join(tmpDir(), 'concurrent-reader');
    cli(['init', reader]);
    cli(['--vault', reader, 'sync', 'setup', '--url', mcpBase, '--token', TOKEN, '--passphrase', 'p']);
    expect(cli(['--vault', reader, 'sync']).code).toBe(0);
    const firstList = cli(['--vault', reader, 'list', '-p', 'demo']).out;
    for (const title of titles) expect(firstList).toContain(title);

    // a second server-side sync cycle (any further mcp traffic through the queue)
    // must not delete anything already pushed
    await mcp(mcpBase, TOKEN, { jsonrpc: '2.0', id: 200, method: 'tools/list' }, sid);
    expect(cli(['--vault', reader, 'sync']).code).toBe(0);
    const secondList = cli(['--vault', reader, 'list', '-p', 'demo']).out;
    for (const title of titles) expect(secondList).toContain(title);
  }, 60000);   // five serialized MCP writes + syncs: comfortably over vitest's 5s default on slow CI runners

  it('survives a corrupted store manifest instead of crashing the process', async () => {
    // a DEDICATED server + data dir: fresh() has never run on its Replica yet
    // (lastSync stays 0), so the very first /v1/mcp request below cannot be skipped
    // by the 15s freshness throttle - it is guaranteed to hit the corrupted manifest
    const dataDir = tmpDir();
    const { proc: crashProc, base: crashBase } = await spawnVaultServer(dataDir, { VAULT_SERVER_TOKEN: TOKEN, VAULT_PASSPHRASE: 'p' });
    try {
      // seed through the ordinary sync endpoints only - this never touches the
      // server's Replica or mcp machinery at all
      const client = join(tmpDir(), 'crash-client');
      cli(['init', client]);
      cli(['--vault', client, 'sync', 'setup', '--url', crashBase, '--token', TOKEN, '--passphrase', 'p']);
      cli(['--vault', client, 'project', 'new', 'Demo']);
      cli(['--vault', client, 'add', 'fact', 'Seed record', '-p', 'demo']);
      cli(['--vault', client, 'sync']);

      const manifestPath = join(dataDir, 'store', 'manifest.json');
      const original = readFileSync(manifestPath, 'utf8');
      writeFileSync(manifestPath, 'not json at all {{{');

      const broken = await mcp(crashBase, TOKEN, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'crash-test', version: '1.0.0' } },
      });
      expect(broken.status).toBe(500);
      expect(typeof broken.json.error).toBe('string');
      expect(broken.json.error).not.toMatch(/\//); // no filesystem path leaked into the response

      writeFileSync(manifestPath, original);

      // the process itself must still be up: a plain authenticated health check,
      // then one more real mcp request, both against the SAME still-running process
      const health = await fetch(`${crashBase}/v1/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(health.status).toBe(200);

      const recovered = await mcp(crashBase, TOKEN, {
        jsonrpc: '2.0', id: 2, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'crash-test', version: '1.0.0' } },
      });
      expect(recovered.status).toBe(200);
      expect(recovered.json.result.serverInfo.name).toBe('clankervault');
    } finally {
      crashProc.kill();
    }
  }, 30000);

  it('refuses without a token', async () => {
    const res = await fetch(`${mcpBase}/v1/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('returns 503 when the server has no passphrase', async () => {
    const r = await mcp(base, TOKEN, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    expect(r.status).toBe(503);
  });
});
