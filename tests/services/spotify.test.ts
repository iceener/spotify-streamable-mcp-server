import { describe, expect, test } from 'bun:test';
import { createSpotifyClients, errorCodeOf, spotifyCall } from '../../src/services/spotify';
import { searchCatalog } from '../../src/services/spotify-catalog';
import * as player from '../../src/services/spotify-player';
import { fakeFetch } from '../helpers';

describe('Spotify Web API clients', () => {
  test('player commands keep their method, URL, query and body', async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 204 }));
    const api = createSpotifyClients({ clientId: 'c', clientSecret: 's', fetch }).user(
      'user-token',
    );

    await player.play(api, {
      device_id: 'd1',
      context_uri: 'spotify:playlist:p',
      offset: { position: 2 },
      position_ms: 5,
    });
    await player.play(api, { uris: ['spotify:track:t'] });
    await player.pause(api, 'd1');
    await player.next(api, undefined);
    await player.previous(api, 'd1');
    await player.seek(api, 1000, 'd1');
    await player.shuffle(api, true, undefined);
    await player.repeat(api, 'track', 'd1');
    await player.volume(api, 140, 'd1');
    await player.transfer(api, 'd2', true);
    await player.queue(api, 'spotify:track:t', 'd1');

    const sent = await Promise.all(
      fetch.requests.map(async (request) => {
        const url = new URL(request.url);
        const body = await request.text();
        return `${request.method} ${url.pathname}${url.search} ${body}`.trim();
      }),
    );
    expect(sent).toEqual([
      // The SDK (1.2.0) sends `positionMs`, which Spotify ignores; it always has. Kept as is.
      'PUT /v1/me/player/play?device_id=d1 {"context_uri":"spotify:playlist:p","offset":{"position":2},"positionMs":5}',
      'PUT /v1/me/player/play {"uris":["spotify:track:t"]}',
      'PUT /v1/me/player/pause?device_id=d1',
      'POST /v1/me/player/next',
      'POST /v1/me/player/previous?device_id=d1',
      'PUT /v1/me/player/seek?position_ms=1000&device_id=d1',
      'PUT /v1/me/player/shuffle?state=true',
      'PUT /v1/me/player/repeat?state=track&device_id=d1',
      'PUT /v1/me/player/volume?volume_percent=100&device_id=d1',
      'PUT /v1/me/player {"device_ids":["d2"],"play":true}',
      'POST /v1/me/player/queue?uri=spotify%3Atrack%3At&device_id=d1',
    ]);
    for (const request of fetch.requests) {
      expect(request.headers.get('authorization')).toBe('Bearer user-token');
    }
  });

  test('a failed call keeps Spotify’s status and body, and gets a code', async () => {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [429, 'rate_limited'],
      [404, 'bad_response'],
      [502, 'bad_response'],
    ] as const) {
      const fetch = fakeFetch(() => Response.json({ error: { message: 'nope' } }, { status }));
      const api = createSpotifyClients({ clientId: 'c', clientSecret: 's', fetch }).user('t');
      const error = (await player.pause(api, undefined).catch((caught) => caught)) as Error & {
        status: number;
      };
      expect(error.status).toBe(status);
      expect(error.message).toStartWith(`Spotify request failed: ${status} `);
      expect(error.message).toContain('{"error":{"message":"nope"}}');
      expect(errorCodeOf(error)).toBe(code);
    }
  });

  test('a 204 reads as no player; other errors pass through unchanged', async () => {
    const empty = createSpotifyClients({
      clientId: 'c',
      clientSecret: 's',
      fetch: fakeFetch(() => new Response(null, { status: 204 })),
    }).user('t');
    expect(await player.getPlayerState(empty)).toBeNull();
    const offline = new Error('network offline');
    await expect(spotifyCall(() => Promise.reject(offline))).rejects.toBe(offline);
  });

  test('search uses the app token and reports a failure with its code', async () => {
    const fetch = fakeFetch((request) =>
      request.url.startsWith('https://accounts.spotify.com/')
        ? Response.json({ access_token: 'app', expires_in: 3600 })
        : new Response('{}', { status: 429 }),
    );
    const app = createSpotifyClients({ clientId: 'c', clientSecret: 's', fetch }).app();
    await expect(
      searchCatalog(app, { q: 'a b', types: ['track', 'album'], limit: 5, offset: 10 }),
    ).rejects.toThrow(/^Search failed: Spotify request failed: 429 .* \[rate_limited\]$/);
    expect(fetch.requests[1]?.url).toBe(
      'https://api.spotify.com/v1/search?q=a+b&type=track%2Calbum&limit=5&offset=10',
    );
    expect(fetch.requests[1]?.headers.get('authorization')).toBe('Bearer app');
  });

  test('the app client needs the server’s credentials', () => {
    expect(() => createSpotifyClients({ clientId: undefined, clientSecret: 's' }).app()).toThrow(
      'Spotify client credentials are not configured',
    );
  });

  test('the default fetch is called as a plain function, as Workers require', async () => {
    const original = globalThis.fetch;
    let receiver: unknown = 'unset';
    globalThis.fetch = Object.assign(
      function (this: unknown) {
        receiver = this;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
      { preconnect: original.preconnect },
    ) as typeof fetch;
    try {
      await player.pause(
        createSpotifyClients({ clientId: 'c', clientSecret: 's' }).user('t'),
        undefined,
      );
    } finally {
      globalThis.fetch = original;
    }
    expect(receiver).toBeUndefined();
  });
});
