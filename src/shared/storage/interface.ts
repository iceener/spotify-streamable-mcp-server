// Unified storage interfaces for both Node.js and Cloudflare Workers
// Provider-agnostic version from Spotify MCP

export type ProviderTokens = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scopes?: string[];
};

export type RsRecord = {
  rs_access_token: string;
  rs_refresh_token: string;
  provider: ProviderTokens;
  created_at: number;
};

export type Transaction = {
  codeChallenge: string;
  state?: string;
  scope?: string;
  createdAt: number;
  sid?: string;
  provider?: ProviderTokens;
};

export type SessionRecord = {
  rs_access_token?: string;
  rs_refresh_token?: string;
  provider?: ProviderTokens | null;
  created_at: number;
};

/**
 * Token storage interface - all operations are async to support both
 * sync (Node Map + File) and async (Cloudflare KV) backends
 */
export interface TokenStore {
  // RS token mapping
  storeRsMapping(
    rsAccess: string,
    provider: ProviderTokens,
    rsRefresh?: string,
  ): Promise<RsRecord>;

  getByRsAccess(rsAccess: string): Promise<RsRecord | null>;

  getByRsRefresh(rsRefresh: string): Promise<RsRecord | null>;

  updateByRsRefresh(
    rsRefresh: string,
    provider: ProviderTokens,
    maybeNewRsAccess?: string,
  ): Promise<RsRecord | null>;

  // Transaction storage (PKCE flow)
  saveTransaction(txnId: string, txn: Transaction, ttlSeconds?: number): Promise<void>;

  getTransaction(txnId: string): Promise<Transaction | null>;

  deleteTransaction(txnId: string): Promise<void>;

  // Code storage (authorization codes)
  saveCode(code: string, txnId: string, ttlSeconds?: number): Promise<void>;

  getTxnIdByCode(code: string): Promise<string | null>;

  deleteCode(code: string): Promise<void>;
}

/**
 * Session storage interface
 */
export interface SessionStore {
  ensure(sessionId: string): Promise<void>;

  get(sessionId: string): Promise<SessionRecord | null>;

  put(sessionId: string, value: SessionRecord): Promise<void>;

  delete(sessionId: string): Promise<void>;
}
