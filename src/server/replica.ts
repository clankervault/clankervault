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

  constructor(private dataDir: string, private passphrase: string) {
    this.dir = join(dataDir, 'replica');
  }

  async fresh(maxAgeMs = 15000): Promise<void> {
    if (Date.now() - this.lastSync < maxAgeMs) return;
    if (!isVault(this.dir)) {
      initVault(this.dir);
      chmodSync(this.dir, 0o700);
    }
    await syncOnce(this.dir, new DirBackend(join(this.dataDir, 'store')), this.passphrase, 'server');
    this.lastSync = Date.now();
  }
}
