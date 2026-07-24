import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { initVault, isVault } from '../vault.js';
import { DirBackend } from '../sync/backend.js';
import { syncOnce } from '../sync/engine.js';
import { deriveKey } from '../sync/crypto.js';
import type { SyncKey } from '../sync/crypto.js';

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
  private cachedKey: SyncKey | null = null;

  constructor(private dataDir: string, private passphrase: string) {
    this.dir = join(dataDir, 'replica');
  }

  private async syncNow(): Promise<void> {
    if (!isVault(this.dir)) {
      initVault(this.dir);
      chmodSync(this.dir, 0o700);
    }
    const backend = new DirBackend(join(this.dataDir, 'store'));
    // scrypt is deliberately expensive (that is the point of a KDF); every single
    // mcp request would otherwise pay that cost twice (fresh + push). The salt is
    // written once and never changes for a given store, so deriving the key once
    // per server process and reusing it here is safe, not just faster.
    if (!this.cachedKey) {
      await backend.ensure();
      this.cachedKey = deriveKey(this.passphrase, await backend.getSalt());
    }
    await syncOnce(this.dir, backend, this.passphrase, 'server', this.cachedKey);
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
   * nothing moved, and the key is cached rather than re-derived).
   */
  async push(): Promise<void> {
    await this.run();
  }
}
