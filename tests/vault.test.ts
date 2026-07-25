import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { initVault, isVault, readConfig, readDeviceConfig, requireVault } from '../src/vault.js';
import { tmpDir } from './helpers.js';

describe('initVault', () => {
  it('creates the spec structure', () => {
    const dir = tmpDir();
    initVault(dir);
    expect(isVault(dir)).toBe(true);
    expect(existsSync(join(dir, 'vault.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'me/profile.md'))).toBe(true);
    expect(existsSync(join(dir, 'me/taste'))).toBe(true);
    expect(existsSync(join(dir, 'me/skills'))).toBe(true);
    expect(existsSync(join(dir, 'projects'))).toBe(true);
  });
  it('refuses to init twice', () => {
    const dir = tmpDir();
    initVault(dir);
    expect(() => initVault(dir)).toThrow(/already/i);
  });
});

describe('readConfig', () => {
  it('reads defaults', () => {
    const dir = tmpDir();
    initVault(dir);
    const cfg = readConfig(dir);
    expect(cfg.spec_version).toBe(1);
    expect(cfg.compile.token_budget).toBe(4000);
  });
});

describe('requireVault', () => {
  it('throws a helpful error outside a vault', () => {
    expect(() => requireVault(tmpDir())).toThrow(/clanker init/);
  });
});

describe('readDeviceConfig', () => {
  it('reads device.yaml written by init', () => {
    const dir = tmpDir();
    initVault(dir);
    const dev = readDeviceConfig(dir);
    expect(dev.device.length).toBeGreaterThan(0);
    expect(dev.anchors).toEqual({});
    expect(dev.projects).toEqual({});
  });
  it('survives a missing device.yaml with defaults', () => {
    const dir = tmpDir();
    initVault(dir);
    rmSync(join(dir, 'device.yaml'));
    expect(readDeviceConfig(dir).anchors).toEqual({});
  });
});
