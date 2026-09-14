import { expect, test } from 'bun:test';
import { SpotifyControlInputSchema } from '../src/schemas/inputs.js';
import { SpotifyControlBatchOutput } from '../src/schemas/outputs.js';
import { spotifyControlTool } from '../src/shared/tools/spotify-control.js';
import type { ToolContext } from '../src/shared/tools/types.js';

const deviceId = '8fc48c51d766ea0b3e3badb484996070749c1c91';
const trackUri = 'spotify:track:5ViijhC2983J1B8Bo1wbbo';

function pausedContext(): ToolContext {
  const fetchMock: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (init?.method === 'PUT') return new Response(null, { status: 204 });
      if (url.pathname.endsWith('/devices')) {
        return Response.json({
          devices: [
            { id: deviceId, name: 'MacBook Pro', type: 'Computer', is_active: true },
          ],
        });
      }
      return Response.json({
        is_playing: false,
        item: null,
        progress_ms: 0,
        device: { id: deviceId },
      });
    },
    { preconnect: fetch.preconnect },
  );
  return {
    requestId: 'play-paused-regression',
    runtimeName: 'test',
    signal: new AbortController().signal,
    authStrategy: 'oauth',
    spotifyAccessToken: 'test-token',
    spotify: {
      clientId: 'test-client',
      apiUrl: 'https://api.spotify.com/v1',
      accountsUrl: 'https://accounts.spotify.com',
      includeJsonInContent: true,
      fetch: fetchMock,
    },
  };
}

test('204 play with an active but paused/empty device is not successful playback', async () => {
  const result = await spotifyControlTool.handler(
    SpotifyControlInputSchema.parse({
      operations: [{ action: 'play', device_id: deviceId, uris: [trackUri] }],
    }),
    pausedContext(),
  );
  const output = SpotifyControlBatchOutput.parse(result.structuredContent);
  expect(result.isError).toBe(true);
  expect(output.results[0]?.ok).toBe(false);
  expect(output.summary).toEqual({ ok: 0, failed: 1 });
  expect(output._msg).not.toContain('Successful: play');
  expect(output.results[0]?.error).toContain('not confirmed');
  expect(output.results[0]?.note).toContain('open Spotify');
});
