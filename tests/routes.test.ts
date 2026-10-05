import { afterEach, expect, test } from 'bun:test';
import { MemoryOAuthAuthority } from '../src/oauth/authority';
import { pkceChallenge } from '../src/oauth/crypto';
import { MemoryTokenStore } from '../src/oauth/token-store';
import { type App, createApp } from '../src/platform/app';
import { parseConfig } from '../src/platform/config';
import { createDeps } from '../src/server';
import { createSpotifyClients } from '../src/services/spotify';
import { SPOTIFY_SCOPES } from '../src/services/spotify-oauth';
import { tokenEncryptionKey } from '../src/settings';
import before from './fixtures/routes-before.json';
import { cleanup, fakeFetch, memoryLogger, testProxy, track } from './helpers';
import { PRODUCTION_VARS } from './production-config';

afterEach(cleanup);

/**
 * The public routes, compared with what the deployed code answered before the migration
 * (`fixtures/routes-before.json`, recorded in workerd with the same probes). The server runs
 * here with the production vars from `wrangler.production.example.jsonc`, in process: Spotify is a fake.
 */
const ORIGIN = 'https://spotify-mcp.example.workers.dev';
const HOST = 'spotify-mcp.example.workers.dev';
const NATIVE = 'http://127.0.0.1:43210/oauth/callback';
const VERIFIER = 'v'.repeat(43);

interface Probe {
  label: string;
  method: string;
  path: string;
  status: number;
  contentType: string | null;
  allowOrigin: string | null;
  cacheControl: string | null;
  wwwAuthenticate?: string;
  location?: string;
  error?: unknown;
}

/** Unknown paths answer JSON, as the template does everywhere, instead of plain text. */
const JSON_NOT_FOUND = { contentType: 'application/json', error: 'not_found' };
/** The older discovery locations answer exactly as the standard ones, behind the Origin check. */
const ALIAS_PREFLIGHT = { status: 204, contentType: null, allowOrigin: '*' };
const ALIAS_POST = {
  status: 405,
  contentType: 'application/json',
  allowOrigin: '*',
  error: 'method_not_allowed',
};
/** The OAuth endpoints now answer CORS for allowed origins (`cors()` from `hono/cors`). */
const OAUTH_PREFLIGHT = {
  status: 204,
  contentType: null,
  allowOrigin: 'https://claude.ai',
  cacheControl: null,
};

/** Differences from the recorded matrix, each deliberate. Keyed by "<label> <METHOD> <path>". */
const CHANGED: Record<string, Partial<Probe>> = {
  // The template serves the server icon.
  'icon GET /icon.svg': {
    status: 200,
    contentType: 'image/svg+xml',
    cacheControl: 'public, max-age=86400',
  },
  'not served GET /.well-known/openid-configuration': JSON_NOT_FOUND,
  'not served GET /.well-known/oauth-protected-resource/other': JSON_NOT_FOUND,
  'unknown GET /nope': JSON_NOT_FOUND,
  'unknown POST /nope': JSON_NOT_FOUND,
  'register GET /register': JSON_NOT_FOUND,
  'token GET /token': JSON_NOT_FOUND,
  'revoke GET /revoke': JSON_NOT_FOUND,
  // The shared verifier words an unknown token's challenge differently; the error is the same.
  'mcp, unknown token POST /mcp': { wwwAuthenticate: challenge('Access token is invalid') },
  // The older discovery locations serve the documents the way the standard locations do:
  // readable from any allowed origin, with preflight, and 405 for other methods.
  ...Object.fromEntries(
    [
      '/.well-known/oauth-protected-resource',
      '/mcp/.well-known/oauth-protected-resource',
      '/mcp/.well-known/oauth-authorization-server',
    ].flatMap((path) => [
      [`discovery GET ${path}`, { allowOrigin: '*' }],
      [`discovery, claude.ai origin GET ${path}`, { allowOrigin: '*' }],
      [`discovery HEAD ${path}`, { allowOrigin: '*' }],
      [`discovery preflight OPTIONS ${path}`, ALIAS_PREFLIGHT],
      [`discovery POST ${path}`, ALIAS_POST],
    ]),
  ),
  // OAuth endpoints: an allowed browser origin may read the answers and send a preflight.
  'register, web, claude.ai origin POST /register': { allowOrigin: 'https://claude.ai' },
  'register preflight, claude.ai OPTIONS /register': OAUTH_PREFLIGHT,
  'token preflight, claude.ai OPTIONS /token': OAUTH_PREFLIGHT,
  'token, refresh, claude.ai origin POST /token': { allowOrigin: 'https://claude.ai' },
  // Tokens issued from now on are bound to the client that asked for them, as gmail-mcp's
  // already are: a refresh must name that client. Tokens issued before stay unbound.
  'token, refresh, wrong client POST /token': {
    status: 400,
    error: 'invalid_grant',
  },
  'token, refresh, no client_id POST /token': {
    status: 400,
    error: 'invalid_grant',
  },
};

function challenge(description: string): string {
  return `Bearer error="invalid_token", error_description="${description}", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`;
}

/** The stand-in production vars, from wrangler.production.example.jsonc. */
function productionVars(): Record<string, string> {
  return { ...PRODUCTION_VARS };
}

const track1 = {
  id: 'track1',
  uri: 'spotify:track:track1',
  name: 'Mock Song',
  artists: [{ name: 'Mock Artist' }],
  album: { name: 'Mock Album' },
  duration_ms: 200000,
};

/** Spotify, answering the way the workerd recording's stand-in did. */
function spotifyStandIn(scope: string) {
  return fakeFetch(async (request) => {
    const url = new URL(request.url);
    if (url.href === 'https://accounts.spotify.com/api/token') {
      const grant = new URLSearchParams(await request.text()).get('grant_type');
      return Response.json({
        access_token: `spotify-access-${grant}`,
        token_type: 'Bearer',
        expires_in: 3600,
        ...(grant === 'client_credentials' ? {} : { scope }),
        ...(grant === 'authorization_code' ? { refresh_token: 'spotify-refresh' } : {}),
      });
    }
    switch (url.pathname) {
      case '/v1/me/player':
        return Response.json({
          is_playing: true,
          shuffle_state: false,
          repeat_state: 'off',
          progress_ms: 1000,
          timestamp: 1,
          device: { id: 'device1' },
          item: track1,
          context: { uri: 'spotify:playlist:p1' },
        });
      case '/v1/me/player/devices':
        return Response.json({
          devices: [
            { id: 'device1', name: 'Mac', type: 'Computer', is_active: true, volume_percent: 50 },
          ],
        });
      case '/v1/me/player/currently-playing':
        return Response.json({ is_playing: true, item: track1 });
      case '/v1/search':
        return Response.json({ tracks: { total: 1, items: [track1] } });
    }
    return undefined;
  });
}

function productionApp(): { app: App; outbound: Request[] } {
  const vars = productionVars();
  const config = parseConfig({
    ...vars,
    SPOTIFY_CLIENT_ID: 'mock-spotify-client',
    SPOTIFY_CLIENT_SECRET: 'mock-spotify-secret',
    RS_TOKENS_ENC_KEY: Buffer.alloc(32, 1).toString('base64url'),
    TOKENS_ENC_KEY: Buffer.alloc(32, 2).toString('base64url'),
  });
  const logger = memoryLogger();
  const spotify = spotifyStandIn(SPOTIFY_SCOPES.join(' '));
  const tokens = new MemoryTokenStore();
  const authority = new MemoryOAuthAuthority();
  const credentials = { clientId: 'mock-spotify-client', clientSecret: 'mock-spotify-secret' };
  const deps = {
    ...createDeps(config, logger, { tokens, authority }),
    spotify: createSpotifyClients({ ...credentials, fetch: spotify }),
    oauth: testProxy({
      config,
      logger,
      tokens,
      authority,
      credentials,
      fetch: spotify,
      redirectAllowlist: config.settings.PROXY_REDIRECT_ALLOWLIST,
      encryptionKey: tokenEncryptionKey(config.settings),
    }),
  };
  return { app: track(createApp(config, { deps })), outbound: spotify.requests };
}

/** The probe sequence the recorded matrix came from, in the same order. */
async function probeAll(app: App): Promise<{
  matrix: Probe[];
  documents: Record<string, unknown>;
  spotify: URL;
  callback: URL;
  tokenResponse: Record<string, unknown>;
  refreshResponse: Record<string, unknown>;
  registrationShape: string[];
}> {
  const matrix: Probe[] = [];
  const documents: Record<string, unknown> = {};
  const send = (
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: string } = {},
  ) =>
    app.fetch(
      new Request(new URL(path, ORIGIN).href, {
        method,
        headers: { Host: HOST, ...options.headers },
        ...(options.body !== undefined && { body: options.body }),
        redirect: 'manual',
      }),
    );
  const probe = async (
    label: string,
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: string } = {},
  ) => {
    const response = await send(method, path, options);
    const location = response.headers.get('location');
    const authenticate = response.headers.get('www-authenticate');
    const entry: Probe = {
      label,
      method,
      path: path.split('?')[0] as string,
      status: response.status,
      contentType: response.headers.get('content-type')?.split(';')[0] ?? null,
      allowOrigin: response.headers.get('access-control-allow-origin'),
      cacheControl: response.headers.get('cache-control'),
      ...(authenticate && { wwwAuthenticate: authenticate }),
      ...(location && { location: `${new URL(location).origin}${new URL(location).pathname}` }),
    };
    const text = await response.text();
    if (entry.contentType === 'application/json' && text) {
      const json = JSON.parse(text) as Record<string, unknown>;
      if (json && typeof json === 'object' && 'error' in json) entry.error = json.error;
    }
    matrix.push(entry);
    return { response, text };
  };
  const json = (value: unknown, headers: Record<string, string> = {}) => ({
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value),
  });
  const form = (value: Record<string, string>, headers: Record<string, string> = {}) => ({
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(value).toString(),
  });
  const EVIL = { Origin: 'https://evil.example' };
  const CLAUDE = { Origin: 'https://claude.ai' };

  for (const path of [
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/mcp/.well-known/oauth-protected-resource',
    '/mcp/.well-known/oauth-authorization-server',
  ]) {
    const { text } = await probe('discovery', 'GET', path);
    documents[path] = JSON.parse(text);
    await probe('discovery, foreign origin', 'GET', path, { headers: EVIL });
    await probe('discovery, claude.ai origin', 'GET', path, { headers: CLAUDE });
    await probe('discovery', 'HEAD', path);
    await probe('discovery preflight', 'OPTIONS', path, {
      headers: { ...CLAUDE, 'Access-Control-Request-Method': 'GET' },
    });
    await probe('discovery', 'POST', path);
  }
  await probe('not served', 'GET', '/.well-known/openid-configuration');
  await probe('not served', 'GET', '/.well-known/oauth-protected-resource/other');
  await probe('health', 'GET', '/health');
  await probe('icon', 'GET', '/icon.svg');
  await probe('unknown', 'GET', '/nope');
  await probe('unknown', 'POST', '/nope');

  const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const mcp = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  await probe('mcp, anonymous', 'POST', '/mcp', { headers: mcp, body: list });
  await probe('mcp, anonymous', 'GET', '/mcp');
  await probe('mcp, unknown token', 'POST', '/mcp', {
    headers: { ...mcp, Authorization: 'Bearer not-a-token' },
    body: list,
  });
  await probe('mcp, foreign origin', 'POST', '/mcp', { headers: { ...mcp, ...EVIL }, body: list });
  await probe('mcp, anonymous, claude.ai origin', 'POST', '/mcp', {
    headers: { ...mcp, ...CLAUDE },
    body: list,
  });
  await probe('mcp preflight, claude.ai', 'OPTIONS', '/mcp', {
    headers: {
      ...CLAUDE,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type, mcp-protocol-version',
    },
  });

  await probe('register, invalid', 'POST', '/register', json({ redirect_uris: [] }));
  await probe('register', 'GET', '/register');
  await probe(
    'register, foreign origin',
    'POST',
    '/register',
    json({ application_type: 'native', redirect_uris: [NATIVE] }, EVIL),
  );
  await probe(
    'register, web, claude.ai origin',
    'POST',
    '/register',
    json({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }, CLAUDE),
  );
  for (const [label, uri] of [
    ['register, web, unlisted redirect', 'https://evil.example/callback'],
    ['register, web, origin entry (https://example.org/any/path)', 'https://example.org/any/path'],
    [
      'register, web, wonderlands exact',
      'https://wonderlands.example.net/integration/oauth/callback',
    ],
    ['register, web, alice://', 'alice://oauth/callback'],
    ['register, web, http://127.0.0.1:3000 entry', 'http://127.0.0.1:3000/v1/mcp/oauth/callback'],
    ['register, web, http://127.0.0.1:* entry', 'http://127.0.0.1:5555/oauth/callback'],
  ] as const) {
    await probe(label, 'POST', '/register', json({ redirect_uris: [uri] }));
  }
  await probe(
    'register, native, localhost',
    'POST',
    '/register',
    json({
      application_type: 'native',
      redirect_uris: ['http://localhost:43210/oauth/callback'],
    }),
  );
  await probe('register preflight, claude.ai', 'OPTIONS', '/register', {
    headers: {
      ...CLAUDE,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  const { text: registered } = await probe(
    'register, native',
    'POST',
    '/register',
    json({
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      redirect_uris: [NATIVE],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  );
  const client = (JSON.parse(registered) as { client_id: string }).client_id;
  const shaped = await send(
    'POST',
    '/register',
    json({ application_type: 'native', redirect_uris: [NATIVE], client_name: 'shape' }),
  );
  const registrationShape = Object.keys((await shaped.json()) as object).sort();

  const query = {
    client_id: client,
    response_type: 'code',
    redirect_uri: NATIVE,
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: `${ORIGIN}/mcp`,
  };
  await probe('authorize, no parameters', 'GET', '/authorize');
  await probe(
    'authorize, plain PKCE',
    'GET',
    `/authorize?${new URLSearchParams({ ...query, code_challenge_method: 'plain' })}`,
  );
  await probe(
    'authorize, other resource',
    'GET',
    `/authorize?${new URLSearchParams({ ...query, resource: 'https://other.example/mcp' })}`,
  );
  await probe(
    'authorize, other loopback port',
    'GET',
    `/authorize?${new URLSearchParams({ ...query, redirect_uri: 'http://127.0.0.1:50000/oauth/callback' })}`,
  );
  await probe('authorize, foreign origin', 'GET', `/authorize?${new URLSearchParams(query)}`, {
    headers: EVIL,
  });
  const { response: authorized } = await probe(
    'authorize',
    'GET',
    `/authorize?${new URLSearchParams(query)}`,
  );
  const spotify = new URL(authorized.headers.get('location') as string);
  const state = spotify.searchParams.get('state');
  await probe('provider callback, no parameters', 'GET', '/oauth/callback');
  await probe(
    'provider callback, provider error',
    'GET',
    '/oauth/callback?error=access_denied&state=x',
  );
  await probe(
    'provider callback, unknown state',
    'GET',
    `/oauth/callback?code=c&state=${client}.${'x'.repeat(32)}`,
  );
  const { response: called } = await probe(
    'provider callback',
    'GET',
    `/oauth/callback?code=spotify-code&state=${state}`,
  );
  const callback = new URL(called.headers.get('location') as string);
  const code = callback.searchParams.get('code') as string;
  await probe(
    'provider callback, replay',
    'GET',
    `/oauth/callback?code=spotify-code&state=${state}`,
  );

  await probe('token, empty', 'POST', '/token', form({}));
  await probe('token', 'GET', '/token');
  await probe('token preflight, claude.ai', 'OPTIONS', '/token', {
    headers: {
      ...CLAUDE,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  await probe(
    'token, foreign origin',
    'POST',
    '/token',
    form({ grant_type: 'authorization_code' }, EVIL),
  );
  await probe('token, unsupported grant', 'POST', '/token', form({ grant_type: 'password' }));
  await probe(
    'token, refresh, missing token',
    'POST',
    '/token',
    form({ grant_type: 'refresh_token' }),
  );
  await probe(
    'token, refresh, unknown token',
    'POST',
    '/token',
    form({ grant_type: 'refresh_token', refresh_token: 'unknown' }),
  );
  const grant = { grant_type: 'authorization_code', code, client_id: client, redirect_uri: NATIVE };
  await probe(
    'token, wrong verifier',
    'POST',
    '/token',
    form({ ...grant, code_verifier: 'w'.repeat(43) }),
  );
  const { text: issued } = await probe(
    'token, authorization code',
    'POST',
    '/token',
    form({ ...grant, code_verifier: VERIFIER, resource: `${ORIGIN}/mcp` }),
  );
  const tokens = JSON.parse(issued) as Record<string, string>;
  await probe('token, code replay', 'POST', '/token', form({ ...grant, code_verifier: VERIFIER }));
  const refresh = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token as string };
  await probe(
    'token, refresh, wrong client',
    'POST',
    '/token',
    form({ ...refresh, client_id: 'someone-else' }),
  );
  await probe('token, refresh, no client_id', 'POST', '/token', form(refresh));
  const { text: refreshed } = await probe(
    'token, refresh',
    'POST',
    '/token',
    form({ ...refresh, client_id: client }),
  );
  await probe(
    'token, refresh, claude.ai origin',
    'POST',
    '/token',
    form({ ...refresh, client_id: client }, CLAUDE),
  );

  await probe('revoke', 'POST', '/revoke', form({ token: tokens.access_token as string }));
  await probe('revoke', 'GET', '/revoke');

  const bearer = { Authorization: `Bearer ${tokens.access_token}` };
  await probe('mcp, issued token, 2025 initialize', 'POST', '/mcp', {
    headers: { ...mcp, ...bearer },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'matrix', version: '1' },
      },
    }),
  });
  await probe('mcp, issued token', 'GET', '/mcp', { headers: bearer });
  await probe('mcp, issued token', 'DELETE', '/mcp', { headers: bearer });
  return {
    matrix,
    documents,
    spotify,
    callback,
    tokenResponse: tokens,
    refreshResponse: JSON.parse(refreshed) as Record<string, unknown>,
    registrationShape,
  };
}

test('every public route answers as before, except the listed changes', async () => {
  const { matrix } = await probeAll(productionApp().app);
  const recorded = before.matrix as Probe[];
  expect(matrix.map((entry) => `${entry.label} ${entry.method} ${entry.path}`)).toEqual(
    recorded.map((entry) => `${entry.label} ${entry.method} ${entry.path}`),
  );

  const differences = matrix.flatMap((entry, index) => {
    const old = recorded[index] as Probe;
    const key = `${old.label} ${old.method} ${old.path}`;
    const expected: Record<string, unknown> = { ...old, ...CHANGED[key] };
    for (const field of ['error', 'wwwAuthenticate', 'location']) {
      if (expected[field] === undefined) delete expected[field];
    }
    const normalized = Object.fromEntries(
      Object.keys(expected)
        .sort()
        .map((field) => [field, expected[field]]),
    );
    const actual = Object.fromEntries(
      Object.keys(entry)
        .sort()
        .map((field) => [field, entry[field as keyof Probe]]),
    );
    return JSON.stringify(actual) === JSON.stringify(normalized)
      ? []
      : [{ key, entry: actual, expected: normalized }];
  });
  expect(differences).toEqual([]);
});

test('every listed change applies to a recorded probe', () => {
  const recorded = new Set(
    (before.matrix as Probe[]).map((entry) => `${entry.label} ${entry.method} ${entry.path}`),
  );
  expect(Object.keys(CHANGED).filter((key) => !recorded.has(key))).toEqual([]);
});

test('the discovery documents are what production published, with two listed changes', async () => {
  const { documents } = await probeAll(productionApp().app);
  const authorizationServer = before.documents['/.well-known/oauth-authorization-server'];
  // Added: `client_id_metadata_document_supported: false`, which is also the default when the
  // field is absent.
  const published = { ...authorizationServer, client_id_metadata_document_supported: false };
  // Removed from the protected-resource documents: `scopes_supported`. The platform publishes
  // the scopes every request needs, and this server, as before, needs none. The Spotify scopes
  // stay in the authorization server document above.
  const withoutScopes = (document: unknown) => {
    const { scopes_supported: _, ...rest } = document as Record<string, unknown>;
    return rest;
  };
  const protectedResource = Object.fromEntries(
    Object.entries(before.documents)
      .filter(([path]) => path.includes('oauth-protected-resource'))
      .map(([path, document]) => [path, withoutScopes(document)]),
  );
  expect(documents).toEqual({
    ...before.documents,
    ...protectedResource,
    '/.well-known/oauth-authorization-server': published,
    '/mcp/.well-known/oauth-authorization-server': published,
  });
});

test('Spotify is asked for the same sign-in as before, with the same callback', async () => {
  const { spotify, callback } = await probeAll(productionApp().app);
  expect(`${spotify.origin}${spotify.pathname}`).toBe(before.spotifyAuthorize.url);
  expect({ ...Object.fromEntries(spotify.searchParams), state: '<handle>' }).toEqual(
    before.spotifyAuthorize.query,
  );
  expect(spotify.searchParams.get('redirect_uri')).toBe(
    'https://spotify-mcp.example.workers.dev/oauth/callback',
  );
  expect(`${callback.origin}${callback.pathname}`).toBe(before.clientCallback.url);
  expect([...callback.searchParams.keys()].sort()).toEqual(before.clientCallback.queryKeys);
  expect(callback.searchParams.get('state')).toBe('client-state');
});

test('registration, token and refresh answers have the same shape and values', async () => {
  const { tokenResponse, refreshResponse, registrationShape } = await probeAll(productionApp().app);
  expect(registrationShape).toEqual(before.registrationShape);
  const opaque = (value: Record<string, unknown>): Record<string, unknown> => ({
    ...value,
    access_token: '<opaque>',
    refresh_token: '<opaque>',
  });
  expect(opaque(tokenResponse)).toEqual(before.tokenResponse);
  // `expires_in` counts down from the Spotify token's expiry; the rest is identical.
  const { expires_in: seconds, ...rest } = opaque(refreshResponse);
  const { expires_in: _recorded, ...recordedRest } = before.refreshResponse as Record<
    string,
    unknown
  >;
  expect(rest).toEqual(recordedRest);
  expect(seconds).toBeGreaterThan(3500);
});

test('Spotify receives the same calls as before', async () => {
  const { app, outbound } = productionApp();
  await probeAll(app);
  // The recording also called two tools through the official client; those run in
  // tests/contract.test.ts. These are the calls the route probes make: one code exchange.
  expect(outbound.map((request) => `${request.method} ${request.url}`)).toEqual([
    before.outbound[0] as string,
  ]);
});
