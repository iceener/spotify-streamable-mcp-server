import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config/env.js';

export type SpotifyUserTokens = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  scopes?: string[];
};

export type RsTokenRecord = {
  rs_access_token: string;
  rs_refresh_token: string;
  created_at: number; // epoch ms
  // Latest Spotify tokens for this subject
  spotify: SpotifyUserTokens;
};

// In-memory stores
const rsAccessToRecord = new Map<string, RsTokenRecord>();
const rsRefreshToRecord = new Map<string, RsTokenRecord>();

// Strong 256-bit opaque token
export function generateOpaqueToken(bytes: number = 32): string {
  return randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function persistPath(): string | null {
  return config.RS_TOKENS_FILE || null;
}

type PersistShape = {
  records: Array<{
    rs_access_token: string;
    rs_refresh_token: string;
    created_at: number;
    spotify: SpotifyUserTokens;
  }>;
};

function loadPersisted(): void {
  const p = persistPath();
  if (!p) {
    return;
  }
  try {
    if (!existsSync(p)) {
      return;
    }
    const raw = readFileSync(p, 'utf8');
    const data = JSON.parse(raw) as PersistShape;
    if (!data || !Array.isArray(data.records)) {
      return;
    }
    for (const rec of data.records) {
      const record: RsTokenRecord = {
        rs_access_token: rec.rs_access_token,
        rs_refresh_token: rec.rs_refresh_token,
        created_at: rec.created_at,
        spotify: rec.spotify,
      };
      rsAccessToRecord.set(record.rs_access_token, record);
      rsRefreshToRecord.set(record.rs_refresh_token, record);
    }
  } catch {
    // ignore
  }
}

function savePersisted(): void {
  const p = persistPath();
  if (!p) {
    return;
  }
  try {
    const dir = dirname(p);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const records = Array.from(rsAccessToRecord.values()).map((r) => ({
      rs_access_token: r.rs_access_token,
      rs_refresh_token: r.rs_refresh_token,
      created_at: r.created_at,
      spotify: r.spotify,
    }));
    const obj: PersistShape = { records };
    writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

loadPersisted();

export function storeRsTokenMapping(
  rsAccessToken: string,
  spotifyTokens: SpotifyUserTokens,
  rsRefreshToken?: string,
): RsTokenRecord {
  // If we are rotating only the access token for an existing RS refresh token, reuse that record
  if (rsRefreshToken) {
    const existing = rsRefreshToRecord.get(rsRefreshToken);
    if (existing) {
      // Remove old access mapping
      rsAccessToRecord.delete(existing.rs_access_token);
      existing.rs_access_token = rsAccessToken;
      existing.spotify = { ...spotifyTokens };
      rsAccessToRecord.set(rsAccessToken, existing);
      savePersisted();
      return existing;
    }
  }
  // Create new record with its own RS refresh token if not provided
  const record: RsTokenRecord = {
    rs_access_token: rsAccessToken,
    rs_refresh_token: rsRefreshToken ?? generateOpaqueToken(),
    created_at: Date.now(),
    spotify: { ...spotifyTokens },
  };
  rsAccessToRecord.set(record.rs_access_token, record);
  rsRefreshToRecord.set(record.rs_refresh_token, record);
  savePersisted();
  return record;
}

export function getSpotifyTokensByRsToken(rsToken?: string): SpotifyUserTokens | null {
  if (!rsToken) {
    return null;
  }
  const rec = rsAccessToRecord.get(rsToken);
  return rec ? rec.spotify : null;
}

function _getRecordByRsAccessToken(rsToken?: string): RsTokenRecord | null {
  if (!rsToken) {
    return null;
  }
  return rsAccessToRecord.get(rsToken) ?? null;
}

export function getRecordByRsRefreshToken(
  rsRefreshToken?: string,
): RsTokenRecord | null {
  if (!rsRefreshToken) {
    return null;
  }
  return rsRefreshToRecord.get(rsRefreshToken) ?? null;
}

export function updateSpotifyTokensByRsRefreshToken(
  rsRefreshToken: string,
  newSpotify: SpotifyUserTokens,
  maybeNewRsAccessToken?: string,
): RsTokenRecord | null {
  const rec = rsRefreshToRecord.get(rsRefreshToken);
  if (!rec) {
    return null;
  }
  if (maybeNewRsAccessToken) {
    rsAccessToRecord.delete(rec.rs_access_token);
    rec.rs_access_token = maybeNewRsAccessToken;
    rec.created_at = Date.now();
  }
  rec.spotify = { ...newSpotify };
  rsAccessToRecord.set(rec.rs_access_token, rec);
  rsRefreshToRecord.set(rsRefreshToken, rec);
  savePersisted();
  return rec;
}
