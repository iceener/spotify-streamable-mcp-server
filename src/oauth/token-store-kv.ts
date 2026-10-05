import type { Logger } from '../platform/logger';
import type { Encryptor } from './crypto';
import {
  MemoryTokenStore,
  type ProviderTokens,
  type RsRecord,
  type TokenStore,
  TokenStoreUnavailableError,
} from './token-store';

/** The part of a Workers KV namespace the store uses. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Records in Workers KV, each written twice: `rs:access:<token>` and `rs:refresh:<token>`,
 * as JSON encrypted with `RS_TOKENS_ENC_KEY` (plain JSON without a key). Every write goes to
 * an in-memory copy first, so a failed KV write (quota, outage) still works in this isolate.
 * KV is eventually consistent, so it never decides single-use questions: authorization codes
 * and transactions live in the authority (`authority.ts`).
 */
export class KvTokenStore implements TokenStore {
  private readonly fallback = new MemoryTokenStore();

  constructor(
    private readonly kv: KvLike,
    private readonly options: { encryptor: Encryptor | undefined; logger: Logger },
  ) {}

  async storeRsMapping(
    rsAccess: string,
    provider: ProviderTokens,
    rsRefresh?: string,
    binding?: RsRecord['oauth'],
  ): Promise<RsRecord> {
    const record: RsRecord = {
      rs_access_token: rsAccess,
      rs_refresh_token: rsRefresh ?? crypto.randomUUID(),
      ...(binding && { oauth: { ...binding } }),
      provider: { ...provider },
      created_at: Date.now(),
    };
    await this.fallback.storeRsMapping(rsAccess, provider, record.rs_refresh_token, binding);
    await this.settle('Could not store tokens in KV; this isolate keeps them', [
      this.put(`rs:access:${record.rs_access_token}`, record),
      this.put(`rs:refresh:${record.rs_refresh_token}`, record),
    ]);
    return record;
  }

  async getByRsAccess(rsAccess: string): Promise<RsRecord | null> {
    return (
      (await this.get(`rs:access:${rsAccess}`)) ?? (await this.fallback.getByRsAccess(rsAccess))
    );
  }

  async getByRsRefresh(rsRefresh: string): Promise<RsRecord | null> {
    return (
      (await this.get(`rs:refresh:${rsRefresh}`)) ?? (await this.fallback.getByRsRefresh(rsRefresh))
    );
  }

  async updateByRsRefresh(
    rsRefresh: string,
    provider: ProviderTokens,
    newRsAccess?: string,
  ): Promise<RsRecord | null> {
    const existing = await this.get(`rs:refresh:${rsRefresh}`);
    if (!existing) return this.fallback.updateByRsRefresh(rsRefresh, provider, newRsAccess);

    const accessChanged = !!newRsAccess && newRsAccess !== existing.rs_access_token;
    const next: RsRecord = {
      ...(existing.oauth && { oauth: { ...existing.oauth } }),
      rs_access_token: newRsAccess || existing.rs_access_token,
      rs_refresh_token: rsRefresh,
      provider: { ...provider },
      created_at: Date.now(),
    };
    await this.fallback.updateByRsRefresh(rsRefresh, provider, newRsAccess);
    await this.settle('Could not update tokens in KV; this isolate keeps them', [
      ...(accessChanged ? [this.delete(`rs:access:${existing.rs_access_token}`)] : []),
      this.put(`rs:access:${next.rs_access_token}`, next),
      this.put(`rs:refresh:${rsRefresh}`, next),
    ]);
    return next;
  }

  /** Wait for every write, and log the ones that failed. The memory copy already has them. */
  private async settle(message: string, writes: Promise<void>[]): Promise<void> {
    const errors = (await Promise.allSettled(writes)).flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length > 0) this.options.logger.warning(message, { errors });
  }

  private async put(key: string, value: RsRecord): Promise<void> {
    const json = JSON.stringify(value);
    const raw = this.options.encryptor ? await this.options.encryptor.encrypt(json) : json;
    try {
      await this.kv.put(key, raw);
    } catch {
      throw new KvError('write', key);
    }
  }

  private async delete(key: string): Promise<void> {
    try {
      await this.kv.delete(key);
    } catch {
      throw new KvError('delete', key);
    }
  }

  private async get(key: string): Promise<RsRecord | null> {
    let raw: string | null;
    try {
      raw = await this.kv.get(key);
    } catch {
      throw new KvError('read', key);
    }
    if (!raw) return null;
    const json = this.options.encryptor ? await this.options.encryptor.decrypt(raw) : raw;
    try {
      return JSON.parse(json) as RsRecord;
    } catch {
      return null;
    }
  }
}

/**
 * A failed KV call. Keys contain the opaque tokens, and KV's own error messages may repeat the
 * key, so the error names only the operation and the kind of record, never the key or the cause.
 */
class KvError extends TokenStoreUnavailableError {
  constructor(operation: 'read' | 'write' | 'delete', key: string) {
    const kind = key.startsWith('rs:refresh:') ? 'refresh' : 'access';
    super(`KV ${operation} failed (${kind} record)`);
    this.name = 'KvError';
  }
}
