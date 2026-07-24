import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';
import { discoverProjects } from '../src/setup.js';

function run(args: string[], home: string, vault: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      VAULT_DIR: vault,
      VAULT_SETUP_NO_LAUNCHCTL: '1',
      ...extraEnv,
    },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

/** fabricate a claude-code transcript directory whose only jsonl entry carries the given cwd */
function fabricateClaudeTranscript(home: string, dirName: string, cwd: string): void {
  const dir = join(home, '.claude', 'projects', dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session.jsonl'),
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } }) + '\n',
  );
}

describe('vault setup wizard', () => {
  it('detects tools, discovers a claude-code project, wires hooks/mcp/compile, fast-forwards mining', () => {
    const home = tmpDir();
    const vault = join(tmpDir(), 'v');
    const work = join(tmpDir(), 'work');
    mkdirSync(work, { recursive: true });

    fabricateClaudeTranscript(home, '-x-work', work);
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.cursor'), { recursive: true });

    const r = run(['setup', '--yes'], home, vault);
    expect(r.code).toBe(0);

    // vault created
    expect(existsSync(join(vault, 'vault.yaml'))).toBe(true);

    // project registered with the work dir root
    const list = run(['project', 'list'], home, vault);
    expect(list.out).toMatch(/work/);

    // claude code hook wired
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    const sessionStart = settings.hooks.SessionStart;
    expect(sessionStart.length).toBeGreaterThan(0);
    expect(JSON.stringify(sessionStart)).toMatch(/compile --tool claude/);

    // cursor mcp.json wired
    const cursorMcp = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursorMcp.mcpServers.vault).toBeTruthy();

    // offsets fast-forwarded
    const offsets = JSON.parse(readFileSync(join(vault, '.mine', 'offsets.json'), 'utf8'));
    const key = Object.keys(offsets).find((k) => k.includes('session.jsonl'));
    expect(key).toBeTruthy();
    expect(offsets[key!]).toBeGreaterThan(0);

    // compiled files: claude-code -> CLAUDE.md, codex -> AGENTS.md, cursor -> .cursorrules
    expect(existsSync(join(work, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(work, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(work, '.cursorrules'))).toBe(true);

    // refresh daemon plist written (darwin only; this test machine is darwin)
    if (process.platform === 'darwin') {
      expect(existsSync(join(home, 'Library', 'LaunchAgents', 'dev.vault.refresh.plist'))).toBe(true);
    }
  });

  it('is idempotent: a second run adds no duplicate hooks or projects and exits 0', () => {
    const home = tmpDir();
    const vault = join(tmpDir(), 'v');
    const work = join(tmpDir(), 'work');
    mkdirSync(work, { recursive: true });
    fabricateClaudeTranscript(home, '-x-work', work);
    mkdirSync(join(home, '.cursor'), { recursive: true });

    expect(run(['setup', '--yes'], home, vault).code).toBe(0);
    const listAfterFirst = run(['project', 'list'], home, vault).out;

    const second = run(['setup', '--yes'], home, vault);
    expect(second.code).toBe(0);

    const listAfterSecond = run(['project', 'list'], home, vault).out;
    expect(listAfterSecond).toBe(listAfterFirst);

    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    const commands = JSON.stringify(settings.hooks.SessionStart).match(/compile --tool claude/g) ?? [];
    expect(commands.length).toBe(1);
  });

  it('preserves unrelated settings.json keys and backs up once', () => {
    const home = tmpDir();
    const vault = join(tmpDir(), 'v');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'x',
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      }),
    );

    const r = run(['setup', '--yes'], home, vault);
    expect(r.code).toBe(0);

    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(settings.model).toBe('x');
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).toMatch(/echo hi/);
    expect(settings.hooks.SessionStart.length).toBeGreaterThan(0);

    expect(existsSync(join(home, '.claude', 'settings.json.bak-vault'))).toBe(true);
    const bak = JSON.parse(readFileSync(join(home, '.claude', 'settings.json.bak-vault'), 'utf8'));
    expect(bak.model).toBe('x');
    expect(bak.hooks.SessionStart).toBeUndefined();
  });

  it('--dry-run changes nothing and prints the plan', () => {
    const home = tmpDir();
    const vault = join(tmpDir(), 'v');
    const work = join(tmpDir(), 'work');
    mkdirSync(work, { recursive: true });
    fabricateClaudeTranscript(home, '-x-work', work);
    mkdirSync(join(home, '.cursor'), { recursive: true });

    const r = run(['setup', '--dry-run'], home, vault);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dry-run/);

    expect(existsSync(join(vault, 'vault.yaml'))).toBe(false);
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false);
    expect(existsSync(join(work, 'CLAUDE.md'))).toBe(false);
  });
});

describe('discoverProjects', () => {
  it('drops a cwd pointing at a non-existent directory', () => {
    const home = tmpDir();
    fabricateClaudeTranscript(home, '-ghost', join(home, 'does-not-exist'));
    expect(discoverProjects(home)).toEqual([]);
  });

  it('drops a cwd equal to the home dir itself', () => {
    const home = tmpDir();
    fabricateClaudeTranscript(home, '-home', home);
    expect(discoverProjects(home)).toEqual([]);
  });

  it('dedupes two transcripts pointing at the same cwd into one candidate', () => {
    const home = tmpDir();
    const work = join(home, 'work');
    mkdirSync(work, { recursive: true });
    fabricateClaudeTranscript(home, '-a', work);
    fabricateClaudeTranscript(home, '-b', work);
    const found = discoverProjects(home);
    expect(found.length).toBe(1);
    expect(found[0].source).toBe('claude-code');
  });
});
