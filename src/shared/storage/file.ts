// File-backed storage for Node.js (wraps memory with JSON persistence)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RsRecord, SpotifyTokens, TokenStore, Transaction } from './interface.ts';
import { MemoryTokenStore } from './memory.ts';

type PersistShape = {
  records: Array<RsRecord>;
};

export class FileTokenStore implements TokenStore {
  private memory: MemoryTokenStore;
  private persistPath: string | null;

  constructor(persistPath?: string) {
    this.memory = new MemoryTokenStore();
    this.persistPath = persistPath ?? null;
    this.load();
  }

  private load(): void {
    if (!this.persistPath) {
      console.log('[FileTokenStore] No persistPath, skipping load');
      return;
    }

    try {
      if (!existsSync(this.persistPath)) {
        console.log('[FileTokenStore] File does not exist:', this.persistPath);
        return;
      }

      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as PersistShape;

      if (!data || !Array.isArray(data.records)) {
        console.warn('[FileTokenStore] Invalid file format');
        return;
      }

      console.log(
        '[FileTokenStore] Loading',
        data.records.length,
        'records from',
        this.persistPath,
      );

      for (const rec of data.records) {
        this.memory['rsAccessMap'].set(rec.rs_access_token, rec);
        this.memory['rsRefreshMap'].set(rec.rs_refresh_token, rec);
      }

      console.log('[FileTokenStore] Loaded', this.memory['rsAccessMap'].size, 'tokens');
    } catch (error) {
      console.error('[FileTokenStore] Load failed:', error);
    }
  }

  private save(): void {
    if (!this.persistPath) {
      console.warn('[FileTokenStore] No persistPath configured, skipping file save');
      return;
    }

    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        console.log('[FileTokenStore] Creating directory:', dir);
        mkdirSync(dir, { recursive: true });
      }

      const records = Array.from(this.memory['rsAccessMap'].values());
      const obj: PersistShape = { records };
      console.log(
        '[FileTokenStore] Writing',
        records.length,
        'records to',
        this.persistPath,
      );
      writeFileSync(this.persistPath, JSON.stringify(obj, null, 2), 'utf8');
      console.log('[FileTokenStore] File write successful');
    } catch (error) {
      console.error('[FileTokenStore] Save failed:', error);
    }
  }

  async storeRsMapping(
    rsAccess: string,
    spotify: SpotifyTokens,
    rsRefresh?: string,
  ): Promise<RsRecord> {
    console.log('[FileTokenStore] Storing RS mapping...', {
      rsAccessPrefix: rsAccess.substring(0, 8),
      persistPath: this.persistPath,
    });
    const result = await this.memory.storeRsMapping(rsAccess, spotify, rsRefresh);
    this.save();
    console.log('[FileTokenStore] Saved to memory and file');
    return result;
  }

  async getByRsAccess(rsAccess: string): Promise<RsRecord | null> {
    return this.memory.getByRsAccess(rsAccess);
  }

  async getByRsRefresh(rsRefresh: string): Promise<RsRecord | null> {
    return this.memory.getByRsRefresh(rsRefresh);
  }

  async updateByRsRefresh(
    rsRefresh: string,
    spotify: SpotifyTokens,
    maybeNewRsAccess?: string,
  ): Promise<RsRecord | null> {
    const result = await this.memory.updateByRsRefresh(
      rsRefresh,
      spotify,
      maybeNewRsAccess,
    );
    this.save();
    return result;
  }

  async saveTransaction(txnId: string, txn: Transaction): Promise<void> {
    return this.memory.saveTransaction(txnId, txn);
  }

  async getTransaction(txnId: string): Promise<Transaction | null> {
    return this.memory.getTransaction(txnId);
  }

  async deleteTransaction(txnId: string): Promise<void> {
    return this.memory.deleteTransaction(txnId);
  }

  async saveCode(code: string, txnId: string): Promise<void> {
    return this.memory.saveCode(code, txnId);
  }

  async getTxnIdByCode(code: string): Promise<string | null> {
    return this.memory.getTxnIdByCode(code);
  }

  async deleteCode(code: string): Promise<void> {
    return this.memory.deleteCode(code);
  }
}
