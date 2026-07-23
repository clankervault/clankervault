import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import type { ProjectInfo, ProjectKind, ProjectRoot } from './types.js';
import { shortId, slugify } from './util.js';
import { readDeviceConfig } from './vault.js';

export function createProject(
  vaultDir: string, name: string,
  opts: { kind?: ProjectKind; roots?: ProjectRoot[] } = {},
): ProjectInfo {
  const id = `${slugify(name)}-${shortId()}`;
  const dir = join(vaultDir, 'projects', id);
  mkdirSync(join(dir, 'records'), { recursive: true });
  const meta = {
    id, name, aliases: [], kind: opts.kind ?? 'code', roots: opts.roots ?? [],
  };
  writeFileSync(join(dir, 'project.md'), matter.stringify(`\n# ${name}\n\n## Facts\n`, meta));
  writeFileSync(join(dir, 'state.md'), `# State\n\nNothing in progress.\n`);
  return { ...meta, facts: `# ${name}\n\n## Facts`, dir };
}

function readProject(vaultDir: string, id: string): ProjectInfo | null {
  const dir = join(vaultDir, 'projects', id);
  const file = join(dir, 'project.md');
  if (!existsSync(file)) return null;
  const { data, content } = matter(readFileSync(file, 'utf8'));
  return {
    id: data.id ?? id,
    name: data.name ?? id,
    aliases: data.aliases ?? [],
    kind: (data.kind as ProjectKind) ?? 'code',
    roots: (data.roots as ProjectRoot[]) ?? [],
    facts: content.trim(),
    dir,
  };
}

export function listProjects(vaultDir: string): ProjectInfo[] {
  const root = join(vaultDir, 'projects');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readProject(vaultDir, d.name))
    .filter((p): p is ProjectInfo => p !== null);
}

export function getProject(vaultDir: string, ref: string): ProjectInfo | null {
  const wanted = ref.toLowerCase();
  return (
    listProjects(vaultDir).find(
      (p) =>
        p.id === wanted ||
        slugify(p.name) === wanted ||
        p.id.replace(/-[0-9a-f]{4}$/, '') === wanted ||
        p.aliases.some((a) => a.toLowerCase() === wanted),
    ) ?? null
  );
}

export function normalizeGitUrl(url: string): string {
  return url
    .trim().toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')   // https:// ssh://
    .replace(/^[^@/]+@/, '')        // git@
    .replace(':', '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

function cwdGitRemote(cwd: string): string | null {
  const out = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (out.status !== 0) return null;
  return out.stdout.trim() || null;
}

/** walk up from cwd looking for a .vault-id file; return its content */
function findVaultIdFile(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const f = join(dir, '.vault-id');
    if (existsSync(f)) return readFileSync(f, 'utf8').trim();
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveProjectFromCwd(vaultDir: string, cwd: string): ProjectInfo | null {
  const projects = listProjects(vaultDir);
  const abs0 = resolve(cwd);

  // 1. explicit .vault-id marker wins
  const marked = findVaultIdFile(cwd);
  if (marked) {
    const p = projects.find((p) => p.id === marked);
    if (p) return p;
  }

  // 2. device.yaml projects map (local, per-device path mapping - spec §7)
  const device = readDeviceConfig(vaultDir);
  for (const [id, root] of Object.entries(device.projects)) {
    const rootAbs = resolve(root);
    if (abs0 === rootAbs || abs0.startsWith(rootAbs + sep)) {
      const p = projects.find((p) => p.id === id);
      if (p) return p;
    }
  }

  // 3. git remote match
  const remote = cwdGitRemote(cwd);
  if (remote) {
    const norm = normalizeGitUrl(remote);
    for (const p of projects) {
      if (p.roots.some((r) => r.git && normalizeGitUrl(r.git) === norm)) return p;
    }
  }

  // 4. path prefix match from synced roots
  const abs = abs0;
  for (const p of projects) {
    for (const r of p.roots) {
      if (!r.path) continue;
      const rootAbs = resolve(r.path);
      if (abs === rootAbs || abs.startsWith(rootAbs + sep)) return p;
    }
  }
  return null;
}
