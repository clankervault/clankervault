import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initVault } from '../src/vault.js';
import { createRecord, listRecords, findRecord, supersedeRecord } from '../src/records.js';
import { tmpDir } from './helpers.js';

let dir: string;
beforeEach(() => {
  dir = tmpDir();
  initVault(dir);
  mkdirSync(join(dir, 'projects', 'demo', 'records'), { recursive: true });
});

describe('createRecord', () => {
  it('writes a spec-conformant record file', () => {
    const r = createRecord(dir, 'demo', {
      type: 'recipe',
      title: 'Export shorts verze',
      body: '## Postup\n`ffmpeg -crf 18`\n\n## Proč takhle\nNižší CRF.',
      scope: 'export',
      tags: ['ffmpeg', 'shorts'],
    });
    expect(r.meta.id).toMatch(/^rcp-\d{4}-\d{2}-\d{2}-[0-9a-f]{4}$/);
    expect(r.meta.status).toBe('confirmed');    // manual default
    expect(r.meta.confidence).toBe('high');
    expect(r.meta.source).toBeNull();
    const raw = readFileSync(r.path, 'utf8');
    expect(raw).toContain('type: recipe');
    expect(raw).toContain('# Export shorts verze');
  });
  it('uses type-specific id prefixes', () => {
    expect(createRecord(dir, 'demo', { type: 'fact', title: 'a' }).meta.id).toMatch(/^fct-/);
    expect(createRecord(dir, 'demo', { type: 'decision', title: 'b' }).meta.id).toMatch(/^dec-/);
    expect(createRecord(dir, 'demo', { type: 'taste', title: 'c' }).meta.id).toMatch(/^tst-/);
  });
  it('never overwrites an existing file with the same slug', () => {
    const a = createRecord(dir, 'demo', { type: 'fact', title: 'Same title' });
    const b = createRecord(dir, 'demo', { type: 'fact', title: 'Same title' });
    expect(a.path).not.toBe(b.path);
  });
});

describe('listRecords / findRecord', () => {
  it('round-trips records', () => {
    createRecord(dir, 'demo', { type: 'fact', title: 'Deploy on Vercel' });
    const all = listRecords(dir, 'demo');
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Deploy on Vercel');
    expect(findRecord(dir, 'demo', all[0].meta.id)?.title).toBe('Deploy on Vercel');
    expect(findRecord(dir, 'demo', 'fct-0000-00-00-dead')).toBeNull();
  });
});

describe('supersedeRecord', () => {
  it('creates new record and marks old one superseded (append-only)', () => {
    const old = createRecord(dir, 'demo', { type: 'decision', title: 'Prisma' });
    const { old: updated, created } = supersedeRecord(dir, 'demo', old.meta.id, {
      type: 'decision',
      title: 'Drizzle instead of Prisma',
      body: 'Edge runtime support.',
    });
    expect(created.meta.supersedes).toBe(old.meta.id);
    expect(updated.meta.status).toBe('superseded');
    expect(updated.meta.superseded_by).toBe(created.meta.id);
    // old body untouched
    expect(readFileSync(updated.path, 'utf8')).toContain('# Prisma');
  });
});
