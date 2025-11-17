// In-memory storage implementation (suitable for development and testing)

import type {
  RsRecord,
  SessionRecord,
  SessionStore,
  SpotifyTokens,
  TokenStore,
  Transaction,
} from './interface.ts';

export class MemoryTokenStore implements TokenStore {
  protected rsAccessMap = new Map<string, RsRecord>();
  protected rsRefreshMap = new Map<string, RsRecord>();
  protected transactions = new Map<string, Transaction>();
  protected codes = new Map<string, string>();

  async storeRsMapping(
    rsAccess: string,
    spotify: SpotifyTokens,
    rsRefresh?: string,
  ): Promise<RsRecord> {
    if (rsRefresh) {
      const existing = this.rsRefreshMap.get(rsRefresh);
      if (existing) {
        this.rsAccessMap.delete(existing.rs_access_token);
        existing.rs_access_token = rsAccess;
        existing.spotify = { ...spotify };
        this.rsAccessMap.set(rsAccess, existing);
        return existing;
      }
    }

    const record: RsRecord = {
      rs_access_token: rsAccess,
      rs_refresh_token: rsRefresh ?? crypto.randomUUID(),
      spotify: { ...spotify },
      created_at: Date.now(),
    };

    this.rsAccessMap.set(record.rs_access_token, record);
    this.rsRefreshMap.set(record.rs_refresh_token, record);
    return record;
  }

  async getByRsAccess(rsAccess: string): Promise<RsRecord | null> {
    return this.rsAccessMap.get(rsAccess) ?? null;
  }

  async getByRsRefresh(rsRefresh: string): Promise<RsRecord | null> {
    return this.rsRefreshMap.get(rsRefresh) ?? null;
  }

  async updateByRsRefresh(
    rsRefresh: string,
    spotify: SpotifyTokens,
    maybeNewRsAccess?: string,
  ): Promise<RsRecord | null> {
    const rec = this.rsRefreshMap.get(rsRefresh);
    if (!rec) {
      return null;
    }

    if (maybeNewRsAccess) {
      this.rsAccessMap.delete(rec.rs_access_token);
      rec.rs_access_token = maybeNewRsAccess;
      rec.created_at = Date.now();
    }

    rec.spotify = { ...spotify };
    this.rsAccessMap.set(rec.rs_access_token, rec);
    this.rsRefreshMap.set(rsRefresh, rec);
    return rec;
  }

  async saveTransaction(txnId: string, txn: Transaction): Promise<void> {
    this.transactions.set(txnId, txn);
  }

  async getTransaction(txnId: string): Promise<Transaction | null> {
    return this.transactions.get(txnId) ?? null;
  }

  async deleteTransaction(txnId: string): Promise<void> {
    this.transactions.delete(txnId);
  }

  async saveCode(code: string, txnId: string): Promise<void> {
    this.codes.set(code, txnId);
  }

  async getTxnIdByCode(code: string): Promise<string | null> {
    return this.codes.get(code) ?? null;
  }

  async deleteCode(code: string): Promise<void> {
    this.codes.delete(code);
  }
}

export class MemorySessionStore implements SessionStore {
  protected sessions = new Map<string, SessionRecord>();

  async ensure(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        created_at: Date.now(),
      });
    }
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async put(sessionId: string, value: SessionRecord): Promise<void> {
    this.sessions.set(sessionId, value);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
