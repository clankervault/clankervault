import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { initVault } from '../src/vault.js';
import { createProject, getProject, listProjects, normalizeGitUrl, resolveProjectFromCwd } from '../src/project.js';
import { tmpDir } from './helpers.js';

let dir: string;
beforeEach(() => { dir = tmpDir(); initVault(dir); });

describe('createProject', () => {
  it('creates project.md, records/ and state.md with stable id', () => {
    const p = createProject(dir, 'Cettra Eshop', { kind: 'code' });
    expect(p.id).toMatch(/^cettra-eshop-[0-9a-f]{4}$/);
    expect(existsSync(join(p.dir, 'project.md'))).toBe(true);
    expect(existsSync(join(p.dir, 'records'))).toBe(true);
    expect(existsSync(join(p.dir, 'state.md'))).toBe(true);
  });
});

describe('getProject / listProjects', () => {
  it('finds by id, name slug and alias', () => {
    const p = createProject(dir, 'Cettra Eshop');
    expect(listProjects(dir)).toHaveLength(1);
    expect(getProject(dir, p.id)?.id).toBe(p.id);
    expect(getProject(dir, 'cettra-eshop')?.id).toBe(p.id);
    expect(getProject(dir, 'nope')).toBeNull();
  });
});

describe('normalizeGitUrl', () => {
  it('treats ssh and https forms as equal', () => {
    expect(normalizeGitUrl('git@github.com:me/repo.git')).toBe('github.com/me/repo');
    expect(normalizeGitUrl('https://github.com/me/repo')).toBe('github.com/me/repo');
    expect(normalizeGitUrl('https://github.com/Me/Repo.git/')).toBe('github.com/me/repo');
  });
});

describe('resolveProjectFromCwd', () => {
  it('resolves via .vault-id file walking up', () => {
    const p = createProject(dir, 'Demo');
    const work = tmpDir();
    const nested = join(work, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(work, '.vault-id'), p.id + '\n');
    expect(resolveProjectFromCwd(dir, nested)?.id).toBe(p.id);
  });
  it('resolves via device.yaml projects map', () => {
    const p = createProject(dir, 'DemoDev');
    const work = tmpDir();
    writeFileSync(join(dir, 'device.yaml'), `device: test\nanchors: {}\nprojects:\n  ${p.id}: ${work}\n`);
    expect(resolveProjectFromCwd(dir, work)?.id).toBe(p.id);
  });
  it('resolves via path root prefix', () => {
    const work = tmpDir();
    const p = createProject(dir, 'Demo2', { roots: [{ path: work }] });
    const nested = join(work, 'src');
    mkdirSync(nested, { recursive: true });
    expect(resolveProjectFromCwd(dir, nested)?.id).toBe(p.id);
  });
  it('returns null when nothing matches', () => {
    createProject(dir, 'Demo3');
    expect(resolveProjectFromCwd(dir, tmpDir())).toBeNull();
  });
});
