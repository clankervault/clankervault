import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, readdirSync,
  realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileAll } from './compile.js';
import { createProject, listProjects } from './project.js';
import { TOOL_ADAPTERS } from './adapters/index.js';
import { discoverTranscripts, readOffsets, writeOffsets } from './mine/reader.js';
import { initVault, isVault, readConfig } from './vault.js';

/** every AI tool `vault setup` knows how to detect and wire, in the order it walks them */
export const KNOWN_TOOLS = ['claude-code', 'codex', 'cursor', 'gemini', 'claude-desktop', 'windsurf'] as const;

// -------------------------------------------------------------------------
// vaultBin: the resolved CLI entry other tools' configs should invoke.
// -------------------------------------------------------------------------

/** command + argv prefix needed to invoke the vault CLI; never a pre-joined shell string */
export interface VaultBin {
  command: string;
  args: string[];
}

/**
 * Resolve the CLI entry other tools' configs should shell out to. Prefers an
 * installed `vault` on PATH (npm link / global install): `{ command: <abs path>, args: [] }`.
 * Falls back, when it is not on PATH (a dev checkout not yet linked), to running the
 * built CLI straight through node: `{ command: process.execPath, args: [<abs dist/cli.js>] }`.
 * Always structured, never a pre-joined string: a path containing a space must stay
 * one argv element, not get split by a naive `.split(' ')` downstream.
 */
export function vaultBin(): VaultBin {
  const found = spawnSync('which', ['vault'], { encoding: 'utf8' });
  if (found.status === 0 && found.stdout.trim()) {
    return { command: resolve(found.stdout.trim()), args: [] };
  }
  const here = fileURLToPath(import.meta.url);
  const distCli = resolve(dirname(here), '..', 'dist', 'cli.js');
  return { command: process.execPath, args: [distCli] };
}

/** human-readable rendering for informational print lines (never executed, quoting not required) */
function binDisplay(bin: VaultBin): string {
  return [bin.command, ...bin.args].join(' ');
}

/** double-quote a single shell token, escaping the characters that matter inside double quotes */
function shellQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

/**
 * The exact shell command written into the Claude Code SessionStart hook. Every
 * token is quoted, including the command itself, so a path containing a space
 * (a node fallback path, or a `vault` install under a spaced directory) still
 * runs as one program with one set of args rather than splitting apart.
 */
export function hookCommand(bin: VaultBin): string {
  const parts = [bin.command, ...bin.args].map(shellQuote).join(' ');
  return `${parts} compile --tool claude >/dev/null 2>&1 || true`;
}

/** the exact `{ command, args }` object written into an MCP client's JSON config */
export function mcpServerConfig(bin: VaultBin): { command: string; args: string[] } {
  return { command: bin.command, args: [...bin.args, 'mcp'] };
}

// -------------------------------------------------------------------------
// detectTools
// -------------------------------------------------------------------------

function toolDirs(home: string): [string, string][] {
  return [
    ['claude-code', join(home, '.claude')],
    ['codex', join(home, '.codex')],
    ['cursor', join(home, '.cursor')],
    ['gemini', join(home, '.gemini')],
    ['claude-desktop', join(home, 'Library', 'Application Support', 'Claude')],
    ['windsurf', join(home, '.windsurf')],
  ];
}

export function detectTools(home: string): string[] {
  return toolDirs(home).filter(([, dir]) => existsSync(dir)).map(([name]) => name);
}

// -------------------------------------------------------------------------
// discoverProjects: read `cwd` out of real transcript files, never decode
// directory names (lossy).
// -------------------------------------------------------------------------

function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs; // path does not exist (yet) on this machine: compare by resolved form
  }
}

/** read up to maxBytes from the start of a file, split into at most maxLines lines */
function readHeadLines(file: string, maxBytes: number, maxLines: number): string[] {
  const size = statSync(file).size;
  const want = Math.min(size, maxBytes);
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(want);
  let readTotal = 0;
  while (readTotal < want) {
    const n = readSync(fd, buf, readTotal, want - readTotal, readTotal);
    if (n === 0) break;
    readTotal += n;
  }
  closeSync(fd);
  return buf.subarray(0, readTotal).toString('utf8').split('\n').slice(0, maxLines);
}

const CLAUDE_SCAN_LINES = 50;
const CLAUDE_SCAN_BYTES = 1 << 20; // 1MB is generous for 50 lines of chat transcript

function extractClaudeCwd(file: string): string | null {
  for (const line of readHeadLines(file, CLAUDE_SCAN_BYTES, CLAUDE_SCAN_LINES)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { cwd?: unknown };
      if (typeof e.cwd === 'string' && e.cwd) return e.cwd;
    } catch {
      continue; // corrupted or truncated line: skip
    }
  }
  return null;
}

function discoverClaudeCandidates(home: string): { cwd: string; source: string }[] {
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root)) return [];
  const out: { cwd: string; source: string }[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const abs = join(root, dir.name);
    let files: string[];
    try {
      files = readdirSync(abs).filter((f) => f.endsWith('.jsonl')).map((f) => join(abs, f));
    } catch {
      continue;
    }
    if (!files.length) continue;
    // newest transcript in this project dir, by mtime
    const newest = files.map((f) => ({ f, m: statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
    const cwd = extractClaudeCwd(newest);
    if (cwd) out.push({ cwd, source: 'claude-code' });
  }
  return out;
}

function walkJsonlFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walkJsonlFiles(abs, out);
    else if (e.name.endsWith('.jsonl')) out.push(abs);
  }
}

// codex session files are organized by date (YYYY/MM/DD/rollout-*.jsonl), not by project,
// and the first line alone can run tens of KB (it carries the full base instructions), so
// scan a modest window of the newest files rather than every session ever recorded
const CODEX_SCAN_FILES = 40;
const CODEX_SCAN_BYTES = 1 << 17; // 128KB
const CODEX_SCAN_LINES = 20;

/** codex rollout entries carry cwd nested under payload (session_meta), not at the top level */
function extractCodexCwd(file: string): string | null {
  for (const line of readHeadLines(file, CODEX_SCAN_BYTES, CODEX_SCAN_LINES)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
      const cwd = e.payload?.cwd ?? e.cwd;
      if (typeof cwd === 'string' && cwd) return cwd;
    } catch {
      continue;
    }
  }
  return null;
}

function discoverCodexCandidates(home: string): { cwd: string; source: string }[] {
  const root = join(home, '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const files: string[] = [];
  walkJsonlFiles(root, files);
  // YYYY/MM/DD/rollout-<ISO timestamp>... paths sort lexicographically = chronologically
  files.sort();
  const newest = files.slice(-CODEX_SCAN_FILES).reverse();
  const out: { cwd: string; source: string }[] = [];
  for (const f of newest) {
    const cwd = extractCodexCwd(f);
    if (cwd) out.push({ cwd, source: 'codex' });
  }
  return out;
}

export function discoverProjects(home: string): { cwd: string; source: string }[] {
  const candidates = [...discoverClaudeCandidates(home), ...discoverCodexCandidates(home)];
  const homeCanonical = canonicalPath(home);
  const seen = new Set<string>();
  const out: { cwd: string; source: string }[] = [];
  for (const c of candidates) {
    if (!existsSync(c.cwd)) continue; // dropped: not on this disk
    const canon = canonicalPath(c.cwd);
    if (canon === homeCanonical) continue; // dropped: cwd is the home dir itself
    if (seen.has(canon)) continue; // dropped: already found (dedupe by realpath)
    seen.add(canon);
    out.push({ cwd: canon, source: c.source });
  }
  return out;
}

// -------------------------------------------------------------------------
// buildPlan
// -------------------------------------------------------------------------

export interface SetupPlan {
  vaultDir: string;
  tools: string[];
  newProjects: { cwd: string; name: string }[];
  adapters: string[];
}

export function buildPlan(home: string, vaultDir: string): SetupPlan {
  const tools = detectTools(home);
  const discovered = discoverProjects(home);

  // drop cwds already covered by a registered project root, so re-running setup
  // (or running it after the user has already registered projects by hand) never
  // proposes registering the same directory twice
  const existingRoots = new Set<string>();
  if (isVault(vaultDir)) {
    for (const p of listProjects(vaultDir)) {
      for (const r of p.roots) {
        if (r.path) existingRoots.add(canonicalPath(r.path));
      }
    }
  }

  const newProjects = discovered
    .filter((d) => !existingRoots.has(d.cwd))
    .map((d) => ({ cwd: d.cwd, name: basename(d.cwd) }));

  const adapterSet = new Set<string>();
  for (const t of tools) adapterSet.add(TOOL_ADAPTERS[t]);
  if (tools.includes('claude-code')) adapterSet.add('claude'); // belt and suspenders on the always-claude rule

  return { vaultDir, tools, newProjects, adapters: [...adapterSet].sort() };
}

// -------------------------------------------------------------------------
// runSetup
// -------------------------------------------------------------------------

export interface RunSetupOptions {
  home: string;
  vaultDir: string;
  yes: boolean;
  dryRun: boolean;
  ask: (q: string) => Promise<boolean>;
}

/** thrown by readJsonFileStrict when a config file exists but does not parse as JSON */
export class InvalidConfigError extends Error {
  file: string;
  constructor(file: string) {
    super(`${file} is not valid JSON`);
    this.file = file;
  }
}

/**
 * Read a JSON config. A missing file is treated as "start from empty" ({}); a file
 * that EXISTS but fails to parse throws InvalidConfigError instead of silently
 * discarding whatever the user (or another tool) put there. Callers must not write
 * anything, and must not take a backup, when this throws: there is nothing safe to
 * merge into, and a backup of unparseable content would just be a second unparseable
 * file.
 */
function readJsonFileStrict(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidConfigError(file);
  }
}

/** every edited config gets a one-time sibling backup, taken before the first edit ever */
function backupOnce(file: string): void {
  const bak = `${file}.bak-vault`;
  if (existsSync(file) && !existsSync(bak)) {
    writeFileSync(bak, readFileSync(file));
  }
}

function writeJsonFile(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

interface HookEntry { type?: string; command?: string; timeout?: number }
interface HookGroup { hooks?: HookEntry[] }

/** a hook command we (or an earlier run of us, under a different resolved bin) wrote */
function isOurHook(command: string | undefined): boolean {
  return !!command && command.includes('vault') && command.includes('compile');
}

/**
 * Idempotently add (or, on a stale entry, REPLACE in place) the SessionStart hook that
 * keeps CLAUDE.md fresh every session. Matching by a stable "vault" + "compile" marker,
 * not by exact string equality, because the resolved bin path can legitimately change
 * between runs (a fresh npm link, a moved checkout); an exact-match dedupe would just
 * keep appending a new, now-correct entry next to a stale, now-wrong one forever.
 */
function addClaudeCodeHook(home: string, bin: VaultBin): string {
  const file = join(home, '.claude', 'settings.json');
  const settings = readJsonFileStrict(file) as { hooks?: Record<string, HookGroup[]> };
  backupOnce(file); // only reached once the existing file is confirmed to parse
  settings.hooks = settings.hooks ?? {};
  const list = settings.hooks.SessionStart ?? [];
  const command = hookCommand(bin);
  let replaced = false;
  for (const group of list) {
    for (const h of group.hooks ?? []) {
      if (isOurHook(h.command)) {
        h.type = 'command';
        h.command = command;
        h.timeout = 15;
        replaced = true;
      }
    }
  }
  if (!replaced) list.push({ hooks: [{ type: 'command', command, timeout: 15 }] });
  settings.hooks.SessionStart = list;
  writeJsonFile(file, settings);
  return file;
}

/** idempotently merge mcpServers.vault into a client's MCP config, preserving everything else */
function mergeMcpServer(file: string, bin: VaultBin): void {
  const config = readJsonFileStrict(file) as { mcpServers?: Record<string, unknown> };
  backupOnce(file); // only reached once the existing file is confirmed to parse
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers.vault = mcpServerConfig(bin);
  writeJsonFile(file, config);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** the free, local refresh daemon: `vault compile --all` on an hourly launchd schedule */
function writeRefreshPlist(home: string, vaultDirPath: string, bin: VaultBin): string {
  const dir = join(home, 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });
  const plistPath = join(dir, 'dev.vault.refresh.plist');
  const programArgs = [bin.command, ...bin.args, 'compile', '--all']
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.vault.refresh</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>VAULT_DIR</key>
        <string>${escapeXml(vaultDirPath)}</string>
    </dict>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
`;
  writeFileSync(plistPath, xml);
  return plistPath;
}

/** codex config.toml is never edited; this is the ready-to-paste snippet vault prints instead */
function codexSnippetText(bin: VaultBin): string {
  const cfg = mcpServerConfig(bin);
  const argsList = cfg.args.map((a) => `"${a}"`).join(', ');
  return `[mcp_servers.vault]\ncommand = "${cfg.command}"\nargs = [${argsList}]`;
}

export async function runSetup(opts: RunSetupOptions): Promise<void> {
  const { home, vaultDir, yes, dryRun, ask } = opts;
  const plan = buildPlan(home, vaultDir);
  const bin = vaultBin();
  const done: string[] = [];

  /** gate one mutating action group: dry-run only prints, --yes always proceeds, else prompts */
  const confirm = async (label: string): Promise<boolean> => {
    if (dryRun) {
      console.log(`[dry-run] Would: ${label}`);
      return false;
    }
    if (yes) return true;
    return ask(`${label}? [Y/n] `);
  };

  /** an edited config that turned out not to parse: warn, skip that one action, touch nothing */
  const warnOrRethrow = (err: unknown): void => {
    if (err instanceof InvalidConfigError) {
      console.log(`warning: ${err.file} is not valid JSON; fix it and re-run vault setup; the file was NOT touched`);
      return;
    }
    throw err;
  };

  console.log(`Detected tools: ${plan.tools.length ? plan.tools.join(', ') : '(none)'}`);

  // 1. init vault
  if (!isVault(vaultDir)) {
    if (await confirm(`create a new vault at ${vaultDir}`)) {
      initVault(vaultDir);
      console.log(`Vault created at ${vaultDir}`);
      done.push(`created vault at ${vaultDir}`);
    } else if (!dryRun) {
      // every remaining step either registers into the vault or compiles out of it:
      // without one there is nothing left to safely do
      console.log('nothing else to do without a vault');
      return;
    }
  } else {
    console.log(`Vault exists at ${vaultDir}`);
  }

  // 2. register discovered projects
  if (plan.newProjects.length) {
    const names = plan.newProjects.map((p) => p.name).join(', ');
    if (await confirm(`register ${plan.newProjects.length} discovered project(s): ${names}`)) {
      for (const np of plan.newProjects) {
        createProject(vaultDir, np.name, { kind: 'code', roots: [{ path: np.cwd }] });
        console.log(`Registered project ${np.name} (${np.cwd})`);
      }
      done.push(`registered ${plan.newProjects.length} project(s): ${names}`);
    }
  } else {
    console.log('No new projects discovered.');
  }

  const claudeMcpLine = `claude mcp add vault -- vault mcp`;

  // 3. Claude Code: SessionStart hook (compiled files), print the MCP one-liner (never run it)
  if (plan.tools.includes('claude-code')) {
    if (await confirm('wire a SessionStart hook into Claude Code settings.json (keeps CLAUDE.md fresh)')) {
      try {
        const file = addClaudeCodeHook(home, bin);
        console.log(`Wired Claude Code hook in ${file}`);
        done.push('wired Claude Code SessionStart hook');
      } catch (err) {
        warnOrRethrow(err);
      }
    }
  }

  // 4. Claude Desktop: merge MCP server config
  if (plan.tools.includes('claude-desktop')) {
    const file = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    if (await confirm(`register the vault MCP server in Claude Desktop config (${file})`)) {
      try {
        mergeMcpServer(file, bin);
        console.log(`Wired Claude Desktop MCP config in ${file}`);
        done.push('wired Claude Desktop MCP config');
      } catch (err) {
        warnOrRethrow(err);
      }
    }
  }

  // 5. Cursor: merge MCP server config
  if (plan.tools.includes('cursor')) {
    const file = join(home, '.cursor', 'mcp.json');
    if (await confirm(`register the vault MCP server in Cursor (${file})`)) {
      try {
        mergeMcpServer(file, bin);
        console.log(`Wired Cursor MCP config in ${file}`);
        done.push('wired Cursor MCP config');
      } catch (err) {
        warnOrRethrow(err);
      }
    }
  }

  // 6. Codex: print the config.toml snippet, never edit TOML
  if (plan.tools.includes('codex')) {
    console.log('Codex detected. Add this to ~/.codex/config.toml by hand (vault never edits TOML):');
    console.log(codexSnippetText(bin));
  }

  // 7. mine --from-now semantics inline: fast-forward offsets, print the mining daemon line
  if (await confirm('fast-forward mining offsets (so `vault mine` only ever looks at new sessions from here on)')) {
    const root = join(home, '.claude', 'projects');
    const offsets = readOffsets(vaultDir);
    let forwarded = 0;
    for (const file of discoverTranscripts(root)) {
      const size = statSync(file).size;
      if ((offsets[file] ?? 0) < size) {
        offsets[file] = size;
        forwarded++;
      }
    }
    writeOffsets(vaultDir, offsets);
    console.log(`Fast-forwarded ${forwarded} transcript(s); mining starts fresh from here.`);
    done.push(`fast-forwarded ${forwarded} transcript offset(s)`);
  }
  console.log(
    `Mining daemon (optional, costs API calls via the claude CLI): create ~/Library/LaunchAgents/dev.vault.mine.plist ` +
      `running \`${binDisplay(bin)} mine\` on a schedule, then: launchctl load ~/Library/LaunchAgents/dev.vault.mine.plist`,
  );

  // 8. darwin only: offer the free local refresh daemon
  if (process.platform === 'darwin') {
    if (await confirm('install the refresh daemon (hourly `vault compile --all`, local and free)')) {
      const plistPath = writeRefreshPlist(home, vaultDir, bin);
      console.log(`Wrote refresh daemon plist at ${plistPath}`);
      if (!process.env.VAULT_SETUP_NO_LAUNCHCTL) {
        spawnSync('launchctl', ['load', plistPath]);
        console.log(`Loaded ${plistPath}`);
      }
      done.push('installed the refresh daemon');
    }
  } else {
    console.log(`Non-macOS: no launchd here. Add a cron entry instead, e.g.: 0 * * * * ${binDisplay(bin)} compile --all`);
  }

  // 9. final compile --all with the plan's adapters
  if (plan.adapters.length) {
    if (await confirm(`compile the vault into ${plan.adapters.join(', ')} for every registered project`)) {
      const budget = readConfig(vaultDir).compile.token_budget;
      const result = compileAll(vaultDir, plan.adapters, { budget });
      for (const w of result.wrote) console.log(`wrote ${w}`);
      for (const s of result.skipped) console.log(`skipped ${s.target}: ${s.reason}`);
      console.log(`Compiled ${result.compiledProjects} project(s), skipped ${result.skipped.length} file(s).`);
      done.push(`compiled ${result.compiledProjects} project(s)`);
    }
  }

  console.log('\nSetup summary:');
  console.log(done.length ? done.map((d) => `  - ${d}`).join('\n') : '  (nothing changed)');
  console.log('\nManual follow-ups:');
  if (plan.tools.includes('claude-code')) console.log(`  - Claude Code MCP: ${claudeMcpLine}`);
  if (plan.tools.includes('codex')) console.log(`  - Codex: add the printed [mcp_servers.vault] snippet to ~/.codex/config.toml`);
}
