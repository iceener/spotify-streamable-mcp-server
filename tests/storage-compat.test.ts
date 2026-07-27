import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/env.js';
import {
  createOpaqueSpotifyTokenVerifier,
  SPOTIFY_ACCESS_TOKEN_EXTRA_KEY,
} from '../src/shared/auth/opaque-token-verifier.js';
import { createEncryptor, generateKey } from '../src/shared/crypto/aes-gcm.js';
import { handleToken } from '../src/shared/oauth/flow.js';
import { FileTokenStore } from '../src/shared/storage/file.js';
import type {
  ProviderTokens,
  RsRecord,
  SessionRecord,
} from '../src/shared/storage/interface.js';
import { KvSessionStore, KvTokenStore } from '../src/shared/storage/kv.js';
import { MemorySessionStore, MemoryTokenStore } from '../src/shared/storage/memory.js';

class FakeKv {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const stores: Array<{ stopCleanup(): void }> = [];
const directories: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const store of stores) store.stopCleanup();
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  stores.length = 0;
  directories.length = 0;
  globalThis.fetch = originalFetch;
});

function provider(
  accessToken = 'spotify-old',
  refreshToken = 'spotify-refresh',
  expiresAt = Date.now() + 300_000,
): ProviderTokens {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    scopes: ['user-read-playback-state'],
  };
}

function record(tokens = provider()): RsRecord {
  return {
    rs_access_token: 'mcp-access',
    rs_refresh_token: 'mcp-refresh',
    provider: tokens,
    created_at: Date.now() - 1_000,
  };
}

function config() {
  return parseConfig({
    NODE_ENV: 'test',
    MCP_PUBLIC_URL: 'http://localhost:3000/mcp',
    MCP_ALLOWED_HOSTS: 'localhost',
    MCP_ALLOWED_ORIGIN_HOSTNAMES: 'localhost',
    AUTH_STRATEGY: 'oauth',
    AUTH_ENABLED: 'true',
    SPOTIFY_CLIENT_ID: 'client-id',
    SPOTIFY_CLIENT_SECRET: 'client-secret',
    SPOTIFY_ACCOUNTS_URL: 'https://accounts.spotify.example',
    OAUTH_SCOPES: 'user-read-playback-state',
  });
}

function fetchMock(
  implementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  }) as typeof globalThis.fetch;
}

describe('stored-record upgrade and rollback compatibility', () => {
  test('reads and rewrites the existing plaintext file envelope unchanged', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spotify-mcp-record-'));
    directories.push(directory);
    const path = join(directory, 'tokens.json');
    const existing = record();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, encrypted: false, records: [existing] }),
    );

    const store = new FileTokenStore(path);
    stores.push(store);
    expect(await store.getByRsAccess(existing.rs_access_token)).toMatchObject(existing);
    await store.updateByRsRefresh(existing.rs_refresh_token, provider('spotify-new'));
    store.flush();

    const saved = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number;
      encrypted: boolean;
      records: RsRecord[];
    };
    expect(saved.version).toBe(1);
    expect(saved.encrypted).toBe(false);
    expect(saved.records[0]).toMatchObject({
      rs_access_token: 'mcp-access',
      rs_refresh_token: 'mcp-refresh',
      provider: { access_token: 'spotify-new' },
    });
  });

  test('round-trips the existing encrypted file format with the same key', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spotify-mcp-encrypted-'));
    directories.push(directory);
    const path = join(directory, 'tokens.enc');
    const key = generateKey();
    const writer = new FileTokenStore(path, key);
    stores.push(writer);
    await writer.storeRsMapping('mcp-access', provider(), 'mcp-refresh');
    writer.flush();
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).toThrow();

    const reader = new FileTokenStore(path, key);
    stores.push(reader);
    expect(await reader.getByRsAccess('mcp-access')).toMatchObject({
      rs_access_token: 'mcp-access',
      rs_refresh_token: 'mcp-refresh',
      provider: { access_token: 'spotify-old' },
    });
  });

  test('keeps KV RS and session key/value shapes backward readable', async () => {
    const kv = new FakeKv();
    const existing = record();
    const existingSession: SessionRecord = {
      rs_access_token: existing.rs_access_token,
      rs_refresh_token: existing.rs_refresh_token,
      provider: existing.provider,
      created_at: existing.created_at,
    };
    kv.values.set(`rs:access:${existing.rs_access_token}`, JSON.stringify(existing));
    kv.values.set(`rs:refresh:${existing.rs_refresh_token}`, JSON.stringify(existing));
    kv.values.set('session:legacy-session', JSON.stringify(existingSession));

    const tokenFallback = new MemoryTokenStore();
    const sessionFallback = new MemorySessionStore();
    stores.push(tokenFallback, sessionFallback);
    const tokens = new KvTokenStore(kv, { fallback: tokenFallback });
    const sessions = new KvSessionStore(kv, { fallback: sessionFallback });

    expect(await tokens.getByRsAccess(existing.rs_access_token)).toMatchObject(
      existing,
    );
    expect(await sessions.get('legacy-session')).toEqual(existingSession);

    await tokens.updateByRsRefresh(
      existing.rs_refresh_token,
      provider('spotify-kv-new'),
    );
    expect(
      JSON.parse(kv.values.get(`rs:access:${existing.rs_access_token}`) ?? '{}'),
    ).toMatchObject({
      rs_access_token: 'mcp-access',
      rs_refresh_token: 'mcp-refresh',
      provider: { access_token: 'spotify-kv-new' },
    });
  });

  test('keeps KV encryption compatible with the existing ciphertext codec', async () => {
    const kv = new FakeKv();
    const key = generateKey();
    const encryptor = createEncryptor(key);
    const fallback = new MemoryTokenStore();
    stores.push(fallback);
    const writer = new KvTokenStore(kv, { ...encryptor, fallback });
    await writer.storeRsMapping('mcp-access', provider(), 'mcp-refresh');
    expect(kv.values.get('rs:access:mcp-access')).not.toContain('spotify-old');

    const readerFallback = new MemoryTokenStore();
    stores.push(readerFallback);
    const reader = new KvTokenStore(kv, {
      ...encryptor,
      fallback: readerFallback,
    });
    expect(await reader.getByRsAccess('mcp-access')).toMatchObject({
      provider: { access_token: 'spotify-old' },
    });
  });
});

describe('refresh and RS-token rotation compatibility', () => {
  test('proactively refreshes provider access without exposing refresh token', async () => {
    const store = new MemoryTokenStore();
    stores.push(store);
    await store.storeRsMapping(
      'mcp-access',
      provider('spotify-expiring', 'spotify-refresh', Date.now() + 500),
      'mcp-refresh',
    );
    let refreshBody = '';
    const mock = fetchMock(async (_input, init) => {
      refreshBody = String(init?.body ?? '');
      return Response.json({
        access_token: 'spotify-refreshed',
        refresh_token: 'spotify-refresh',
        expires_in: 3600,
        scope: 'user-read-playback-state',
      });
    });
    const verifier = createOpaqueSpotifyTokenVerifier(store, config(), {
      fetch: mock,
    });

    const authInfo = await verifier.verifyAccessToken('mcp-access');
    expect(refreshBody).toContain('refresh_token=spotify-refresh');
    expect(authInfo.extra).toEqual({
      [SPOTIFY_ACCESS_TOKEN_EXTRA_KEY]: 'spotify-refreshed',
    });
    expect(JSON.stringify(authInfo)).not.toContain('spotify-refresh"');
    expect(await store.getByRsAccess('mcp-access')).toMatchObject({
      rs_access_token: 'mcp-access',
      rs_refresh_token: 'mcp-refresh',
      provider: {
        access_token: 'spotify-refreshed',
        refresh_token: 'spotify-refresh',
      },
    });
  });

  test('retains OAuth refresh-token-driven RS access rotation', async () => {
    const store = new MemoryTokenStore();
    stores.push(store);
    await store.storeRsMapping(
      'mcp-access',
      provider('spotify-expiring', 'spotify-refresh-old', Date.now() + 500),
      'mcp-refresh',
    );
    globalThis.fetch = fetchMock(async () =>
      Response.json({
        access_token: 'spotify-refreshed',
        refresh_token: 'spotify-refresh-rotated',
        expires_in: 3600,
        scope: 'user-read-playback-state',
      }),
    );

    const result = await handleToken(
      { grant: 'refresh_token', refreshToken: 'mcp-refresh' },
      store,
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accountsUrl: 'https://accounts.spotify.example',
        oauthScopes: 'user-read-playback-state',
      },
    );
    expect(result.access_token).not.toBe('mcp-access');
    expect(await store.getByRsAccess('mcp-access')).toBeNull();
    expect(await store.getByRsAccess(result.access_token)).toMatchObject({
      rs_refresh_token: 'mcp-refresh',
      provider: {
        access_token: 'spotify-refreshed',
        refresh_token: 'spotify-refresh-rotated',
      },
    });
  });
});
