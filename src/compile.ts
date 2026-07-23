import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { listRecords } from './records.js';
import type { CompiledContext, DeviceConfig, ProjectInfo, ProjectKind, RecordType, VaultRecord } from './types.js';
import { estimateTokens } from './util.js';
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

/** spec §7: {project_root} from device.projects, {name} from device.anchors; unknown stay literal */
export function expandAnchors(text: string, device: DeviceConfig, projectId: string): string {
  return text.replace(/\{([a-z0-9_:-]+)\}/gi, (whole, name: string) => {
    if (name === 'project_root') return device.projects[projectId] ?? whole;
    return device.anchors[name] ?? whole;
  });
}

/** spec §7: contextual availability note for the current device */
function availabilityNote(r: VaultRecord, device: DeviceConfig): string | null {
  const av = r.meta.availability;
  if (!av) return null;
  const here = av[device.device];
  const elsewhere = Object.entries(av)
    .filter(([d]) => d !== device.device)
    .map(([d, p]) => (p ? `${d}: ${p}` : `${d}: not there`))
    .join(', ');
  return here
    ? `(on this device: ${here}${elsewhere ? `; also ${elsewhere}` : ''})`
    : `(NOT on this device (${device.device}); ${elsewhere || 'location unknown'})`;
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
    if (r.meta.status === 'unconfirmed') {
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
      const line = firstMeaningfulLine(body.replace(/^#.+$/m, ''));
      globalTaste.push(line ? `- ${title}: ${line}` : `- ${title}`);
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
