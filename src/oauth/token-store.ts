/**
 * The proxy's tokens: one record per signed-in grant, found by its opaque access token
 * (`rs:access:<token>`) and by its opaque refresh token (`rs:refresh:<token>`). The field
 * names are the stored format; KV and token files written by earlier versions must stay
 * readable, so don't rename them.
 */
export interface ProviderTokens {
  access_token: string;
  refresh_token?: string | undefined;
  /** Milliseconds since the epoch. */
  expires_at?: number | undefined;
  scopes?: string[] | undefined;
}

export interface RsRecord {
  rs_access_token: string;
  rs_refresh_token: string;
  provider: ProviderTokens;
  created_at: number;
  /** Who the tokens were issued to, and for which resource. Absent on records issued before 2026-09. */
  oauth?: { clientId: string; resource: string } | undefined;
}

export interface TokenStore {
  storeRsMapping(
    rsAccess: string,
    provider: ProviderTokens,
    rsRefresh?: string,
    binding?: RsRecord['oauth'],
  ): Promise<RsRecord>;
  getByRsAccess(rsAccess: string): Promise<RsRecord | null>;
  getByRsRefresh(rsRefresh: string): Promise<RsRecord | null>;
  /** Replace the provider tokens, and the access token too when `newRsAccess` is given. */
  updateByRsRefresh(
    rsRefresh: string,
    provider: ProviderTokens,
    newRsAccess?: string,
  ): Promise<RsRecord | null>;
}

/**
 * The store itself couldn't be reached (a KV outage, for example). Unlike a token that isn't
 * found or won't decrypt, this says nothing about the token: the verifier answers 500, so the
 * client keeps its token and retries instead of signing in again.
 */
export class TokenStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenStoreUnavailableError';
  }
}

/** How long a record stays in memory without being refreshed. */
const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Beyond this, the oldest records are dropped to make room. */
const MAX_RECORDS = 10_000;

type Entry = RsRecord & { expiresAt: number };

/**
 * Records in process memory. Tests use it directly; the KV store keeps one as a same-isolate
 * fallback, and the file store loads and saves through one.
 */
export class MemoryTokenStore implements TokenStore {
  private byAccess = new Map<string, Entry>();
  private byRefresh = new Map<string, Entry>();

  async storeRsMapping(
    rsAccess: string,
    provider: ProviderTokens,
    rsRefresh?: string,
    binding?: RsRecord['oauth'],
  ): Promise<RsRecord> {
    const now = Date.now();
    this.evictOldest();

    const existing = rsRefresh ? this.byRefresh.get(rsRefresh) : undefined;
    if (existing) {
      this.byAccess.delete(existing.rs_access_token);
      existing.rs_access_token = rsAccess;
      existing.provider = { ...provider };
      existing.expiresAt = now + RECORD_TTL_MS;
      this.byAccess.set(rsAccess, existing);
      return existing;
    }

    const entry: Entry = {
      rs_access_token: rsAccess,
      rs_refresh_token: rsRefresh ?? crypto.randomUUID(),
      provider: { ...provider },
      created_at: now,
      ...(binding && { oauth: { ...binding } }),
      expiresAt: now + RECORD_TTL_MS,
    };
    this.byAccess.set(entry.rs_access_token, entry);
    this.byRefresh.set(entry.rs_refresh_token, entry);
    return entry;
  }

  async getByRsAccess(rsAccess: string): Promise<RsRecord | null> {
    return this.live(this.byAccess.get(rsAccess));
  }

  async getByRsRefresh(rsRefresh: string): Promise<RsRecord | null> {
    return this.live(this.byRefresh.get(rsRefresh));
  }

  async updateByRsRefresh(
    rsRefresh: string,
    provider: ProviderTokens,
    newRsAccess?: string,
  ): Promise<RsRecord | null> {
    const entry = this.byRefresh.get(rsRefresh);
    if (!entry) return null;
    const now = Date.now();
    if (newRsAccess) {
      this.byAccess.delete(entry.rs_access_token);
      entry.rs_access_token = newRsAccess;
      entry.created_at = now;
    }
    entry.provider = { ...provider };
    entry.expiresAt = now + RECORD_TTL_MS;
    this.byAccess.set(entry.rs_access_token, entry);
    return entry;
  }

  /** Every record, for the file store to save. The saved shape includes `expiresAt`. */
  records(): RsRecord[] {
    return [...this.byAccess.values()];
  }

  /**
   * Load saved records. Each stays for a week from now, whatever its provider token: an expired
   * provider token is refreshed with the stored refresh token.
   */
  restore(records: RsRecord[]): void {
    const expiresAt = Date.now() + RECORD_TTL_MS;
    for (const record of records) {
      const entry = { ...record, expiresAt };
      this.byAccess.set(record.rs_access_token, entry);
      this.byRefresh.set(record.rs_refresh_token, entry);
    }
  }

  private live(entry: Entry | undefined): RsRecord | null {
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.byAccess.delete(entry.rs_access_token);
      this.byRefresh.delete(entry.rs_refresh_token);
      return null;
    }
    return entry;
  }

  private evictOldest(): void {
    if (this.byAccess.size < MAX_RECORDS) return;
    const oldest = [...this.byAccess.values()]
      .sort((left, right) => left.created_at - right.created_at)
      .slice(0, 10);
    for (const entry of oldest) {
      this.byAccess.delete(entry.rs_access_token);
      this.byRefresh.delete(entry.rs_refresh_token);
    }
  }
}
