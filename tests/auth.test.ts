import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { base64url, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { MemoryTokenStore, type TokenStore } from '../src/oauth/token-store';
import { type App, createApp } from '../src/platform/app';
import { createOAuthAuth } from '../src/platform/auth';
import { ConfigError } from '../src/platform/config';
import { createJwtVerifier } from '../src/platform/jwt';
import { oauthMetadata, serverInfo } from '../src/server';
import { SPOTIFY_SCOPES } from '../src/services/spotify-oauth';
import {
  cleanup,
  type LogEntry,
  memoryLogger,
  message,
  PUBLIC_URL,
  post,
  testApp,
  testConfig,
  testDeps,
  testProxy,
  textOf,
  track,
} from './helpers';

/**
 * Adjusted for this project: `createVerifier` and `oauthMetadata` in `src/server.ts` make the
 * server its own authorization server (the OAuth proxy), so OAuth mode checks the opaque
 * tokens it issued instead of JWTs. The platform's guarantees are tested the same way:
 * discovery, the challenge, the audience, scopes, and handlers never seeing the token.
 * The built-in JWT verifier keeps its own test below.
 */
const ORIGIN = 'http://127.0.0.1:3000';
const PROXY_ENV = {
  AUTH_MODE: 'oauth',
  OAUTH_ISSUER_URL: ORIGIN,
  OAUTH_AUTHORIZATION_URL: `${ORIGIN}/authorize`,
  OAUTH_TOKEN_URL: `${ORIGIN}/token`,
  OAUTH_REGISTRATION_URL: `${ORIGIN}/register`,
};
const IN_AN_HOUR = () => Date.now() + 3_600_000;

/**
 * A stand-in authorization server on a local port. Its key set also publishes a shared
 * secret, as a misconfigured server might; a token signed with it must still be refused.
 * `/down` and `/html` are key set URLs that fail.
 */
const SHARED_SECRET = new TextEncoder().encode('a-shared-secret-of-sufficient-length!!');
let issuer: string;
let sign: (claims: JWTPayload, key?: 'rsa' | 'shared') => Promise<string>;
let authorizationServer: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const keys = [
    { ...(await exportJWK(publicKey)), kid: 'rsa', alg: 'RS256', use: 'sig' },
    { kty: 'oct', k: base64url.encode(SHARED_SECRET), kid: 'shared', alg: 'HS256', use: 'sig' },
  ];
  authorizationServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/down') return new Response('Unavailable', { status: 503 });
      if (pathname === '/html')
        return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
      return Response.json({ keys });
    },
  });
  issuer = `http://127.0.0.1:${authorizationServer.port}`;

  sign = async (claims, key = 'rsa') => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({
      iss: issuer,
      aud: PUBLIC_URL,
      client_id: 'client-1',
      sub: 'user-1',
      scope: 'mcp',
      iat: now,
      exp: now + 300,
      ...claims,
    }).setProtectedHeader(
      key === 'rsa' ? { alg: 'RS256', kid: 'rsa' } : { alg: 'HS256', kid: 'shared' },
    );
    return jwt.sign(key === 'rsa' ? privateKey : SHARED_SECRET);
  };
});

afterAll(() => authorizationServer.stop(true));
afterEach(cleanup);

function oauthApp(tokens: TokenStore = new MemoryTokenStore(), logs: LogEntry[] = []): App {
  const config = testConfig(PROXY_ENV);
  const logger = memoryLogger(logs);
  return testApp(config, {
    deps: testDeps({ config, logger, oauth: testProxy({ config, logger, tokens }) }),
  });
}

/** A token store holding one grant, as `/token` writes it. */
async function storeWith(
  scopes: string[] = [...SPOTIFY_SCOPES],
  overrides: { resource?: string; expiresAt?: number; refresh?: string } = {},
): Promise<MemoryTokenStore> {
  const tokens = new MemoryTokenStore();
  await tokens.storeRsMapping(
    'mcp-token',
    {
      access_token: 'spotify-access',
      ...(overrides.refresh && { refresh_token: overrides.refresh }),
      expires_at: overrides.expiresAt ?? IN_AN_HOUR(),
      scopes,
    },
    'mcp-refresh',
    { clientId: 'client-1', resource: overrides.resource ?? PUBLIC_URL },
  );
  return tokens;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function connectWith(
  app: App,
  token: string,
  mode: 'auto' | 'legacy' = 'auto',
): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(PUBLIC_URL), {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Host', '127.0.0.1:3000');
        headers.set('Authorization', `Bearer ${token}`);
        return app.fetch(new Request(String(url), { ...init, headers }));
      },
    }),
  );
  return track(client);
}

describe('discovery', () => {
  test('publishes RFC 9728 metadata at the path-aware location, readable from any origin', async () => {
    const response = await oauthApp().fetch(
      new Request('http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp', {
        headers: { Host: '127.0.0.1:3000', Origin: 'https://any-client.example' },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await response.json()).toEqual({
      resource: PUBLIC_URL,
      authorization_servers: [ORIGIN],
      resource_name: serverInfo.title,
    });
  });

  test('publishes this server as the authorization server, with PKCE S256', async () => {
    const response = await oauthApp().fetch(
      new Request('http://127.0.0.1:3000/.well-known/oauth-authorization-server', {
        headers: { Host: '127.0.0.1:3000' },
      }),
    );
    expect(await response.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    });
  });

  test('discovery documents are behind the Host check like every route', async () => {
    const response = await oauthApp().fetch(
      new Request('http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp', {
        headers: { Host: 'evil.example' },
      }),
    );
    expect(response.status).toBe(403);
  });

  test('a request without a token is challenged toward the metadata', async () => {
    const response = await post(oauthApp(), message('tools/list'));

    expect(response.status).toBe(401);
    const challenge = response.headers.get('WWW-Authenticate') ?? '';
    expect(challenge).toStartWith('Bearer ');
    expect(challenge).toContain(
      'resource_metadata="http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp"',
    );
  });
});

describe('tokens', () => {
  for (const era of ['auto', 'legacy'] as const) {
    test(`${era}: handlers see the verified caller, but neither the token nor the header`, async () => {
      const client = await connectWith(oauthApp(await storeWith()), 'mcp-token', era);
      const result = await client.callTool({ name: 'caller', arguments: {} });

      expect(JSON.parse(textOf(result))).toEqual({
        authInfo: expect.objectContaining({
          token: '',
          clientId: 'client-1',
          scopes: [...SPOTIFY_SCOPES],
          resource: PUBLIC_URL,
          extra: { providerAccessToken: 'spotify-access' },
        }),
        authorization: null,
      });
      expect(JSON.stringify(result)).not.toContain('mcp-token');
    });
  }

  const rejected: Array<[string, () => Promise<MemoryTokenStore>]> = [
    ['that this server never issued', async () => new MemoryTokenStore()],
    [
      'issued for another server',
      () => storeWith(undefined, { resource: 'https://other.example/mcp' }),
    ],
    [
      'whose Spotify token has expired, with nothing to refresh it',
      () => storeWith(undefined, { expiresAt: Date.now() - 120_000 }),
    ],
  ];
  for (const [label, tokens] of rejected) {
    test(`a token ${label} is rejected with 401`, async () => {
      const response = await post(
        oauthApp(await tokens()),
        message('tools/list'),
        bearer('mcp-token'),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
    });
  }

  test('no scope is required: a token granted only some scopes is still served', async () => {
    const response = await post(
      oauthApp(await storeWith(['user-read-playback-state'])),
      message('tools/list'),
      bearer('mcp-token'),
    );

    expect(response.status).toBe(200);
  });

  test('a tool scope is challenged before the tool runs (step-up)', async () => {
    const call = message('tools/call', { name: 'scoped', arguments: {} });
    const headers = { 'Mcp-Name': 'scoped' };

    const reader = await post(oauthApp(await storeWith()), call, {
      ...headers,
      ...bearer('mcp-token'),
    });
    expect(reader.status).toBe(403);
    expect(reader.headers.get('WWW-Authenticate')).toContain('scope="probe:write"');

    const writer = await post(oauthApp(await storeWith([...SPOTIFY_SCOPES, 'probe:write'])), call, {
      ...headers,
      ...bearer('mcp-token'),
    });
    expect(writer.status).toBe(200);
  });

  // Unlike the template's key-set failures (500), a token store that can't be read answers
  // 401, as this server did before the migration: the client refreshes or signs in again.
  test('a token store failure is an invalid token', async () => {
    const failing: TokenStore = Object.assign(new MemoryTokenStore(), {
      getByRsAccess: async () => {
        throw new Error('KV is down');
      },
    });
    const response = await post(oauthApp(failing), message('tools/list'), bearer('mcp-token'));

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('KV is down');
  });
});

describe('audience, checked twice', () => {
  test('the JWT verifier rejects a token for another server on its own', async () => {
    const verifier = createJwtVerifier(
      { issuer, jwksUrl: new URL(`${issuer}/jwks.json`), audience: PUBLIC_URL },
      memoryLogger(),
    );
    const token = await sign({ aud: 'https://other.example/mcp' });

    await expect(verifier.verifyAccessToken(token)).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });

  test('the gate rejects whatever verifier reports another resource', async () => {
    const config = testConfig(PROXY_ENV);
    if (config.auth.mode !== 'oauth') throw new Error('expected oauth');
    const lenient = {
      verifyAccessToken: async (token: string) => ({
        token,
        clientId: 'client',
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        resource: new URL('https://other.example/mcp'),
      }),
    };
    const { gate } = createOAuthAuth(config, config.auth, {
      verifier: lenient,
      authorizationServer: oauthMetadata(config.auth, testDeps({ config })),
      resourceName: 'test',
    });

    const result = await gate(
      new Request(PUBLIC_URL, { headers: { Authorization: 'Bearer anything' } }),
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
});

test('the proxy needs OAUTH_* to name its own endpoints, and no key set', () => {
  for (const env of [
    { OAUTH_ISSUER_URL: issuer },
    { OAUTH_AUTHORIZATION_URL: `${issuer}/authorize` },
    { OAUTH_REGISTRATION_URL: '' },
    { OAUTH_JWKS_URL: `${issuer}/jwks.json` },
  ]) {
    const config = testConfig({ ...PROXY_ENV, ...env });
    expect(() => createApp(config, { deps: testDeps({ config }) })).toThrow(ConfigError);
  }
  const config = testConfig(PROXY_ENV);
  expect(() => createApp(config, { deps: testDeps({ config }) })).not.toThrow();
});

describe('AUTH_MODE=bearer', () => {
  const TOKEN = 'a-long-random-shared-secret';
  const bearerApp = () => testApp(testConfig({ AUTH_MODE: 'bearer', BEARER_TOKEN: TOKEN }));

  test('the shared token gets through; handlers see the caller but not the token', async () => {
    const client = await connectWith(bearerApp(), TOKEN);
    const result = await client.callTool({ name: 'caller', arguments: {} });

    expect(JSON.parse(textOf(result))).toEqual({
      authInfo: expect.objectContaining({ token: '', clientId: 'bearer', resource: PUBLIC_URL }),
      authorization: null,
    });
  });

  test('a missing or wrong token gets 401 with no OAuth metadata to follow', async () => {
    for (const headers of [{}, bearer('wrong'), bearer(`${TOKEN}x`)]) {
      const response = await post(bearerApp(), message('tools/list'), headers);
      expect(response.status).toBe(401);
      const challenge = response.headers.get('WWW-Authenticate') ?? '';
      expect(challenge).toStartWith('Bearer ');
      expect(challenge).not.toContain('resource_metadata');
    }
  });

  test('publishes no OAuth discovery documents', async () => {
    const app = bearerApp();
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
    ]) {
      const response = await app.fetch(
        new Request(`http://127.0.0.1:3000${path}`, { headers: { Host: '127.0.0.1:3000' } }),
      );
      expect(response.status).toBe(404);
    }
  });
});

describe('oauthMetadata', () => {
  test('what the project returns is published as the authorization server metadata', async () => {
    const config = testConfig(PROXY_ENV);
    if (config.auth.mode !== 'oauth') throw new Error('expected oauth');
    const proxy = createOAuthAuth(config, config.auth, {
      verifier: { verifyAccessToken: async () => Promise.reject(new Error('unused')) },
      authorizationServer: {
        ...oauthMetadata(config.auth, testDeps({ config })),
        revocation_endpoint: 'http://127.0.0.1:3000/revoke',
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
      resourceName: 'proxy',
    });

    const response = proxy.metadata(
      new Request('http://127.0.0.1:3000/.well-known/oauth-authorization-server'),
    );
    expect(await response?.json()).toMatchObject({
      issuer: 'http://127.0.0.1:3000',
      revocation_endpoint: 'http://127.0.0.1:3000/revoke',
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });
});
