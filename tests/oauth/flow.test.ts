import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AuthorityCommand,
  type AuthorizationTransaction,
  MemoryOAuthAuthority,
  type OAuthAuthority,
  type RegisteredClient,
} from '../../src/oauth/authority';
import { FileOAuthAuthority } from '../../src/oauth/authority-file';
import { pkceChallenge } from '../../src/oauth/crypto';
import { cleanup } from '../helpers';
import {
  authorize,
  CALLBACK,
  codeFor,
  handleFor,
  loopback,
  ORIGIN,
  type ProxyFixture,
  proxyFixture,
  redeem,
  registerNative,
  SCOPE,
  spotifyTokens,
  type TokenPair,
  VERIFIER,
} from './fixture';

const RESOURCE = `${ORIGIN}/mcp`;
const KEY = Buffer.alloc(32, 5).toString('base64url');
const directories: string[] = [];

afterEach(async () => {
  await cleanup();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** Register a client straight in the authority, as `/register` would. */
async function registerIn(
  authority: OAuthAuthority,
  redirectUri: string,
  applicationType: 'native' | 'web' = 'native',
): Promise<RegisteredClient> {
  const f = proxyFixture({ authority, redirectAllowlist: ['https://configured.example/callback'] });
  const response = await f.request('/register', {
    application_type: applicationType,
    redirect_uris: [redirectUri],
  });
  expect(response.status).toBe(201);
  return (await response.json()) as RegisteredClient;
}

describe('native clients: registration, sign-in and tokens', () => {
  test('two clients on OS-assigned loopback ports and their own paths sign in end to end', async () => {
    const f = proxyFixture();
    const first = loopback();
    const second = loopback('/another/registered/path');
    expect(new URL(first).port).not.toBe(new URL(second).port);

    for (const uri of [first, second]) {
      const client = await registerNative(f, uri);
      const issued = await codeFor(f, client.client_id, uri);
      const response = await redeem(f, client.client_id, uri, issued.code);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');
      const pair = (await response.json()) as TokenPair;
      expect(pair).toMatchObject({ token_type: 'bearer', expires_in: 3600, scope: SCOPE });
      expect(pair.access_token).not.toBe('spotify-access');
      expect(pair.refresh_token).not.toBe('spotify-refresh');

      const caller = await f.proxy.verifier.verifyAccessToken(pair.access_token);
      expect(caller.extra).toEqual({ providerAccessToken: 'spotify-access' });
      expect(caller.clientId).toBe(client.client_id);
      expect(caller.resource?.href).toBe(RESOURCE);

      // Codes and callbacks work once.
      expect((await redeem(f, client.client_id, uri, issued.code)).status).toBe(400);
      expect((await f.request(`/oauth/callback?code=again&state=${issued.state}`)).status).toBe(
        400,
      );
    }
    expect(f.accounts.forms.map((form) => Object.fromEntries(form))).toEqual([
      { grant_type: 'authorization_code', code: 'spotify-code', redirect_uri: CALLBACK },
      { grant_type: 'authorization_code', code: 'spotify-code', redirect_uri: CALLBACK },
    ]);
  });

  test('a native registration may change only its port at authorize; the token request must repeat it', async () => {
    const f = proxyFixture();
    const original = loopback();
    const chosen = loopback();
    const client = await registerNative(f, original);
    const issued = await codeFor(f, client.client_id, chosen);

    expect((await redeem(f, client.client_id, original, issued.code)).status).toBe(400);
    expect((await redeem(f, client.client_id, chosen, issued.code)).status).toBe(200);
  });

  test.each([
    'http://localhost:43210/oauth/callback',
    'http://127.1:43210/oauth/callback',
    'http://2130706433:43210/oauth/callback',
    'http://0x7f000001:43210/oauth/callback',
    'http://127.000.0.1:43210/oauth/callback',
    'http://127.0.0.1:0/oauth/callback',
    'http://127.0.0.1:65536/oauth/callback',
    'http://127.0.0.1:080/oauth/callback',
    'http://127.0.0.1/oauth/callback',
    'http://127.0.0.1:43210/oauth/callback#x',
    'http://127.0.0.1:43210/oauth/callback?x=y',
    'http://user@127.0.0.1:43210/oauth/callback',
    'http://127.0.0.1@evil.example:43210/oauth/callback',
    'http://127.0.0.1.evil.example:43210/oauth/callback',
    'http://[::1]:43210/oauth/callback',
    'https://127.0.0.1:43210/oauth/callback',
    'ftp://127.0.0.1:43210/oauth/callback',
    'http://192.168.1.1:43210/oauth/callback',
    'http://127.0.0.1:43210/a/../oauth/callback',
  ])('registration refuses the unsafe native redirect %s', async (uri) => {
    const response = await proxyFixture().request('/register', {
      application_type: 'native',
      redirect_uris: [uri],
    });
    expect(response.status).toBe(400);
  });

  test('registration checks every field, and loopback is for native clients only', async () => {
    const f = proxyFixture();
    const uri = loopback();
    for (const body of [
      { redirect_uris: [uri] },
      { application_type: 'native', redirect_uris: [3] },
      {
        application_type: 'native',
        redirect_uris: [uri],
        token_endpoint_auth_method: 'client_secret_basic',
      },
      { application_type: 'native', redirect_uris: [uri], grant_types: ['implicit'] },
      { application_type: 'native', redirect_uris: [uri], response_types: ['token'] },
      { application_type: 'native', redirect_uris: [] },
    ]) {
      expect((await f.request('/register', body)).status).toBe(400);
    }
  });

  test('authorize refuses unknown and altered clients, PKCE, redirects and resources before Spotify', async () => {
    const f = proxyFixture();
    const uri = loopback();
    const client = await registerNative(f, uri);
    const challenge = await pkceChallenge(VERIFIER);
    for (const fields of [
      { client_id: '' },
      { client_id: handleFor(client.client_id).split('.')[1] as string },
      { client_id: handleFor(client.client_id) },
      { response_type: '' },
      { response_type: 'token' },
      { redirect_uri: `${uri}/` },
      { redirect_uri: uri.replace('/oauth/callback', '/unregistered') },
      { code_challenge: '' },
      { code_challenge: 'short' },
      { code_challenge: `${challenge}=` },
      { code_challenge_method: 'plain' },
      { resource: `${ORIGIN}/other` },
    ]) {
      expect((await authorize(f, client.client_id, uri, fields)).status).toBe(400);
    }
    expect(f.accounts.forms).toHaveLength(0);
  });

  test('a wrong binding or verifier leaves the code usable; concurrent redemptions succeed once', async () => {
    const f = proxyFixture();
    const uri = loopback();
    const client = await registerNative(f, uri);
    const issued = await codeFor(f, client.client_id, uri);
    for (const overrides of [
      { client_id: '' },
      { client_id: handleFor(client.client_id).split('.')[1] as string },
      { redirect_uri: '' },
      { redirect_uri: `${uri}/` },
      { redirect_uri: uri.replace('/oauth/callback', '/oauth/%63allback') },
      { code_verifier: '' },
      { code_verifier: 'v'.repeat(42) },
      { code_verifier: 'v'.repeat(129) },
      { code_verifier: '!'.repeat(43) },
      { code_verifier: 'wrong'.repeat(10) },
      { resource: `${RESOURCE}/` },
    ]) {
      expect((await redeem(f, client.client_id, uri, issued.code, overrides)).status).toBe(400);
    }
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        redeem(f, client.client_id, uri, issued.code, { resource: RESOURCE }),
      ),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
  });

  test('a callback is claimed before Spotify is called; a failed exchange cannot be replayed', async () => {
    let calls = 0;
    const accounts = spotifyTokens(async () => {
      calls++;
      await Bun.sleep(10);
      return new Response('provider secret must not leak', { status: 400 });
    });
    const f = proxyFixture({ accounts });
    const uri = loopback();
    const client = await registerNative(f, uri);
    const response = await authorize(f, client.client_id, uri);
    const state = new URL(response.headers.get('location') as string).searchParams.get('state');

    const callbacks = await Promise.all(
      Array.from({ length: 8 }, () =>
        f.request(`/oauth/callback?code=spotify-code&state=${state}`),
      ),
    );
    expect(calls).toBe(1);
    expect(callbacks.every((callback) => callback.status >= 400)).toBe(true);
    for (const callback of callbacks) {
      expect(await callback.text()).not.toContain('provider secret');
    }
    expect((await f.request(`/oauth/callback?code=again&state=${state}`)).status).toBe(400);
  });

  test('repeated fields, oversized bodies and forged state fail before Spotify is called', async () => {
    const f = proxyFixture();
    const uri = loopback();
    const client = await registerNative(f, uri);

    expect(
      (await f.request('/register', '{"redirect_uris":[],"redirect_\\u0075ris":[]}')).status,
    ).toBe(400);
    expect((await f.request('/register', 'x'.repeat(16_385))).status).toBe(413);
    expect(
      (await f.request('/token', new URLSearchParams({ code: 'x'.repeat(16_385) }))).status,
    ).toBe(413);
    expect(
      (
        await f.request(
          '/token',
          new URLSearchParams('grant_type=authorization_code&client_id=a&client_id=b'),
        )
      ).status,
    ).toBe(400);
    expect((await f.request('/authorize?client_id=a&client_id=b')).status).toBe(400);
    expect(
      (await f.request(`/oauth/callback?code=a&code=b&state=${handleFor(client.client_id)}`))
        .status,
    ).toBe(400);
    expect(
      (
        await f.request(
          `/oauth/callback?code=a&state=${btoa(JSON.stringify({ redirectUri: uri }))}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await f.request(`/oauth/callback?code=a&state=${handleFor(client.client_id)}`)).status,
    ).toBe(400);
    expect(f.accounts.forms).toHaveLength(0);
  });
});

describe('configured redirects and Spotify', () => {
  test('HTTPS and custom-scheme clients sign in; Spotify gets the exact form and no PKCE', async () => {
    // Even a provider whose extra parameters try to replace protocol fields can't.
    const f = proxyFixture({
      redirectAllowlist: ['https://client.example/callback', 'alice://oauth/callback'],
      provider: {
        ...(await import('../../src/services/spotify-oauth')).spotifyOAuth,
        authorizationParams: {
          show_dialog: 'true',
          redirect_uri: 'https://evil.example',
          state: 'evil',
          client_id: 'evil',
          response_type: 'token',
          scope: 'evil',
          code_challenge: 'evil',
          resource: 'evil',
        },
      },
    });
    for (const uri of ['https://client.example/callback', 'alice://oauth/callback']) {
      const registration = await f.request('/register', {
        application_type: 'native',
        token_endpoint_auth_method: 'none',
        redirect_uris: [uri],
      });
      expect(registration.status).toBe(201);
      const { client_id: clientId } = (await registration.json()) as RegisteredClient;
      const verifier = 'a'.repeat(64);
      const authorized = await f.request(
        `/authorize?${new URLSearchParams({
          client_id: clientId,
          redirect_uri: uri,
          response_type: 'code',
          code_challenge: await pkceChallenge(verifier),
          code_challenge_method: 'S256',
          state: 'client-state',
        })}`,
      );
      expect(authorized.status).toBe(302);
      const accounts = new URL(authorized.headers.get('location') as string);
      expect(accounts.origin + accounts.pathname).toBe('https://accounts.spotify.com/authorize');
      expect(Object.fromEntries(accounts.searchParams)).toEqual({
        show_dialog: 'true',
        response_type: 'code',
        client_id: 'spotify-client',
        redirect_uri: CALLBACK,
        state: expect.stringMatching(/^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{32}$/),
        scope: SCOPE,
      });

      const callback = await f.request(
        `/oauth/callback?code=spotify-code&state=${accounts.searchParams.get('state')}`,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toStartWith(`${uri}?`);
      const target = new URL(callback.headers.get('location') as string);
      expect(target.searchParams.get('state')).toBe('client-state');

      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: target.searchParams.get('code') as string,
        client_id: clientId,
        redirect_uri: uri,
        code_verifier: 'wrong-verifier',
      });
      expect((await f.request('/token', form)).status).toBe(400);
      form.set('code_verifier', verifier);
      const issued = await f.request('/token', form);
      expect(issued.status).toBe(200);
      const pair = (await issued.json()) as TokenPair;
      expect((await f.tokens.getByRsAccess(pair.access_token))?.provider).toEqual({
        access_token: 'spotify-access',
        refresh_token: 'spotify-refresh',
        expires_at: expect.any(Number),
        scopes: SCOPE.split(' '),
      });
    }
    expect(f.accounts.forms.map((form) => Object.fromEntries(form))).toEqual([
      { grant_type: 'authorization_code', code: 'spotify-code', redirect_uri: CALLBACK },
      { grant_type: 'authorization_code', code: 'spotify-code', redirect_uri: CALLBACK },
    ]);
  });

  test('Spotify answering without scopes keeps the requested ones', async () => {
    const f = proxyFixture({
      accounts: spotifyTokens(() =>
        Response.json({ access_token: 'spotify-access', refresh_token: 'r', expires_in: 3600 }),
      ),
    });
    const uri = loopback();
    const client = await registerNative(f, uri);
    const issued = await codeFor(f, client.client_id, uri);
    const pair = (await (await redeem(f, client.client_id, uri, issued.code)).json()) as TokenPair;
    expect(pair.scope).toBe(SCOPE);
  });

  test('a stored transaction with another callback or resource, or a withdrawn redirect, fails before Spotify', async () => {
    const authority = new MemoryOAuthAuthority();
    const uri = 'https://configured.example/callback';
    const client = await registerIn(authority, uri, 'web');
    for (const field of ['providerCallbackUri', 'resource', 'policy'] as const) {
      const f = proxyFixture({
        authority,
        redirectAllowlist: field === 'policy' ? ['https://withdrawn.example/callback'] : [uri],
      });
      const state = handleFor(client.client_id);
      await authority.execute(client.client_id, {
        kind: 'begin',
        handle: state,
        txn: {
          clientId: client.client_id,
          redirectUri: uri,
          resource: field === 'resource' ? `${ORIGIN}/other` : RESOURCE,
          codeChallenge: await pkceChallenge(VERIFIER),
          providerCallbackUri:
            field === 'providerCallbackUri' ? 'https://wrong.example/oauth/callback' : CALLBACK,
          expiresAt: Date.now() + 60_000,
        },
      });
      expect((await f.request(`/oauth/callback?code=x&state=${state}`)).status).toBe(400);
      expect((await f.request(`/oauth/callback?code=x&state=${state}`)).status).toBe(400);
      expect(f.accounts.forms).toHaveLength(0);
    }
  });

  test('the proxy fails closed without its Spotify credentials', async () => {
    const f = proxyFixture({ credentials: { clientId: undefined, clientSecret: undefined } });
    const uri = loopback();
    const client = await registerNative(f, uri);
    const response = await authorize(f, client.client_id, uri);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'server_error' });
    expect(f.accounts.forms).toHaveLength(0);
  });

  test('the raw redirect URI is kept, default port included', async () => {
    const f = proxyFixture();
    const uri = 'http://127.0.0.1:80/oauth/callback';
    const client = await registerNative(f, uri);
    const response = await authorize(f, client.client_id, uri);
    const state = new URL(response.headers.get('location') as string).searchParams.get('state');
    const callback = await f.request(`/oauth/callback?code=x&state=${state}`);
    expect(callback.headers.get('location')).toStartWith(`${uri}?`);
    const code = new URL(callback.headers.get('location') as string).searchParams.get(
      'code',
    ) as string;
    expect((await redeem(f, client.client_id, uri.replace(':80', ''), code)).status).toBe(400);
    expect((await redeem(f, client.client_id, uri, code)).status).toBe(200);
  });
});

describe('authority', () => {
  test('file authority keeps encrypted grants across instances and consumes codes once', async () => {
    const directory = await temporaryDirectory('spotify-authority-');
    const f = proxyFixture({ authority: new FileOAuthAuthority(directory), encryptionKey: KEY });
    const uri = loopback();
    const client = await registerNative(f, uri);
    const issued = await codeFor(f, client.client_id, uri);

    const file = await readFile(join(directory, `${client.client_id}.json`), 'utf8');
    expect(file).toContain('enc:');
    expect(file).not.toContain('spotify-access');
    expect(file).not.toContain('spotify-refresh');

    const second = proxyFixture({
      authority: new FileOAuthAuthority(directory),
      encryptionKey: KEY,
    });
    const responses = await Promise.all([
      redeem(f, client.client_id, uri, issued.code),
      redeem(second, client.client_id, uri, issued.code),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const third = proxyFixture({
      authority: new FileOAuthAuthority(directory),
      encryptionKey: KEY,
    });
    expect((await redeem(third, client.client_id, uri, issued.code)).status).toBe(400);
  });

  test('a pending callback survives a restart; of two racing callbacks one wins', async () => {
    const directory = await temporaryDirectory('spotify-pending-');
    const first = proxyFixture({ authority: new FileOAuthAuthority(directory) });
    const uri = loopback();
    const client = await registerNative(first, uri);
    const response = await authorize(first, client.client_id, uri);
    const state = new URL(response.headers.get('location') as string).searchParams.get('state');

    const accounts = spotifyTokens();
    const second = proxyFixture({ authority: new FileOAuthAuthority(directory), accounts });
    const third = proxyFixture({ authority: new FileOAuthAuthority(directory), accounts });
    const replies = await Promise.all([
      second.request(`/oauth/callback?code=x&state=${state}`),
      third.request(`/oauth/callback?code=x&state=${state}`),
    ]);
    expect(replies.filter((reply) => reply.status === 302)).toHaveLength(1);
    expect(accounts.forms).toHaveLength(1);
    // A code the authority never issued, such as one from before the authority existed, fails.
    expect((await redeem(first, client.client_id, uri, handleFor(client.client_id))).status).toBe(
      400,
    );
  });

  test('expiry is absolute and survives restarts; storage failures fail closed', async () => {
    const directory = await temporaryDirectory('spotify-expiry-');
    const authority = new FileOAuthAuthority(directory);
    const client = await registerIn(authority, loopback());
    const state = handleFor(client.client_id);
    const txn: AuthorizationTransaction = {
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0] as string,
      resource: RESOURCE,
      codeChallenge: await pkceChallenge(VERIFIER),
      providerCallbackUri: CALLBACK,
      expiresAt: Date.now() + 100,
    };
    await authority.execute(client.client_id, { kind: 'begin', handle: state, txn });
    await Bun.sleep(120);
    await expect(
      new FileOAuthAuthority(directory).execute(client.client_id, { kind: 'claim', handle: state }),
    ).rejects.toThrow('invalid_grant');
    await authority.cleanupExpired();
    expect(await readFile(join(directory, `${client.client_id}.json`), 'utf8')).not.toContain(
      state,
    );

    const failing = proxyFixture({
      authority: {
        execute: async () => {
          throw new Error('private storage failure');
        },
      },
    });
    const response = await failing.request('/register', {
      application_type: 'native',
      redirect_uris: [loopback()],
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private storage');

    await writeFile(join(directory, `${client.client_id}.json`), 'corrupt');
    await expect(
      new FileOAuthAuthority(directory).execute(client.client_id, { kind: 'client' }),
    ).rejects.toThrow();
  });

  test('an unusable authority directory fails at startup', async () => {
    const directory = await temporaryDirectory('spotify-readiness-');
    const file = join(directory, 'not-a-directory');
    await writeFile(file, 'occupied');
    await expect(new FileOAuthAuthority(file).ready).rejects.toThrow();
  });

  test('an expired code cannot be redeemed; a failed issue leaves the callback claimed', async () => {
    const authority = new MemoryOAuthAuthority();
    const client = await registerIn(authority, loopback());
    const state = handleFor(client.client_id);
    const code = handleFor(client.client_id);
    const txn: AuthorizationTransaction = {
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0] as string,
      resource: RESOURCE,
      codeChallenge: await pkceChallenge(VERIFIER),
      providerCallbackUri: CALLBACK,
      expiresAt: Date.now() + 10,
    };
    await authority.execute(client.client_id, { kind: 'begin', handle: state, txn });
    await authority.execute(client.client_id, { kind: 'claim', handle: state });
    await authority.execute(client.client_id, {
      kind: 'issue',
      handle: state,
      code,
      providerMaterial: 'json:{}',
    });
    await Bun.sleep(15);
    const consume: AuthorityCommand = {
      kind: 'consume',
      code,
      clientId: client.client_id,
      redirectUri: txn.redirectUri,
      resource: txn.resource,
      challenge: txn.codeChallenge,
    };
    await expect(authority.execute(client.client_id, consume)).rejects.toThrow('invalid_grant');

    const failing: OAuthAuthority = {
      execute: (id, command) => {
        if (command.kind === 'issue') throw new Error('disk failure');
        return authority.execute(id, command);
      },
    };
    const f = proxyFixture({ authority: failing });
    const response = await authorize(f, client.client_id, txn.redirectUri);
    const handle = new URL(response.headers.get('location') as string).searchParams.get('state');
    expect((await f.request(`/oauth/callback?code=x&state=${handle}`)).status).toBe(503);
    expect((await f.request(`/oauth/callback?code=x&state=${handle}`)).status).toBe(400);
    expect(f.accounts.forms).toHaveLength(1);
  });
});

describe('issued tokens and refresh', () => {
  async function signIn(f: ProxyFixture): Promise<{ client: RegisteredClient; pair: TokenPair }> {
    const uri = loopback();
    const client = (await registerNative(f, uri)) as RegisteredClient;
    const issued = await codeFor(f, client.client_id, uri);
    const response = await redeem(f, client.client_id, uri, issued.code);
    return { client, pair: (await response.json()) as TokenPair };
  }

  test('new tokens are bound to their client and this server; refresh requires that client', async () => {
    const f = proxyFixture();
    const { client, pair } = await signIn(f);
    const record = await f.tokens.getByRsAccess(pair.access_token);
    expect(record?.oauth).toEqual({ clientId: client.client_id, resource: RESOURCE });

    const elsewhere = proxyFixture({
      tokens: f.tokens,
      env: { MCP_PUBLIC_URL: `${ORIGIN}/other` },
    });
    await expect(elsewhere.proxy.verifier.verifyAccessToken(pair.access_token)).rejects.toThrow();

    for (const id of ['', handleFor(client.client_id).split('.')[1] as string, client.client_id]) {
      const refresh = await f.request(
        '/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: pair.refresh_token,
          client_id: id,
        }),
      );
      expect(refresh.status).toBe(id === client.client_id ? 200 : 400);
    }

    // A bound record keeps the scopes Spotify granted, even none; it never inherits defaults.
    if (!record) throw new Error('expected a record');
    await f.tokens.updateByRsRefresh(pair.refresh_token, { ...record.provider, scopes: [] });
    expect((await f.proxy.verifier.verifyAccessToken(pair.access_token)).scopes).toEqual([]);
    expect((await f.tokens.getByRsAccess(pair.access_token))?.oauth).toEqual(record.oauth);
  });

  test('a failed token write cannot bring a consumed code back', async () => {
    const f = proxyFixture();
    const uri = loopback();
    const client = await registerNative(f, uri);
    const issued = await codeFor(f, client.client_id, uri);
    const store = f.tokens.storeRsMapping.bind(f.tokens);
    f.tokens.storeRsMapping = async () => {
      throw new Error('mapping write failure');
    };
    expect((await redeem(f, client.client_id, uri, issued.code)).status).toBe(503);
    f.tokens.storeRsMapping = store;
    expect((await redeem(f, client.client_id, uri, issued.code)).status).toBe(400);
  });

  test('records from before provenance refresh without a client, but never for another resource', async () => {
    const f = proxyFixture();
    await f.tokens.storeRsMapping(
      'old-access',
      { access_token: 'old-accounts', expires_at: Date.now() + 3_600_000 },
      'old-refresh',
    );
    const refresh = (resource?: string) =>
      f.request(
        '/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: 'old-refresh',
          ...(resource && { resource }),
        }),
      );
    expect((await refresh('https://wrong.example/mcp')).status).toBe(400);
    expect((await refresh()).status).toBe(200);
  });

  test('refresh renews Spotify tokens near expiry, keeps omitted scopes and refresh token, and rotates only with Spotify', async () => {
    let rotate = false;
    const accounts = spotifyTokens((form) => {
      expect(Object.fromEntries(form)).toEqual({
        grant_type: 'refresh_token',
        refresh_token: rotate ? 'spotify-refresh' : 'spotify-refresh',
      });
      return Response.json({
        access_token: 'fresh-spotify-access',
        ...(rotate && { refresh_token: 'rotated' }),
        expires_in: 3600,
      });
    });
    const f = proxyFixture({ accounts });
    await f.tokens.storeRsMapping(
      'mcp-access',
      {
        access_token: 'expired',
        refresh_token: 'spotify-refresh',
        expires_at: Date.now() - 1000,
        scopes: ['user-read-playback-state'],
      },
      'mcp-refresh',
    );
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'mcp-refresh' });

    const response = await f.request('/token', form);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      access_token: 'mcp-access',
      refresh_token: 'mcp-refresh',
      scope: 'user-read-playback-state',
    });
    const old = await f.tokens.getByRsAccess('mcp-access');
    expect(old?.provider).toMatchObject({
      access_token: 'fresh-spotify-access',
      refresh_token: 'spotify-refresh',
    });

    if (!old) throw new Error('expected a record');
    await f.tokens.updateByRsRefresh('mcp-refresh', {
      ...old.provider,
      expires_at: Date.now() - 1000,
    });
    rotate = true;
    const rotated = await f.request('/token', form);
    expect(rotated.status).toBe(200);
    const pair = (await rotated.json()) as TokenPair;
    expect(pair.access_token).not.toBe('mcp-access');
    expect(pair.refresh_token).toBe('mcp-refresh');
    expect((await f.tokens.getByRsAccess(pair.access_token))?.provider.refresh_token).toBe(
      'rotated',
    );
    expect(await f.tokens.getByRsAccess('mcp-access')).toBeNull();
  });

  test('an expired Spotify token without a refresh token cannot be refreshed', async () => {
    const f = proxyFixture();
    await f.tokens.storeRsMapping(
      'mcp-access',
      { access_token: 'expired', expires_at: Date.now() - 1000 },
      'mcp-refresh',
    );
    const response = await f.request(
      '/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'mcp-refresh' }),
    );
    expect(response.status).toBe(503);
    expect(f.accounts.forms).toHaveLength(0);
  });

  test('unknown grants and missing fields are named', async () => {
    const f = proxyFixture();
    for (const [form, error] of [
      [{ grant_type: 'password' }, 'unsupported_grant_type'],
      [{ grant_type: 'refresh_token' }, 'missing_refresh_token'],
      [{ grant_type: 'authorization_code', code: 'x' }, 'invalid_request'],
      [{ grant_type: 'refresh_token', refresh_token: 'unknown' }, 'invalid_grant'],
    ] as const) {
      const response = await f.request('/token', new URLSearchParams(form));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
  });

  test('revocation is accepted and changes nothing', async () => {
    const f = proxyFixture();
    const { pair } = await signIn(f);
    const response = await f.request('/revoke', new URLSearchParams({ token: pair.access_token }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(await f.tokens.getByRsAccess(pair.access_token)).not.toBeNull();
  });
});
