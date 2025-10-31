// Worker-safe token and transaction store with optional KV and encryption
// Falls back to in-memory maps when KV is unavailable

import { decryptString, encryptString } from '../utils/crypto.ts';
import { getEnv, setEnv } from '../utils/env.ts';

export type SpotifyUserTokens = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scopes?: string[];
};

type Txn = {
  codeChallenge: string;
  state?: string;
  scope?: string;
  createdAt: number;
  spotify?: SpotifyUserTokens;
};

export function setAuthStoreEnv(env: Record<string, unknown>): void {
  setEnv(env);
}

// In-memory fallback (dev)
const memTxns = new Map<string, Txn>();
const memCodes = new Map<string, string>();
const memRsByAccess = new Map<
  string,
  {
    rs_access_token: string;
    rs_refresh_token: string;
    spotify: SpotifyUserTokens;
  }
>();
const memRsByRefresh = new Map<
  string,
  {
    rs_access_token: string;
    rs_refresh_token: string;
    spotify: SpotifyUserTokens;
  }
>();

export type SessionRecord = {
  rs_access_token?: string;
  rs_refresh_token?: string;
  spotify?: SpotifyUserTokens | null;
  created_at: number;
};

const memSessions = new Map<string, SessionRecord>();
const SESSION_TTL_SECONDS = 24 * 60 * 60;

// Cloudflare Workers KV type declaration (for type-checking without runtime import)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expiration?: number; expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
};

const SESSION_KEY_PREFIX = 'session:';

function getKV(): KVNamespace | undefined {
  const env = getEnv();
  const ns = (env as unknown as { TOKENS?: KVNamespace })?.TOKENS;
  return ns;
}

function ttl(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

// Basic JSON helpers
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

async function kvPutJson(
  key: string,
  value: unknown,
  options?: { expiration?: number; expirationTtl?: number },
) {
  const kv = getKV();
  const raw = await encryptString(toJson(value));
  await kv?.put(key, raw, options);
}

async function kvGetSession(key: string): Promise<SessionRecord | null> {
  const kv = getKV();
  if (!kv) {
    return memSessions.get(key) ?? null;
  }
  const raw = await kv.get(`${SESSION_KEY_PREFIX}${key}`);
  if (!raw) {
    return null;
  }
  const data = await decryptString(raw);
  return fromJson<SessionRecord>(data);
}

async function kvPutSession(key: string, value: SessionRecord): Promise<void> {
  const kv = getKV();
  if (!kv) {
    memSessions.set(key, value);
    return;
  }
  const ttlSeconds = SESSION_TTL_SECONDS;
  await kvPutJson(`${SESSION_KEY_PREFIX}${key}`, value, {
    expiration: ttl(ttlSeconds),
  });
}

async function kvDeleteSession(key: string): Promise<void> {
  const kv = getKV();
  if (kv) {
    await kv.delete(`${SESSION_KEY_PREFIX}${key}`);
  }
  memSessions.delete(key);
}

async function kvGetJson<T>(key: string): Promise<T | null> {
  const kv = getKV();
  if (!kv) {
    return null;
  }
  const raw = await kv.get(key);
  if (raw == null) {
    return null;
  }
  const plain = await decryptString(raw);
  return fromJson<T>(plain);
}

async function kvPutString(
  key: string,
  value: string,
  options?: { expiration?: number; expirationTtl?: number },
) {
  await kvPutJson(key, { v: value }, options);
}

async function kvGetString(key: string): Promise<string | null> {
  const obj = await kvGetJson<{ v: string }>(key);
  return obj?.v ?? null;
}

// Transactions (PKCE)
export async function saveTransaction(
  txnId: string,
  txn: Txn,
  ttlSeconds = 600,
): Promise<void> {
  const kv = getKV();
  if (kv) {
    await kvPutJson(`txn:${txnId}`, txn, { expiration: ttl(ttlSeconds) });
    return;
  }
  memTxns.set(txnId, txn);
}

export async function getTransaction(txnId: string): Promise<Txn | null> {
  const kv = getKV();
  if (kv) {
    return await kvGetJson<Txn>(`txn:${txnId}`);
  }
  return memTxns.get(txnId) ?? null;
}

export async function deleteTransaction(txnId: string): Promise<void> {
  const kv = getKV();
  if (kv) {
    await kv.delete(`txn:${txnId}`);
    return;
  }
  memTxns.delete(txnId);
}

// Auth codes → txnId mapping
export async function saveCode(
  code: string,
  txnId: string,
  ttlSeconds = 600,
): Promise<void> {
  const kv = getKV();
  if (kv) {
    await kvPutString(`code:${code}`, txnId, { expiration: ttl(ttlSeconds) });
    return;
  }
  memCodes.set(code, txnId);
}

export async function getTxnIdByCode(code: string): Promise<string | null> {
  const kv = getKV();
  if (kv) {
    return (await kvGetString(`code:${code}`)) || null;
  }
  return memCodes.get(code) ?? null;
}

export async function deleteCode(code: string): Promise<void> {
  const kv = getKV();
  if (kv) {
    await kv.delete(`code:${code}`);
    return;
  }
  memCodes.delete(code);
}

// RS ↔ Spotify token mapping
export async function storeRsTokenMapping(
  rsAccessToken: string,
  spotifyTokens: SpotifyUserTokens,
  rsRefreshToken?: string,
): Promise<void> {
  const kv = getKV();
  const rec = {
    rs_access_token: rsAccessToken,
    rs_refresh_token: rsRefreshToken || crypto.randomUUID(),
    spotify: spotifyTokens,
  };
  if (kv) {
    await Promise.all([
      kvPutJson(`rs:access:${rec.rs_access_token}`, rec),
      kvPutJson(`rs:refresh:${rec.rs_refresh_token}`, rec),
    ]);
    return;
  }
  memRsByAccess.set(rec.rs_access_token, rec);
  memRsByRefresh.set(rec.rs_refresh_token, rec);
}

export async function getRecordByRsRefreshToken(rsRefreshToken?: string): Promise<{
  rs_access_token: string;
  rs_refresh_token: string;
  spotify: SpotifyUserTokens;
} | null> {
  if (!rsRefreshToken) {
    return null;
  }
  const kv = getKV();
  if (kv) {
    const rec = await kvGetJson<{
      rs_access_token: string;
      rs_refresh_token: string;
      spotify: SpotifyUserTokens;
    }>(`rs:refresh:${rsRefreshToken}`);
    return rec;
  }
  return memRsByRefresh.get(rsRefreshToken) ?? null;
}

export async function updateSpotifyTokensByRsRefreshToken(
  rsRefreshToken: string,
  newSpotify: SpotifyUserTokens,
  maybeNewRsAccessToken?: string,
): Promise<{
  rs_access_token: string;
  rs_refresh_token: string;
  spotify: SpotifyUserTokens;
} | null> {
  const kv = getKV();
  if (kv) {
    const existing = await kvGetJson<{
      rs_access_token: string;
      rs_refresh_token: string;
      spotify: SpotifyUserTokens;
    }>(`rs:refresh:${rsRefreshToken}`);
    if (!existing) {
      return null;
    }
    const next = {
      rs_access_token: maybeNewRsAccessToken || existing.rs_access_token,
      rs_refresh_token: rsRefreshToken,
      spotify: newSpotify,
    };
    await Promise.all([
      (await getKV())?.delete?.(`rs:access:${existing.rs_access_token}`),
      kvPutJson(`rs:access:${next.rs_access_token}`, next),
      kvPutJson(`rs:refresh:${rsRefreshToken}`, next),
    ]);
    return next;
  }
  const existing = memRsByRefresh.get(rsRefreshToken);
  if (!existing) {
    return null;
  }
  if (maybeNewRsAccessToken) {
    memRsByAccess.delete(existing.rs_access_token);
    existing.rs_access_token = maybeNewRsAccessToken;
  }
  existing.spotify = { ...newSpotify };
  memRsByAccess.set(existing.rs_access_token, existing);
  memRsByRefresh.set(rsRefreshToken, existing);
  return existing;
}

export async function getSpotifyTokensByRsAccessToken(
  rsAccessToken?: string,
): Promise<SpotifyUserTokens | null> {
  if (!rsAccessToken) {
    return null;
  }
  const kv = getKV();
  if (kv) {
    const rec = await kvGetJson<{
      rs_access_token: string;
      rs_refresh_token: string;
      spotify: SpotifyUserTokens;
    }>(`rs:access:${rsAccessToken}`);
    return rec?.spotify ?? null;
  }
  const mem = memRsByAccess.get(rsAccessToken);
  return mem?.spotify ?? null;
}

export async function refreshSpotifyTokensByRsAccessToken(
  rsAccessToken: string,
  options: {
    signal?: AbortSignal;
    newRsAccessToken?: string;
  } = {},
): Promise<{
  rs_access_token: string;
  rs_refresh_token: string;
  spotify: SpotifyUserTokens;
} | null> {
  const record = await getRecordByRsAccessToken(rsAccessToken);
  if (!record?.spotify.refresh_token) {
    return null;
  }

  // Dynamically import oauth.ts to reuse refresh logic (avoids circular dependency)
  const { refreshSpotifyTokens } = await import('../services/spotify/oauth.ts');

  try {
    const refreshed = await refreshSpotifyTokens({
      refreshToken: record.spotify.refresh_token,
      signal: options.signal,
    });

    const expiresIn = Number(refreshed.expires_in ?? 3600);
    const scopesArray = refreshed.scope?.split(' ').filter(Boolean);

    const spotify: SpotifyUserTokens = {
      access_token: refreshed.access_token?.trim() || '',
      refresh_token: refreshed.refresh_token?.trim() || record.spotify.refresh_token,
      expires_at: Date.now() + expiresIn * 1000,
      scopes: scopesArray || record.spotify.scopes,
    };

    if (!spotify.access_token) {
      return null;
    }

    const updated = await updateSpotifyTokensByRsRefreshToken(
      record.rs_refresh_token,
      spotify,
      options.newRsAccessToken || rsAccessToken,
    );

    return (
      updated || {
        rs_access_token: options.newRsAccessToken || rsAccessToken,
        rs_refresh_token: record.rs_refresh_token,
        spotify,
      }
    );
  } catch {
    return null;
  }
}

export async function getSpotifyTokensWithRefreshByRsAccessToken(
  rsAccessToken: string,
  options: { signal?: AbortSignal; refreshWindowMs?: number } = {},
): Promise<{ tokens: SpotifyUserTokens; refreshed: boolean } | null> {
  const record = await getRecordByRsAccessToken(rsAccessToken);
  if (!record) {
    return null;
  }
  const tokens = record.spotify;
  const margin = options.refreshWindowMs ?? 30_000;
  const expiresAt = tokens.expires_at ?? 0;
  const shouldRefresh =
    typeof expiresAt === 'number' && Number.isFinite(expiresAt)
      ? expiresAt - margin <= Date.now()
      : !tokens.access_token;
  if (!shouldRefresh) {
    return { tokens, refreshed: false };
  }
  const refreshed = await refreshSpotifyTokensByRsAccessToken(rsAccessToken, {
    signal: options.signal,
  });
  if (!refreshed) {
    return { tokens, refreshed: false };
  }
  return { tokens: refreshed.spotify, refreshed: true };
}

export async function getRecordByRsAccessToken(rsAccessToken?: string): Promise<{
  rs_access_token: string;
  rs_refresh_token: string;
  spotify: SpotifyUserTokens;
} | null> {
  if (!rsAccessToken) {
    return null;
  }
  const kv = getKV();
  if (kv) {
    const rec = await kvGetJson<{
      rs_access_token: string;
      rs_refresh_token: string;
      spotify: SpotifyUserTokens;
    }>(`rs:access:${rsAccessToken}`);
    return rec ?? null;
  }
  const existing = memRsByAccess.get(rsAccessToken);
  if (!existing) {
    return null;
  }
  return existing;
}

export async function getSessionRecord(
  sessionId: string,
): Promise<SessionRecord | null> {
  const kvRecord = await kvGetSession(sessionId);
  if (kvRecord) {
    return kvRecord;
  }
  return memSessions.get(sessionId) ?? null;
}

export async function storeSessionRecord(
  sessionId: string,
  record: SessionRecord,
): Promise<void> {
  memSessions.set(sessionId, record);
  await kvPutSession(sessionId, record);
}

export async function deleteSessionRecord(sessionId: string): Promise<void> {
  memSessions.delete(sessionId);
  await kvDeleteSession(sessionId);
}
