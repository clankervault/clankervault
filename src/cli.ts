#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultVaultDir, initVault, readConfig, requireVault } from './vault.js';
import { createProject, getProject, listProjects, resolveProjectFromCwd } from './project.js';
import { createRecord, listRecords, supersedeRecord } from './records.js';
import { applyBudget, gatherContext } from './compile.js';
import { adapters, getAdapter } from './adapters/index.js';
import type { ProjectInfo, RecordType } from './types.js';

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
  .action((name: string, opts: { kind: 'code' | 'creative'; root: string[]; git: string[] }) => {
    const dir = requireVault(vaultDir());
    const roots = [...opts.root.map((p) => ({ path: p })), ...opts.git.map((g) => ({ git: g }))];
    const p = createProject(dir, name, { kind: opts.kind, roots });
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
  .description('add a record (written by hand → confirmed)')
  .action((type: string, title: string, opts: { project?: string; body?: string; scope?: string; tags?: string }) => {
    if (!['fact', 'recipe', 'decision', 'taste'].includes(type)) {
      console.error(`Unknown type "${type}". Use: fact | recipe | decision | taste (work in progress goes to \`vault state\`).`);
      process.exit(1);
    }
    const p = needProject(opts.project);
    const r = createRecord(vaultDir(), p.id, {
      type: type as RecordType, title,
      body: opts.body, scope: opts.scope,
      tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
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
    const q = query.toLowerCase();
    for (const p of listProjects(dir)) {
      for (const r of listRecords(dir, p.id)) {
        if (r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q)) {
          console.log(`${p.id}  ${r.meta.id}  ${r.title}`);
        }
      }
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
    const budget = opts.budget ? Number(opts.budget) : readConfig(dir).compile.token_budget;
    const ctx = applyBudget(gatherContext(dir, p), budget);
    const outDir = opts.out ?? process.cwd();
    for (const name of opts.tool.split(',').map((t) => t.trim()).filter(Boolean)) {
      const adapter = getAdapter(name);
      const target = join(outDir, adapter.filename);
      writeFileSync(target, adapter.render(ctx));
      console.log(`wrote ${target}`);
    }
    if (ctx.droppedCount) console.log(`(${ctx.droppedCount} records over budget omitted, raise compile.token_budget in vault.yaml if needed)`);
    console.log('Remember: generated files belong in .gitignore.');
  });

program.parse();
