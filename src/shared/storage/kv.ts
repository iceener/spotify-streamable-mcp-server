// Cloudflare KV storage with encryption support

import type {
  RsRecord,
  SessionRecord,
  SessionStore,
  SpotifyTokens,
  TokenStore,
  Transaction,
} from './interface.ts';
import { MemorySessionStore, MemoryTokenStore } from './memory.ts';

// Cloudflare KV namespace type
type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expiration?: number; expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
};

type EncryptFn = (plaintext: string) => Promise<string> | string;
type DecryptFn = (ciphertext: string) => Promise<string> | string;

function ttl(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function fromJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export class KvTokenStore implements TokenStore {
  private kv: KVNamespace;
  private encrypt: EncryptFn;
  private decrypt: DecryptFn;
  private fallback: MemoryTokenStore;

  constructor(
    kv: KVNamespace,
    options?: {
      encrypt?: EncryptFn;
      decrypt?: DecryptFn;
      fallback?: MemoryTokenStore;
    },
  ) {
    this.kv = kv;
    this.encrypt = options?.encrypt ?? ((s) => s);
    this.decrypt = options?.decrypt ?? ((s) => s);
    this.fallback = options?.fallback ?? new MemoryTokenStore();
  }

  private async putJson(
    key: string,
    value: unknown,
    options?: { expiration?: number; expirationTtl?: number },
  ): Promise<void> {
    try {
      const raw = await this.encrypt(toJson(value));
      await this.kv.put(key, raw, options);
    } catch (error) {
      // KV write failed (likely quota exceeded) - log but don't crash
      // Fallback memory store will still have the data
      console.error('[KV] Write failed:', (error as Error).message);
      throw error; // Re-throw so caller knows KV failed
    }
  }

  private async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key);
    if (!raw) {
      return null;
    }
    const plain = await this.decrypt(raw);
    return fromJson<T>(plain);
  }

  async storeRsMapping(
    rsAccess: string,
    spotify: SpotifyTokens,
    rsRefresh?: string,
  ): Promise<RsRecord> {
    const rec: RsRecord = {
      rs_access_token: rsAccess,
      rs_refresh_token: rsRefresh ?? crypto.randomUUID(),
      spotify: { ...spotify },
      created_at: Date.now(),
    };

    // CRITICAL: Store in memory fallback FIRST
    // If KV fails (quota/network), memory still has it
    await this.fallback.storeRsMapping(rsAccess, spotify, rsRefresh);

    // Then try KV (may fail due to quota)
    try {
      await Promise.all([
        this.putJson(`rs:access:${rec.rs_access_token}`, rec),
        this.putJson(`rs:refresh:${rec.rs_refresh_token}`, rec),
      ]);
    } catch (error) {
      console.warn(
        '[KV] Failed to persist RS mapping (using memory fallback):',
        (error as Error).message,
      );
      // Don't throw - memory fallback has the data
    }

    return rec;
  }

  async getByRsAccess(rsAccess: string): Promise<RsRecord | null> {
    const rec = await this.getJson<RsRecord>(`rs:access:${rsAccess}`);
    return rec ?? (await this.fallback.getByRsAccess(rsAccess));
  }

  async getByRsRefresh(rsRefresh: string): Promise<RsRecord | null> {
    const rec = await this.getJson<RsRecord>(`rs:refresh:${rsRefresh}`);
    return rec ?? (await this.fallback.getByRsRefresh(rsRefresh));
  }

  async updateByRsRefresh(
    rsRefresh: string,
    spotify: SpotifyTokens,
    maybeNewRsAccess?: string,
  ): Promise<RsRecord | null> {
    const existing = await this.getJson<RsRecord>(`rs:refresh:${rsRefresh}`);
    if (!existing) {
      return this.fallback.updateByRsRefresh(rsRefresh, spotify, maybeNewRsAccess);
    }

    const next: RsRecord = {
      rs_access_token: maybeNewRsAccess || existing.rs_access_token,
      rs_refresh_token: rsRefresh,
      spotify: { ...spotify },
      created_at: Date.now(),
    };

    // Update memory fallback first
    await this.fallback.updateByRsRefresh(rsRefresh, spotify, maybeNewRsAccess);

    // Then try KV (may fail due to quota)
    try {
      await Promise.all([
        this.kv.delete(`rs:access:${existing.rs_access_token}`),
        this.putJson(`rs:access:${next.rs_access_token}`, next),
        this.putJson(`rs:refresh:${rsRefresh}`, next),
      ]);
    } catch (error) {
      console.warn(
        '[KV] Failed to update RS mapping (using memory fallback):',
        (error as Error).message,
      );
      // Don't throw - memory fallback has the data
    }

    return next;
  }

  async saveTransaction(
    txnId: string,
    txn: Transaction,
    ttlSeconds = 600,
  ): Promise<void> {
    // Memory fallback first (critical for OAuth flow)
    await this.fallback.saveTransaction(txnId, txn);

    // KV is optional (nice to have for persistence across instances)
    try {
      await this.putJson(`txn:${txnId}`, txn, { expiration: ttl(ttlSeconds) });
    } catch (error) {
      console.warn(
        '[KV] Failed to save transaction (using memory):',
        (error as Error).message,
      );
      // Don't throw - memory has it
    }
  }

  async getTransaction(txnId: string): Promise<Transaction | null> {
    const txn = await this.getJson<Transaction>(`txn:${txnId}`);
    return txn ?? (await this.fallback.getTransaction(txnId));
  }

  async deleteTransaction(txnId: string): Promise<void> {
    await this.kv.delete(`txn:${txnId}`);
    await this.fallback.deleteTransaction(txnId);
  }

  async saveCode(code: string, txnId: string, ttlSeconds = 600): Promise<void> {
    // Memory fallback first (critical for OAuth flow)
    await this.fallback.saveCode(code, txnId);

    // KV is optional
    try {
      await this.putJson(`code:${code}`, { v: txnId }, { expiration: ttl(ttlSeconds) });
    } catch (error) {
      console.warn(
        '[KV] Failed to save code (using memory):',
        (error as Error).message,
      );
      // Don't throw - memory has it
    }
  }

  async getTxnIdByCode(code: string): Promise<string | null> {
    const obj = await this.getJson<{ v: string }>(`code:${code}`);
    return obj?.v ?? (await this.fallback.getTxnIdByCode(code));
  }

  async deleteCode(code: string): Promise<void> {
    await this.kv.delete(`code:${code}`);
    await this.fallback.deleteCode(code);
  }
}

const SESSION_KEY_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 24 * 60 * 60;

export class KvSessionStore implements SessionStore {
  private kv: KVNamespace;
  private encrypt: EncryptFn;
  private decrypt: DecryptFn;
  private fallback: MemorySessionStore;

  constructor(
    kv: KVNamespace,
    options?: {
      encrypt?: EncryptFn;
      decrypt?: DecryptFn;
      fallback?: MemorySessionStore;
    },
  ) {
    this.kv = kv;
    this.encrypt = options?.encrypt ?? ((s) => s);
    this.decrypt = options?.decrypt ?? ((s) => s);
    this.fallback = options?.fallback ?? new MemorySessionStore();
  }

  private async putSession(key: string, value: SessionRecord): Promise<void> {
    const raw = await this.encrypt(toJson(value));
    await this.kv.put(`${SESSION_KEY_PREFIX}${key}`, raw, {
      expiration: ttl(SESSION_TTL_SECONDS),
    });
    await this.fallback.put(key, value);
  }

  private async getSession(key: string): Promise<SessionRecord | null> {
    const raw = await this.kv.get(`${SESSION_KEY_PREFIX}${key}`);
    if (!raw) {
      return this.fallback.get(key);
    }
    const plain = await this.decrypt(raw);
    return fromJson<SessionRecord>(plain);
  }

  async ensure(sessionId: string): Promise<void> {
    const existing = await this.getSession(sessionId);
    if (!existing) {
      await this.putSession(sessionId, { created_at: Date.now() });
    }
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    return this.getSession(sessionId);
  }

  async put(sessionId: string, value: SessionRecord): Promise<void> {
    await this.putSession(sessionId, value);
  }

  async delete(sessionId: string): Promise<void> {
    await this.kv.delete(`${SESSION_KEY_PREFIX}${sessionId}`);
    await this.fallback.delete(sessionId);
  }
}
