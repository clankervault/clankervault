import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initVault } from '../src/vault.js';
import { discoverTranscripts, readOffsets, writeOffsets, readChunk } from '../src/mine/reader.js';
import { tmpDir } from './helpers.js';

function entry(type: string, textContent: string, cwd = '/Users/me/proj'): string {
  return JSON.stringify({ type, cwd, timestamp: '2026-07-24T10:00:00Z', message: { role: type, content: textContent } }) + '\n';
}

describe('discoverTranscripts', () => {
  it('finds jsonl files one level deep', () => {
    const root = tmpDir();
    mkdirSync(join(root, '-Users-me-proj'), { recursive: true });
    writeFileSync(join(root, '-Users-me-proj', 'a.jsonl'), '');
    writeFileSync(join(root, '-Users-me-proj', 'ignore.txt'), '');
    const found = discoverTranscripts(root);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/a\.jsonl$/);
  });
});

describe('offsets', () => {
  it('round-trips and defaults to empty', () => {
    const dir = tmpDir();
    initVault(dir);
    expect(readOffsets(dir)).toEqual({});
    writeOffsets(dir, { '/x/a.jsonl': 42 });
    expect(readOffsets(dir)).toEqual({ '/x/a.jsonl': 42 });
  });
});

describe('readChunk', () => {
  it('extracts user/assistant text and cwd, reports byte range', () => {
    const f = join(tmpDir(), 's.jsonl');
    writeFileSync(f, entry('user', 'How do I export shorts?'));
    appendFileSync(f, JSON.stringify({ type: 'assistant', cwd: '/Users/me/proj', message: { role: 'assistant', content: [{ type: 'text', text: 'Use ffmpeg -crf 18.' }] } }) + '\n');
    appendFileSync(f, JSON.stringify({ type: 'summary', stuff: true }) + '\n');   // meta line, skipped
    const chunk = readChunk(f, 0)!;
    expect(chunk.text).toContain('USER: How do I export shorts?');
    expect(chunk.text).toContain('ASSISTANT: Use ffmpeg -crf 18.');
    expect(chunk.text).not.toContain('summary');
    expect(chunk.cwd).toBe('/Users/me/proj');
    expect(chunk.fromByte).toBe(0);
    expect(chunk.toByte).toBeGreaterThan(0);
  });

  it('is incremental and never consumes a partial trailing line', () => {
    const f = join(tmpDir(), 's.jsonl');
    writeFileSync(f, entry('user', 'first'));
    const c1 = readChunk(f, 0)!;
    appendFileSync(f, '{"type":"user","message":{"role":"user","content":"partial');   // no newline
    const c2 = readChunk(f, c1.toByte);
    expect(c2).toBeNull();                                    // nothing complete yet
    appendFileSync(f, ' done"}}\n');
    const c3 = readChunk(f, c1.toByte)!;
    expect(c3.text).toContain('partial done');
    expect(c3.fromByte).toBe(c1.toByte);
  });

  it('returns null when there is nothing new', () => {
    const f = join(tmpDir(), 's.jsonl');
    writeFileSync(f, entry('user', 'hello'));
    const c1 = readChunk(f, 0)!;
    expect(readChunk(f, c1.toByte)).toBeNull();
  });

  it('survives corrupted lines', () => {
    const f = join(tmpDir(), 's.jsonl');
    writeFileSync(f, 'not json at all\n' + entry('user', 'valid'));
    const c = readChunk(f, 0)!;
    expect(c.text).toContain('valid');
  });
});
