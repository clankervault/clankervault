import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'vault-test-'));
}
