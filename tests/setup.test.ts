import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';
import { discoverProjects, hookCommand, mcpServerConfig, type VaultBin } from '../src/setup.js';

function run(args: string[], home: string, vault: string, extraEnv: Record<string, string> = {}, input?: string) {
  const r = spawnSync('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), ...args], {
    encoding: 'utf8',
    input,
    timeout: 20000,
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
    expect(cursorMcp.mcpServers.clankervault).toBeTruthy();

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
      const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'dev.clankervault.refresh.plist'), 'utf8');
      // launchd has a minimal PATH: the plist must invoke node absolutely, never rely on a shebang
      expect(plist).toContain(`<string>${process.execPath}</string>`);
      expect(plist).not.toMatch(/<string>[^<]*\/clanker<\/string>/);
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

  it('never touches a settings.json that fails to parse, warns instead, and still completes the other steps', () => {
    const home = tmpDir();
    const vault = join(tmpDir(), 'v');
    const work = join(tmpDir(), 'work');
    mkdirSync(work, { recursive: true });
    fabricateClaudeTranscript(home, '-x-work', work);
    mkdirSync(join(home, '.claude'), { recursive: true });
    const settingsFile = join(home, '.claude', 'settings.json');
    const invalidJson = '{"model":"x",}'; // trailing comma: not valid JSON
    writeFileSync(settingsFile, invalidJson);

    const r = run(['setup', '--yes'], home, vault);
    expect(r.code).toBe(0);

    // the broken file is byte-identical, no backup was made for it
    expect(readFileSync(settingsFile, 'utf8')).toBe(invalidJson);
    expect(existsSync(`${settingsFile}.bak-vault`)).toBe(false);
    expect(r.out).toMatch(/warning:.*settings\.json is not valid JSON.*re-run clanker setup.*NOT touched/);

    // other, independent action groups still went through
    expect(existsSync(join(vault, 'vault.yaml'))).toBe(true);
    const list = run(['project', 'list'], home, vault);
    expect(list.out).toMatch(/work/);
  });

  it('never proposes a discovered parent directory of an already-registered project root', () => {
    const home = tmpDir();
    const vault = join(tmpDir(), 'v');
    const parent = join(tmpDir(), 'studio');
    const child = join(parent, 'engines', 'motion');
    mkdirSync(child, { recursive: true });
    // child is registered first (by hand), parent shows up in transcripts
    run(['init', vault], home, vault);
    run(['project', 'new', 'Motion', '--root', child], home, vault);
    fabricateClaudeTranscript(home, '-x-studio', parent);
    const r = run(['setup', '--yes'], home, vault);
    expect(r.code).toBe(0);
    const list = run(['project', 'list'], home, vault);
    expect(list.out).toMatch(/motion/);
    expect(list.out).not.toMatch(/studio/);
  });

  it('replaces a stale hook entry in place instead of appending a duplicate, keyed by a stable vault+compile marker', () => {
    const home = tmpDir();
    const vault = join(tmpDir(), 'v');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const staleCommand = '/old/moved/path/vault compile --tool claude >/dev/null 2>&1 || true';
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: staleCommand, timeout: 15 }] }] } }),
    );

    const r = run(['setup', '--yes'], home, vault);
    expect(r.code).toBe(0);

    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    const commands: string[] = settings.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => h.command),
    );
    const vaultHooks = commands.filter((c) => (c.includes('vault') || c.includes('clanker')) && c.includes('compile'));
    expect(vaultHooks.length).toBe(1);
    expect(vaultHooks[0]).not.toBe(staleCommand);
  });

  it('replaces a stale mcpServers.vault entry with mcpServers.clankervault, keyed by the vault/clanker footprint', () => {
    const home = tmpDir();
    const vault = join(tmpDir(), 'v');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { vault: { command: '/old/moved/path/vault', args: ['mcp'] } } }),
    );

    const r = run(['setup', '--yes'], home, vault);
    expect(r.code).toBe(0);

    const cursorMcp = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursorMcp.mcpServers.clankervault).toBeTruthy();
    expect(cursorMcp.mcpServers.vault).toBeUndefined();
  });

  it('exits 0 without hanging when the first prompt is declined, with no vault ever created', () => {
    const home = tmpDir();
    const vault = join(tmpDir(), 'v');
    const r = run(['setup'], home, vault, {}, 'n\n');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/nothing else to do without a vault/);
    expect(existsSync(join(vault, 'vault.yaml'))).toBe(false);
  }, 20000);

  it('registers a discovered project through the default-yes interactive flow (empty answers)', () => {
    const home = tmpDir();
    const vault = join(tmpDir(), 'v');
    const work = join(tmpDir(), 'work');
    mkdirSync(work, { recursive: true });
    fabricateClaudeTranscript(home, '-x-work', work);

    // one empty line per possible prompt is more than enough; EOF-before-answer
    // defaults to yes too, so extra blank lines are harmless padding
    const r = run(['setup'], home, vault, {}, '\n\n\n\n\n\n\n\n\n\n');
    expect(r.code).toBe(0);

    expect(existsSync(join(vault, 'vault.yaml'))).toBe(true);
    const list = run(['project', 'list'], home, vault);
    expect(list.out).toMatch(/work/);
  }, 20000);
});

describe('vaultBin formatting surfaces', () => {
  it('hookCommand quotes every token, including a command containing a space', () => {
    const bin: VaultBin = { command: '/Users/mac test/vault', args: [] };
    const cmd = hookCommand(bin);
    expect(cmd).toBe('"/Users/mac test/vault" compile --tool claude >/dev/null 2>&1 || true');
  });

  it('hookCommand quotes the fallback node + script form (command and args both quoted)', () => {
    const bin: VaultBin = { command: '/usr/local/bin/node', args: ['/Users/mac/my project/dist/cli.js'] };
    const cmd = hookCommand(bin);
    expect(cmd).toBe('"/usr/local/bin/node" "/Users/mac/my project/dist/cli.js" compile --tool claude >/dev/null 2>&1 || true');
  });

  it('mcpServerConfig appends "mcp" to the base args without mutating the input', () => {
    const bin: VaultBin = { command: '/usr/local/bin/node', args: ['/Users/mac/my project/dist/cli.js'] };
    const cfg = mcpServerConfig(bin);
    expect(cfg).toEqual({ command: '/usr/local/bin/node', args: ['/Users/mac/my project/dist/cli.js', 'mcp'] });
    expect(bin.args).toEqual(['/Users/mac/my project/dist/cli.js']); // not mutated
  });

  it('mcpServerConfig on a plain resolved binary is just { command, args: ["mcp"] }', () => {
    const bin: VaultBin = { command: '/Users/mac/.npm-global/bin/clanker', args: [] };
    expect(mcpServerConfig(bin)).toEqual({ command: '/Users/mac/.npm-global/bin/clanker', args: ['mcp'] });
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
