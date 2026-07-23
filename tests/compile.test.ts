import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initVault } from '../src/vault.js';
import { createProject } from '../src/project.js';
import { createRecord } from '../src/records.js';
import { condense, gatherContext, applyBudget } from '../src/compile.js';
import { tmpDir } from './helpers.js';
import type { ProjectInfo } from '../src/types.js';

let dir: string;
let p: ProjectInfo;
beforeEach(() => {
  dir = tmpDir();
  initVault(dir);
  p = createProject(dir, 'Demo', { kind: 'code' });
});

describe('condense', () => {
  it('emits one line with title, first body line and id ref', () => {
    const r = createRecord(dir, p.id, {
      type: 'recipe', title: 'Export shorts',
      body: '## Postup\n`ffmpeg -crf 18`\nmore',
    });
    const line = condense(r);
    expect(line).toContain('Export shorts');
    expect(line).toContain('ffmpeg -crf 18');
    expect(line).toContain(`[${r.meta.id}]`);
    expect(line.startsWith('- ')).toBe(true);
  });
});

describe('gatherContext', () => {
  it('splits confirmed by type, unconfirmed-high separately, skips superseded and low', () => {
    createRecord(dir, p.id, { type: 'fact', title: 'Deploy Vercel' });
    createRecord(dir, p.id, { type: 'decision', title: 'Old choice', status: 'superseded' });
    createRecord(dir, p.id, { type: 'recipe', title: 'Fresh mined', status: 'unconfirmed', confidence: 'high' });
    createRecord(dir, p.id, { type: 'recipe', title: 'Noise', status: 'unconfirmed', confidence: 'low' });
    createRecord(dir, p.id, { type: 'recipe', title: 'Meh', status: 'unconfirmed', confidence: 'medium' });
    writeFileSync(join(p.dir, 'state.md'), '# State\n\nRefactoring payments.\n');
    writeFileSync(join(dir, 'me', 'taste', 'tone.md'), '# Tone\n\nNo em-dashes.\n');
    const ctx = gatherContext(dir, p);
    expect(ctx.records.fact).toHaveLength(1);
    expect(ctx.records.decision).toHaveLength(0);
    expect(ctx.unconfirmed).toHaveLength(1);
    expect(ctx.unconfirmed[0]).toContain('Fresh mined');
    expect(ctx.state).toContain('Refactoring payments');
    expect(ctx.globalTaste[0]).toContain('No em-dashes');
    expect(ctx.profile).toContain('Who I am');
  });
});

describe('anchors + availability', () => {
  it('expands anchors from device.yaml and flags missing assets on this device', () => {
    writeFileSync(join(dir, 'device.yaml'),
      `device: mini\nanchors:\n  nas: /Volumes/NAS\nprojects:\n  ${p.id}: /Users/mac/Development/demo\n`);
    const r = createRecord(dir, p.id, {
      type: 'fact', title: 'Raw footage',
      body: 'Zdroj: {project_root}/footage',
    });
    // availability is hand-edited frontmatter; simulate it
    const raw = readFileSync(r.path, 'utf8');
    writeFileSync(r.path, raw.replace('tags: []',
      'tags: []\navailability:\n  macbook: "{project_root}/footage"\n  nas: "{nas}/footage/x"\n  mini: null'));
    const ctx = gatherContext(dir, p);
    const line = ctx.records.fact[0];
    expect(line).toContain('/Users/mac/Development/demo/footage');   // {project_root} expanded
    expect(line).toMatch(/NOT on this device \(mini\)/);
    expect(line).toContain('/Volumes/NAS/footage/x');                // {nas} expanded
    expect(ctx.device.device).toBe('mini');
  });
});

describe('applyBudget', () => {
  it('cuts lowest-priority record lines first for code projects (facts before decisions)', () => {
    for (let i = 0; i < 30; i++) {
      createRecord(dir, p.id, { type: 'fact', title: `Fact ${i}`, body: 'x'.repeat(200) });
      createRecord(dir, p.id, { type: 'decision', title: `Decision ${i}`, body: 'x'.repeat(200) });
    }
    const full = gatherContext(dir, p);
    const cut = applyBudget(full, 1500);
    expect(cut.droppedCount).toBeGreaterThan(0);
    // decisions outrank facts for code projects
    expect(cut.records.decision.length).toBeGreaterThanOrEqual(cut.records.fact.length);
    expect(cut.records.decision.length).toBeGreaterThan(0);
  });
  it('keeps everything when budget is large', () => {
    createRecord(dir, p.id, { type: 'fact', title: 'One' });
    const ctx = applyBudget(gatherContext(dir, p), 100000);
    expect(ctx.droppedCount).toBe(0);
  });
});
