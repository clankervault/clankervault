# Vault Phase 3 (MCP Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `vault mcp`: a stdio MCP server exposing the vault to chat assistants (Claude Desktop/Code, and any MCP client) with four tools per spec §5: `get_context`, `get_state`, `remember`, `search`. Plus the `vault confirm <id>` command that closes the trust loop for MCP-written records.

**Architecture:** One new module `src/mcp.ts` built on `@modelcontextprotocol/sdk` (stdio transport), reusing the existing compile pipeline (`gatherContext`/`applyBudget`) and a small extracted `searchRecords` helper. MCP-written records are born `unconfirmed` with `source.tool: mcp:<client>` and never compile until a human runs `vault confirm` (spec §8 poisoning defense, already enforced in the compiler).

**Tech Stack:** @modelcontextprotocol/sdk (+ zod peer), Node stdio. Tests speak raw JSON-RPC over a spawned process, so they validate the protocol independent of SDK internals.

## Global Constraints

- Tools exactly per spec §5: `get_context(project?, lenses?)`, `get_state(project)`, `remember(project?, type, title, body?, scope?, tags?)`, `search(query)`.
- Tool descriptions must tell the model when to call them: get_context's description starts with "Call this at the start of every conversation" (spec §5 pull-vs-push caveat).
- `remember` creates records as `unconfirmed` with `source.tool: 'mcp:<clientName>'` (client name from the MCP initialize handshake; 'unknown' if absent). Its result text must state that the record stays out of compiled context until the user confirms it.
- `get_context` with `lenses: false` omits profile and taste (spec §8: lenses color every task; must be switchable off). Default is lenses on.
- Every tool call appends to the access log (spec §8): `logAccess(vaultDir, 'mcp:<tool>', {...})`.
- `vault confirm <id>` flips an unconfirmed record to confirmed by rewriting frontmatter only (append-only body rule).
- get_context without a resolvable project returns the me-layer (profile + global taste) plus the list of known projects, not an error.
- NO em/en dashes anywhere. Commit messages: technical, never reference AI/Claude/assistant, no co-author trailers.
- If the installed SDK's API surface differs from the sketch, adapt the wiring but keep tool names, schemas, behavior, and the raw-protocol tests exactly as specified.

---

## File Structure

```
src/search.ts       # searchRecords(vaultDir, query) shared by CLI + MCP
src/records.ts      # + confirmRecord()
src/mcp.ts          # buildServer(vaultDir) + runMcp(vaultDir)
src/cli.ts          # + `vault confirm`, + `vault mcp`, search cmd refactored onto searchRecords
tests/search-confirm.test.ts
tests/mcp.test.ts   # raw JSON-RPC over spawned stdio process
```

---

### Task 1: searchRecords + confirmRecord + `vault confirm`

**Files:**
- Create: `src/search.ts`, `tests/search-confirm.test.ts`
- Modify: `src/records.ts` (add `confirmRecord`), `src/cli.ts` (add `confirm` command; rewire `search` command through `searchRecords`)

**Interfaces:**
- Produces:
  - `interface SearchHit { projectId: string; record: VaultRecord }`
  - `searchRecords(vaultDir: string, query: string): SearchHit[]` (case-insensitive substring over title and body, across all projects, superseded excluded)
  - `confirmRecord(vaultDir: string, projectId: string, id: string): VaultRecord` (throws if not found; throws if status is 'superseded'; idempotent if already confirmed; rewrites frontmatter only)
  - CLI: `vault confirm <id> [-p, --project <ref>]` printing `<id> confirmed`.

- [ ] **Step 1: Write failing tests**

`tests/search-confirm.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify fail** - `npx vitest run tests/search-confirm.test.ts`

- [ ] **Step 3: Implement**

`src/search.ts`:
```ts
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
```

`src/records.ts` append:
```ts
export function confirmRecord(vaultDir: string, projectId: string, id: string): VaultRecord {
  const rec = findRecord(vaultDir, projectId, id);
  if (!rec) throw new Error(`Record ${id} not found in project ${projectId}`);
  if (rec.meta.status === 'superseded') throw new Error(`Record ${id} is superseded and cannot be confirmed`);
  if (rec.meta.status !== 'confirmed') {
    const raw = matter(readFileSync(rec.path, 'utf8'));
    raw.data.status = 'confirmed';
    writeFileSync(rec.path, matter.stringify(raw.content, raw.data));
  }
  return parseRecordFile(rec.path);
}
```

`src/cli.ts`: add after the `supersede` command:
```ts
program
  .command('confirm')
  .argument('<id>')
  .option('-p, --project <ref>')
  .description('confirm an unconfirmed record so it starts compiling')
  .action((id: string, opts: { project?: string }) => {
    const p = needProject(opts.project);
    confirmRecord(vaultDir(), p.id, id);
    console.log(`${id} confirmed`);
  });
```
and rewire the `search` command body to:
```ts
  .action((query: string) => {
    const dir = requireVault(vaultDir());
    logAccess(dir, 'search', { query });
    for (const h of searchRecords(dir, query)) {
      console.log(`${h.projectId}  ${h.record.meta.id}  ${h.record.title}`);
    }
  });
```
(keep imports tidy: `confirmRecord` from records, `searchRecords` from search.)

- [ ] **Step 4: Run tests, FULL suite, tsc** - `npx vitest run tests/search-confirm.test.ts && npx vitest run && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add cross-project search helper and record confirmation"
```

---

### Task 2: MCP server + `vault mcp` + README

**Files:**
- Create: `src/mcp.ts`, `tests/mcp.test.ts`
- Modify: `package.json` (deps: `@modelcontextprotocol/sdk`, `zod`), `src/cli.ts` (`mcp` command), `README.md` (MCP section)

**Interfaces:**
- Produces: `runMcp(vaultDir: string): Promise<void>` (connects a stdio server and keeps running); CLI `vault mcp`.
- Tool behavior (normative):
  - `get_context(project?: string, lenses?: boolean)`: resolve project via `getProject(ref)` when given, else `resolveProjectFromCwd(vaultDir, process.cwd())`. When resolved: `applyBudget(gatherContext(...), budget from vault.yaml)` rendered through the shared `renderMarkdownBody` WITHOUT the GENERATED header; when `lenses === false`, blank out `profile` and `globalTaste` (and taste records) before rendering. When no project resolves: return profile + global taste + `Known projects:` list (ids + names). Log `mcp:get_context`.
  - `get_state(project: string)`: state.md content for the project (or "Nothing in progress." when template/empty). Error text (not protocol error) when project unknown, listing known ids. Log `mcp:get_state`.
  - `remember(project?, type, title, body?, scope?, tags?)`: resolve project (same as get_context; error text listing projects when unresolvable). `createRecord` with `status: 'unconfirmed'`, `confidence: 'high'`, `source: { tool: 'mcp:' + clientName }` where clientName comes from the initialize handshake (fallback 'unknown'). Result text: `Saved <id> as unconfirmed. It will not appear in compiled context until the user runs: vault confirm <id>`. Log `mcp:remember`.
  - `search(query)`: `searchRecords`; one line per hit `<projectId>  <id>  <title>`; "No matches." when empty. Log `mcp:search`.
- Tool descriptions (normative, verbatim):
  - get_context: "Call this at the start of every conversation to load who the user is and the context of their current project. Returns profile, taste, project facts, recipes, decisions and work in progress."
  - get_state: "Get the user's current work in progress for a project."
  - remember: "Save a new fact, recipe, decision or taste to the user's memory vault. Use when the user states something worth remembering across sessions. The record stays unconfirmed until the user approves it."
  - search: "Search the user's memory vault records by keyword."

**Implementation sketch** (`src/mcp.ts`) - adapt to the installed SDK if its API differs, keeping behavior identical:
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { readConfig } from './vault.js';
import { getProject, listProjects, resolveProjectFromCwd } from './project.js';
import { createRecord } from './records.js';
import { searchRecords } from './search.js';
import { applyBudget, gatherContext } from './compile.js';
import { renderMarkdownBody } from './adapters/index.js';
import { logAccess } from './log.js';
import type { ProjectInfo, RecordType } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function buildServer(vaultDir: string): McpServer {
  const server = new McpServer({ name: 'vault', version: '0.1.0' });
  const clientName = () => server.server.getClientVersion()?.name ?? 'unknown';

  const resolveRef = (ref?: string): ProjectInfo | null =>
    ref ? getProject(vaultDir, ref) : resolveProjectFromCwd(vaultDir, process.cwd());

  const knownList = () =>
    listProjects(vaultDir).map((p) => `- ${p.id} (${p.name})`).join('\n') || '(no projects yet)';

  server.tool(
    'get_context',
    'Call this at the start of every conversation to load who the user is and the context of their current project. Returns profile, taste, project facts, recipes, decisions and work in progress.',
    { project: z.string().optional(), lenses: z.boolean().optional() },
    async ({ project, lenses }) => {
      logAccess(vaultDir, 'mcp:get_context', { project: project ?? null, client: clientName() });
      const p = resolveRef(project);
      if (!p) {
        const ctxless = gatherMeOnly(vaultDir);
        return text(`${ctxless}\n\nKnown projects:\n${knownList()}`);
      }
      let ctx = applyBudget(gatherContext(vaultDir, p), readConfig(vaultDir).compile.token_budget);
      if (lenses === false) ctx = { ...ctx, profile: null, globalTaste: [], records: { ...ctx.records, taste: [] } };
      return text(renderMarkdownBody(ctx));
    },
  );
  // ... get_state, remember, search in the same style per the normative behavior above
  return server;
}

function gatherMeOnly(vaultDir: string): string {
  // profile body + one line per me/taste file (reuse readBody-style logic locally)
}

export async function runMcp(vaultDir: string): Promise<void> {
  await buildServer(vaultDir).connect(new StdioServerTransport());
}
```
CLI command:
```ts
program
  .command('mcp')
  .description('run the vault as an MCP server on stdio (connect from Claude Desktop, Claude Code, etc.)')
  .action(async () => {
    try {
      await runMcp(requireVault(vaultDir()));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
```

- [ ] **Step 1: Install deps** - `npm install @modelcontextprotocol/sdk zod`

- [ ] **Step 2: Write failing protocol tests**

`tests/mcp.test.ts` - a minimal JSON-RPC-over-stdio client (newline-delimited JSON, which the SDK's stdio transport speaks):
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';

let vault: string;
let work: string;
let proc: ChildProcess;
let buf = '';
const pending = new Map<number, (msg: any) => void>();
let nextId = 1;

function rpc(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 15000);
  });
}

function notify(method: string, params?: unknown): void {
  proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

beforeAll(async () => {
  vault = join(tmpDir(), 'v');
  work = tmpDir();
  const cli = (args: string[], cwd?: string) =>
    spawnSync('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), ...args], { encoding: 'utf8', cwd });
  cli(['init', vault]);
  cli(['--vault', vault, 'project', 'new', 'Demo', '--root', work]);
  cli(['--vault', vault, 'add', 'fact', 'Deploy on Vercel', '-b', 'branch main'], work);

  proc = spawn('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), '--vault', vault, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  proc.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    }
  });
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });
  expect(init.result.serverInfo.name).toBe('vault');
  notify('notifications/initialized');
}, 60000);

afterAll(() => { proc?.kill(); });

describe('vault mcp', () => {
  it('lists the four spec tools with call-me descriptions', async () => {
    const res = await rpc('tools/list');
    const names = res.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['get_context', 'get_state', 'remember', 'search']);
    const getContext = res.result.tools.find((t: any) => t.name === 'get_context');
    expect(getContext.description).toMatch(/start of every conversation/i);
  });

  it('get_context returns compiled project context', async () => {
    const res = await rpc('tools/call', { name: 'get_context', arguments: { project: 'demo' } });
    const body = res.result.content[0].text;
    expect(body).toContain('Deploy on Vercel');
    expect(body).not.toContain('GENERATED');
  });

  it('get_context without lenses omits profile and taste', async () => {
    const withL = await rpc('tools/call', { name: 'get_context', arguments: { project: 'demo' } });
    const withoutL = await rpc('tools/call', { name: 'get_context', arguments: { project: 'demo', lenses: false } });
    expect(withL.result.content[0].text).toMatch(/About the user/);
    expect(withoutL.result.content[0].text).not.toMatch(/About the user/);
  });

  it('remember writes an unconfirmed record with mcp provenance and tells the user how to confirm', async () => {
    const res = await rpc('tools/call', {
      name: 'remember',
      arguments: { project: 'demo', type: 'recipe', title: 'Export shorts', body: 'ffmpeg -crf 18' },
    });
    const msg = res.result.content[0].text;
    expect(msg).toMatch(/unconfirmed/);
    expect(msg).toMatch(/vault confirm/);
    const recDir = readdirSync(join(vault, 'projects')).find((d) => d.startsWith('demo'))!;
    const files = readdirSync(join(vault, 'projects', recDir, 'records'));
    const remembered = files.find((f) => f.includes('export-shorts'))!;
    const raw = readFileSync(join(vault, 'projects', recDir, 'records', remembered), 'utf8');
    expect(raw).toContain('status: unconfirmed');
    expect(raw).toContain('mcp:test-client');
  });

  it('remembered records stay out of get_context until confirmed', async () => {
    const before = await rpc('tools/call', { name: 'get_context', arguments: { project: 'demo' } });
    expect(before.result.content[0].text).not.toContain('Export shorts');
  });

  it('search finds records across the vault', async () => {
    const res = await rpc('tools/call', { name: 'search', arguments: { query: 'vercel' } });
    expect(res.result.content[0].text).toContain('Deploy on Vercel');
  });

  it('get_state answers for a known project and guides for unknown', async () => {
    const ok = await rpc('tools/call', { name: 'get_state', arguments: { project: 'demo' } });
    expect(ok.result.content[0].text.length).toBeGreaterThan(0);
    const bad = await rpc('tools/call', { name: 'get_state', arguments: { project: 'nope' } });
    expect(bad.result.content[0].text).toMatch(/Known projects|not found/i);
  });
}, 60000);
```

- [ ] **Step 3: Run to verify fail, implement src/mcp.ts + CLI command, iterate until green**

Run: `npx vitest run tests/mcp.test.ts`

- [ ] **Step 4: README**

Add `## MCP server` section: what it covers (chat assistants, multiple accounts of the same assistant, spec §5), Claude Desktop / Claude Code config snippet (`"command": "vault", "args": ["mcp"]` with optional `"--vault", "<dir>"`), the four tools, the trust model in one paragraph (remember lands unconfirmed; `vault confirm <id>` releases it into compiled context; lenses toggle). Factual, no em dashes.

- [ ] **Step 5: FULL suite + build, commit**

```bash
npx vitest run && npm run build
git add -A && git commit -m "Add MCP server exposing vault context, state, remember and search"
```

---

## Self-Review Notes

- Spec §5 tools covered 1:1; pull-vs-push caveat addressed via normative descriptions; §8 hooks: lenses toggle, mcp trust gate (already in compiler), access log per tool call.
- Remote/hosted MCP endpoint is the paid tier (spec §9) and stays out of scope; stdio covers Claude Desktop/Code today and the module boundary (`buildServer`) is transport-agnostic for a later HTTP wrapper.
- `confirmRecord` reuses the frontmatter-only rewrite pattern from supersede; body untouched.
