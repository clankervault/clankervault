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
