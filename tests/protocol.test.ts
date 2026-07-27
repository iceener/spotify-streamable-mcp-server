import { afterEach, describe, expect, test } from 'bun:test';
import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { parseConfig, type UnifiedConfig } from '../src/config/env.js';
import { buildHttpApp, type HttpRuntime } from '../src/http/app.js';
import {
  SpotifyControlInputSchema,
  SpotifyPlaylistInputSchema,
} from '../src/schemas/inputs.js';
import { MemoryTokenStore } from '../src/shared/storage/memory.js';

interface Exchange {
  method: string;
  requestHeaders: Headers;
  status: number;
  responseHeaders: Headers;
}

interface TestConnection {
  client: Client;
  exchanges: Exchange[];
}

const activeRuntimes = new Set<HttpRuntime>();
const activeClients = new Set<Client>();
const activeStores = new Set<MemoryTokenStore>();

const originalFetch = globalThis.fetch;

afterEach(async () => {
  await Promise.all([...activeClients].map((client) => client.close()));
  await Promise.all([...activeRuntimes].map((runtime) => runtime.close()));
  for (const store of activeStores) store.stopCleanup();
  activeClients.clear();
  activeRuntimes.clear();
  activeStores.clear();
  globalThis.fetch = originalFetch;
});

function testConfig(overrides: Record<string, unknown> = {}): UnifiedConfig {
  return parseConfig({
    NODE_ENV: 'test',
    MCP_PUBLIC_URL: 'http://localhost:3000/mcp',
    MCP_ALLOWED_HOSTS: 'localhost',
    MCP_ALLOWED_ORIGIN_HOSTNAMES: 'localhost',
    AUTH_STRATEGY: 'none',
    AUTH_ENABLED: 'false',
    SPOTIFY_CLIENT_ID: 'spotify-client-id',
    SPOTIFY_CLIENT_SECRET: 'spotify-client-secret',
    ...overrides,
  });
}

function memoryStore(): MemoryTokenStore {
  const store = new MemoryTokenStore();
  activeStores.add(store);
  return store;
}

function createRuntime(
  options: {
    config?: UnifiedConfig;
    store?: MemoryTokenStore;
    verifier?: OAuthTokenVerifier;
    spotifyFetch?: typeof globalThis.fetch;
  } = {},
): HttpRuntime {
  const config = options.config ?? testConfig();
  const store = options.store ?? memoryStore();
  const runtime = buildHttpApp(config, {
    runtimeName: 'test',
    tokenStore: store,
    authorizationServerUrl: new URL(
      config.AUTH_DISCOVERY_URL ?? 'http://localhost:4000',
    ),
    ...(options.verifier ? { verifier: options.verifier } : {}),
    ...(options.spotifyFetch ? { spotifyFetch: options.spotifyFetch } : {}),
  });
  activeRuntimes.add(runtime);
  return runtime;
}

function runtimeFetch(
  runtime: HttpRuntime,
  exchanges: Exchange[],
  token?: string,
): FetchLike {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Host', 'localhost:3000');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await runtime.fetch(new Request(url, { ...init, headers }));
    exchanges.push({
      method: init?.method ?? 'GET',
      requestHeaders: new Headers(headers),
      status: response.status,
      responseHeaders: new Headers(response.headers),
    });
    return response;
  };
}

async function connect(
  runtime: HttpRuntime,
  mode: 'modern' | 'legacy',
  token?: string,
): Promise<TestConnection> {
  const exchanges: Exchange[] = [];
  const client = new Client(
    { name: `spotify-test-${mode}`, version: '1.0.0' },
    mode === 'modern'
      ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      : undefined,
  );
  const transport = new StreamableHTTPClientTransport(
    new URL('http://localhost:3000/mcp'),
    {
      fetch: runtimeFetch(runtime, exchanges, token),
      ...(token ? { authProvider: { token: async () => token } } : {}),
    },
  );
  await client.connect(transport);
  activeClients.add(client);
  return { client, exchanges };
}

const TOOL_CONTRACT_SNAPSHOT = (await Bun.file(
  new URL('./tool-contract.snapshot.json', import.meta.url),
).json()) as Array<Record<string, unknown>>;
const LEGACY_TOOL_CONTRACT_SNAPSHOT = (await Bun.file(
  new URL('./tool-contract.legacy.snapshot.json', import.meta.url),
).json()) as Array<Record<string, unknown>>;

function normalizeZod4InputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeZod4InputSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => !(key === 'additionalProperties' && entry === false))
      .map(([key, entry]) => [key, normalizeZod4InputSchema(entry)]),
  );
}

function preservedToolContract(tools: Array<Record<string, unknown>>) {
  return tools.map((tool) => ({
    ...tool,
    inputSchema: normalizeZod4InputSchema(tool.inputSchema),
  }));
}

const TOOL_NAMES = [
  'health',
  'player_status',
  'search_catalog',
  'spotify_control',
  'spotify_playlist',
  'spotify_library',
];

function spotifyMock(observedAuthorization: string[]): typeof globalThis.fetch {
  const implementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = new Headers(init?.headers);
    const authorization = headers.get('Authorization') ?? '';
    observedAuthorization.push(authorization);

    if (url.pathname === '/api/token') {
      return Response.json({
        access_token: 'spotify-app-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    if (url.pathname.endsWith('/search')) {
      return Response.json({
        tracks: {
          total: 1,
          items: [
            {
              id: 'track-1',
              uri: 'spotify:track:track-1',
              name: 'Migration Song',
              artists: [{ name: 'MCP' }],
            },
          ],
        },
      });
    }
    if (url.pathname.endsWith('/me/player')) {
      const suffix = authorization.replace('Bearer spotify-', '');
      return Response.json({
        is_playing: true,
        device: { id: `device-${suffix}` },
      });
    }
    if (url.pathname.endsWith('/me/playlists')) {
      return Response.json({ items: [], total: 0, limit: 20, offset: 0 });
    }
    if (url.pathname.endsWith('/me/tracks/contains')) {
      return Response.json([true]);
    }
    if (url.pathname.endsWith('/tracks')) {
      return Response.json({
        tracks: [
          {
            id: 'track-1',
            uri: 'spotify:track:track-1',
            name: 'Migration Song',
          },
        ],
      });
    }
    return new Response(null, { status: 204 });
  };
  return Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  }) as typeof globalThis.fetch;
}

async function storeAlias(
  store: MemoryTokenStore,
  mcpToken: string,
  spotifyToken: string,
  scopes = ['user-read-playback-state'],
): Promise<void> {
  await store.storeRsMapping(mcpToken, {
    access_token: spotifyToken,
    refresh_token: `refresh-${spotifyToken}`,
    expires_at: Date.now() + 300_000,
    scopes,
  });
}

describe('MCP 2026-07-28 and stateless legacy', () => {
  test('preserves the pre-v2 unknown-key stripping behavior', () => {
    expect(
      SpotifyControlInputSchema.safeParse({
        operations: [{ action: 'pause', futureOperationOption: true }],
        futureBatchOption: true,
      }).success,
    ).toBe(true);
    expect(
      SpotifyPlaylistInputSchema.safeParse({
        action: 'remove_items',
        playlist_id: 'playlist',
        tracks: [{ uri: 'spotify:track:track', futureTrackOption: true }],
        futurePlaylistOption: true,
      }).success,
    ).toBe(true);
  });

  test('official modern client discovers the exact six-tool contract', async () => {
    const runtime = createRuntime();
    const { client, exchanges } = await connect(runtime, 'modern');

    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const tools = await client.listTools();
    expect(JSON.stringify(preservedToolContract(tools.tools))).toBe(
      JSON.stringify(preservedToolContract(TOOL_CONTRACT_SNAPSHOT)),
    );
    expect(tools.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    for (const tool of tools.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type).toBe('object');
    }

    const health = await client.callTool({ name: 'health', arguments: {} });
    expect(health.structuredContent).toMatchObject({
      status: 'ok',
      runtime: 'test',
    });
    expect(
      exchanges.filter(
        (exchange) =>
          exchange.requestHeaders.get('MCP-Protocol-Version') === '2026-07-28',
      ).length,
    ).toBeGreaterThan(1);
    expect(
      exchanges.every((exchange) => !exchange.responseHeaders.has('Mcp-Session-Id')),
    ).toBe(true);
  });

  test('official legacy client uses SDK stateless fallback without sessions', async () => {
    const runtime = createRuntime();
    const { client, exchanges } = await connect(runtime, 'legacy');

    expect(client.getProtocolEra()).toBe('legacy');
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(false);
    const tools = await client.listTools();
    expect(JSON.stringify(preservedToolContract(tools.tools))).toBe(
      JSON.stringify(preservedToolContract(LEGACY_TOOL_CONTRACT_SNAPSHOT)),
    );
    expect(tools.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(
      (await client.callTool({ name: 'health', arguments: {} })).structuredContent,
    ).toMatchObject({ status: 'ok' });
    expect(
      exchanges.every((exchange) => !exchange.responseHeaders.has('Mcp-Session-Id')),
    ).toBe(true);
  });

  test('SDK owns method, header mismatch, and unsupported-version errors', async () => {
    const runtime = createRuntime();
    for (const method of ['GET', 'DELETE']) {
      const response = await runtime.fetch(
        new Request('http://localhost:3000/mcp', {
          method,
          headers: { Host: 'localhost:3000' },
        }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.has('Mcp-Session-Id')).toBe(false);
    }

    const discover = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': {
            name: 'raw-test',
            version: '1.0.0',
          },
        },
      },
    });
    const mismatch = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/list',
        },
        body: discover,
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: { code: -32020 } });

    const unsupported = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2099-01-01',
          'Mcp-Method': 'server/discover',
        },
        body: discover,
      }),
    );
    expect(unsupported.status).toBe(400);

    const unsupportedMediaType = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          'Content-Type': 'text/plain',
        },
        body: discover,
      }),
    );
    expect(unsupportedMediaType.status).toBe(415);
  });
});

describe('HTTP security and opaque Spotify authorization', () => {
  test('rejects invalid AUTH_ENABLED values', () => {
    expect(() => testConfig({ AUTH_ENABLED: 'sometimes' })).toThrow(
      'AUTH_ENABLED must be true or false',
    );
  });

  test('enforces Host, Origin, strict CORS, and bounded request bodies', async () => {
    const runtime = createRuntime({
      config: testConfig({ MCP_MAX_REQUEST_BYTES: '1024' }),
    });
    const untrustedOrigin = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    );
    expect(untrustedOrigin.status).toBe(403);
    expect(untrustedOrigin.headers.has('Access-Control-Allow-Origin')).toBe(false);

    const untrustedHost = await runtime.fetch(
      new Request('http://localhost:3000/health', {
        headers: { Host: 'evil.example' },
      }),
    );
    expect(untrustedHost.status).toBe(403);

    const preflight = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'OPTIONS',
        headers: {
          Host: 'localhost:3000',
          Origin: 'http://localhost:8080',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers':
            'authorization, content-type, mcp-param-tenant',
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:8080',
    );

    const oversized = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          'Content-Type': 'application/json',
        },
        body: 'x'.repeat(1_025),
      }),
    );
    expect(oversized.status).toBe(413);
  });

  test('serves metadata and returns 401, invalid_token, and 403 scope errors', async () => {
    const store = memoryStore();
    await storeAlias(store, 'valid-token', 'spotify-valid', ['spotify.read']);
    await storeAlias(store, 'limited-token', 'spotify-limited', []);
    const config = testConfig({
      AUTH_STRATEGY: 'oauth',
      AUTH_ENABLED: 'true',
      AUTH_DISCOVERY_URL: 'http://localhost:4000',
      MCP_REQUIRED_SCOPES: 'spotify.read',
      OAUTH_SCOPES: 'spotify.read spotify.write',
    });
    const runtime = createRuntime({ config, store });

    const metadata = await runtime.fetch(
      new Request('http://localhost:3000/.well-known/oauth-protected-resource/mcp', {
        headers: { Host: 'localhost:3000' },
      }),
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: 'http://localhost:3000/mcp',
      authorization_servers: ['http://localhost:4000'],
    });

    const unauthorized = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'GET',
        headers: { Host: 'localhost:3000' },
      }),
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('WWW-Authenticate')).toContain(
      'resource_metadata=',
    );

    const invalid = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'GET',
        headers: {
          Host: 'localhost:3000',
          Authorization: 'Bearer not-a-record',
        },
      }),
    );
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('WWW-Authenticate')).toContain('invalid_token');

    const insufficient = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'GET',
        headers: {
          Host: 'localhost:3000',
          Authorization: 'Bearer limited-token',
        },
      }),
    );
    expect(insufficient.status).toBe(403);
    expect(insufficient.headers.get('WWW-Authenticate')).toContain(
      'insufficient_scope',
    );
  });

  test('never forwards the visibly different inbound MCP bearer to Spotify', async () => {
    const observed: string[] = [];
    const store = memoryStore();
    await storeAlias(store, 'MCP-RS-TOKEN', 'spotify-PROVIDER-TOKEN');
    const config = testConfig({
      AUTH_STRATEGY: 'oauth',
      AUTH_ENABLED: 'true',
      AUTH_DISCOVERY_URL: 'http://localhost:4000',
      OAUTH_SCOPES: 'user-read-playback-state',
    });
    const runtime = createRuntime({
      config,
      store,
      spotifyFetch: spotifyMock(observed),
    });
    const { client } = await connect(runtime, 'modern', 'MCP-RS-TOKEN');

    const result = await client.callTool({
      name: 'player_status',
      arguments: { include: ['player'] },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      player: { device_id: 'device-PROVIDER-TOKEN' },
    });
    expect(observed).toContain('Bearer spotify-PROVIDER-TOKEN');
    expect(observed).not.toContain('Bearer MCP-RS-TOKEN');
  });

  test('isolates concurrent principals through fresh request servers', async () => {
    const observed: string[] = [];
    const store = memoryStore();
    await Promise.all([
      storeAlias(store, 'mcp-alice', 'spotify-alice'),
      storeAlias(store, 'mcp-bob', 'spotify-bob'),
    ]);
    const config = testConfig({
      AUTH_STRATEGY: 'oauth',
      AUTH_ENABLED: 'true',
      AUTH_DISCOVERY_URL: 'http://localhost:4000',
      OAUTH_SCOPES: 'user-read-playback-state',
    });
    const runtime = createRuntime({
      config,
      store,
      spotifyFetch: spotifyMock(observed),
    });
    const [alice, bob] = await Promise.all([
      connect(runtime, 'modern', 'mcp-alice'),
      connect(runtime, 'modern', 'mcp-bob'),
    ]);
    const [aliceResult, bobResult] = await Promise.all([
      alice.client.callTool({
        name: 'player_status',
        arguments: { include: ['player'] },
      }),
      bob.client.callTool({
        name: 'player_status',
        arguments: { include: ['player'] },
      }),
    ]);
    expect(aliceResult.structuredContent).toMatchObject({
      player: { device_id: 'device-alice' },
    });
    expect(bobResult.structuredContent).toMatchObject({
      player: { device_id: 'device-bob' },
    });
  });
});

describe('mocked Spotify provider behavior', () => {
  test('keeps catalog client-credentials behavior and structured output', async () => {
    const observed: string[] = [];
    const mock = spotifyMock(observed);
    globalThis.fetch = mock;
    const runtime = createRuntime({ spotifyFetch: mock });
    const { client } = await connect(runtime, 'modern');
    const result = await client.callTool({
      name: 'search_catalog',
      arguments: { queries: ['migration'], types: ['track'] },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      queries: ['migration'],
      batches: [
        {
          query: 'migration',
          items: [{ id: 'track-1', name: 'Migration Song' }],
        },
      ],
    });
    expect(observed).toContain('Bearer spotify-app-token');
  });

  test('keeps control, playlist, and library requests on the resolved user client', async () => {
    const observed: string[] = [];
    const store = memoryStore();
    await storeAlias(store, 'mcp-user', 'spotify-user');
    const config = testConfig({
      AUTH_STRATEGY: 'oauth',
      AUTH_ENABLED: 'true',
      AUTH_DISCOVERY_URL: 'http://localhost:4000',
      OAUTH_SCOPES: 'user-read-playback-state',
    });
    const runtime = createRuntime({
      config,
      store,
      spotifyFetch: spotifyMock(observed),
    });
    const { client } = await connect(runtime, 'modern', 'mcp-user');

    const [control, playlists, library] = await Promise.all([
      client.callTool({
        name: 'spotify_control',
        arguments: { operations: [{ action: 'pause' }] },
      }),
      client.callTool({
        name: 'spotify_playlist',
        arguments: { action: 'list_user' },
      }),
      client.callTool({
        name: 'spotify_library',
        arguments: { action: 'tracks_contains', ids: ['track-1'] },
      }),
    ]);
    expect(control.structuredContent).toMatchObject({
      summary: { ok: 1, failed: 0 },
    });
    expect(playlists.structuredContent).toMatchObject({
      ok: true,
      action: 'list_user',
    });
    expect(library.structuredContent).toMatchObject({
      ok: true,
      action: 'tracks_contains',
    });
    expect(observed.every((header) => header === 'Bearer spotify-user')).toBe(true);
  });
});
