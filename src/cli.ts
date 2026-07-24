#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { defaultVaultDir, initVault, readConfig, readDeviceConfig, requireVault } from './vault.js';
import { createProject, getProject, listProjects, resolveProjectFromCwd } from './project.js';
import { confirmRecord, createRecord, listRecords, supersedeRecord } from './records.js';
import { searchRecords } from './search.js';
import { applyBudget, gatherContext } from './compile.js';
import { adapters, getAdapter } from './adapters/index.js';
import { logAccess } from './log.js';
import { runMcp } from './mcp.js';
import { DirBackend } from './sync/backend.js';
import { isExcluded, syncOnce } from './sync/engine.js';
import { ClaudeCliExtractor } from './mine/extract.js';
import { mineOnce, settleRecords } from './mine/mine.js';
import type { ProjectInfo, RecordType } from './types.js';

/** wrong-passphrase decryption failures surface as a raw AES-GCM error; give a human reason instead */
function friendlySyncError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Unsupported state') || msg.includes('unable to authenticate')) {
    return 'Sync failed to decrypt the remote. Wrong passphrase for this remote?';
  }
  return msg;
}

const program = new Command();
program
  .name('vault')
  .description('Portable memory for AI tools: one markdown vault, compiled into CLAUDE.md, AGENTS.md, .cursorrules.')
  .option('--vault <dir>', 'vault directory (default: $VAULT_DIR or ~/vault)');

function vaultDir(): string {
  return program.opts().vault ?? defaultVaultDir();
}

/** resolve project from --project flag or cwd; exit with guidance otherwise */
function needProject(ref: string | undefined): ProjectInfo {
  const dir = requireVault(vaultDir());
  const p = ref ? getProject(dir, ref) : resolveProjectFromCwd(dir, process.cwd());
  if (!p) {
    const known = listProjects(dir).map((x) => `  ${x.id}  (${x.name})`).join('\n');
    console.error(
      ref
        ? `Project "${ref}" not found.\nKnown projects:\n${known || '  (none)'}`
        : `Could not resolve a project from ${process.cwd()}.\nUse --project <id>, or add a root/.vault-id to one of:\n${known || '  (none, create one with `vault project new <name>`)'}`,
    );
    process.exit(1);
  }
  return p;
}

program
  .command('init')
  .argument('[dir]', 'where to create the vault')
  .description('create a new empty vault')
  .action((dir?: string) => {
    const target = dir ?? vaultDir();
    initVault(target);
    console.log(`Vault created at ${target}`);
    console.log('Next: `vault project new <name>` and edit me/profile.md');
  });

const project = program.command('project').description('manage projects');
project
  .command('new')
  .argument('<name>')
  .option('--kind <kind>', 'code | creative', 'code')
  .option('--root <path>', 'directory on disk that identifies this project (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--git <url>', 'git remote URL that identifies this project (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .action((name: string, opts: { kind: string; root: string[]; git: string[] }) => {
    if (!['code', 'creative'].includes(opts.kind)) {
      console.error(`Unknown kind "${opts.kind}". Use: code | creative`);
      process.exit(1);
    }
    const dir = requireVault(vaultDir());
    // resolve --root to an absolute path now, at registration time - stored roots
    // must never be re-interpreted against whatever cwd a later command runs from
    const roots = [...opts.root.map((p) => ({ path: resolve(p) })), ...opts.git.map((g) => ({ git: g }))];
    const p = createProject(dir, name, { kind: opts.kind as 'code' | 'creative', roots });
    console.log(`Project ${p.id} created at ${p.dir}`);
    if (!roots.length) console.log(`Tip: drop a .vault-id file containing "${p.id}" into the project folder on disk.`);
  });
project
  .command('list')
  .action(() => {
    const dir = requireVault(vaultDir());
    for (const p of listProjects(dir)) console.log(`${p.id}\t${p.name}\t(${p.kind})`);
  });

program
  .command('add')
  .argument('<type>', 'fact | recipe | decision | taste')
  .argument('<title>')
  .option('-p, --project <ref>')
  .option('-b, --body <text>')
  .option('-s, --scope <scope>')
  .option('-t, --tags <tags>', 'comma-separated')
  .option('-e, --expires <date>', 'YYYY-MM-DD after which this record stops compiling (volatile facts)')
  .description('add a record (written by hand → confirmed)')
  .action((type: string, title: string, opts: { project?: string; body?: string; scope?: string; tags?: string; expires?: string }) => {
    if (!['fact', 'recipe', 'decision', 'taste'].includes(type)) {
      console.error(`Unknown type "${type}". Use: fact | recipe | decision | taste (work in progress goes to \`vault state\`).`);
      process.exit(1);
    }
    const p = needProject(opts.project);
    const r = createRecord(vaultDir(), p.id, {
      type: type as RecordType, title,
      body: opts.body, scope: opts.scope,
      tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      expires: opts.expires,
    });
    console.log(`${r.meta.id}  ${r.path}`);
  });

program
  .command('supersede')
  .argument('<oldId>')
  .argument('<title>', 'title of the replacement record')
  .option('-p, --project <ref>')
  .option('-b, --body <text>')
  .description('replace a record append-only style (new record + superseded_by link)')
  .action((oldId: string, title: string, opts: { project?: string; body?: string }) => {
    const p = needProject(opts.project);
    const old = listRecords(vaultDir(), p.id).find((r) => r.meta.id === oldId);
    if (!old) { console.error(`Record ${oldId} not found in ${p.id}`); process.exit(1); }
    const { created } = supersedeRecord(vaultDir(), p.id, oldId, {
      type: old.meta.type, title, body: opts.body,
    });
    console.log(`${created.meta.id} supersedes ${oldId}`);
  });

program
  .command('confirm')
  .argument('<id>')
  .option('-p, --project <ref>')
  .description('confirm an unconfirmed record so it starts compiling')
  .action((id: string, opts: { project?: string }) => {
    const p = needProject(opts.project);
    confirmRecord(vaultDir(), p.id, id);
    console.log(`${id} confirmed`);
  });

program
  .command('state')
  .argument('[text...]', 'new state text; omit to print current state')
  .option('-p, --project <ref>')
  .description('read or overwrite state.md (the only mutable record)')
  .action((text: string[], opts: { project?: string }) => {
    const p = needProject(opts.project);
    const file = join(p.dir, 'state.md');
    if (text.length) {
      writeFileSync(file, `# State\n\n${text.join(' ')}\n`);
      console.log(`State updated for ${p.id}`);
    } else {
      console.log(readFileSync(file, 'utf8'));
    }
  });

program
  .command('list')
  .option('-p, --project <ref>')
  .option('--type <type>')
  .action((opts: { project?: string; type?: string }) => {
    const p = needProject(opts.project);
    for (const r of listRecords(vaultDir(), p.id)) {
      if (opts.type && r.meta.type !== opts.type) continue;
      console.log(`${r.meta.id}  [${r.meta.status}${r.meta.status === 'unconfirmed' ? `/${r.meta.confidence}` : ''}]  ${r.title}`);
    }
  });

program
  .command('search')
  .argument('<query>')
  .description('search titles and bodies across all projects')
  .action((query: string) => {
    const dir = requireVault(vaultDir());
    logAccess(dir, 'search', { query });
    for (const h of searchRecords(dir, query)) {
      console.log(`${h.projectId}  ${h.record.meta.id}  ${h.record.title}`);
    }
  });

program
  .command('compile')
  .option('-p, --project <ref>')
  .option('--tool <tools>', 'comma-separated adapters (claude,agents,cursor)', Object.keys(adapters).join(','))
  .option('--out <dir>', 'output directory (default: current directory)')
  .option('--budget <n>', 'token budget override')
  .description('compile the vault into native tool files')
  .action((opts: { project?: string; tool: string; out?: string; budget?: string }) => {
    const dir = requireVault(vaultDir());
    const p = needProject(opts.project);
    let budget = readConfig(dir).compile.token_budget;
    if (opts.budget !== undefined) {
      const parsed = Number(opts.budget);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`Invalid --budget "${opts.budget}": expected a positive number`);
        process.exit(1);
      }
      budget = parsed;
    }
    const ctx = applyBudget(gatherContext(dir, p), budget);
    const outDir = opts.out ?? process.cwd();
    for (const name of opts.tool.split(',').map((t) => t.trim()).filter(Boolean)) {
      const adapter = getAdapter(name);
      const target = join(outDir, adapter.filename);
      writeFileSync(target, adapter.render(ctx));
      console.log(`wrote ${target}`);
    }
    if (ctx.droppedCount) console.log(`(${ctx.droppedCount} records over budget omitted, raise compile.token_budget in vault.yaml if needed)`);
    logAccess(dir, 'compile', { project: p.id, tools: opts.tool });
    console.log('Remember: generated files belong in .gitignore.');
  });

program
  .command('mcp')
  .description('run the vault as an MCP server on stdio (connect from Claude Desktop, Claude Code, etc.)')
  .action(async () => {
    try {
      await runMcp(requireVault(vaultDir()));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command('mine')
  .option('--root <dir>', 'transcript root (default: ~/.claude/projects)')
  .option('--dry-run', 'show what would be created without writing')
  .option('--watch', 'keep running, mine every interval')
  .option('--interval <s>', 'watch interval seconds', '300')
  .description('mine session transcripts into unconfirmed records (claude-code reader)')
  .action(async (opts: { root?: string; dryRun?: boolean; watch?: boolean; interval: string }) => {
    try {
      const dir = requireVault(vaultDir());
      const extractor = new ClaudeCliExtractor();
      const runOnce = async () => {
        const r = await mineOnce(dir, extractor, { root: opts.root, dryRun: opts.dryRun });
        console.log(`mined: ${r.created.length} new records from ${r.chunksMined} chunks (${r.skippedDuplicates} duplicates, ${r.skippedNoProject} chunks without a matching project)`);
        for (const c of r.created) console.log(`  ${c.id}  [${c.projectId}]  ${c.title}`);
        if (r.created.length && !opts.dryRun) console.log('Review them with `vault list`, release with `vault confirm <id>` or let `vault settle` confirm them after they age.');
      };
      await runOnce();
      if (opts.watch) {
        setInterval(() => { runOnce().catch((e) => console.error(e instanceof Error ? e.message : String(e))); }, Number(opts.interval) * 1000);
        console.log(`mining every ${opts.interval}s, Ctrl+C to stop`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command('settle')
  .option('--days <n>', 'minimum age in days', '14')
  .option('-p, --project <ref>')
  .description('confirm aged unconfirmed high-confidence records (never MCP-written ones)')
  .action((opts: { days: string; project?: string }) => {
    const dir = requireVault(vaultDir());
    const days = Number(opts.days);
    if (!Number.isFinite(days) || days < 0) { console.error(`Invalid --days "${opts.days}"`); process.exit(1); }
    const projectId = opts.project ? needProject(opts.project).id : undefined;
    const { confirmed } = settleRecords(dir, { days, projectId });
    console.log(confirmed.length ? `settled: ${confirmed.join(', ')}` : 'nothing old enough to settle');
  });

const sync = program.command('sync').description('sync the vault with the configured remote (E2E encrypted)');
sync
  .command('setup')
  .requiredOption('--path <dir>', 'remote directory (mounted cloud folder, NAS, USB)')
  .option('--passphrase <p>', 'encryption passphrase (or set VAULT_PASSPHRASE)')
  .action((opts: { path: string; passphrase?: string }) => {
    const dir = requireVault(vaultDir());
    const file = join(dir, 'device.yaml');
    const raw = existsSync(file) ? parseYaml(readFileSync(file, 'utf8')) ?? {} : {};
    // merge, do not clobber: rerunning setup to change --path (or move to a new remote)
    // must not silently drop a passphrase saved on a previous run
    const existing = raw.sync && typeof raw.sync === 'object' ? raw.sync : {};
    raw.sync = {
      backend: 'dir',
      path: resolve(opts.path),
      ...(opts.passphrase ? { passphrase: opts.passphrase } : existing.passphrase ? { passphrase: existing.passphrase } : {}),
    };
    writeFileSync(file, stringifyYaml(raw));
    console.log(`Sync configured: ${resolve(opts.path)}`);
    console.log('Use the SAME passphrase on every device. It never leaves your machines.');
    if (!raw.sync.passphrase) console.log('No passphrase saved: set VAULT_PASSPHRASE before running `vault sync`.');
  });
sync
  .option('--watch', 'keep running and sync on changes')
  .option('--interval <s>', 'periodic sync interval in watch mode (seconds)', '30')
  .action(async (opts: { watch?: boolean; interval: string }) => {
    // commander does not await an async action, so an uncaught rejection here would
    // escape the top-level try/catch entirely (unhandled rejection, ugly stack trace,
    // and no guaranteed exit code) - catch everything in this action ourselves instead
    try {
      const dir = requireVault(vaultDir());
      const device = readDeviceConfig(dir);
      if (!device.sync) {
        console.error('Sync is not configured on this device. Run: vault sync setup --path <remoteDir>');
        process.exit(1);
      }
      const passphrase = process.env.VAULT_PASSPHRASE ?? device.sync.passphrase;
      if (!passphrase) {
        console.error('No passphrase. Set VAULT_PASSPHRASE or run `vault sync setup` with --passphrase.');
        process.exit(1);
      }
      const backend = new DirBackend(device.sync.path);
      const runOnce = async () => {
        const r = await syncOnce(dir, backend, passphrase, device.device);
        const total = r.uploaded.length + r.downloaded.length + r.deletedLocal.length + r.deletedRemote.length;
        if (total > 0 || r.conflicts.length > 0 || !opts.watch) {
          console.log(`synced: ${r.uploaded.length} up, ${r.downloaded.length} down, ${r.conflicts.length} conflicts`);
        }
        for (const c of r.conflicts) console.log(`conflict on ${c}: losing version saved next to it as a .conflict-<device> file`);
      };
      await runOnce();
      if (!opts.watch) return;
      let timer: NodeJS.Timeout | null = null;
      let running = false;
      const trigger = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          if (running) return trigger();
          running = true;
          try { await runOnce(); } catch (e) { console.error(friendlySyncError(e)); }
          running = false;
        }, 1500);
      };
      // same per-device exclusions as the sync engine itself (device.yaml, .sync/, .mine/, .DS_Store)
      watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && isExcluded(filename)) return;
        trigger();
      });
      setInterval(trigger, Number(opts.interval) * 1000);
      console.log(`watching ${dir} (interval ${opts.interval}s), Ctrl+C to stop`);
    } catch (err) {
      console.error(friendlySyncError(err));
      process.exit(1);
    }
  });

// expected user errors (no vault yet, vault exists, ...) print one clean line, not a stack trace
try {
  program.parse();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
