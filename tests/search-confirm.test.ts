import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { initVault } from '../src/vault.js';
import { createProject } from '../src/project.js';
import { createRecord, supersedeRecord, confirmRecord, parseRecordFile } from '../src/records.js';
import { searchRecords } from '../src/search.js';
import { tmpDir } from './helpers.js';
import type { ProjectInfo } from '../src/types.js';

let dir: string;
let p: ProjectInfo;
beforeEach(() => {
  dir = tmpDir();
  initVault(dir);
  p = createProject(dir, 'Demo');
});

describe('searchRecords', () => {
  it('finds by title and body across projects, case-insensitive', () => {
    const p2 = createProject(dir, 'Other');
    createRecord(dir, p.id, { type: 'fact', title: 'Deploy on Vercel' });
    createRecord(dir, p2.id, { type: 'recipe', title: 'Export', body: 'use FFMPEG -crf 18' });
    expect(searchRecords(dir, 'vercel').map((h) => h.projectId)).toEqual([p.id]);
    expect(searchRecords(dir, 'ffmpeg')[0].projectId).toBe(p2.id);
    expect(searchRecords(dir, 'nonexistent')).toHaveLength(0);
  });
  it('excludes superseded records', () => {
    const old = createRecord(dir, p.id, { type: 'decision', title: 'Prisma forever' });
    supersedeRecord(dir, p.id, old.meta.id, { type: 'decision', title: 'Drizzle now' });
    const hits = searchRecords(dir, 'prisma');
    expect(hits).toHaveLength(0);
  });
});

describe('confirmRecord', () => {
  it('flips unconfirmed to confirmed, frontmatter only', () => {
    const r = createRecord(dir, p.id, {
      type: 'fact', title: 'From assistant', body: 'detail line',
      status: 'unconfirmed', source: { tool: 'mcp:claude-ai' },
    });
    const updated = confirmRecord(dir, p.id, r.meta.id);
    expect(updated.meta.status).toBe('confirmed');
    const onDisk = parseRecordFile(r.path);
    expect(onDisk.meta.status).toBe('confirmed');
    expect(onDisk.body).toContain('detail line');
    expect(onDisk.meta.source?.tool).toBe('mcp:claude-ai');   // provenance is preserved
  });
  it('is idempotent on confirmed and refuses superseded', () => {
    const r = createRecord(dir, p.id, { type: 'fact', title: 'Solid' });
    expect(confirmRecord(dir, p.id, r.meta.id).meta.status).toBe('confirmed');
    const old = createRecord(dir, p.id, { type: 'fact', title: 'Old' });
    supersedeRecord(dir, p.id, old.meta.id, { type: 'fact', title: 'New' });
    expect(() => confirmRecord(dir, p.id, old.meta.id)).toThrow(/superseded/);
    expect(() => confirmRecord(dir, p.id, 'fct-0000-00-00-dead')).toThrow(/not found/);
  });
});
