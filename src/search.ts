import { listProjects } from './project.js';
import { listRecords } from './records.js';
import type { VaultRecord } from './types.js';

export interface SearchHit { projectId: string; record: VaultRecord }

/** case-insensitive substring search over title + body, all projects, superseded excluded */
export function searchRecords(vaultDir: string, query: string): SearchHit[] {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const p of listProjects(vaultDir)) {
    for (const record of listRecords(vaultDir, p.id)) {
      if (record.meta.status === 'superseded') continue;
      if (record.title.toLowerCase().includes(q) || record.body.toLowerCase().includes(q)) {
        hits.push({ projectId: p.id, record });
      }
    }
  }
  return hits;
}
