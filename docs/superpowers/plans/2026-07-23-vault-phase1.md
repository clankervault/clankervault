# Vault Phase 1 (Format + CLI + Compiler) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the open-source layer of Vault per `/Users/mac/Downloads/vault-spec.md`: a plain-markdown memory vault (5 record types, `me/` + `projects/` structure) plus a `vault` CLI that initializes vaults, manages records, resolves projects from cwd, and compiles the vault into native tool files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`) via pluggable adapters.

**Architecture:** A Node/TypeScript CLI (`vault`) over a plain-files vault directory. Pure library modules (`vault.ts`, `records.ts`, `project.ts`, `compile.ts`, `adapters/*`) each own one concern and are unit-tested against temp dirs; `cli.ts` is a thin commander wiring layer. The vault is the database; compiled tool files are disposable views with a `GENERATED` header.

**Tech Stack:** Node 22, TypeScript (ESM, NodeNext), commander, gray-matter (frontmatter), yaml, vitest.

## Global Constraints

- Record types are exactly: `fact`, `recipe`, `decision`, `taste` (+ `state.md` as the only mutable file). ID prefixes: `fct`, `rcp`, `dec`, `tst` (spec §1, §3).
- `fact/recipe/decision/taste` are append-only: change of mind = new record + `superseded_by` on the old one. Never edit body of an existing record in place (only status/superseded_by frontmatter rewrite).
- Record frontmatter fields exactly per spec §3: `id, type, date, status, supersedes, superseded_by, scope, confidence, source (tool/transcript/approx_range), tags`.
- Manual records: `source: null`, default `status: confirmed`, `confidence: high`.
- Compile includes: project.md + confirmed records (condensed to one line + id ref) + unconfirmed **high**-confidence records in a separate "recent, take with a grain of salt" section + state.md + `me/` layer. `confidence: low` and unconfirmed medium are never compiled (spec §4, §6).
- Token budget default 4000 (configurable in `vault.yaml`), priorities: creative = state > taste > recipes > decisions > facts; code = state > decisions > recipes > taste > facts (spec §4).
- Generated files carry a `GENERATED` do-not-edit header.
- Adapters are pluggable modules (one file per target tool).
- Paths in records use anchors (`{project_root}` reserved, `{<name>}` free), never absolute (spec §7). `device.yaml` in the vault root is per-device and never synced: `device` name, `anchors` map, `projects` map (project id → local path). The compiler expands anchors from `device.yaml` and renders `availability` frontmatter contextually ("not on this device; macbook: …, nas: …").
- Project identity: stable generated `id` + `roots` (git remote URL, `.vault-id` file, path). Git remote is only one option (spec §2).
- License MIT. Vault dir default `~/vault`, overridable with `VAULT_DIR` env var.
- Commit messages: technical, active voice, never reference AI/Claude/assistant (user RULES.md). No co-author trailers.
- Repo: `/Users/mac/Development/vault`. All paths below are relative to it.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, LICENSE, README.md, .gitignore
src/
├── cli.ts            # commander entry (bin)
├── types.ts          # shared interfaces
├── util.ts           # slugify, shortId, today, estimateTokens
├── vault.ts          # locate/init vault, vault.yaml config
├── records.ts        # create/parse/list/find/supersede records
├── project.ts        # create/list/get projects + cwd resolution
├── compile.ts        # gather + condense + priority budget
└── adapters/
    ├── index.ts      # Adapter interface + registry
    ├── claude.ts     # CLAUDE.md
    ├── agents.ts     # AGENTS.md
    └── cursor.ts     # .cursorrules
tests/
├── util.test.ts
├── vault.test.ts
├── records.test.ts
├── project.test.ts
├── compile.test.ts
├── adapters.test.ts
└── helpers.ts        # temp vault fixture
```

---

### Task 1: Scaffold + util

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `src/util.ts`, `src/types.ts`
- Test: `tests/util.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `slugify(s: string): string`, `shortId(): string` (4 hex chars), `today(): string` (YYYY-MM-DD), `estimateTokens(s: string): number`; all types in `src/types.ts` (used verbatim by every later task).

- [ ] **Step 1: Write scaffold files**

`package.json`:
```json
{
  "name": "vault-cli",
  "version": "0.1.0",
  "description": "Portable memory for AI tools: one plain-markdown vault, compiled into CLAUDE.md, AGENTS.md, .cursorrules and more.",
  "license": "MIT",
  "type": "module",
  "bin": { "vault": "dist/cli.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "dev": "tsx src/cli.ts"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "gray-matter": "^4.0.3",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
```

`.gitignore`:
```
node_modules/
dist/
```

`LICENSE`: standard MIT text, `Copyright (c) 2026 Tadeáš Raška`.

`src/types.ts`:
```ts
export type RecordType = 'fact' | 'recipe' | 'decision' | 'taste';
export type RecordStatus = 'unconfirmed' | 'confirmed' | 'superseded';
export type Confidence = 'high' | 'medium' | 'low';

export interface RecordSource {
  tool: string;               // claude-code | codex | mcp:<assistant> | manual tooling later
  transcript?: string;
  approx_range?: string;
}

export interface RecordMeta {
  id: string;                 // e.g. rcp-2026-07-12-a1b2
  type: RecordType;
  date: string;               // YYYY-MM-DD
  status: RecordStatus;
  supersedes: string | null;
  superseded_by: string | null;
  scope: string | null;
  confidence: Confidence;
  source: RecordSource | null; // null = written by hand
  tags: string[];
  /** optional, spec §7: device name → anchored path, or null = not present there */
  availability?: Record<string, string | null> | null;
}

export interface DeviceConfig {
  device: string;                     // e.g. "macbook"
  anchors: Record<string, string>;    // e.g. { nas: "/Volumes/NAS" }
  projects: Record<string, string>;   // project id → local root path
}

export interface VaultRecord {
  meta: RecordMeta;
  title: string;
  body: string;               // body without the leading H1 title
  path: string;
}

export interface ProjectRoot {
  git?: string;               // git remote URL
  path?: string;              // absolute dir prefix on disk
}

export type ProjectKind = 'code' | 'creative';

export interface ProjectInfo {
  id: string;
  name: string;
  aliases: string[];
  kind: ProjectKind;
  roots: ProjectRoot[];
  facts: string;              // body of project.md (identity + facts)
  dir: string;                // absolute path of projects/<id>
}

export interface VaultConfig {
  spec_version: number;
  compile: { token_budget: number };
}

export interface CompiledContext {
  project: ProjectInfo;
  device: DeviceConfig;
  profile: string | null;                    // me/profile.md body
  globalTaste: string[];                     // condensed lines from me/taste/*.md
  records: Record<RecordType, string[]>;     // condensed confirmed lines per type
  unconfirmed: string[];                     // condensed unconfirmed high-confidence lines
  state: string | null;                      // state.md content
  droppedCount: number;                      // lines cut by token budget
}
```

`src/util.ts`:
```ts
import { randomBytes } from 'node:crypto';

/** ascii-safe kebab slug, diacritics stripped, max 60 chars */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/** 4 hex chars, e.g. "a1b2" */
export function shortId(): string {
  return randomBytes(2).toString('hex');
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** rough token estimate: ~4 chars per token */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
```

- [ ] **Step 2: Write failing test**

`tests/util.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { slugify, shortId, today, estimateTokens } from '../src/util.js';

describe('slugify', () => {
  it('kebab-cases and strips diacritics', () => {
    expect(slugify('Export shorts verze')).toBe('export-shorts-verze');
    expect(slugify('Řemeslníci: pivot!')).toBe('remeslnici-pivot');
  });
  it('caps length at 60', () => {
    expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe('shortId', () => {
  it('returns 4 hex chars', () => {
    expect(shortId()).toMatch(/^[0-9a-f]{4}$/);
  });
});

describe('today', () => {
  it('returns YYYY-MM-DD', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('estimateTokens', () => {
  it('estimates ~chars/4', () => {
    expect(estimateTokens('a'.repeat(40))).toBe(10);
    expect(estimateTokens('')).toBe(0);
  });
});
```

- [ ] **Step 3: Install deps, run tests, verify pass**

Run: `cd /Users/mac/Development/vault && npm install && npx vitest run tests/util.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Scaffold vault-cli project with shared types and util helpers"
```

---

### Task 2: Vault core (init / locate / config)

**Files:**
- Create: `src/vault.ts`, `tests/vault.test.ts`, `tests/helpers.ts`

**Interfaces:**
- Consumes: `VaultConfig` from types.
- Produces: `defaultVaultDir(): string`, `isVault(dir: string): boolean`, `initVault(dir: string): void`, `requireVault(dir: string): string`, `readConfig(dir: string): VaultConfig`, `readDeviceConfig(dir: string): DeviceConfig` (missing/partial device.yaml → defaults: `device` = os.hostname() first label, empty maps).

- [ ] **Step 1: Write failing tests**

`tests/helpers.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'vault-test-'));
}
```

`tests/vault.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initVault, isVault, readConfig, requireVault } from '../src/vault.js';
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
    expect(() => requireVault(tmpDir())).toThrow(/vault init/);
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
```
(add `rmSync` to the `node:fs` import and `readDeviceConfig` to the vault import)

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/vault.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/vault.ts`:
```ts
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
    `# Vault settings — https://github.com/tadeasraska/vault\nspec_version: 1\ncompile:\n  token_budget: 4000\n`,
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
    `# Per-device settings — NEVER synced between machines (spec §7).\n` +
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
  };
}

export function readConfig(dir: string): VaultConfig {
  const raw = parse(readFileSync(join(dir, 'vault.yaml'), 'utf8')) ?? {};
  return {
    spec_version: raw.spec_version ?? DEFAULT_CONFIG.spec_version,
    compile: { token_budget: raw.compile?.token_budget ?? DEFAULT_CONFIG.compile.token_budget },
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/vault.test.ts` — Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add vault core: init, locate and config reading"
```

---

### Task 3: Records (create / parse / list / supersede)

**Files:**
- Create: `src/records.ts`, `tests/records.test.ts`

**Interfaces:**
- Consumes: `slugify, shortId, today` from util; types; `requireVault` not needed (caller's job).
- Produces:
  - `createRecord(vaultDir: string, projectId: string, input: NewRecordInput): VaultRecord`
  - `parseRecordFile(filePath: string): VaultRecord`
  - `listRecords(vaultDir: string, projectId: string): VaultRecord[]`
  - `findRecord(vaultDir: string, projectId: string, id: string): VaultRecord | null`
  - `supersedeRecord(vaultDir: string, projectId: string, oldId: string, input: NewRecordInput): { old: VaultRecord; created: VaultRecord }`
  - `interface NewRecordInput { type: RecordType; title: string; body?: string; scope?: string; tags?: string[]; status?: RecordStatus; confidence?: Confidence; source?: RecordSource | null }`

- [ ] **Step 1: Write failing tests**

`tests/records.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/records.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/records.ts`:
```ts
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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/records.test.ts` — Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add record layer: create, parse, list and append-only supersede"
```

---

### Task 4: Projects (create / get / resolve from cwd)

**Files:**
- Create: `src/project.ts`, `tests/project.test.ts`

**Interfaces:**
- Consumes: `slugify, shortId` from util; types.
- Produces:
  - `createProject(vaultDir: string, name: string, opts?: { kind?: ProjectKind; roots?: ProjectRoot[] }): ProjectInfo`
  - `listProjects(vaultDir: string): ProjectInfo[]`
  - `getProject(vaultDir: string, ref: string): ProjectInfo | null` (matches id, slug of name, or alias)
  - `resolveProjectFromCwd(vaultDir: string, cwd: string): ProjectInfo | null`
  - `normalizeGitUrl(url: string): string` (exported for tests)

- [ ] **Step 1: Write failing tests**

`tests/project.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/project.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/project.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import type { ProjectInfo, ProjectKind, ProjectRoot } from './types.js';
import { shortId, slugify } from './util.js';
import { readDeviceConfig } from './vault.js';

export function createProject(
  vaultDir: string, name: string,
  opts: { kind?: ProjectKind; roots?: ProjectRoot[] } = {},
): ProjectInfo {
  const id = `${slugify(name)}-${shortId()}`;
  const dir = join(vaultDir, 'projects', id);
  mkdirSync(join(dir, 'records'), { recursive: true });
  const meta = {
    id, name, aliases: [], kind: opts.kind ?? 'code', roots: opts.roots ?? [],
  };
  writeFileSync(join(dir, 'project.md'), matter.stringify(`\n# ${name}\n\n## Facts\n`, meta));
  writeFileSync(join(dir, 'state.md'), `# State\n\nNothing in progress.\n`);
  return { ...meta, facts: `# ${name}\n\n## Facts`, dir };
}

function readProject(vaultDir: string, id: string): ProjectInfo | null {
  const dir = join(vaultDir, 'projects', id);
  const file = join(dir, 'project.md');
  if (!existsSync(file)) return null;
  const { data, content } = matter(readFileSync(file, 'utf8'));
  return {
    id: data.id ?? id,
    name: data.name ?? id,
    aliases: data.aliases ?? [],
    kind: (data.kind as ProjectKind) ?? 'code',
    roots: (data.roots as ProjectRoot[]) ?? [],
    facts: content.trim(),
    dir,
  };
}

export function listProjects(vaultDir: string): ProjectInfo[] {
  const root = join(vaultDir, 'projects');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readProject(vaultDir, d.name))
    .filter((p): p is ProjectInfo => p !== null);
}

export function getProject(vaultDir: string, ref: string): ProjectInfo | null {
  const wanted = ref.toLowerCase();
  return (
    listProjects(vaultDir).find(
      (p) =>
        p.id === wanted ||
        slugify(p.name) === wanted ||
        p.id.replace(/-[0-9a-f]{4}$/, '') === wanted ||
        p.aliases.some((a) => a.toLowerCase() === wanted),
    ) ?? null
  );
}

export function normalizeGitUrl(url: string): string {
  return url
    .trim().toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')   // https:// ssh://
    .replace(/^[^@/]+@/, '')        // git@
    .replace(':', '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

function cwdGitRemote(cwd: string): string | null {
  const out = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (out.status !== 0) return null;
  return out.stdout.trim() || null;
}

/** walk up from cwd looking for a .vault-id file; return its content */
function findVaultIdFile(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const f = join(dir, '.vault-id');
    if (existsSync(f)) return readFileSync(f, 'utf8').trim();
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveProjectFromCwd(vaultDir: string, cwd: string): ProjectInfo | null {
  const projects = listProjects(vaultDir);
  const abs0 = resolve(cwd);

  // 1. explicit .vault-id marker wins
  const marked = findVaultIdFile(cwd);
  if (marked) {
    const p = projects.find((p) => p.id === marked);
    if (p) return p;
  }

  // 2. device.yaml projects map (local, per-device path mapping — spec §7)
  const device = readDeviceConfig(vaultDir);
  for (const [id, root] of Object.entries(device.projects)) {
    const rootAbs = resolve(root);
    if (abs0 === rootAbs || abs0.startsWith(rootAbs + sep)) {
      const p = projects.find((p) => p.id === id);
      if (p) return p;
    }
  }

  // 3. git remote match
  const remote = cwdGitRemote(cwd);
  if (remote) {
    const norm = normalizeGitUrl(remote);
    for (const p of projects) {
      if (p.roots.some((r) => r.git && normalizeGitUrl(r.git) === norm)) return p;
    }
  }

  // 4. path prefix match from synced roots
  const abs = abs0;
  for (const p of projects) {
    for (const r of p.roots) {
      if (!r.path) continue;
      const rootAbs = resolve(r.path);
      if (abs === rootAbs || abs.startsWith(rootAbs + sep)) return p;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/project.test.ts` — Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add project layer: creation, lookup and cwd identity resolution"
```

---

### Task 5: Compiler core (gather / condense / budget)

**Files:**
- Create: `src/compile.ts`, `tests/compile.test.ts`

**Interfaces:**
- Consumes: `listRecords` from records; `ProjectInfo`, `CompiledContext`, `VaultRecord` types; `estimateTokens` from util.
- Produces:
  - `condense(r: VaultRecord): string` — one line: `- <title> — <first body line, ≤160 chars> [<id>]`
  - `expandAnchors(text: string, device: DeviceConfig, projectId: string): string` — replaces `{project_root}` (from `device.projects`) and `{name}` (from `device.anchors`); unknown anchors stay literal
  - `gatherContext(vaultDir: string, project: ProjectInfo): CompiledContext` — reads `device.yaml` itself, sets `ctx.device`, expands anchors in every condensed line/state, and appends an availability note to records that carry `availability` frontmatter ("NOT on this device (mini); macbook: …, nas: …")
  - `applyBudget(ctx: CompiledContext, budget: number): CompiledContext` — cuts record lines by priority profile, sets `droppedCount`
  - `PRIORITY: Record<ProjectKind, RecordType[]>` — creative: `['taste','recipe','decision','fact']`, code: `['decision','recipe','taste','fact']` (state is always kept and is above all of these)

- [ ] **Step 1: Write failing tests**

`tests/compile.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/compile.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/compile.ts`:
```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { listRecords } from './records.js';
import type { CompiledContext, DeviceConfig, ProjectInfo, ProjectKind, RecordType, VaultRecord } from './types.js';
import { estimateTokens } from './util.js';
import { readDeviceConfig } from './vault.js';

/** which record types survive budget cuts longest; state always survives */
export const PRIORITY: Record<ProjectKind, RecordType[]> = {
  creative: ['taste', 'recipe', 'decision', 'fact'],
  code: ['decision', 'recipe', 'taste', 'fact'],
};

function firstMeaningfulLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    return line.replace(/\s+/g, ' ').slice(0, 160);
  }
  return '';
}

export function condense(r: VaultRecord): string {
  const detail = firstMeaningfulLine(r.body);
  return detail
    ? `- ${r.title} — ${detail} [${r.meta.id}]`
    : `- ${r.title} [${r.meta.id}]`;
}

/** spec §7: {project_root} from device.projects, {name} from device.anchors; unknown stay literal */
export function expandAnchors(text: string, device: DeviceConfig, projectId: string): string {
  return text.replace(/\{([a-z0-9_:-]+)\}/gi, (whole, name: string) => {
    if (name === 'project_root') return device.projects[projectId] ?? whole;
    return device.anchors[name] ?? whole;
  });
}

/** spec §7: contextual availability note for the current device */
function availabilityNote(r: VaultRecord, device: DeviceConfig): string | null {
  const av = r.meta.availability;
  if (!av) return null;
  const here = av[device.device];
  const elsewhere = Object.entries(av)
    .filter(([d]) => d !== device.device)
    .map(([d, p]) => (p ? `${d}: ${p}` : `${d}: not there`))
    .join(', ');
  return here
    ? `(on this device: ${here}${elsewhere ? `; also ${elsewhere}` : ''})`
    : `(NOT on this device (${device.device}); ${elsewhere || 'location unknown'})`;
}

function readBody(file: string): string | null {
  if (!existsSync(file)) return null;
  const { content } = matter(readFileSync(file, 'utf8'));
  const trimmed = content.trim();
  return trimmed || null;
}

export function gatherContext(vaultDir: string, project: ProjectInfo): CompiledContext {
  const device = readDeviceConfig(vaultDir);
  const records: Record<RecordType, string[]> = { fact: [], recipe: [], decision: [], taste: [] };
  const unconfirmed: string[] = [];

  const line = (r: VaultRecord): string => {
    const note = availabilityNote(r, device);
    return expandAnchors(note ? `${condense(r)} ${note}` : condense(r), device, project.id);
  };

  for (const r of listRecords(vaultDir, project.id)) {
    if (r.meta.status === 'superseded') continue;
    if (r.meta.status === 'unconfirmed') {
      if (r.meta.confidence === 'high') unconfirmed.push(line(r));
      continue; // medium/low unconfirmed stay in the vault, never compiled
    }
    records[r.meta.type].push(line(r));
  }

  const tasteDir = join(vaultDir, 'me', 'taste');
  const globalTaste: string[] = [];
  if (existsSync(tasteDir)) {
    for (const f of readdirSync(tasteDir).filter((f) => f.endsWith('.md')).sort()) {
      const body = readBody(join(tasteDir, f));
      if (!body) continue;
      const title = body.match(/^#\s+(.+)$/m)?.[1] ?? f.replace(/\.md$/, '');
      const line = firstMeaningfulLine(body.replace(/^#.+$/m, ''));
      globalTaste.push(line ? `- ${title} — ${line}` : `- ${title}`);
    }
  }

  const stateRaw = readBody(join(project.dir, 'state.md'));
  const state = stateRaw && !/^#?\s*state\s*nothing in progress\.?$/i.test(stateRaw.replace(/\n+/g, ' ').trim())
    ? stateRaw : null;

  return {
    project,
    device,
    profile: readBody(join(vaultDir, 'me', 'profile.md')),
    globalTaste,
    records,
    unconfirmed,
    state: state ? expandAnchors(state, device, project.id) : null,
    droppedCount: 0,
  };
}

export function applyBudget(ctx: CompiledContext, budget: number): CompiledContext {
  // fixed parts always ship: identity, profile, state, global taste, unconfirmed
  const fixed = [ctx.project.facts, ctx.profile ?? '', ctx.state ?? '', ...ctx.globalTaste, ...ctx.unconfirmed]
    .map(estimateTokens)
    .reduce((a, b) => a + b, 0);

  let remaining = budget - fixed;
  const order = PRIORITY[ctx.project.kind];
  const kept: Record<RecordType, string[]> = { fact: [], recipe: [], decision: [], taste: [] };
  let dropped = 0;

  for (const type of order) {
    for (const line of ctx.records[type]) {
      const cost = estimateTokens(line);
      if (remaining - cost >= 0) {
        kept[type].push(line);
        remaining -= cost;
      } else {
        dropped++;
      }
    }
  }
  return { ...ctx, records: kept, droppedCount: dropped };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/compile.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add compiler core: context gathering, condensing and priority token budget"
```

---

### Task 6: Adapters (claude / agents / cursor)

**Files:**
- Create: `src/adapters/index.ts`, `src/adapters/claude.ts`, `src/adapters/agents.ts`, `src/adapters/cursor.ts`, `tests/adapters.test.ts`

**Interfaces:**
- Consumes: `CompiledContext`.
- Produces:
  - `interface Adapter { name: string; filename: string; render(ctx: CompiledContext): string }`
  - `adapters: Record<string, Adapter>` with keys `claude`, `agents`, `cursor`
  - `getAdapter(name: string): Adapter` (throws on unknown, listing valid names)
  - `renderMarkdownBody(ctx: CompiledContext): string` in index.ts (shared by claude/agents)

- [ ] **Step 1: Write failing tests**

`tests/adapters.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { adapters, getAdapter } from '../src/adapters/index.js';
import type { CompiledContext } from '../src/types.js';

const ctx: CompiledContext = {
  project: {
    id: 'demo-a1b2', name: 'Demo', aliases: [], kind: 'code', roots: [],
    facts: '# Demo\n\n## Facts\nDeploy: Vercel, branch main', dir: '/x',
  },
  device: { device: 'macbook', anchors: {}, projects: {} },
  profile: 'Czech dev, answer in Czech.',
  globalTaste: ['- No em-dashes'],
  records: {
    fact: ['- Deploy Vercel [fct-2026-07-23-aaaa]'],
    recipe: ['- Export shorts — ffmpeg -crf 18 [rcp-2026-07-23-bbbb]'],
    decision: ['- Drizzle over Prisma [dec-2026-07-23-cccc]'],
    taste: [],
  },
  unconfirmed: ['- Fresh mined thing [rcp-2026-07-23-dddd]'],
  state: 'Refactoring payments, refund flow left.',
  droppedCount: 0,
};

describe('adapter registry', () => {
  it('exposes claude, agents, cursor', () => {
    expect(Object.keys(adapters).sort()).toEqual(['agents', 'claude', 'cursor']);
    expect(getAdapter('claude').filename).toBe('CLAUDE.md');
    expect(getAdapter('agents').filename).toBe('AGENTS.md');
    expect(getAdapter('cursor').filename).toBe('.cursorrules');
    expect(() => getAdapter('zed')).toThrow(/claude/);
  });
});

describe('rendering', () => {
  for (const name of ['claude', 'agents', 'cursor'] as const) {
    it(`${name}: GENERATED header + all sections + id refs`, () => {
      const out = getAdapter(name).render(ctx);
      expect(out).toMatch(/GENERATED/);
      expect(out).toContain('Deploy Vercel');
      expect(out).toContain('ffmpeg -crf 18');
      expect(out).toContain('Drizzle over Prisma');
      expect(out).toContain('Refactoring payments');
      expect(out).toContain('No em-dashes');
      expect(out).toContain('Czech dev');
      expect(out).toContain('[rcp-2026-07-23-dddd]');
      expect(out).toMatch(/grain of salt/i);
    });
  }
  it('omits empty sections', () => {
    const empty = { ...ctx, state: null, unconfirmed: [], records: { ...ctx.records, taste: [], recipe: [] } };
    const out = getAdapter('claude').render(empty);
    expect(out).not.toMatch(/## State/);
    expect(out).not.toMatch(/grain of salt/i);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/adapters.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/adapters/index.ts`:
```ts
import type { CompiledContext } from '../types.js';
import { claude } from './claude.js';
import { agents } from './agents.js';
import { cursor } from './cursor.js';

export interface Adapter {
  name: string;
  filename: string;
  render(ctx: CompiledContext): string;
}

export const adapters: Record<string, Adapter> = { claude, agents, cursor };

export function getAdapter(name: string): Adapter {
  const a = adapters[name];
  if (!a) throw new Error(`Unknown adapter "${name}". Available: ${Object.keys(adapters).join(', ')}`);
  return a;
}

export const GENERATED_HEADER =
  '<!-- GENERATED by vault — do not edit. Regenerate with `vault compile`. -->';

/** shared section layout for markdown-based targets */
export function renderMarkdownBody(ctx: CompiledContext): string {
  const parts: string[] = [];
  parts.push(ctx.project.facts);
  if (ctx.state) parts.push(`## State (work in progress)\n\n${ctx.state}`);
  const taste = [...ctx.globalTaste, ...ctx.records.taste];
  if (taste.length) parts.push(`## Taste & style\n\n${taste.join('\n')}`);
  if (ctx.records.recipe.length) parts.push(`## Recipes (how things are done here)\n\n${ctx.records.recipe.join('\n')}`);
  if (ctx.records.decision.length) parts.push(`## Decisions\n\n${ctx.records.decision.join('\n')}`);
  if (ctx.records.fact.length) parts.push(`## Facts\n\n${ctx.records.fact.join('\n')}`);
  if (ctx.unconfirmed.length) parts.push(`## Recent (unconfirmed — take with a grain of salt)\n\n${ctx.unconfirmed.join('\n')}`);
  if (ctx.profile) parts.push(`## About the user\n\n${ctx.profile}`);
  if (ctx.droppedCount > 0) parts.push(`<!-- ${ctx.droppedCount} records omitted by token budget; full detail lives in the vault -->`);
  return parts.join('\n\n') + '\n';
}
```

`src/adapters/claude.ts`:
```ts
import type { Adapter } from './index.js';
import { GENERATED_HEADER, renderMarkdownBody } from './index.js';

export const claude: Adapter = {
  name: 'claude',
  filename: 'CLAUDE.md',
  render: (ctx) => `${GENERATED_HEADER}\n\n${renderMarkdownBody(ctx)}`,
};
```

`src/adapters/agents.ts`:
```ts
import type { Adapter } from './index.js';
import { GENERATED_HEADER, renderMarkdownBody } from './index.js';

export const agents: Adapter = {
  name: 'agents',
  filename: 'AGENTS.md',
  render: (ctx) => `${GENERATED_HEADER}\n\n${renderMarkdownBody(ctx)}`,
};
```

`src/adapters/cursor.ts`:
```ts
import type { Adapter } from './index.js';
import { renderMarkdownBody } from './index.js';

// .cursorrules is plain text; markdown reads fine there, but use a text header
export const cursor: Adapter = {
  name: 'cursor',
  filename: '.cursorrules',
  render: (ctx) => `# GENERATED by vault — do not edit. Regenerate with \`vault compile\`.\n\n${renderMarkdownBody(ctx)}`,
};
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/adapters.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add compile adapters for CLAUDE.md, AGENTS.md and .cursorrules"
```

---

### Task 7: CLI wiring + README + end-to-end check

**Files:**
- Create: `src/cli.ts`, `README.md`
- Test: `tests/cli.test.ts` (end-to-end through execa-less child_process on built dist? No — test through commander programmatically is overkill; use a smoke test via `tsx`)

**Interfaces:**
- Consumes: everything above.
- Produces: `vault` binary with commands: `init`, `project new|list`, `add`, `supersede`, `state`, `list`, `search`, `compile`.

- [ ] **Step 1: Implement CLI**

`src/cli.ts`:
```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultVaultDir, initVault, readConfig, requireVault } from './vault.js';
import { createProject, getProject, listProjects, resolveProjectFromCwd } from './project.js';
import { createRecord, listRecords, supersedeRecord } from './records.js';
import { applyBudget, gatherContext } from './compile.js';
import { adapters, getAdapter } from './adapters/index.js';
import type { ProjectInfo, RecordType } from './types.js';

const program = new Command();
program
  .name('vault')
  .description('Portable memory for AI tools — one markdown vault, compiled into CLAUDE.md, AGENTS.md, .cursorrules.')
  .option('--vault <dir>', 'vault directory (default: $VAULT_DIR or ~/vault)');

function vaultDir(): string {
  return program.opts().vault ?? defaultVaultDir();
}

/** resolve project from --project flag or cwd; exit with guidance otherwise */
function needProject(ref: string | undefined): ProjectInfo {
  const dir = requireVault(vaultDir());
  const p = ref ? getProject(dir, ref) : resolveProjectFromCwd(dir, process.cwd());
  if (!p) {
    const known = listProjects(dir).map((x) => `  ${x.id}  (${x.name})`).join('\n');
    console.error(
      ref
        ? `Project "${ref}" not found.\nKnown projects:\n${known || '  (none)'}`
        : `Could not resolve a project from ${process.cwd()}.\nUse --project <id>, or add a root/.vault-id to one of:\n${known || '  (none — create one with `vault project new <name>`)'}`,
    );
    process.exit(1);
  }
  return p;
}

program
  .command('init')
  .argument('[dir]', 'where to create the vault')
  .description('create a new empty vault')
  .action((dir?: string) => {
    const target = dir ?? vaultDir();
    initVault(target);
    console.log(`Vault created at ${target}`);
    console.log('Next: `vault project new <name>` and edit me/profile.md');
  });

const project = program.command('project').description('manage projects');
project
  .command('new')
  .argument('<name>')
  .option('--kind <kind>', 'code | creative', 'code')
  .option('--root <path>', 'directory on disk that identifies this project (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--git <url>', 'git remote URL that identifies this project (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .action((name: string, opts: { kind: 'code' | 'creative'; root: string[]; git: string[] }) => {
    const dir = requireVault(vaultDir());
    const roots = [...opts.root.map((p) => ({ path: p })), ...opts.git.map((g) => ({ git: g }))];
    const p = createProject(dir, name, { kind: opts.kind, roots });
    console.log(`Project ${p.id} created at ${p.dir}`);
    if (!roots.length) console.log(`Tip: drop a .vault-id file containing "${p.id}" into the project folder on disk.`);
  });
project
  .command('list')
  .action(() => {
    const dir = requireVault(vaultDir());
    for (const p of listProjects(dir)) console.log(`${p.id}\t${p.name}\t(${p.kind})`);
  });

program
  .command('add')
  .argument('<type>', 'fact | recipe | decision | taste')
  .argument('<title>')
  .option('-p, --project <ref>')
  .option('-b, --body <text>')
  .option('-s, --scope <scope>')
  .option('-t, --tags <tags>', 'comma-separated')
  .description('add a record (written by hand → confirmed)')
  .action((type: string, title: string, opts: { project?: string; body?: string; scope?: string; tags?: string }) => {
    if (!['fact', 'recipe', 'decision', 'taste'].includes(type)) {
      console.error(`Unknown type "${type}". Use: fact | recipe | decision | taste (work in progress goes to \`vault state\`).`);
      process.exit(1);
    }
    const p = needProject(opts.project);
    const r = createRecord(vaultDir(), p.id, {
      type: type as RecordType, title,
      body: opts.body, scope: opts.scope,
      tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    });
    console.log(`${r.meta.id}  ${r.path}`);
  });

program
  .command('supersede')
  .argument('<oldId>')
  .argument('<title>', 'title of the replacement record')
  .option('-p, --project <ref>')
  .option('-b, --body <text>')
  .description('replace a record append-only style (new record + superseded_by link)')
  .action((oldId: string, title: string, opts: { project?: string; body?: string }) => {
    const p = needProject(opts.project);
    const old = listRecords(vaultDir(), p.id).find((r) => r.meta.id === oldId);
    if (!old) { console.error(`Record ${oldId} not found in ${p.id}`); process.exit(1); }
    const { created } = supersedeRecord(vaultDir(), p.id, oldId, {
      type: old.meta.type, title, body: opts.body,
    });
    console.log(`${created.meta.id} supersedes ${oldId}`);
  });

program
  .command('state')
  .argument('[text...]', 'new state text; omit to print current state')
  .option('-p, --project <ref>')
  .description('read or overwrite state.md (the only mutable record)')
  .action((text: string[], opts: { project?: string }) => {
    const p = needProject(opts.project);
    const file = join(p.dir, 'state.md');
    if (text.length) {
      writeFileSync(file, `# State\n\n${text.join(' ')}\n`);
      console.log(`State updated for ${p.id}`);
    } else {
      console.log(readFileSync(file, 'utf8'));
    }
  });

program
  .command('list')
  .option('-p, --project <ref>')
  .option('--type <type>')
  .action((opts: { project?: string; type?: string }) => {
    const p = needProject(opts.project);
    for (const r of listRecords(vaultDir(), p.id)) {
      if (opts.type && r.meta.type !== opts.type) continue;
      console.log(`${r.meta.id}  [${r.meta.status}${r.meta.status === 'unconfirmed' ? `/${r.meta.confidence}` : ''}]  ${r.title}`);
    }
  });

program
  .command('search')
  .argument('<query>')
  .description('search titles and bodies across all projects')
  .action((query: string) => {
    const dir = requireVault(vaultDir());
    const q = query.toLowerCase();
    for (const p of listProjects(dir)) {
      for (const r of listRecords(dir, p.id)) {
        if (r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q)) {
          console.log(`${p.id}  ${r.meta.id}  ${r.title}`);
        }
      }
    }
  });

program
  .command('compile')
  .option('-p, --project <ref>')
  .option('--tool <tools>', 'comma-separated adapters (claude,agents,cursor)', Object.keys(adapters).join(','))
  .option('--out <dir>', 'output directory (default: current directory)')
  .option('--budget <n>', 'token budget override')
  .description('compile the vault into native tool files')
  .action((opts: { project?: string; tool: string; out?: string; budget?: string }) => {
    const dir = requireVault(vaultDir());
    const p = needProject(opts.project);
    const budget = opts.budget ? Number(opts.budget) : readConfig(dir).compile.token_budget;
    const ctx = applyBudget(gatherContext(dir, p), budget);
    const outDir = opts.out ?? process.cwd();
    for (const name of opts.tool.split(',').map((t) => t.trim()).filter(Boolean)) {
      const adapter = getAdapter(name);
      const target = join(outDir, adapter.filename);
      writeFileSync(target, adapter.render(ctx));
      console.log(`wrote ${target}`);
    }
    if (ctx.droppedCount) console.log(`(${ctx.droppedCount} records over budget omitted — raise compile.token_budget in vault.yaml if needed)`);
    console.log('Remember: generated files belong in .gitignore.');
  });

program.parse();
```

- [ ] **Step 2: Write end-to-end smoke test**

`tests/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';

function run(args: string[], cwd?: string) {
  const r = spawnSync('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), ...args], {
    encoding: 'utf8', cwd: cwd ?? process.cwd(),
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('vault CLI end to end', () => {
  it('init → project → add → compile', () => {
    const vault = join(tmpDir(), 'v');
    const work = tmpDir();

    expect(run(['init', vault]).code).toBe(0);
    expect(run(['--vault', vault, 'project', 'new', 'Demo', '--root', work]).code).toBe(0);

    const add = run(['--vault', vault, 'add', 'fact', 'Deploy on Vercel', '-b', 'branch main'], work);
    expect(add.code).toBe(0);
    expect(add.out).toMatch(/fct-/);

    const compile = run(['--vault', vault, 'compile'], work);
    expect(compile.code).toBe(0);
    for (const f of ['CLAUDE.md', 'AGENTS.md', '.cursorrules']) {
      const content = readFileSync(join(work, f), 'utf8');
      expect(content).toContain('GENERATED');
      expect(content).toContain('Deploy on Vercel');
    }
  });

  it('rejects unknown record type with guidance', () => {
    const vault = join(tmpDir(), 'v');
    run(['init', vault]);
    run(['--vault', vault, 'project', 'new', 'Demo']);
    const r = run(['--vault', vault, 'add', 'state', 'x', '-p', 'demo']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/vault state/);
  });
});
```

- [ ] **Step 3: Run full suite + build**

Run: `npx vitest run && npm run build`
Expected: all tests PASS, tsc exits 0.

- [ ] **Step 4: Write README**

`README.md` — cover: one-paragraph pitch (landing sentence from spec translated: "Wherever you talk to AI, you're talking to someone who knows you."), the 5 record types table, vault structure tree, install (`npm i -g`), quickstart (init → project new → add → compile), the append-only + supersede model, project identity (roots + .vault-id + device.yaml projects map), anchors + `availability` ("the vault never syncs assets — it syncs knowledge about them"; `device.yaml` is per-device and never synced), token budget + priorities, adapter plugin note, roadmap note (sync / MCP server / mining are upcoming layers; format is stable and MIT).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Wire vault CLI commands, add end-to-end test and README"
```

---

## Self-Review Notes

- Spec §1 types/rules → Task 3 (append-only supersede, state mutable via CLI `state` cmd), §2 structure → Tasks 2+4, §3 schema → Task 3, §4 compile+budget+adapters+header → Tasks 5+6+7, §7 devices/anchors/availability → Tasks 2 (device.yaml), 4 (device projects resolution), 5 (expandAnchors + availability note). §5 MCP / §6 mining / §8 sync layer → explicitly out of phase 1 (README roadmap note).
- `state.conflict-<device>.md` handling is sync-layer (phase 2) — intentionally excluded.
- Type names checked consistent: `VaultRecord`, `ProjectInfo`, `CompiledContext`, `NewRecordInput`, `Adapter` used identically across tasks.
