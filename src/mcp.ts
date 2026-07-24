import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import matter from 'gray-matter';
import { readConfig } from './vault.js';
import { getProject, listProjects, resolveProjectFromCwd } from './project.js';
import { createRecord } from './records.js';
import { searchRecords } from './search.js';
import { applyBudget, gatherContext } from './compile.js';
import { renderMarkdownBody } from './adapters/index.js';
import { logAccess } from './log.js';
import type { ProjectInfo, RecordType } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function readBody(file: string): string | null {
  if (!existsSync(file)) return null;
  const { content } = matter(readFileSync(file, 'utf8'));
  const trimmed = content.trim();
  return trimmed || null;
}

function firstMeaningfulLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    return line.replace(/\s+/g, ' ').slice(0, 160);
  }
  return '';
}

/** profile + global taste only, for when no project can be resolved (spec: still greet the user) */
function gatherMeOnly(vaultDir: string): string {
  const parts: string[] = [];
  const profile = readBody(join(vaultDir, 'me', 'profile.md'));
  if (profile) parts.push(`## About the user\n\n${profile}`);
  const tasteDir = join(vaultDir, 'me', 'taste');
  const globalTaste: string[] = [];
  if (existsSync(tasteDir)) {
    for (const f of readdirSync(tasteDir).filter((f) => f.endsWith('.md')).sort()) {
      const body = readBody(join(tasteDir, f));
      if (!body) continue;
      const title = body.match(/^#\s+(.+)$/m)?.[1] ?? f.replace(/\.md$/, '');
      const line = firstMeaningfulLine(body.replace(/^#.+$/m, ''));
      globalTaste.push(line ? `- ${title}: ${line}` : `- ${title}`);
    }
  }
  if (globalTaste.length) parts.push(`## Taste & style\n\n${globalTaste.join('\n')}`);
  return parts.join('\n\n');
}

export function buildServer(vaultDir: string): McpServer {
  const server = new McpServer({ name: 'vault', version: '0.1.0' });
  const clientName = () => server.server.getClientVersion()?.name ?? 'unknown';

  const resolveRef = (ref?: string): ProjectInfo | null =>
    ref ? getProject(vaultDir, ref) : resolveProjectFromCwd(vaultDir, process.cwd());

  const knownList = () =>
    listProjects(vaultDir).map((p) => `- ${p.id} (${p.name})`).join('\n') || '(no projects yet)';

  const projectNotFoundText = (ref?: string): string =>
    ref
      ? `Project "${ref}" not found.\nKnown projects:\n${knownList()}`
      : `Could not resolve a project from the current directory.\nKnown projects:\n${knownList()}`;

  server.tool(
    'get_context',
    'Call this at the start of every conversation to load who the user is and the context of their current project. Returns profile, taste, project facts, recipes, decisions and work in progress.',
    { project: z.string().optional(), lenses: z.boolean().optional() },
    async ({ project, lenses }) => {
      logAccess(vaultDir, 'mcp:get_context', { project: project ?? null, client: clientName() });
      const p = resolveRef(project);
      if (!p) {
        const ctxless = gatherMeOnly(vaultDir);
        return text(`${ctxless ? `${ctxless}\n\n` : ''}Known projects:\n${knownList()}`);
      }
      let ctx = applyBudget(gatherContext(vaultDir, p), readConfig(vaultDir).compile.token_budget);
      if (lenses === false) ctx = { ...ctx, profile: null, globalTaste: [], records: { ...ctx.records, taste: [] } };
      return text(renderMarkdownBody(ctx));
    },
  );

  server.tool(
    'get_state',
    "Get the user's current work in progress for a project.",
    { project: z.string() },
    async ({ project }) => {
      logAccess(vaultDir, 'mcp:get_state', { project, client: clientName() });
      const p = getProject(vaultDir, project);
      if (!p) return text(projectNotFoundText(project));
      const raw = readBody(join(p.dir, 'state.md'));
      const isEmpty = !raw || /^#?\s*state\s*nothing in progress\.?$/i.test(raw.replace(/\n+/g, ' ').trim());
      return text(isEmpty ? 'Nothing in progress.' : raw!);
    },
  );

  server.tool(
    'remember',
    'Save a new fact, recipe, decision or taste to the user\'s memory vault. Use when the user states something worth remembering across sessions. The record stays unconfirmed until the user approves it.',
    {
      project: z.string().optional(),
      type: z.enum(['fact', 'recipe', 'decision', 'taste']),
      title: z.string(),
      body: z.string().optional(),
      scope: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ project, type, title, body, scope, tags }) => {
      logAccess(vaultDir, 'mcp:remember', { project: project ?? null, type, client: clientName() });
      const p = resolveRef(project);
      if (!p) return text(projectNotFoundText(project));
      const rec = createRecord(vaultDir, p.id, {
        type: type as RecordType,
        title,
        body,
        scope,
        tags,
        status: 'unconfirmed',
        confidence: 'high',
        source: { tool: `mcp:${clientName()}` },
      });
      return text(`Saved ${rec.meta.id} as unconfirmed. It will not appear in compiled context until the user runs: vault confirm ${rec.meta.id}`);
    },
  );

  server.tool(
    'search',
    "Search the user's memory vault records by keyword.",
    { query: z.string() },
    async ({ query }) => {
      logAccess(vaultDir, 'mcp:search', { query });
      const hits = searchRecords(vaultDir, query);
      if (!hits.length) return text('No matches.');
      return text(hits.map((h) => `${h.projectId}  ${h.record.meta.id}  ${h.record.title}`).join('\n'));
    },
  );

  return server;
}

export async function runMcp(vaultDir: string): Promise<void> {
  await buildServer(vaultDir).connect(new StdioServerTransport());
}
