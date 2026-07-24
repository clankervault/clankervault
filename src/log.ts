import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * spec §8: per-device access log (never synced). Records which memory was
 * actually served, as raw material for future decay/ranking. Logging must
 * never break serving, so failures are swallowed.
 */
export function logAccess(vaultDir: string, op: string, detail: Record<string, unknown> = {}): void {
  try {
    const dir = join(vaultDir, '.log');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, 'access.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), op, ...detail }) + '\n',
    );
  } catch {
    // intentionally silent: an unwritable log must not take down compile/search
  }
}
