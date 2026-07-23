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
});
