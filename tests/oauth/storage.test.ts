import { afterEach, describe, expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileOAuthAuthority } from '../../src/oauth/authority-file';
import { createEncryptor, pkceChallenge } from '../../src/oauth/crypto';
import type { RsRecord } from '../../src/oauth/token-store';
import { FileTokenStore } from '../../src/oauth/token-store-file';
import { type KvLike, KvTokenStore } from '../../src/oauth/token-store-kv';
import { parseConfig } from '../../src/platform/config';
import { SPOTIFY_SCOPES } from '../../src/services/spotify-oauth';
import { tokenEncryptionKey } from '../../src/settings';
import before from '../fixtures/storage-before.json';
import { cleanup, memoryLogger } from '../helpers';
import {
  CALLBACK,
  handleFor,
  ORIGIN,
  proxyFixture,
  SCOPE,
  spotifyTokens,
  VERIFIER,
} from './fixture';

/**
 * Stored tokens must survive the migration: records the checkpoint code (213a57b) wrote, in
 * `fixtures/storage-before.json`, are read and refreshed here, and new writes are checked
 * against the old layouts with an independent implementation of each codec.
 */
const KEY = before.key;
const RESOURCE = 'https://spotify-mcp.example.workers.dev/mcp';
const directories: string[] = [];

afterEach(async () => {
  await cleanup();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'spotify-storage-'));
  directories.push(directory);
  return directory;
}

class FakeKv implements KvLike {
  readonly values = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

/** The KV and grant layout, independently: base64url(iv[12] || ciphertext || tag[16]). */
function openKvValue(value: string, key = KEY): unknown {
  const bytes = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64url'),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString(),
  );
}

/** The token file layout, independently: base64url(iv[12] || tag[16] || ciphertext). */
function openFile(value: string, key = KEY): unknown {
  const bytes = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64url'),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
  );
}

function kvStore(kv: KvLike, key: string | null = KEY): KvTokenStore {
  return new KvTokenStore(kv, {
    encryptor: key ? createEncryptor(key) : undefined,
    logger: memoryLogger(),
  });
}

describe('records written before the migration', () => {
  test('KV records are read as they were written, with no binding', async () => {
    const store = kvStore(new FakeKv(before.kv));
    for (const name of ['legacy', 'expired', 'unscoped']) {
      const record = await store.getByRsAccess(`${name}-rs-access`);
      expect(record).toMatchObject({
        rs_access_token: `${name}-rs-access`,
        rs_refresh_token: `${name}-rs-refresh`,
        provider: {
          access_token: `${name}-spotify-access`,
          refresh_token: `${name}-spotify-refresh`,
        },
      });
      expect(record?.oauth).toBeUndefined();
      expect(await store.getByRsRefresh(`${name}-rs-refresh`)).toEqual(record);
    }
  });

  test('a current record verifies as it is: the Spotify token, its scopes, no refresh', async () => {
    const accounts = spotifyTokens();
    const f = proxyFixture({
      tokens: kvStore(new FakeKv(before.kv)),
      accounts,
      env: { MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp' },
    });
    const caller = await f.proxy.verifier.verifyAccessToken('legacy-rs-access');
    expect(caller.extra).toEqual({ providerAccessToken: 'legacy-spotify-access' });
    // No provenance: the caller is a hash of the token, and the scopes are the stored ones.
    expect(caller.clientId).toMatch(/^rs:[0-9a-f]{64}$/);
    expect(caller.scopes).toEqual([...SPOTIFY_SCOPES]);
    expect(accounts.forms).toHaveLength(0);
  });

  test('a record with an expired Spotify token is refreshed on use, in the same format', async () => {
    const kv = new FakeKv(before.kv);
    const accounts = spotifyTokens();
    const f = proxyFixture({
      tokens: kvStore(kv),
      accounts,
      env: { MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp' },
    });

    const caller = await f.proxy.verifier.verifyAccessToken('expired-rs-access');
    expect(caller.extra).toEqual({ providerAccessToken: 'spotify-fresh' });
    expect(Object.fromEntries(accounts.forms[0] ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'expired-spotify-refresh',
    });

    // Both keys were rewritten in the old layout, readable by the old codec, still unbound.
    for (const key of ['rs:access:expired-rs-access', 'rs:refresh:expired-rs-refresh']) {
      const record = openKvValue(kv.values.get(key) as string) as RsRecord;
      expect(record).toMatchObject({
        rs_access_token: 'expired-rs-access',
        rs_refresh_token: 'expired-rs-refresh',
        provider: { access_token: 'spotify-fresh', refresh_token: 'spotify-refresh' },
      });
      expect(Object.keys(record)).toEqual([
        'rs_access_token',
        'rs_refresh_token',
        'provider',
        'created_at',
      ]);
    }
  });

  test('a record stored without scopes passes the required scopes on an MCP request', async () => {
    // The checkpoint stored `scopes: []` when Spotify named none, and required no scopes.
    // OAUTH_SCOPES is now required on every request: such a record must not be locked out.
    const f = proxyFixture({ tokens: kvStore(new FakeKv(before.kv)) });
    expect((await f.proxy.verifier.verifyAccessToken('unscoped-rs-access')).scopes).toEqual([
      ...SPOTIFY_SCOPES,
    ]);
    const response = await f.app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          Host: '127.0.0.1:3000',
          Authorization: 'Bearer unscoped-rs-access',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  test('a checkpoint refresh token works with or without a client_id, as before', async () => {
    const f = proxyFixture({ tokens: kvStore(new FakeKv(before.kv)) });
    for (const clientId of [undefined, 'any-client']) {
      const response = await f.request(
        '/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: 'legacy-rs-refresh',
          ...(clientId && { client_id: clientId }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        access_token: 'legacy-rs-access',
        refresh_token: 'legacy-rs-refresh',
        scope: SCOPE,
      });
    }
  });

  test('the encrypted token file opens', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'tokens.enc');
    writeFileSync(path, before.file);
    const store = new FileTokenStore(path, KEY, memoryLogger());
    const record = await store.getByRsAccess('file-rs-access');
    expect(record).toMatchObject({ provider: { access_token: 'file-spotify-access' } });
    expect(record?.oauth).toBeUndefined();
  });

  test('a code issued before the migration, still within its two minutes, is redeemed', async () => {
    const directory = temporaryDirectory();
    const clientDocument = JSON.parse(before.authorityDocument) as {
      client: { client_id: string; redirect_uris: string[] };
    };
    const clientId = clientDocument.client.client_id;
    const redirectUri = clientDocument.client.redirect_uris[0] as string;
    const code = handleFor(clientId);
    writeFileSync(
      join(directory, `${clientId}.json`),
      JSON.stringify({
        ...clientDocument,
        codes: {
          [code]: {
            clientId,
            redirectUri,
            resource: `${ORIGIN}/mcp`,
            codeChallenge: await pkceChallenge(VERIFIER),
            providerCallbackUri: CALLBACK,
            expiresAt: Date.now() + 60_000,
            providerMaterial: before.grantProviderMaterial,
          },
        },
      }),
    );
    const f = proxyFixture({ authority: new FileOAuthAuthority(directory), encryptionKey: KEY });
    const response = await f.request(
      '/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: VERIFIER,
      }),
    );
    expect(response.status).toBe(200);
    const pair = (await response.json()) as { access_token: string; scope: string };
    expect(pair.scope).toBe(SCOPE);
    expect((await f.tokens.getByRsAccess(pair.access_token))?.provider.access_token).toBe(
      'grant-spotify-access',
    );
  });

  test('a client registered before the migration can still sign in', async () => {
    const directory = temporaryDirectory();
    const document = JSON.parse(before.authorityDocument) as {
      client: { client_id: string; redirect_uris: string[] };
    };
    writeFileSync(join(directory, `${document.client.client_id}.json`), before.authorityDocument);
    const f = proxyFixture({ authority: new FileOAuthAuthority(directory) });
    const response = await f.request(
      `/authorize?${new URLSearchParams({
        client_id: document.client.client_id,
        response_type: 'code',
        // Native clients may pick another port at sign-in.
        redirect_uri: 'http://127.0.0.1:50000/oauth/callback',
        code_challenge: await pkceChallenge(VERIFIER),
        code_challenge_method: 'S256',
      })}`,
    );
    expect(response.status).toBe(302);
  });
});

describe('the two key secrets', () => {
  const kvValues = before.kv as Record<string, string>;
  const other = Buffer.alloc(32, 7).toString('base64url');

  test('RS_TOKENS_ENC_KEY is the key in use; TOKENS_ENC_KEY never replaces it', async () => {
    const settings = parseConfig({ RS_TOKENS_ENC_KEY: KEY, TOKENS_ENC_KEY: other }).settings;
    expect(tokenEncryptionKey(settings)).toBe(KEY);
    const store = kvStore(new FakeKv(kvValues), tokenEncryptionKey(settings) as string);
    expect(await store.getByRsAccess('legacy-rs-access')).not.toBeNull();
  });

  test('TOKENS_ENC_KEY takes over only when RS_TOKENS_ENC_KEY is unset or empty', async () => {
    for (const env of [{ TOKENS_ENC_KEY: KEY }, { RS_TOKENS_ENC_KEY: '', TOKENS_ENC_KEY: KEY }]) {
      const settings = parseConfig(env).settings;
      expect(tokenEncryptionKey(settings)).toBe(KEY);
      const store = kvStore(new FakeKv(kvValues), tokenEncryptionKey(settings) as string);
      expect(await store.getByRsAccess('legacy-rs-access')).not.toBeNull();
    }
    expect(tokenEncryptionKey(parseConfig({}).settings)).toBeUndefined();
  });

  test('the Worker and Bun entry points use the same key resolution', () => {
    for (const entry of ['../../src/worker.ts', '../../src/bun.ts']) {
      const source = readFileSync(new URL(entry, import.meta.url), 'utf8');
      expect(source).toContain('tokenEncryptionKey(config.settings)');
      expect(source).not.toContain('settings.RS_TOKENS_ENC_KEY');
    }
  });
});

describe('new writes keep the old layouts', () => {
  test('KV: both keys hold the same record, encrypted as before', async () => {
    const kv = new FakeKv();
    await kvStore(kv).storeRsMapping(
      'new-rs-access',
      { access_token: 'new-spotify-access', refresh_token: 'new-spotify-refresh', expires_at: 1 },
      'new-rs-refresh',
      { clientId: 'client', resource: RESOURCE },
    );
    const byAccess = openKvValue(kv.values.get('rs:access:new-rs-access') as string);
    expect(openKvValue(kv.values.get('rs:refresh:new-rs-refresh') as string)).toEqual(byAccess);
    expect(Object.keys(byAccess as object)).toEqual([
      'rs_access_token',
      'rs_refresh_token',
      'oauth',
      'provider',
      'created_at',
    ]);
  });

  test('KV without a key stores plain JSON, and reads it back', async () => {
    const kv = new FakeKv();
    const store = kvStore(kv, null);
    await store.storeRsMapping('plain-access', { access_token: 'g' }, 'plain-refresh');
    expect(JSON.parse(kv.values.get('rs:access:plain-access') as string)).toMatchObject({
      provider: { access_token: 'g' },
    });
    expect(await store.getByRsRefresh('plain-refresh')).toMatchObject({
      rs_access_token: 'plain-access',
    });
  });

  test('KV: rotating the access token moves the record and keeps its binding', async () => {
    const kv = new FakeKv();
    const binding = { clientId: 'registered-client', resource: RESOURCE };
    await kvStore(kv).storeRsMapping(
      'bound-access',
      { access_token: 'g' },
      'bound-refresh',
      binding,
    );
    await kvStore(kv).updateByRsRefresh('bound-refresh', { access_token: 'g2' }, 'rotated-access');

    const restarted = kvStore(kv);
    expect(await restarted.getByRsAccess('bound-access')).toBeNull();
    expect((await restarted.getByRsAccess('rotated-access'))?.oauth).toEqual(binding);
    expect((await restarted.getByRsRefresh('bound-refresh'))?.oauth).toEqual(binding);
  });

  test('KV: a failed write still works in this isolate', async () => {
    const kv: KvLike = {
      get: async () => null,
      put: async () => {
        throw new Error('KV quota exceeded');
      },
      delete: async () => {},
    };
    const logs: Parameters<typeof memoryLogger>[0] = [];
    const store = new KvTokenStore(kv, { encryptor: undefined, logger: memoryLogger(logs) });
    await store.storeRsMapping('a', { access_token: 'g' }, 'r');
    expect((await store.getByRsAccess('a'))?.provider.access_token).toBe('g');
    expect(logs.map((entry) => entry.level)).toEqual(['warning']);
  });

  test('file: version 1, encrypted whole, readable with the old codec and after a restart', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'tokens.enc');
    const binding = { clientId: 'registered-client', resource: RESOURCE };
    const writer = new FileTokenStore(path, KEY, memoryLogger());
    await writer.storeRsMapping(
      'bound-access',
      { access_token: 'g', refresh_token: 'r', expires_at: Date.now() + 3_600_000 },
      'bound-refresh',
      binding,
    );
    writer.flush();

    const saved = openFile(readFileSync(path, 'utf8')) as { version: number; records: RsRecord[] };
    expect(saved.version).toBe(1);
    expect(saved.records[0]).toMatchObject({ rs_access_token: 'bound-access', oauth: binding });
    expect(
      (await new FileTokenStore(path, KEY, memoryLogger()).getByRsAccess('bound-access'))?.oauth,
    ).toEqual(binding);
  });

  test('file: a plaintext version 1 file is read unchanged', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'tokens.json');
    const record: RsRecord = {
      rs_access_token: 'existing-access',
      rs_refresh_token: 'existing-refresh',
      provider: {
        access_token: 'g',
        refresh_token: 'r',
        expires_at: Date.now() + 3_600_000,
        scopes: ['s'],
      },
      created_at: Date.now() - 10_000,
    };
    writeFileSync(path, JSON.stringify({ version: 1, encrypted: false, records: [record] }));
    const store = new FileTokenStore(path, undefined, memoryLogger());
    expect(await store.getByRsAccess('existing-access')).toMatchObject(record);
    store.flush();
    expect(JSON.parse(readFileSync(path, 'utf8')).records[0]).toMatchObject(record);
  });

  test('the authority grant layout is the KV layout, prefixed with enc:', async () => {
    const material = before.grantProviderMaterial;
    expect(material.startsWith('enc:')).toBe(true);
    expect(openKvValue(material.slice(4))).toMatchObject({ access_token: 'grant-spotify-access' });
    const sealed = await createEncryptor(KEY).encrypt('{"a":1}');
    expect(openKvValue(sealed)).toEqual({ a: 1 });
    // And the new code opens what the old layout produces.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'base64url'), iv);
    const body = Buffer.concat([cipher.update('{"b":2}'), cipher.final()]);
    const old = Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
    expect(JSON.parse(await createEncryptor(KEY).decrypt(old))).toEqual({ b: 2 });
  });
});
