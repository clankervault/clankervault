import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { DeviceConfig, VaultConfig } from './types.js';

const DEFAULT_CONFIG: VaultConfig = { spec_version: 1, compile: { token_budget: 4000 } };

export function defaultVaultDir(): string {
  return process.env.VAULT_DIR ?? join(homedir(), 'vault');
}

export function isVault(dir: string): boolean {
  return existsSync(join(dir, 'vault.yaml'));
}

export function requireVault(dir: string): string {
  if (!isVault(dir)) {
    throw new Error(`No vault found at ${dir}. Run \`vault init\` first (or set VAULT_DIR).`);
  }
  return dir;
}

export function initVault(dir: string): void {
  if (isVault(dir)) throw new Error(`Vault already exists at ${dir}`);
  mkdirSync(join(dir, 'me', 'taste'), { recursive: true });
  mkdirSync(join(dir, 'me', 'skills'), { recursive: true });
  mkdirSync(join(dir, 'projects'), { recursive: true });
  writeFileSync(
    join(dir, 'vault.yaml'),
    `# Vault settings - https://github.com/tadeasraska/vault\nspec_version: 1\ncompile:\n  token_budget: 4000\n`,
  );
  writeFileSync(
    join(dir, 'me', 'profile.md'),
    `# Profile\n\nWho I am, what I do, language and tone preferences.\nThis goes into every compiled output, for every tool.\n`,
  );
  writeFileSync(join(dir, 'device.yaml'), deviceTemplate());
}

function defaultDeviceName(): string {
  return hostname().split('.')[0].toLowerCase() || 'device';
}

function deviceTemplate(): string {
  return (
    `# Per-device settings - NEVER synced between machines (spec §7).\n` +
    `# Anchors map {name} placeholders in records to local paths.\n` +
    `device: ${defaultDeviceName()}\n` +
    `anchors: {}\n` +
    `# projects: maps project ids to their local roots, e.g.\n` +
    `#   my-project-a1b2: /Users/me/Development/my-project\n` +
    `projects: {}\n`
  );
}

export function readDeviceConfig(dir: string): DeviceConfig {
  const file = join(dir, 'device.yaml');
  const raw = existsSync(file) ? (parse(readFileSync(file, 'utf8')) ?? {}) : {};
  return {
    device: raw.device ?? defaultDeviceName(),
    anchors: raw.anchors ?? {},
    projects: raw.projects ?? {},
    sync: raw.sync ?? undefined,
  };
}

export function readConfig(dir: string): VaultConfig {
  const raw = parse(readFileSync(join(dir, 'vault.yaml'), 'utf8')) ?? {};
  return {
    spec_version: raw.spec_version ?? DEFAULT_CONFIG.spec_version,
    compile: { token_budget: raw.compile?.token_budget ?? DEFAULT_CONFIG.compile.token_budget },
  };
}
