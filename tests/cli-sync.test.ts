import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), ...args], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('vault sync CLI', () => {
  it('setup writes the device sync block and sync round-trips between two vaults', () => {
    const vaultA = join(tmpDir(), 'a');
    const vaultB = join(tmpDir(), 'b');
    const remote = tmpDir();

    run(['init', vaultA]);
    run(['init', vaultB]);
    // widen perms first to prove setup tightens a pre-existing file, not just fresh writes
    chmodSync(join(vaultA, 'device.yaml'), 0o644);
    expect(run(['--vault', vaultA, 'sync', 'setup', '--path', remote, '--passphrase', 'p']).code).toBe(0);
    expect(readFileSync(join(vaultA, 'device.yaml'), 'utf8')).toContain('backend: dir');
    // passphrase on disk: owner-only
    expect(statSync(join(vaultA, 'device.yaml')).mode & 0o777).toBe(0o600);
    expect(run(['--vault', vaultB, 'sync', 'setup', '--path', remote, '--passphrase', 'p']).code).toBe(0);

    run(['--vault', vaultA, 'project', 'new', 'Demo']);
    const s1 = run(['--vault', vaultA, 'sync']);
    expect(s1.code).toBe(0);
    expect(s1.out).toMatch(/synced:/);
    const s2 = run(['--vault', vaultB, 'sync']);
    expect(s2.code).toBe(0);
    const list = run(['--vault', vaultB, 'project', 'list']);
    expect(list.out).toContain('Demo');

    // rerunning setup to change --path must MERGE, not clobber: no --passphrase this
    // time means the previously saved one must survive, only backend/path replace
    const remote2 = tmpDir();
    expect(run(['--vault', vaultA, 'sync', 'setup', '--path', remote2]).code).toBe(0);
    const deviceYamlA = readFileSync(join(vaultA, 'device.yaml'), 'utf8');
    expect(deviceYamlA).toContain('passphrase: p');
    expect(deviceYamlA).toContain(remote2);
  });

  it('fails with guidance when sync is not configured', () => {
    const vault = join(tmpDir(), 'v');
    run(['init', vault]);
    const r = run(['--vault', vault, 'sync']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/clanker sync setup/);
  });

  it('fails cleanly, no stack trace, when the configured passphrase is wrong', () => {
    const vaultA = join(tmpDir(), 'a');
    const vaultB = join(tmpDir(), 'b');
    const remote = tmpDir();

    run(['init', vaultA]);
    run(['init', vaultB]);
    run(['--vault', vaultA, 'sync', 'setup', '--path', remote, '--passphrase', 'good']);
    run(['--vault', vaultB, 'sync', 'setup', '--path', remote, '--passphrase', 'bad']);

    expect(run(['--vault', vaultA, 'sync']).code).toBe(0);   // A writes the salt + manifest with 'good'
    const r = run(['--vault', vaultB, 'sync']);               // B tries to read it back with 'bad'
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/passphrase/i);
    expect(r.out).not.toMatch(/^\s+at /m);
  });
});
