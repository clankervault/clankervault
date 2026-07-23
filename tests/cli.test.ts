import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';

function run(args: string[], cwd?: string) {
  const r = spawnSync('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), ...args], {
    encoding: 'utf8', cwd: cwd ?? process.cwd(),
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('vault CLI end to end', () => {
  it('init to project to add to compile', () => {
    const vault = join(tmpDir(), 'v');
    const work = tmpDir();

    expect(run(['init', vault]).code).toBe(0);
    expect(run(['--vault', vault, 'project', 'new', 'Demo', '--root', work]).code).toBe(0);

    const add = run(['--vault', vault, 'add', 'fact', 'Deploy on Vercel', '-b', 'branch main'], work);
    expect(add.code).toBe(0);
    expect(add.out).toMatch(/fct-/);

    const compile = run(['--vault', vault, 'compile'], work);
    expect(compile.code).toBe(0);
    for (const f of ['CLAUDE.md', 'AGENTS.md', '.cursorrules']) {
      const content = readFileSync(join(work, f), 'utf8');
      expect(content).toContain('GENERATED');
      expect(content).toContain('Deploy on Vercel');
    }
  });

  it('rejects unknown record type with guidance', () => {
    const vault = join(tmpDir(), 'v');
    run(['init', vault]);
    run(['--vault', vault, 'project', 'new', 'Demo']);
    const r = run(['--vault', vault, 'add', 'state', 'x', '-p', 'demo']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/vault state/);
  });

  it('stores relative --root as an absolute path so later cwds cannot misattribute records', () => {
    const vault = join(tmpDir(), 'v');
    const projA = tmpDir();
    const projB = tmpDir();
    run(['init', vault]);
    // register both projects with a RELATIVE root from inside their own dirs
    expect(run(['--vault', vault, 'project', 'new', 'ProjA', '--root', '.'], projA).code).toBe(0);
    expect(run(['--vault', vault, 'project', 'new', 'ProjB', '--root', '.'], projB).code).toBe(0);
    // adding from projB without -p must land in ProjB, never ProjA
    const add = run(['--vault', vault, 'add', 'fact', 'marker-in-B'], projB);
    expect(add.code).toBe(0);
    const list = run(['--vault', vault, 'list', '-p', 'projb']);
    expect(list.out).toContain('marker-in-B');
    expect(run(['--vault', vault, 'list', '-p', 'proja']).out).not.toContain('marker-in-B');
  });

  it('rejects an unknown --kind with guidance', () => {
    const vault = join(tmpDir(), 'v');
    run(['init', vault]);
    const r = run(['--vault', vault, 'project', 'new', 'Demo', '--kind', 'banana']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/code \| creative/);
  });

  it('rejects a non-numeric --budget with guidance', () => {
    const vault = join(tmpDir(), 'v');
    const work = tmpDir();
    run(['init', vault]);
    run(['--vault', vault, 'project', 'new', 'Demo', '--root', work]);
    const r = run(['--vault', vault, 'compile', '--budget', 'abc'], work);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Invalid --budget/);
  });

  it('prints a clean one-line error, not a stack trace, on init over an existing vault', () => {
    const vault = join(tmpDir(), 'v');
    run(['init', vault]);
    const r = run(['init', vault]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/already exists/i);
    expect(r.out).not.toMatch(/at .*cli\.ts/);
  });
});
