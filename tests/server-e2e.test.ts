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
  let mcpProc: ChildProcess;
  let mcpBase: string;

  beforeAll(async () => {
    // own data dir and own server process (passphrase-bearing) - sharing the Task 2
    // server's data dir would race its manifest CAS with the round-trip test above
    const data = tmpDir();
    mcpProc = spawn('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), 'serve', '--data', data, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VAULT_SERVER_TOKEN: TOKEN, VAULT_PASSPHRASE: 'p' },
    });
    mcpBase = await new Promise<string>((resolve, reject) => {
      let buf = '';
      mcpProc.stdout!.on('data', (c: Buffer) => {
        buf += c.toString();
        const m = buf.match(/listening on :(\d+)/);
        if (m) resolve(`http://127.0.0.1:${m[1]}`);
      });
      setTimeout(() => reject(new Error(`mcp server did not start: ${buf}`)), 30000);
    });

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
