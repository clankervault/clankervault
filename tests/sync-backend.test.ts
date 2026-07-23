import { describe, it, expect } from 'vitest';
import { DirBackend, VersionConflictError } from '../src/sync/backend.js';
import { tmpDir } from './helpers.js';

describe('DirBackend', () => {
  it('creates a stable salt on first use', async () => {
    const b = new DirBackend(tmpDir());
    await b.ensure();
    const s1 = await b.getSalt();
    const s2 = await b.getSalt();
    expect(s1.equals(s2)).toBe(true);
    expect(s1.length).toBe(16);
  });

  it('stores and retrieves objects by key', async () => {
    const b = new DirBackend(tmpDir());
    await b.ensure();
    await b.putObject('a'.repeat(64), Buffer.from('blob'));
    expect((await b.getObject('a'.repeat(64))).toString()).toBe('blob');
    await b.deleteObject('a'.repeat(64));
    await expect(b.getObject('a'.repeat(64))).rejects.toThrow();
  });

  it('manifest CAS: rejects a stale expected version', async () => {
    const b = new DirBackend(tmpDir());
    await b.ensure();
    expect(await b.getManifest()).toBeNull();
    const v1 = await b.putManifest(Buffer.from('m1'), null);
    const got = await b.getManifest();
    expect(got!.data.toString()).toBe('m1');
    expect(got!.version).toBe(v1);
    // concurrent writer moved the version forward
    const v2 = await b.putManifest(Buffer.from('m2'), v1);
    await expect(b.putManifest(Buffer.from('stale'), v1)).rejects.toThrow(VersionConflictError);
    expect((await b.getManifest())!.version).toBe(v2);
  });
});
