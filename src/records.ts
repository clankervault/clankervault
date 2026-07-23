import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { Confidence, RecordMeta, RecordSource, RecordStatus, RecordType, VaultRecord } from './types.js';
import { shortId, slugify, today } from './util.js';

const PREFIXES: Record<RecordType, string> = { fact: 'fct', recipe: 'rcp', decision: 'dec', taste: 'tst' };

export interface NewRecordInput {
  type: RecordType;
  title: string;
  body?: string;
  scope?: string;
  tags?: string[];
  status?: RecordStatus;
  confidence?: Confidence;
  source?: RecordSource | null;
}

function recordsDir(vaultDir: string, projectId: string): string {
  return join(vaultDir, 'projects', projectId, 'records');
}

export function createRecord(vaultDir: string, projectId: string, input: NewRecordInput): VaultRecord {
  const date = today();
  const meta: RecordMeta = {
    id: `${PREFIXES[input.type]}-${date}-${shortId()}`,
    type: input.type,
    date,
    status: input.status ?? 'confirmed',      // manual records default to confirmed
    supersedes: null,
    superseded_by: null,
    scope: input.scope ?? null,
    confidence: input.confidence ?? 'high',
    source: input.source ?? null,             // null = written by hand
    tags: input.tags ?? [],
  };
  const dir = recordsDir(vaultDir, projectId);
  let file = join(dir, `${date}-${slugify(input.title)}.md`);
  for (let n = 2; existsSync(file); n++) file = join(dir, `${date}-${slugify(input.title)}-${n}.md`);
  const body = input.body?.trim() ?? '';
  const content = matter.stringify(`\n# ${input.title}\n${body ? `\n${body}\n` : ''}`, meta as unknown as Record<string, unknown>);
  writeFileSync(file, content);
  return { meta, title: input.title, body, path: file };
}

export function parseRecordFile(filePath: string): VaultRecord {
  const { data, content } = matter(readFileSync(filePath, 'utf8'));
  const lines = content.split('\n');
  let title = '';
  const bodyLines: string[] = [];
  for (const line of lines) {
    if (!title && line.startsWith('# ')) { title = line.slice(2).trim(); continue; }
    bodyLines.push(line);
  }
  return {
    meta: {
      id: data.id, type: data.type, date: String(data.date).slice(0, 10),
      status: data.status ?? 'confirmed',
      supersedes: data.supersedes ?? null, superseded_by: data.superseded_by ?? null,
      scope: data.scope ?? null, confidence: data.confidence ?? 'high',
      source: data.source ?? null, tags: data.tags ?? [],
      availability: data.availability ?? null,
    },
    title: title || filePath.split('/').pop()!.replace(/\.md$/, ''),
    body: bodyLines.join('\n').trim(),
    path: filePath,
  };
}

export function listRecords(vaultDir: string, projectId: string): VaultRecord[] {
  const dir = recordsDir(vaultDir, projectId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parseRecordFile(join(dir, f)));
}

export function findRecord(vaultDir: string, projectId: string, id: string): VaultRecord | null {
  return listRecords(vaultDir, projectId).find((r) => r.meta.id === id) ?? null;
}

export function supersedeRecord(
  vaultDir: string, projectId: string, oldId: string, input: NewRecordInput,
): { old: VaultRecord; created: VaultRecord } {
  const old = findRecord(vaultDir, projectId, oldId);
  if (!old) throw new Error(`Record ${oldId} not found in project ${projectId}`);
  const created = createRecord(vaultDir, projectId, input);
  // rewrite frontmatter only — body stays untouched (append-only rule)
  const raw = matter(readFileSync(old.path, 'utf8'));
  raw.data.status = 'superseded';
  raw.data.superseded_by = created.meta.id;
  writeFileSync(old.path, matter.stringify(raw.content, raw.data));
  // stamp the link on the new record too
  const createdRaw = matter(readFileSync(created.path, 'utf8'));
  createdRaw.data.supersedes = old.meta.id;
  writeFileSync(created.path, matter.stringify(createdRaw.content, createdRaw.data));
  created.meta.supersedes = old.meta.id;
  return { old: parseRecordFile(old.path), created };
}
