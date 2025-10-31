import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config/env.ts';
import { refreshSpotifyTokens } from '../services/spotify/oauth.ts';
import type { SpotifyTokenResponseCodecType } from '../types/spotify.codecs.ts';
import { logger } from '../utils/logger.ts';

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
  spotify: SpotifyUserTokens;
};

const rsAccessToRecord = new Map<string, RsTokenRecord>();
const rsRefreshToRecord = new Map<string, RsTokenRecord>();

type RefreshResult = {
  spotify: SpotifyUserTokens;
  rs_access_token: string;
  rs_refresh_token: string;
};

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
  } catch {}
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
  } catch {}
}

loadPersisted();

export function storeRsTokenMapping(
  rsAccessToken: string,
  spotifyTokens: SpotifyUserTokens,
  rsRefreshToken?: string,
): RsTokenRecord {
  if (rsRefreshToken) {
    const existing = rsRefreshToRecord.get(rsRefreshToken);
    if (existing) {
      rsAccessToRecord.delete(existing.rs_access_token);
      existing.rs_access_token = rsAccessToken;
      existing.spotify = { ...spotifyTokens };
      rsAccessToRecord.set(rsAccessToken, existing);
      savePersisted();
      return existing;
    }
  }
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

export function getRecordByRsRefreshToken(
  rsRefreshToken?: string,
): RsTokenRecord | null {
  if (!rsRefreshToken) {
    return null;
  }
  return rsRefreshToRecord.get(rsRefreshToken) ?? null;
}

export function getRecordByRsAccessToken(rsAccessToken?: string): RsTokenRecord | null {
  if (!rsAccessToken) {
    return null;
  }
  return rsAccessToRecord.get(rsAccessToken) ?? null;
}

export async function refreshSpotifyTokensForRsRefreshToken(
  rsRefreshToken: string,
  options: { signal?: AbortSignal; newRsAccessToken?: string } = {},
): Promise<RefreshResult | null> {
  const { signal, newRsAccessToken } = options;
  const record = rsRefreshToRecord.get(rsRefreshToken);
  if (!record) {
    await logger.warning('tokens', {
      message: 'refreshSpotifyTokensForRsRefreshToken: record not found',
      rsRefreshToken,
    });
    return null;
  }

  const spotifyRefreshToken = record.spotify.refresh_token;
  if (!spotifyRefreshToken) {
    await logger.warning('tokens', {
      message: 'refreshSpotifyTokensForRsRefreshToken: spotify refresh token missing',
      rsRefreshToken,
    });
    return null;
  }

  try {
    const refreshed = await refreshSpotifyTokens({
      refreshToken: spotifyRefreshToken,
      signal,
    });
    const tokens = normalizeSpotifyTokenPayload(refreshed, spotifyRefreshToken);
    updateRecordWithSpotify(record, tokens, newRsAccessToken);
    return {
      spotify: tokens,
      rs_access_token: record.rs_access_token,
      rs_refresh_token: record.rs_refresh_token,
    };
  } catch (error) {
    await logger.error('tokens', {
      message: 'refreshSpotifyTokensForRsRefreshToken: refresh failed',
      rsRefreshToken,
      error: (error as Error).message,
    });
    return null;
  }
}

export async function refreshSpotifyTokensForRsAccessToken(
  rsAccessToken: string,
  options: { signal?: AbortSignal } = {},
): Promise<RefreshResult | null> {
  const record = getRecordByRsAccessToken(rsAccessToken);
  if (!record) {
    await logger.warning('tokens', {
      message: 'refreshSpotifyTokensForRsAccessToken: record not found',
      rsAccessToken,
    });
    return null;
  }
  return await refreshSpotifyTokensForRsRefreshToken(record.rs_refresh_token, {
    signal: options.signal,
    newRsAccessToken: rsAccessToken,
  });
}

export async function getSpotifyTokensWithRefreshByRsAccessToken(
  rsAccessToken: string,
  options: { signal?: AbortSignal; refreshWindowMs?: number } = {},
): Promise<{ tokens: SpotifyUserTokens; refreshed: boolean } | null> {
  const record = getRecordByRsAccessToken(rsAccessToken);
  if (!record) {
    await logger.warning('tokens', {
      message: 'getSpotifyTokensWithRefreshByRsAccessToken: record not found',
      rsAccessToken,
    });
    return null;
  }

  const margin = options.refreshWindowMs ?? 30_000;
  const expiresAt = record.spotify.expires_at;
  const now = Date.now();
  const shouldRefresh =
    typeof expiresAt === 'number' && Number.isFinite(expiresAt)
      ? expiresAt - margin <= now
      : false;

  if (!shouldRefresh) {
    return { tokens: record.spotify, refreshed: false };
  }

  const refreshed = await refreshSpotifyTokensForRsAccessToken(rsAccessToken, {
    signal: options.signal,
  });
  if (!refreshed) {
    return { tokens: record.spotify, refreshed: false };
  }

  return { tokens: refreshed.spotify, refreshed: true };
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

function normalizeSpotifyTokenPayload(
  payload: SpotifyTokenResponseCodecType,
  fallbackRefreshToken: string,
): SpotifyUserTokens {
  const scopes = String(payload.scope || '')
    .split(' ')
    .map((v) => v.trim())
    .filter(Boolean);
  const accessToken = payload.access_token?.trim();
  if (!accessToken) {
    throw new Error('Spotify refresh payload missing access_token');
  }
  const refreshToken = payload.refresh_token?.trim() || fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error('Spotify refresh payload missing refresh_token');
  }
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
    scopes,
  };
}

function updateRecordWithSpotify(
  record: RsTokenRecord,
  tokens: SpotifyUserTokens,
  maybeNewRsAccessToken?: string,
): void {
  if (maybeNewRsAccessToken) {
    rsAccessToRecord.delete(record.rs_access_token);
    record.rs_access_token = maybeNewRsAccessToken;
    record.created_at = Date.now();
  }
  record.spotify = { ...tokens };
  rsAccessToRecord.set(record.rs_access_token, record);
  rsRefreshToRecord.set(record.rs_refresh_token, record);
  savePersisted();
}
