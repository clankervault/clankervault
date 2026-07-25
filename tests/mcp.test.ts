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
let rememberedId: string;
let initResult: any;

function cli(args: string[], cwd?: string) {
  return spawnSync('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), ...args], { encoding: 'utf8', cwd });
}

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
  initResult = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });
  expect(initResult.result.serverInfo.name).toBe('clankervault');
  notify('notifications/initialized');
}, 60000);

afterAll(() => { proc?.kill(); });

describe('vault mcp', () => {
  it('advertises server-level instructions that teach the model to call get_context', () => {
    expect(initResult.result.instructions).toContain('get_context');
  });

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
    expect(msg).toMatch(/clanker confirm/);
    rememberedId = msg.match(/Saved (\S+) as unconfirmed/)![1];
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

  it('unconfirmed MCP records are gated out of search until confirmed', async () => {
    const before = await rpc('tools/call', { name: 'search', arguments: { query: 'export shorts' } });
    expect(before.result.content[0].text).not.toContain('Export shorts');

    const confirmed = cli(['--vault', vault, 'confirm', rememberedId, '--project', 'demo']);
    expect(confirmed.status).toBe(0);

    const after = await rpc('tools/call', { name: 'search', arguments: { query: 'export shorts' } });
    expect(after.result.content[0].text).toContain('Export shorts');
  });

  it('get_state answers for a known project and guides for unknown', async () => {
    const ok = await rpc('tools/call', { name: 'get_state', arguments: { project: 'demo' } });
    expect(ok.result.content[0].text.length).toBeGreaterThan(0);
    const bad = await rpc('tools/call', { name: 'get_state', arguments: { project: 'nope' } });
    expect(bad.result.content[0].text).toMatch(/Known projects|not found/i);
  });
}, 60000);
