import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto';

export interface SyncKey { enc: Buffer; mac: Buffer }

/** one scrypt call yields both the AES key and the path-hiding HMAC key */
export function deriveKey(passphrase: string, salt: Buffer): SyncKey {
  const buf = scryptSync(passphrase, salt, 64);
  return { enc: buf.subarray(0, 32), mac: buf.subarray(32, 64) };
}

/** blob layout: 12B iv, 16B auth tag, ciphertext */
export function encrypt(key: SyncKey, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.enc, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decrypt(key: SyncKey, blob: Buffer): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key.enc, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** remote object name for a vault-relative path; hides the path from the storage provider */
export function objectKey(key: SyncKey, relpath: string): string {
  return createHmac('sha256', key.mac).update(relpath).digest('hex');
}
