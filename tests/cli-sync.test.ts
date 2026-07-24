import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
    expect(run(['--vault', vaultA, 'sync', 'setup', '--path', remote, '--passphrase', 'p']).code).toBe(0);
    expect(readFileSync(join(vaultA, 'device.yaml'), 'utf8')).toContain('backend: dir');
    expect(run(['--vault', vaultB, 'sync', 'setup', '--path', remote, '--passphrase', 'p']).code).toBe(0);

    run(['--vault', vaultA, 'project', 'new', 'Demo']);
    const s1 = run(['--vault', vaultA, 'sync']);
    expect(s1.code).toBe(0);
    expect(s1.out).toMatch(/synced:/);
    const s2 = run(['--vault', vaultB, 'sync']);
    expect(s2.code).toBe(0);
    const list = run(['--vault', vaultB, 'project', 'list']);
    expect(list.out).toContain('Demo');
  });

  it('fails with guidance when sync is not configured', () => {
    const vault = join(tmpDir(), 'v');
    run(['init', vault]);
    const r = run(['--vault', vault, 'sync']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/vault sync setup/);
  });
});
