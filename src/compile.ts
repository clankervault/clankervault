import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { getAdapter, isGenerated } from './adapters/index.js';
import { listProjects } from './project.js';
import { listRecords } from './records.js';
import type { CompiledContext, DeviceConfig, ProjectInfo, ProjectKind, RecordType, VaultRecord } from './types.js';
import { estimateTokens, today } from './util.js';
import { readDeviceConfig } from './vault.js';

/** which record types survive budget cuts longest; state always survives */
export const PRIORITY: Record<ProjectKind, RecordType[]> = {
  creative: ['taste', 'recipe', 'decision', 'fact'],
  code: ['decision', 'recipe', 'taste', 'fact'],
};

function firstMeaningfulLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    return line.replace(/\s+/g, ' ').slice(0, 160);
  }
  return '';
}

export function condense(r: VaultRecord): string {
  const detail = firstMeaningfulLine(r.body);
  return detail
    ? `- ${r.title}: ${detail} [${r.meta.id}]`
    : `- ${r.title} [${r.meta.id}]`;
}

/**
 * spec §7: {project_root} from device.projects, {name} from device.anchors; unknown stay literal.
 * Anchor names are lowercase by convention; matching is case-sensitive.
 */
export function expandAnchors(text: string, device: DeviceConfig, projectId: string): string {
  return text.replace(/\{([a-z0-9_:-]+)\}/g, (whole, name: string) => {
    if (name === 'project_root') return device.projects[projectId] ?? whole;
    return device.anchors[name] ?? whole;
  });
}

/**
 * spec §7: contextual availability note for the current device.
 * Explicit null = confirmed absent; device missing from the map = not tracked (unknown).
 */
function availabilityNote(r: VaultRecord, device: DeviceConfig): string | null {
  const av = r.meta.availability;
  if (!av) return null;
  const tracked = device.device in av;
  const here = av[device.device];
  const elsewhere = Object.entries(av)
    .filter(([d]) => d !== device.device)
    .map(([d, p]) => (p ? `${d}: ${p}` : `${d}: not there`))
    .join(', ');
  if (here) return `(on this device: ${here}${elsewhere ? `; also ${elsewhere}` : ''})`;
  return tracked
    ? `(NOT on this device (${device.device}); ${elsewhere || 'location unknown'})`
    : `(availability not tracked for ${device.device}; ${elsewhere || 'location unknown'})`;
}

function readBody(file: string): string | null {
  if (!existsSync(file)) return null;
  const { content } = matter(readFileSync(file, 'utf8'));
  const trimmed = content.trim();
  return trimmed || null;
}

export function gatherContext(vaultDir: string, project: ProjectInfo): CompiledContext {
  const device = readDeviceConfig(vaultDir);
  const records: Record<RecordType, string[]> = { fact: [], recipe: [], decision: [], taste: [] };
  const unconfirmed: string[] = [];

  const line = (r: VaultRecord): string => {
    const note = availabilityNote(r, device);
    return expandAnchors(note ? `${condense(r)} ${note}` : condense(r), device, project.id);
  };

  for (const r of listRecords(vaultDir, project.id)) {
    if (r.meta.status === 'superseded') continue;
    // spec §8: expired records stay in the vault but are never served
    if (r.meta.expires && r.meta.expires < today()) continue;
    if (r.meta.status === 'unconfirmed') {
      // spec §8: records written via MCP never compile until a human confirms them
      // (memory poisoning defense: compiled files are instructions for the model)
      if (r.meta.source?.tool?.startsWith('mcp')) continue;
      if (r.meta.confidence === 'high') unconfirmed.push(line(r));
      continue; // medium/low unconfirmed stay in the vault, never compiled
    }
    records[r.meta.type].push(line(r));
  }

  const tasteDir = join(vaultDir, 'me', 'taste');
  const globalTaste: string[] = [];
  if (existsSync(tasteDir)) {
    for (const f of readdirSync(tasteDir).filter((f) => f.endsWith('.md')).sort()) {
      const body = readBody(join(tasteDir, f));
      if (!body) continue;
      const title = body.match(/^#\s+(.+)$/m)?.[1] ?? f.replace(/\.md$/, '');
      const tasteLine = firstMeaningfulLine(body.replace(/^#.+$/m, ''));
      globalTaste.push(expandAnchors(tasteLine ? `- ${title}: ${tasteLine}` : `- ${title}`, device, project.id));
    }
  }

  const stateRaw = readBody(join(project.dir, 'state.md'));
  const state = stateRaw && !/^#?\s*state\s*nothing in progress\.?$/i.test(stateRaw.replace(/\n+/g, ' ').trim())
    ? stateRaw : null;

  return {
    project,
    device,
    profile: readBody(join(vaultDir, 'me', 'profile.md')),
    globalTaste,
    records,
    unconfirmed,
    state: state ? expandAnchors(state, device, project.id) : null,
    droppedCount: 0,
  };
}

export function applyBudget(ctx: CompiledContext, budget: number): CompiledContext {
  // fixed parts always ship: identity, profile, state, global taste, unconfirmed
  const fixed = [ctx.project.facts, ctx.profile ?? '', ctx.state ?? '', ...ctx.globalTaste, ...ctx.unconfirmed]
    .map(estimateTokens)
    .reduce((a, b) => a + b, 0);

  let remaining = budget - fixed;
  const order = PRIORITY[ctx.project.kind];
  const kept: Record<RecordType, string[]> = { fact: [], recipe: [], decision: [], taste: [] };
  let dropped = 0;

  for (const type of order) {
    for (const line of ctx.records[type]) {
      const cost = estimateTokens(line);
      if (remaining - cost >= 0) {
        kept[type].push(line);
        remaining -= cost;
      } else {
        dropped++;
      }
    }
  }
  return { ...ctx, records: kept, droppedCount: dropped };
}

export interface CompileAllResult {
  compiledProjects: number;
  wrote: string[];
  skipped: { target: string; reason: string }[];
}

/**
 * shared by `clanker compile --all` and the setup wizard's final step: compile every
 * project that has an existing on-disk path root, into that root. One place for the
 * not-generated safety skip, so the two callers can never drift apart on it.
 */
export function compileAll(
  vaultDir: string,
  tools: string[],
  opts: { budget: number; force?: boolean },
): CompileAllResult {
  const wrote: string[] = [];
  const skipped: { target: string; reason: string }[] = [];
  let compiledProjects = 0;
  for (const p of listProjects(vaultDir)) {
    // first path root whose directory actually exists on this machine; projects
    // with no such root (git-only, or roots not mounted here) are skipped silently
    const root = p.roots.find((r) => r.path && existsSync(r.path));
    if (!root?.path) continue;
    const ctx = applyBudget(gatherContext(vaultDir, p), opts.budget);
    for (const name of tools) {
      const adapter = getAdapter(name);
      const target = join(root.path, adapter.filename);
      // never clobber a hand-written file: only vault-generated targets are ours to replace
      if (!opts.force && existsSync(target) && !isGenerated(readFileSync(target, 'utf8').slice(0, 200))) {
        skipped.push({ target, reason: 'existing file is not vault-generated (use --force to overwrite)' });
        continue;
      }
      writeFileSync(target, adapter.render(ctx));
      wrote.push(target);
    }
    compiledProjects++;
  }
  return { compiledProjects, wrote, skipped };
}
