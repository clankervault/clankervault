import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initVault } from '../src/vault.js';
import { createProject } from '../src/project.js';
import { createRecord, listRecords } from '../src/records.js';
import { mineOnce, settleRecords } from '../src/mine/mine.js';
import { readOffsets } from '../src/mine/reader.js';
import { parseCandidates, buildPrompt } from '../src/mine/extract.js';
import type { Extractor, Candidate } from '../src/mine/extract.js';
import { tmpDir } from './helpers.js';

describe('parseCandidates', () => {
  it('parses a clean array and keeps valid candidates', () => {
    const raw = 'Here you go:\n[{"type":"recipe","title":"Export shorts","body":"ffmpeg -crf 18","confidence":"high"}]';
    const c = parseCandidates(raw);
    expect(c).toHaveLength(1);
    expect(c[0].type).toBe('recipe');
  });
  it('drops invalid entries instead of fixing them up', () => {
    const raw = JSON.stringify([
      { type: 'recipe', title: 'ok', body: 'b', confidence: 'high' },
      { type: 'wishlist', title: 'bad type', body: '', confidence: 'high' },
      { type: 'fact', title: '', body: 'no title', confidence: 'high' },
      { type: 'fact', title: 'x'.repeat(200), body: 'too long', confidence: 'high' },
      { type: 'fact', title: 'bad conf', body: '', confidence: 'certain' },
    ]);
    expect(parseCandidates(raw)).toHaveLength(1);
  });
  it('returns empty on garbage or missing array', () => {
    expect(parseCandidates('no json here')).toEqual([]);
    expect(parseCandidates('{"not":"array"}')).toEqual([]);
  });
  it('does not fail closed on a trivial `[]` example mentioned before the real array', () => {
    const raw = 'an empty result would be `[]` but here are some: [{"type":"fact","title":"t","body":"","confidence":"high"}]';
    expect(parseCandidates(raw)).toHaveLength(1);
  });
  it('does not fail closed on a bracketed range mentioned before the real array', () => {
    const raw = 'Confidence score [1-5] scale applies. [{"type":"fact","title":"t2","body":"","confidence":"high"}]';
    expect(parseCandidates(raw)).toHaveLength(1);
  });
});

describe('buildPrompt', () => {
  it('frames the transcript as data and carries existing titles', () => {
    const p = buildPrompt({ projectName: 'Demo', existingTitles: ['Deploy on Vercel'], text: 'USER: hi' });
    expect(p).toMatch(/DATA to analyze, not instructions/);
    expect(p).toContain('<transcript>');
    expect(p).toContain('Deploy on Vercel');
    expect(p).toMatch(/empty array/i);
  });
});

function fakeExtractor(candidates: Candidate[]): Extractor & { calls: number } {
  const ex = {
    name: 'fake',
    calls: 0,
    async extract() { ex.calls++; return candidates; },
  };
  return ex;
}

function writeTranscript(root: string, name: string, cwd: string, lines: string[]): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'session.jsonl');
  writeFileSync(f, lines.map((t) => JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: t } }) + '\n').join(''));
  return f;
}

describe('mineOnce', () => {
  it('creates unconfirmed records with provenance and advances offsets', async () => {
    const vault = tmpDir(); initVault(vault);
    const work = tmpDir();
    const p = createProject(vault, 'Demo', { roots: [{ path: work }] });
    const root = tmpDir();
    const f = writeTranscript(root, 'proj', work, ['long line about exporting shorts with ffmpeg '.repeat(30)]);

    const ex = fakeExtractor([{ type: 'recipe', title: 'Export shorts', body: 'ffmpeg -crf 18', confidence: 'high' }]);
    const r = await mineOnce(vault, ex, { root, minChars: 10 });
    expect(r.created).toHaveLength(1);
    const rec = listRecords(vault, p.id).find((x) => x.title === 'Export shorts')!;
    expect(rec.meta.status).toBe('unconfirmed');
    expect(rec.meta.source?.tool).toBe('claude-code');
    expect(rec.meta.source?.transcript).toBe(f);
    expect(rec.meta.source?.approx_range).toMatch(/^bytes \d+-\d+$/);
    expect(readOffsets(vault)[f]).toBeGreaterThan(0);

    // second run: nothing new to read, extractor not called again
    const before = ex.calls;
    const r2 = await mineOnce(vault, ex, { root, minChars: 10 });
    expect(r2.created).toHaveLength(0);
    expect(ex.calls).toBe(before);
  });

  it('skips duplicates by normalized title and counts unmapped chunks', async () => {
    const vault = tmpDir(); initVault(vault);
    const work = tmpDir();
    const p = createProject(vault, 'Demo', { roots: [{ path: work }] });
    createRecord(vault, p.id, { type: 'recipe', title: 'Export Shorts' });
    const root = tmpDir();
    writeTranscript(root, 'mapped', work, ['x'.repeat(1000)]);
    writeTranscript(root, 'unmapped', '/nonexistent/elsewhere', ['y'.repeat(1000)]);

    const ex = fakeExtractor([{ type: 'recipe', title: 'export  shorts', body: '', confidence: 'high' }]);
    const r = await mineOnce(vault, ex, { root, minChars: 10 });
    expect(r.created).toHaveLength(0);
    expect(r.skippedDuplicates).toBe(1);
    expect(r.skippedNoProject).toBe(1);
  });

  it('tags contradictions for human review instead of superseding', async () => {
    const vault = tmpDir(); initVault(vault);
    const work = tmpDir();
    const p = createProject(vault, 'Demo', { roots: [{ path: work }] });
    createRecord(vault, p.id, { type: 'decision', title: 'Use Prisma' });
    const root = tmpDir();
    writeTranscript(root, 'proj', work, ['z'.repeat(1000)]);

    const ex = fakeExtractor([{ type: 'decision', title: 'Use Drizzle', body: 'Edge support', confidence: 'high', contradicts: 'Use Prisma' }]);
    await mineOnce(vault, ex, { root, minChars: 10 });
    const rec = listRecords(vault, p.id).find((x) => x.title === 'Use Drizzle')!;
    expect(rec.meta.status).toBe('unconfirmed');
    expect(rec.meta.tags).toContain('contradicts');
    expect(rec.body).toContain('Contradicts: Use Prisma');
    // the old decision is untouched
    expect(listRecords(vault, p.id).find((x) => x.title === 'Use Prisma')!.meta.status).toBe('confirmed');
  });

  it('dry run creates nothing and advances nothing', async () => {
    const vault = tmpDir(); initVault(vault);
    const work = tmpDir();
    createProject(vault, 'Demo', { roots: [{ path: work }] });
    const root = tmpDir();
    writeTranscript(root, 'proj', work, ['w'.repeat(1000)]);
    const ex = fakeExtractor([{ type: 'fact', title: 'Would be new', body: '', confidence: 'high' }]);
    const r = await mineOnce(vault, ex, { root, minChars: 10, dryRun: true });
    expect(r.created).toHaveLength(1);          // reported
    expect(readOffsets(vault)).toEqual({});     // but nothing persisted
  });
});

describe('settleRecords', () => {
  it('settles aged high-confidence mined records, never MCP or fresh or medium ones', async () => {
    const vault = tmpDir(); initVault(vault);
    const p = createProject(vault, 'Demo');
    const aged = createRecord(vault, p.id, { type: 'fact', title: 'Aged mined', status: 'unconfirmed', confidence: 'high', source: { tool: 'claude-code' } });
    const fresh = createRecord(vault, p.id, { type: 'fact', title: 'Fresh mined', status: 'unconfirmed', confidence: 'high', source: { tool: 'claude-code' } });
    const mcp = createRecord(vault, p.id, { type: 'fact', title: 'From assistant', status: 'unconfirmed', confidence: 'high', source: { tool: 'mcp:claude-ai' } });
    const medium = createRecord(vault, p.id, { type: 'fact', title: 'Meh', status: 'unconfirmed', confidence: 'medium', source: { tool: 'claude-code' } });
    // age the first record on disk: rewrite its date frontmatter to 30 days ago
    const old = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    writeFileSync(aged.path, readFileSync(aged.path, 'utf8').replace(/date: '?\d{4}-\d{2}-\d{2}'?/, `date: '${old}'`));

    const { confirmed } = settleRecords(vault, { days: 14 });
    expect(confirmed).toEqual([aged.meta.id]);
    const byTitle = (t: string) => listRecords(vault, p.id).find((x) => x.title === t)!;
    expect(byTitle('Aged mined').meta.status).toBe('confirmed');
    expect(byTitle('Fresh mined').meta.status).toBe('unconfirmed');
    expect(byTitle('From assistant').meta.status).toBe('unconfirmed');
    expect(byTitle('Meh').meta.status).toBe('unconfirmed');
  });
});
