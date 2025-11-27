// In-memory storage implementation with TTL, size limits, and cleanup
// Provider-agnostic version from Spotify MCP

import type {
  ProviderTokens,
  RsRecord,
  SessionRecord,
  SessionStore,
  TokenStore,
  Transaction,
} from './interface.js';

/** Default TTL for transactions (10 minutes per OAuth spec) */
const DEFAULT_TXN_TTL_MS = 10 * 60 * 1000;

/** Default TTL for authorization codes (10 minutes per OAuth spec) */
const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;

/** Default TTL for sessions (24 hours) */
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Default TTL for RS tokens (7 days) */
const DEFAULT_RS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum number of RS token records */
const MAX_RS_RECORDS = 10_000;

/** Maximum number of transactions */
const MAX_TRANSACTIONS = 1_000;

/** Maximum number of sessions */
const MAX_SESSIONS = 10_000;

/** Cleanup interval (1 minute) */
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Wrapper for entries with expiration time.
 */
interface TimedEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

/**
 * LRU-like eviction: remove oldest entries when limit reached.
 */
function evictOldest<K, V extends { created_at?: number; createdAt?: number }>(
  map: Map<K, V>,
  maxSize: number,
  countToRemove = 1,
): void {
  if (map.size < maxSize) return;

  const entries = [...map.entries()].sort((a, b) => {
    const aTime = a[1].created_at ?? a[1].createdAt ?? 0;
    const bTime = b[1].created_at ?? b[1].createdAt ?? 0;
    return aTime - bTime;
  });

  for (let i = 0; i < countToRemove && i < entries.length; i++) {
    map.delete(entries[i][0]);
  }
}

/**
 * Remove expired entries from a timed map.
 */
function cleanupExpired<K, V extends { expiresAt: number }>(map: Map<K, V>): number {
  const now = Date.now();
  let removed = 0;

  for (const [key, entry] of map) {
    if (now >= entry.expiresAt) {
      map.delete(key);
      removed++;
    }
  }

  return removed;
}

export class MemoryTokenStore implements TokenStore {
  protected rsAccessMap = new Map<string, RsRecord & { expiresAt: number }>();
  protected rsRefreshMap = new Map<string, RsRecord & { expiresAt: number }>();
  protected transactions = new Map<string, TimedEntry<Transaction>>();
  protected codes = new Map<string, TimedEntry<string>>();

  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  /**
   * Start periodic cleanup of expired entries.
   */
  startCleanup(): void {
    if (this.cleanupIntervalId) return;

    this.cleanupIntervalId = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);

    // Don't prevent process exit
    if (
      typeof this.cleanupIntervalId === 'object' &&
      'unref' in this.cleanupIntervalId
    ) {
      this.cleanupIntervalId.unref();
    }
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  /**
   * Run cleanup of all expired entries.
   */
  cleanup(): { tokens: number; transactions: number; codes: number } {
    const now = Date.now();

    // Clean RS tokens
    let tokensRemoved = 0;
    for (const [key, entry] of this.rsAccessMap) {
      if (now >= entry.expiresAt) {
        this.rsAccessMap.delete(key);
        tokensRemoved++;
      }
    }
    for (const [key, entry] of this.rsRefreshMap) {
      if (now >= entry.expiresAt) {
        this.rsRefreshMap.delete(key);
      }
    }

    const transactionsRemoved = cleanupExpired(this.transactions);
    const codesRemoved = cleanupExpired(this.codes);

    return {
      tokens: tokensRemoved,
      transactions: transactionsRemoved,
      codes: codesRemoved,
    };
  }

  async storeRsMapping(
    rsAccess: string,
    provider: ProviderTokens,
    rsRefresh?: string,
    ttlMs: number = DEFAULT_RS_TOKEN_TTL_MS,
  ): Promise<RsRecord> {
    const now = Date.now();
    const expiresAt = now + ttlMs;

    // Evict oldest if at capacity
    evictOldest(this.rsAccessMap, MAX_RS_RECORDS, 10);

    // Check for existing refresh token record
    if (rsRefresh) {
      const existing = this.rsRefreshMap.get(rsRefresh);
      if (existing) {
        this.rsAccessMap.delete(existing.rs_access_token);
        existing.rs_access_token = rsAccess;
        existing.provider = { ...provider };
        existing.expiresAt = expiresAt;
        this.rsAccessMap.set(rsAccess, existing);
        return existing;
      }
    }

    const record: RsRecord & { expiresAt: number } = {
      rs_access_token: rsAccess,
      rs_refresh_token: rsRefresh ?? crypto.randomUUID(),
      provider: { ...provider },
      created_at: now,
      expiresAt,
    };

    this.rsAccessMap.set(record.rs_access_token, record);
    this.rsRefreshMap.set(record.rs_refresh_token, record);
    return record;
  }

  async getByRsAccess(rsAccess: string): Promise<RsRecord | null> {
    const entry = this.rsAccessMap.get(rsAccess);
    if (!entry) return null;

    // Check expiration
    if (Date.now() >= entry.expiresAt) {
      this.rsAccessMap.delete(rsAccess);
      this.rsRefreshMap.delete(entry.rs_refresh_token);
      return null;
    }

    return entry;
  }

  async getByRsRefresh(rsRefresh: string): Promise<RsRecord | null> {
    const entry = this.rsRefreshMap.get(rsRefresh);
    if (!entry) return null;

    // Check expiration
    if (Date.now() >= entry.expiresAt) {
      this.rsAccessMap.delete(entry.rs_access_token);
      this.rsRefreshMap.delete(rsRefresh);
      return null;
    }

    return entry;
  }

  async updateByRsRefresh(
    rsRefresh: string,
    provider: ProviderTokens,
    maybeNewRsAccess?: string,
    ttlMs: number = DEFAULT_RS_TOKEN_TTL_MS,
  ): Promise<RsRecord | null> {
    const rec = this.rsRefreshMap.get(rsRefresh);
    if (!rec) return null;

    const now = Date.now();

    if (maybeNewRsAccess) {
      this.rsAccessMap.delete(rec.rs_access_token);
      rec.rs_access_token = maybeNewRsAccess;
      rec.created_at = now;
    }

    rec.provider = { ...provider };
    rec.expiresAt = now + ttlMs;

    this.rsAccessMap.set(rec.rs_access_token, rec);
    this.rsRefreshMap.set(rsRefresh, rec);
    return rec;
  }

  async saveTransaction(
    txnId: string,
    txn: Transaction,
    ttlSeconds?: number,
  ): Promise<void> {
    const ttlMs = ttlSeconds ? ttlSeconds * 1000 : DEFAULT_TXN_TTL_MS;
    const now = Date.now();

    // Evict oldest if at capacity
    evictOldest(this.transactions, MAX_TRANSACTIONS, 10);

    this.transactions.set(txnId, {
      value: txn,
      expiresAt: now + ttlMs,
      createdAt: now,
    });
  }

  async getTransaction(txnId: string): Promise<Transaction | null> {
    const entry = this.transactions.get(txnId);
    if (!entry) return null;

    // Check expiration
    if (Date.now() >= entry.expiresAt) {
      this.transactions.delete(txnId);
      return null;
    }

    return entry.value;
  }

  async deleteTransaction(txnId: string): Promise<void> {
    this.transactions.delete(txnId);
  }

  async saveCode(code: string, txnId: string, ttlSeconds?: number): Promise<void> {
    const ttlMs = ttlSeconds ? ttlSeconds * 1000 : DEFAULT_CODE_TTL_MS;
    const now = Date.now();

    this.codes.set(code, {
      value: txnId,
      expiresAt: now + ttlMs,
      createdAt: now,
    });
  }

  async getTxnIdByCode(code: string): Promise<string | null> {
    const entry = this.codes.get(code);
    if (!entry) return null;

    // Check expiration
    if (Date.now() >= entry.expiresAt) {
      this.codes.delete(code);
      return null;
    }

    return entry.value;
  }

  async deleteCode(code: string): Promise<void> {
    this.codes.delete(code);
  }

  /**
   * Get current store statistics.
   */
  getStats(): {
    rsTokens: number;
    transactions: number;
    codes: number;
  } {
    return {
      rsTokens: this.rsAccessMap.size,
      transactions: this.transactions.size,
      codes: this.codes.size,
    };
  }
}

export class MemorySessionStore implements SessionStore {
  protected sessions = new Map<string, SessionRecord & { expiresAt: number }>();
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  /**
   * Start periodic cleanup of expired sessions.
   */
  startCleanup(): void {
    if (this.cleanupIntervalId) return;

    this.cleanupIntervalId = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);

    // Don't prevent process exit
    if (
      typeof this.cleanupIntervalId === 'object' &&
      'unref' in this.cleanupIntervalId
    ) {
      this.cleanupIntervalId.unref();
    }
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  /**
   * Remove expired sessions.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [sessionId, session] of this.sessions) {
      if (now >= session.expiresAt) {
        this.sessions.delete(sessionId);
        removed++;
      }
    }

    return removed;
  }

  async ensure(
    sessionId: string,
    ttlMs: number = DEFAULT_SESSION_TTL_MS,
  ): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // Extend TTL on access
      existing.expiresAt = Date.now() + ttlMs;
      return;
    }

    // Evict oldest if at capacity
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort(
        (a, b) => a[1].created_at - b[1].created_at,
      )[0];
      if (oldest) {
        this.sessions.delete(oldest[0]);
      }
    }

    const now = Date.now();
    this.sessions.set(sessionId, {
      created_at: now,
      expiresAt: now + ttlMs,
    });
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Check expiration
    if (Date.now() >= session.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  async put(
    sessionId: string,
    value: SessionRecord,
    ttlMs: number = DEFAULT_SESSION_TTL_MS,
  ): Promise<void> {
    const now = Date.now();
    this.sessions.set(sessionId, {
      ...value,
      expiresAt: now + ttlMs,
    });
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /**
   * Get current session count.
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}
