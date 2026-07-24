import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { deriveKey, encrypt, decrypt, objectKey } from '../src/sync/crypto.js';

const salt = randomBytes(16);

describe('sync crypto', () => {
  it('round-trips content', () => {
    const key = deriveKey('correct horse', salt);
    const blob = encrypt(key, Buffer.from('vault content'));
    expect(decrypt(key, blob).toString()).toBe('vault content');
    expect(blob.toString()).not.toContain('vault content');
  });
  it('fails to decrypt with the wrong passphrase', () => {
    const a = deriveKey('right', salt);
    const b = deriveKey('wrong', salt);
    const blob = encrypt(a, Buffer.from('secret'));
    expect(() => decrypt(b, blob)).toThrow();
  });
  it('derives different keys from different salts', () => {
    const a = deriveKey('same', salt);
    const b = deriveKey('same', randomBytes(16));
    expect(a.enc.equals(b.enc)).toBe(false);
  });
  it('object keys hide the path but are stable', () => {
    const key = deriveKey('p', salt);
    const k = objectKey(key, 'projects/demo/records/2026-07-24-x.md');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(objectKey(key, 'projects/demo/records/2026-07-24-x.md')).toBe(k);
    expect(objectKey(key, 'projects/demo/state.md')).not.toBe(k);
  });
});
