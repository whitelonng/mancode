import { randomBytes } from 'node:crypto';
import { SecretError, fail } from './types.js';
export interface KeyProvider {
  get(keyId: string, create: boolean): Promise<Buffer>;
}
/** Loaded only by Secrets, never by status, scan or other workflow commands. */
export class MacKeyProvider implements KeyProvider {
  async get(keyId: string, create: boolean): Promise<Buffer> {
    if (process.platform !== 'darwin') fail('CAPABILITY_UNAVAILABLE');
    try {
      const { Entry } = await import('@napi-rs/keyring');
      const entry = new Entry('mancode.secrets.v1', keyId);
      const existing = entry.getSecret();
      if (existing !== null) {
        const key = Buffer.from(existing);
        if (key.length !== 32) fail('KEYSTORE_UNAVAILABLE');
        return key;
      }
      if (!create) fail('KEYSTORE_UNAVAILABLE');
      const key = randomBytes(32);
      try {
        entry.setSecret(key);
        return Buffer.from(key);
      } finally {
        key.fill(0);
      }
    } catch (error) {
      throw new SecretError('KEYSTORE_UNAVAILABLE', { cause: error });
    }
  }
}
