// Worker-safe token and transaction store with optional KV and encryption
// Falls back to in-memory maps when KV is unavailable

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

let ENV: Record<string, unknown> | undefined;
export function setAuthStoreEnv(env: Record<string, unknown>): void {
  ENV = env;
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

function getKV(): KVNamespace | undefined {
  const ns = (ENV as unknown as { TOKENS?: KVNamespace })?.TOKENS;
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

// --- Optional application-layer encryption (AES-GCM via TOKENS_ENC_KEY) ---
function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    s += String.fromCharCode(b);
  }
  const b64 = btoa(s);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(data: string): Uint8Array {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function getCryptoKey(): Promise<CryptoKey | undefined> {
  try {
    const secret =
      (ENV as unknown as { TOKENS_ENC_KEY?: string })?.TOKENS_ENC_KEY ||
      ((globalThis as unknown as { process?: { env?: Record<string, unknown> } })
        ?.process?.env?.TOKENS_ENC_KEY as string | undefined);
    if (!secret) {
      return undefined;
    }
    const raw = b64urlDecode(String(secret));
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  } catch {
    return undefined;
  }
}

async function encryptString(plain: string): Promise<string> {
  const key = await getCryptoKey();
  if (!key) {
    return plain; // no-op without configured key
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plain);
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc);
  const ct = b64urlEncode(new Uint8Array(ctBuf));
  const ivb64 = b64urlEncode(iv);
  return JSON.stringify({ alg: 'A256GCM', iv: ivb64, ct });
}

async function decryptString(stored: string): Promise<string> {
  try {
    const obj = JSON.parse(stored) as {
      alg?: string;
      iv?: string;
      ct?: string;
    };
    if (!obj || obj.alg !== 'A256GCM' || !obj.iv || !obj.ct) {
      return stored;
    }
    const key = await getCryptoKey();
    if (!key) {
      return stored;
    }
    const iv = b64urlDecode(obj.iv);
    const ct = b64urlDecode(obj.ct);
    const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(ptBuf);
  } catch {
    return stored;
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
