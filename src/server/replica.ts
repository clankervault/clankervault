import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { initVault, isVault } from '../vault.js';
import { DirBackend } from '../sync/backend.js';
import { syncOnce } from '../sync/engine.js';

/**
 * Server-side decrypted working copy for the remote MCP endpoint.
 * Exists only when the operator provides VAULT_PASSPHRASE: the documented
 * self-host tradeoff (your box, your trust domain). Never synced itself,
 * refreshed lazily from the ciphertext store.
 */
export class Replica {
  readonly dir: string;
  private lastSync = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private dataDir: string, private passphrase: string) {
    this.dir = join(dataDir, 'replica');
  }

  private async syncNow(): Promise<void> {
    if (!isVault(this.dir)) {
      initVault(this.dir);
      chmodSync(this.dir, 0o700);
    }
    await syncOnce(this.dir, new DirBackend(join(this.dataDir, 'store')), this.passphrase, 'server');
    this.lastSync = Date.now();
  }

  /**
   * Collapse concurrent callers onto a single in-flight syncOnce run. Defense in
   * depth underneath the http layer's own per-server mcp request queue: this class
   * itself must never let two scans of the replica directory interleave, no matter
   * what calls it.
   */
  private run(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.syncNow().finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  async fresh(maxAgeMs = 15000): Promise<void> {
    if (Date.now() - this.lastSync < maxAgeMs) return;
    await this.run();
  }

  /**
   * Unconditional refresh, ignoring the freshness throttle: run right after an MCP
   * write so it reaches the ciphertext store immediately instead of waiting out
   * fresh()'s window. Cheap on an unchanged tree (syncOnce is a no-op scan when
   * nothing moved).
   */
  async push(): Promise<void> {
    await this.run();
  }
}
