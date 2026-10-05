import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../platform/logger';
import {
  MemoryTokenStore,
  type ProviderTokens,
  type RsRecord,
  type TokenStore,
} from './token-store';

interface SavedFile {
  version: 1;
  encrypted: boolean;
  records: RsRecord[];
}

interface FileCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * The token file's own AES-256-GCM layout, `base64url(iv[12] || tag[16] || ciphertext)`.
 * It differs from the KV layout in `crypto.ts`; both are kept so existing files still open.
 */
function fileCipher(keyBase64Url: string): FileCipher {
  const key = Buffer.from(keyBase64Url, 'base64url');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (256 bits)');
  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
    },
    decrypt(ciphertext) {
      const combined = Buffer.from(ciphertext, 'base64url');
      if (combined.length < 28) throw new Error('Invalid ciphertext: too short');
      const decipher = createDecipheriv('aes-256-gcm', key, combined.subarray(0, 12));
      decipher.setAuthTag(combined.subarray(12, 28));
      return Buffer.concat([decipher.update(combined.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    },
  };
}

/**
 * Records in one JSON file on Bun (`RS_TOKENS_FILE`), encrypted whole with `RS_TOKENS_ENC_KEY`
 * when it is set, with owner-only permissions. Writes are debounced by 100 ms; call `flush()`
 * before the process exits. Loaded records stay for a week, even when their provider access
 * token has expired: the verifier refreshes it with the stored refresh token.
 */
export class FileTokenStore implements TokenStore {
  private readonly memory = new MemoryTokenStore();
  private readonly cipher: FileCipher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly path: string,
    encryptionKey: string | undefined,
    private readonly logger: Logger,
  ) {
    this.cipher = encryptionKey ? fileCipher(encryptionKey) : undefined;
    this.load();
  }

  async storeRsMapping(
    rsAccess: string,
    provider: ProviderTokens,
    rsRefresh?: string,
    binding?: RsRecord['oauth'],
  ): Promise<RsRecord> {
    const record = await this.memory.storeRsMapping(rsAccess, provider, rsRefresh, binding);
    this.scheduleSave();
    return record;
  }

  getByRsAccess(rsAccess: string): Promise<RsRecord | null> {
    return this.memory.getByRsAccess(rsAccess);
  }

  getByRsRefresh(rsRefresh: string): Promise<RsRecord | null> {
    return this.memory.getByRsRefresh(rsRefresh);
  }

  async updateByRsRefresh(
    rsRefresh: string,
    provider: ProviderTokens,
    newRsAccess?: string,
  ): Promise<RsRecord | null> {
    const record = await this.memory.updateByRsRefresh(rsRefresh, provider, newRsAccess);
    this.scheduleSave();
    return record;
  }

  /** Write pending changes now. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.save();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      let raw = readFileSync(this.path, 'utf8');
      let saved: SavedFile;
      try {
        saved = JSON.parse(raw) as SavedFile;
      } catch {
        if (!this.cipher) {
          this.logger.error('The token file is encrypted, and no encryption key is set');
          return;
        }
        raw = this.cipher.decrypt(raw);
        saved = JSON.parse(raw) as SavedFile;
      }
      if (!Array.isArray(saved?.records)) {
        this.logger.warning('The token file has no records list; ignoring it');
        return;
      }
      this.memory.restore(saved.records);
    } catch (error) {
      this.logger.error('Could not load the token file', { error });
    }
  }

  private scheduleSave(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 100);
  }

  private save(): void {
    try {
      const directory = dirname(this.path);
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
      const saved: SavedFile = {
        version: 1,
        encrypted: Boolean(this.cipher),
        records: this.memory.records(),
      };
      const json = JSON.stringify(saved, null, 2);
      writeFileSync(this.path, this.cipher ? this.cipher.encrypt(json) : json, {
        encoding: 'utf8',
        mode: 0o600,
      });
      chmodSync(this.path, 0o600);
    } catch (error) {
      this.logger.error('Could not save the token file', { error });
    }
  }
}
