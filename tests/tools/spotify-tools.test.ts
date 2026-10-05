import { afterEach, describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { tools } from '../../src/tools';
import { SpotifyPlaylistInputSchema } from '../../src/tools/shared/inputs';
import {
  cleanup,
  connect,
  type FetchRoute,
  fakeFetch,
  signedIn,
  testConfig,
  testDeps,
  testSpotify,
  textOf,
  track,
} from '../helpers';
import {
  codeFor,
  loopback,
  ORIGIN,
  proxyFixture,
  redeem,
  registerNative,
  spotifyTokens,
} from '../oauth/fixture';

afterEach(cleanup);

const track1 = {
  id: 'track-1',
  uri: 'spotify:track:track-1',
  name: 'Migration Song',
  artists: [{ name: 'Artist' }],
  album: { name: 'Album' },
  duration_ms: 1000,
};

/** The Spotify Web API, answering like the real one for the calls the tools make. */
function spotifyApi(observed: string[] = []): FetchRoute {
  return async (request) => {
    const url = new URL(request.url);
    const authorization = request.headers.get('authorization') ?? '';
    if (url.href === 'https://accounts.spotify.com/api/token') {
      observed.push(`${authorization} ${await request.text()}`);
      return Response.json({ access_token: 'spotify-app-token', expires_in: 3600 });
    }
    if (url.origin !== 'https://api.spotify.com') return undefined;
    observed.push(authorization);
    const user = authorization.replace('Bearer ', '');
    switch (`${request.method} ${url.pathname}`) {
      case 'GET /v1/me/player':
        return Response.json({ is_playing: false, device: { id: `device-${user}` } });
      case 'GET /v1/me/player/devices':
        return Response.json({
          devices: [{ id: `device-${user}`, name: 'Mac', type: 'Computer', is_active: true }],
        });
      case 'GET /v1/me/player/currently-playing':
        return new Response(null, { status: 204 });
      case 'PUT /v1/me/player/pause':
        return new Response(null, { status: 204 });
      case 'GET /v1/search':
        return Response.json({ tracks: { total: 1, items: [track1] } });
      case 'GET /v1/me/playlists':
        return Response.json({
          items: [{ id: 'p1', name: 'Mix', uri: 'spotify:playlist:p1' }],
          limit: 20,
          offset: 0,
          total: 1,
        });
      case 'GET /v1/playlists/p1/tracks':
        return Response.json({
          items: [{ track: track1 }, { track: null }, { track: { ...track1, id: 'track-2' } }],
          offset: 10,
          total: 12,
        });
      case 'GET /v1/playlists/p1':
        return Response.json({ id: 'p1', name: 'Mix', uri: 'spotify:playlist:p1' });
      case 'GET /v1/me/tracks/contains':
        return Response.json([true]);
      case 'GET /v1/tracks':
        return Response.json({ tracks: [track1] });
    }
    return undefined;
  };
}

/** A client for one Spotify token, with Spotify answered by `route`. */
async function spotifyCaller(route: FetchRoute, spotifyToken = 'spotify-user') {
  const fetch = fakeFetch(route);
  const deps = testDeps({ spotify: testSpotify(fetch) });
  return { client: await connect({ deps, authInfo: signedIn(spotifyToken) }), fetch };
}

function argumentsFor(name: string): Record<string, unknown> {
  switch (name) {
    case 'search_catalog':
      return { queries: ['q'], types: ['track'] };
    case 'spotify_control':
      return { operations: [{ action: 'pause' }] };
    case 'spotify_playlist':
      return { action: 'list_user' };
    case 'spotify_library':
      return { action: 'tracks_get' };
    default:
      return {};
  }
}

describe('every user tool', () => {
  test('asks the user to sign in when there is no Spotify token, and calls nothing', async () => {
    const fetch = fakeFetch();
    const client = await connect({ deps: testDeps({ spotify: testSpotify(fetch) }) });
    for (const tool of tools.filter((tool) => tool.name !== 'search_catalog')) {
      const result = await client.callTool({ name: tool.name, arguments: argumentsFor(tool.name) });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain('unauthorized');
    }
    expect(fetch.requests).toHaveLength(0);
  });
});

describe('through the OAuth proxy, over HTTP', () => {
  async function signIn(f: ReturnType<typeof proxyFixture>): Promise<string> {
    const uri = loopback();
    const client = await registerNative(f, uri);
    const { code } = await codeFor(f, client.client_id, uri);
    return (
      (await (await redeem(f, client.client_id, uri, code)).json()) as { access_token: string }
    ).access_token;
  }

  async function mcpClient(
    f: ReturnType<typeof proxyFixture>,
    token: string,
    era: 'modern' | 'legacy' = 'modern',
  ): Promise<Client> {
    const client = new Client(
      { name: 'test', version: '1.0.0' },
      { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers);
          headers.set('Host', '127.0.0.1:3000');
          headers.set('Authorization', `Bearer ${token}`);
          const response = await f.app.fetch(new Request(String(url), { ...init, headers }));
          expect(response.headers.has('Mcp-Session-Id')).toBe(false);
          return response;
        },
      }),
    );
    return track(client);
  }

  for (const era of ['modern', 'legacy'] as const) {
    test(`${era}: a 204 play followed by a paused player is an MCP error`, async () => {
      const f = proxyFixture({
        api: (request) => {
          const url = new URL(request.url);
          if (request.method === 'PUT') return new Response(null, { status: 204 });
          if (url.pathname === '/v1/me/player') {
            return Response.json({
              is_playing: false,
              item: { uri: 'spotify:track:pretoria', name: 'Pretoria' },
              device: { id: 'desktop-device' },
            });
          }
          return undefined;
        },
      });
      const client = await mcpClient(f, await signIn(f), era);
      const result = await client.callTool({
        name: 'spotify_control',
        arguments: {
          operations: [
            { action: 'play', device_id: 'desktop-device', uris: ['spotify:track:pretoria'] },
          ],
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        results: [{ index: 0, action: 'play', ok: false, code: 'bad_response' }],
        summary: { ok: 0, failed: 1 },
      });
      expect(JSON.stringify(result.structuredContent)).toContain('Playback is paused');
      expect(JSON.stringify(result.structuredContent)).not.toContain('Successful: play');
    });
  }

  test("Spotify sees the user's Spotify token, never the MCP token", async () => {
    const observed: string[] = [];
    const f = proxyFixture({ api: spotifyApi(observed) });
    const token = await signIn(f);
    const client = await mcpClient(f, token);

    const [control, playlists, library] = await Promise.all([
      client.callTool({
        name: 'spotify_control',
        arguments: { operations: [{ action: 'pause' }] },
      }),
      client.callTool({ name: 'spotify_playlist', arguments: { action: 'list_user' } }),
      client.callTool({
        name: 'spotify_library',
        arguments: { action: 'tracks_contains', ids: ['track-1'] },
      }),
    ]);
    expect(control.structuredContent).toMatchObject({ summary: { ok: 1, failed: 0 } });
    expect(playlists.structuredContent).toMatchObject({ ok: true, action: 'list_user' });
    expect(library.structuredContent).toMatchObject({ ok: true, action: 'tracks_contains' });
    expect(observed.length).toBeGreaterThan(3);
    expect(observed.every((header) => header === 'Bearer spotify-access')).toBe(true);
    expect(observed.join()).not.toContain(token);
  });

  test('an expiring Spotify token is refreshed before the tool runs', async () => {
    const observed: string[] = [];
    const accounts = spotifyTokens((form) =>
      Response.json({
        access_token: form.get('grant_type') === 'refresh_token' ? 'spotify-fresh' : 'spotify-old',
        refresh_token: 'spotify-refresh',
        // The first token is already inside the one-minute refresh margin.
        expires_in: form.get('grant_type') === 'refresh_token' ? 3600 : 30,
        scope:
          'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read user-library-modify',
      }),
    );
    const f = proxyFixture({ accounts, api: spotifyApi(observed) });
    const client = await mcpClient(f, await signIn(f));
    await client.callTool({ name: 'player_status', arguments: { include: ['player'] } });
    expect(accounts.forms.map((form) => form.get('grant_type'))).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    // The player, then its device's name: both with the refreshed token.
    expect(observed).toEqual(['Bearer spotify-fresh', 'Bearer spotify-fresh']);
  });
});

describe('player_status', () => {
  test('concurrent callers each get their own player', async () => {
    const route = spotifyApi();
    const [alice, bob] = await Promise.all([
      spotifyCaller(route, 'alice'),
      spotifyCaller(route, 'bob'),
    ]);
    const [a, b] = await Promise.all([
      alice.client.callTool({ name: 'player_status', arguments: { include: ['player'] } }),
      bob.client.callTool({ name: 'player_status', arguments: { include: ['player'] } }),
    ]);
    expect(a.structuredContent).toMatchObject({ player: { device_id: 'device-alice' } });
    expect(b.structuredContent).toMatchObject({ player: { device_id: 'device-bob' } });
  });

  test('names the devices and tells the model what to do next', async () => {
    const { client } = await spotifyCaller(spotifyApi());
    const result = await client.callTool({ name: 'player_status', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(
      'No active playback. You can transfer to an available device and play.\n\nAvailable devices (use device_id for control):\n• Mac (Computer) [ACTIVE] → device_id: "device-spotify-user"',
    );
    expect(result.structuredContent).toMatchObject({
      player: { is_playing: false, device_id: 'device-spotify-user', context_uri: null },
      current_track: null,
      devicesById: { 'device-spotify-user': { name: 'Mac' } },
    });
  });

  test('a Spotify 401 asks the user to sign in again', async () => {
    const { client } = await spotifyCaller(() => new Response('{}', { status: 401 }));
    const result = await client.callTool({ name: 'player_status', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      action: 'status',
      error: 'Not authenticated. Please sign in to Spotify.',
      code: 'unauthorized',
    });
  });
});

describe('search_catalog', () => {
  test("runs with the server's client credentials, fetched once", async () => {
    const observed: string[] = [];
    const { client } = await spotifyCaller(spotifyApi(observed));
    for (let call = 0; call < 2; call++) {
      const result = await client.callTool({
        name: 'search_catalog',
        arguments: { queries: ['migration'], types: ['track'] },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        queries: ['migration'],
        limit: 20,
        offset: 0,
        batches: [{ query: 'migration', items: [{ id: 'track-1', name: 'Migration Song' }] }],
      });
      expect(textOf(result)).toBe(
        'Results for "migration":\n- [track] Migration Song — spotify:track:track-1',
      );
    }
    expect(observed).toEqual([
      `Basic ${btoa('spotify-client:spotify-secret')} grant_type=client_credentials&scope=`,
      'Bearer spotify-app-token',
      'Bearer spotify-app-token',
    ]);
  });

  test('a refused app token is told to the model', async () => {
    const { client } = await spotifyCaller(() => new Response('{}', { status: 400 }));
    const result = await client.callTool({
      name: 'search_catalog',
      arguments: { queries: ['q'], types: ['track'] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Search failed: Failed to get access token.');
  });

  test('a 401 from search names the app credentials', async () => {
    const { client } = await spotifyCaller((request) =>
      new URL(request.url).pathname === '/api/token'
        ? Response.json({ access_token: 'app', expires_in: 3600 })
        : new Response('{}', { status: 401 }),
    );
    const result = await client.callTool({
      name: 'search_catalog',
      arguments: { queries: ['q'], types: ['track'] },
    });
    expect(textOf(result)).toBe(
      'Authorization failed for app credentials. Check SPOTIFY_CLIENT_ID/SECRET.',
    );
  });
});

describe('spotify_playlist and spotify_library', () => {
  test('playlist items keep their positions for play with an offset', async () => {
    const { client } = await spotifyCaller(spotifyApi());
    const result = await client.callTool({
      name: 'spotify_playlist',
      arguments: { action: 'items', playlist_id: 'p1', offset: 10 },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        playlist_uri: 'spotify:playlist:p1',
        offset: 10,
        items: [
          { id: 'track-1', position: 10 },
          { id: 'track-2', position: 12 },
        ],
      },
    });
    expect(textOf(result)).toStartWith(
      "Loaded 2 items from 'Mix' (context: spotify:playlist:p1).\n- #10 Migration Song",
    );
  });

  test('missing arguments are refused before Spotify is called', async () => {
    const { client, fetch } = await spotifyCaller(spotifyApi());
    const playlist = await client.callTool({
      name: 'spotify_playlist',
      arguments: { action: 'items' },
    });
    expect(playlist.structuredContent).toEqual({
      ok: false,
      action: 'items',
      error: 'playlist_id is required for items',
      code: 'invalid_arguments',
    });
    const library = await client.callTool({
      name: 'spotify_library',
      arguments: { action: 'tracks_add' },
    });
    expect(library.structuredContent).toMatchObject({
      ok: false,
      error: 'ids are required for tracks_add',
    });
    expect(fetch.requests).toHaveLength(0);
  });

  test('library contains names the saved tracks; with JSON content when configured', async () => {
    const fetch = fakeFetch(spotifyApi());
    const deps = testDeps({
      config: testConfig({ SPOTIFY_INCLUDE_JSON_IN_CONTENT: 'true' }),
      spotify: testSpotify(fetch),
    });
    const client = await connect({ deps, authInfo: signedIn('spotify-user') });
    const result = await client.callTool({
      name: 'spotify_library',
      arguments: { action: 'tracks_contains', ids: ['track-1'] },
    });
    expect(textOf(result)).toBe(
      'Already saved: 1/1. Saved: Migration Song — spotify:track:track-1',
    );
    expect((result.content as Array<{ text: string }>)[1]?.text).toBe(
      JSON.stringify(result.structuredContent),
    );
  });

  test('unknown keys in nested playlist input are dropped, not refused', () => {
    expect(
      SpotifyPlaylistInputSchema.safeParse({
        action: 'remove_items',
        playlist_id: 'playlist',
        tracks: [{ uri: 'spotify:track:track', futureTrackOption: true }],
        futurePlaylistOption: true,
      }).success,
    ).toBe(true);
  });
});
