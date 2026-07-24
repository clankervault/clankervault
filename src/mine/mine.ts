import { listProjects, resolveProjectFromCwd } from '../project.js';
import { createRecord, listRecords, confirmRecord } from '../records.js';
import { logAccess } from '../log.js';
import type { Extractor } from './extract.js';
import { defaultTranscriptRoot, discoverTranscripts, readChunk, readOffsets, writeOffsets } from './reader.js';

export interface MineOptions { root?: string; dryRun?: boolean; minChars?: number }

export interface MineResult {
  files: number;
  chunksMined: number;
  created: { id: string; title: string; projectId: string }[];
  skippedNoProject: number;
  skippedDuplicates: number;
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

export async function mineOnce(vaultDir: string, extractor: Extractor, opts: MineOptions = {}): Promise<MineResult> {
  const root = opts.root ?? defaultTranscriptRoot();
  const minChars = opts.minChars ?? 800;
  const files = discoverTranscripts(root);
  const offsets = readOffsets(vaultDir);
  const result: MineResult = { files: files.length, chunksMined: 0, created: [], skippedNoProject: 0, skippedDuplicates: 0 };

  for (const file of files) {
    const chunk = readChunk(file, offsets[file] ?? 0);
    if (!chunk) continue;

    // meta-only lines (no user/assistant text, no cwd) will never turn into anything: advance
    // past them now rather than let them sit under minChars and get re-read on every run forever
    if (!chunk.text) {
      offsets[file] = chunk.toByte;
      continue;
    }

    if (chunk.text.length < minChars) continue;          // let it accumulate, offset untouched

    const project = chunk.cwd ? resolveProjectFromCwd(vaultDir, chunk.cwd) : null;
    if (!project) {
      result.skippedNoProject++;
      offsets[file] = chunk.toByte;                       // unmappable text never maps later either
      continue;
    }

    try {
      const existing = listRecords(vaultDir, project.id).filter((r) => r.meta.status !== 'superseded');
      const existingTitles = existing.map((r) => r.title);
      const candidates = await extractor.extract({ projectName: project.name, existingTitles, text: chunk.text });
      result.chunksMined++;
      const known = new Set(existingTitles.map(norm));
      for (const c of candidates) {
        if (known.has(norm(c.title))) { result.skippedDuplicates++; continue; }
        known.add(norm(c.title));
        if (!opts.dryRun) {
          const rec = createRecord(vaultDir, project.id, {
            type: c.type, title: c.title,
            body: c.contradicts ? `Contradicts: ${c.contradicts}\n\n${c.body}` : c.body,
            scope: c.scope,
            tags: c.contradicts ? [...(c.tags ?? []), 'contradicts'] : c.tags,
            status: 'unconfirmed', confidence: c.confidence,
            source: { tool: 'claude-code', transcript: file, approx_range: `bytes ${chunk.fromByte}-${chunk.toByte}` },
          });
          result.created.push({ id: rec.meta.id, title: rec.title, projectId: project.id });
        } else {
          result.created.push({ id: '(dry-run)', title: c.title, projectId: project.id });
        }
      }
      if (!opts.dryRun) offsets[file] = chunk.toByte;
    } catch (err) {
      console.error(`mine: ${file}: ${err instanceof Error ? err.message : String(err)}`);
      // offset NOT advanced: retried next run
    }
  }

  if (!opts.dryRun) writeOffsets(vaultDir, offsets);
  logAccess(vaultDir, 'mine', { files: result.files, created: result.created.length, extractor: extractor.name });
  return result;
}

/** spec section 8: provenance-capped settling. MCP-written records never settle on their own. */
export function settleRecords(vaultDir: string, opts: { days: number; projectId?: string }): { confirmed: string[] } {
  const confirmed: string[] = [];
  const projects = opts.projectId ? [opts.projectId] : listProjects(vaultDir).map((p) => p.id);
  const cutoff = new Date(Date.now() - opts.days * 86400000).toISOString().slice(0, 10);
  for (const pid of projects) {
    for (const r of listRecords(vaultDir, pid)) {
      if (r.meta.status !== 'unconfirmed') continue;
      if (r.meta.confidence !== 'high') continue;
      if (r.meta.source?.tool?.startsWith('mcp')) continue;
      if (r.meta.date > cutoff) continue;
      confirmRecord(vaultDir, pid, r.meta.id);
      confirmed.push(r.meta.id);
    }
  }
  logAccess(vaultDir, 'settle', { confirmed: confirmed.length, days: opts.days });
  return { confirmed };
}
