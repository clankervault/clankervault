import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultTranscriptRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

export function discoverTranscripts(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const abs = join(root, dir.name);
    for (const f of readdirSync(abs)) {
      if (f.endsWith('.jsonl')) out.push(join(abs, f));
    }
  }
  return out.sort();
}

const OFFSETS_FILE = 'offsets.json';

export function readOffsets(vaultDir: string): Record<string, number> {
  const f = join(vaultDir, '.mine', OFFSETS_FILE);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return {};                                          // corrupted offsets file: start fresh, never crash
  }
}

export function writeOffsets(vaultDir: string, o: Record<string, number>): void {
  mkdirSync(join(vaultDir, '.mine'), { recursive: true });
  writeFileSync(join(vaultDir, '.mine', OFFSETS_FILE), JSON.stringify(o, null, 2));
}

export interface TranscriptChunk {
  file: string;
  fromByte: number;
  toByte: number;
  cwd: string | null;
  text: string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text: string } => !!p && typeof p === 'object' && (p as { type?: string }).type === 'text')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

/** read new complete lines from fromByte; a trailing line without a newline stays unread */
export function readChunk(file: string, fromByte: number): TranscriptChunk | null {
  const size = statSync(file).size;
  // if the file is now shorter than our recorded offset, it was rewritten or truncated
  // underneath us (not just appended to); the old offset is meaningless, so restart from 0
  const start = size < fromByte ? 0 : fromByte;
  if (size <= start) return null;
  const fd = openSync(file, 'r');
  const want = size - start;
  const buf = Buffer.alloc(want);
  let readTotal = 0;
  while (readTotal < want) {
    const n = readSync(fd, buf, readTotal, want - readTotal, start + readTotal);
    if (n === 0) break;                                 // EOF hit early; shrink to what we actually got
    readTotal += n;
  }
  closeSync(fd);
  const data = buf.subarray(0, readTotal);
  const lastNl = data.lastIndexOf(0x0a);
  if (lastNl < 0) return null;                       // no complete new line yet
  const toByte = start + lastNl + 1;
  const lines = data.subarray(0, lastNl + 1).toString('utf8').split('\n');

  const parts: string[] = [];
  let cwd: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: { type?: string; cwd?: string; message?: { role?: string; content?: unknown } };
    try { e = JSON.parse(line); } catch { continue; }   // corrupted line: skip
    if (e.cwd) cwd = e.cwd;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const t = textOf(e.message?.content).trim();
    if (t) parts.push(`${e.type.toUpperCase()}: ${t}`);
  }
  if (!parts.length && cwd === null) return { file, fromByte: start, toByte, cwd: null, text: '' };
  return { file, fromByte: start, toByte, cwd, text: parts.join('\n') };
}
