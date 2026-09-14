import { describe, expect, test } from 'bun:test';
import { SpotifyControlInputSchema } from '../src/schemas/inputs.js';
import { SpotifyControlBatchOutput } from '../src/schemas/outputs.js';
import { getSpotifyUserClient } from '../src/services/spotify/sdk.js';
import { verifyPlayback } from '../src/shared/tools/playback-verification.js';
import { spotifyControlTool } from '../src/shared/tools/spotify-control.js';
import type { ToolContext } from '../src/shared/tools/types.js';

const deviceId = '8fc48c51d766ea0b3e3badb484996070749c1c91';
const browserId = '77e6f4ef-browser';
const trackUri = 'spotify:track:5ViijhC2983J1B8Bo1wbbo';
const otherTrack = 'spotify:track:other';
const desktop = {
  id: deviceId,
  name: 'MacBook Pro',
  type: 'Computer',
  is_active: true,
};
const browser = {
  id: browserId,
  name: 'Web Player (Firefox)',
  type: 'Computer',
  is_active: true,
};
const playing = {
  is_playing: true,
  item: { uri: trackUri, name: 'Pretoria' },
  progress_ms: 0,
  device: { id: deviceId },
};
const paused = { ...playing, is_playing: false, item: null };
const play = { action: 'play', device_id: deviceId, uris: [trackUri] };

function fixture(
  options: {
    states?: unknown[];
    devices?: unknown[];
    writeResponse?: () => Response;
    onWrite?: (url: URL, body: unknown) => void;
  } = {},
) {
  let reads = 0;
  const requests: { method: string; url: URL; body: unknown }[] = [];
  const states = options.states ?? [playing];
  const fetchMock: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ method, url, body });
      if (method !== 'GET') {
        options.onWrite?.(url, body);
        return options.writeResponse?.() ?? new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith('/devices')) {
        return Response.json({ devices: options.devices ?? [desktop] });
      }
      if (url.pathname.endsWith('/me/player')) {
        const state = states[Math.min(reads++, states.length - 1)];
        if (state instanceof Error) throw state;
        if (state instanceof Response) return state.clone();
        return state === null
          ? new Response(null, { status: 204 })
          : Response.json(state);
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );
  const context: ToolContext = {
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
  return { context, requests, reads: () => reads };
}

async function control(
  f: ReturnType<typeof fixture>,
  operations: unknown[],
  parallel = false,
) {
  const result = await spotifyControlTool.handler(
    SpotifyControlInputSchema.parse({ operations, parallel }),
    f.context,
  );
  return { result, output: SpotifyControlBatchOutput.parse(result.structuredContent) };
}

async function verify(f: ReturnType<typeof fixture>, operation: unknown = play) {
  const client = await getSpotifyUserClient(f.context);
  if (!client) throw new Error('Missing fixture client');
  const [op] = SpotifyControlInputSchema.parse({ operations: [operation] }).operations;
  if (!op) throw new Error('Missing fixture operation');
  let waits = 0;
  const result = await verifyPlayback(client, op, async () => {
    waits++;
  });
  return { result, waits };
}

describe('playback verification', () => {
  test('204 play with an active but paused/empty device is not successful playback', async () => {
    const f = fixture({ states: [paused] });
    const { result, output } = await control(f, [play]);
    expect(result.isError).toBe(true);
    expect(output.results[0]?.ok).toBe(false);
    expect(output.summary).toEqual({ ok: 0, failed: 1 });
    expect(output._msg).not.toContain('Successful: play');
    expect(output.results[0]?.error).toContain('not confirmed');
    expect(output.results[0]?.note).toContain('open Spotify');
    expect(f.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(f.reads()).toBe(5); // bounded verification; failure already carries status
  });

  test('a paused Firefox with the requested track is not verified as playing', async () => {
    const f = fixture({
      devices: [browser],
      states: [{ ...playing, is_playing: false, device: { id: browserId } }],
    });
    const { result, output } = await control(f, [{ action: 'play', uris: [trackUri] }]);
    expect(result.isError).toBe(true);
    expect(output.results[0]?.error).toContain('Playback is paused');
    expect(output._msg).not.toContain('Track verified');
    expect(output._msg).not.toContain('Successful: play');
    expect(
      f.requests.find((r) => r.method === 'PUT')?.url.searchParams.get('device_id'),
    ).toBe(browserId);
  });

  for (const [label, state, expected] of [
    ['missing state (204)', null, 'No playback state'],
    [
      'missing is_playing',
      { ...playing, is_playing: undefined },
      'Playback state unknown',
    ],
    ['playing without an item', { ...playing, item: null }, 'No current track'],
    [
      'wrong track',
      { ...playing, item: { uri: otherTrack } },
      'Requested track not observed',
    ],
    [
      'wrong device',
      { ...playing, device: { id: browserId } },
      'Target device not confirmed',
    ],
    [
      'null device id',
      { ...playing, device: { id: null } },
      'No playback device identified',
    ],
  ] as const) {
    test(`does not confirm ${label}; reads are bounded and never replay writes`, async () => {
      const f = fixture({ states: [state] });
      const { result, waits } = await verify(f);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(expected);
      expect(f.reads()).toBe(5);
      expect(waits).toBe(4);
      expect(f.requests.every((r) => r.method === 'GET')).toBe(true);
    });
  }

  test('delayed playback requires all conditions on the same state response', async () => {
    const f = fixture({
      states: [paused, { ...playing, device: { id: browserId } }, playing],
    });
    const { result, waits } = await verify(f);
    expect(result.ok).toBe(true);
    expect(result.device_id).toBe(deviceId);
    expect(f.reads()).toBe(3);
    expect(waits).toBe(2);
  });

  test('resume and context play wait for actual playback, not just a matching item', async () => {
    const f = fixture({ states: [{ ...playing, is_playing: false }, playing] });
    expect((await verify(f, { action: 'play' })).result.ok).toBe(true);
    expect(f.reads()).toBe(2);
    const context = { ...play, uris: undefined, context_uri: 'spotify:album:album' };
    expect((await verify(fixture(), context)).result.ok).toBe(false);
    expect(
      (
        await verify(
          fixture({ states: [{ ...playing, context: { uri: context.context_uri } }] }),
          context,
        )
      ).result.ok,
    ).toBe(true);
  });

  test('matches explicit URI/position offsets and relinked tracks', async () => {
    const context = {
      action: 'play',
      context_uri: 'spotify:playlist:list',
      offset: { uri: ` ${trackUri} ` },
    };
    const state = { ...playing, context: { uri: context.context_uri } };
    expect((await verify(fixture({ states: [state] }), context)).result.ok).toBe(true);
    expect(
      (
        await verify(fixture(), {
          ...play,
          uris: [otherTrack, trackUri],
          offset: { position: 1 },
        })
      ).result.ok,
    ).toBe(true);
    expect(
      (await verify(fixture(), { ...play, uris: [otherTrack, trackUri] })).result.ok,
    ).toBe(false);
    expect(
      (
        await verify(
          fixture({
            states: [
              { ...playing, item: { uri: otherTrack, linked_from: { uri: trackUri } } },
            ],
          }),
        )
      ).result.ok,
    ).toBe(true);
  });

  test('transfer without play can confirm a paused device, but transfer_play=true cannot', async () => {
    const transfer = { action: 'transfer', device_id: deviceId };
    const { output } = await control(fixture({ states: [paused] }), [transfer]);
    expect(output.results[0]?.ok).toBe(true);
    expect(output.results[0]?.note).toContain('did not request playback');
    expect(
      (
        await verify(fixture({ states: [paused] }), {
          ...transfer,
          transfer_play: true,
        })
      ).result.ok,
    ).toBe(false);
    expect(
      (
        await verify(
          fixture({ states: [{ ...paused, device: { id: browserId } }] }),
          transfer,
        )
      ).result.ok,
    ).toBe(false);
  });

  test('transfer+play with a persistent paused target is an MCP error', async () => {
    const f = fixture({ states: [paused] });
    const { result, output } = await control(f, [
      { action: 'transfer', device_id: deviceId, transfer_play: true },
    ]);
    expect(result.isError).toBe(true);
    expect(output.summary).toEqual({ ok: 0, failed: 1 });
    expect(output.results[0]?.error).toContain('Playback is paused');
    expect(f.requests.find((r) => r.method === 'PUT')?.body).toEqual({
      device_ids: [deviceId],
      play: true,
    });
  });

  for (const [status, code] of [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
  ] as const) {
    test(`verification HTTP ${status} is not swallowed or repeatedly polled`, async () => {
      const f = fixture({
        states: [Response.json({ error: 'provider read failure' }, { status })],
      });
      const { result, output } = await control(f, [play]);
      expect(result.isError).toBe(true);
      expect(output.results[0]?.code).toBe(code);
      expect(output.results[0]?.error).toContain('Spotify accepted play');
      expect(output.results[0]?.error).toContain('read failed');
      expect(output.results[0]?.note).toBeTruthy();
      expect(f.reads()).toBe(1); // no retries or redundant final status read
    });

    test(`write HTTP ${status} remains an explicit provider error`, async () => {
      const f = fixture({
        writeResponse: () =>
          Response.json({ error: 'provider write failure' }, { status }),
      });
      const { result, output } = await control(f, [play]);
      expect(result.isError).toBe(true);
      expect(output.results[0]?.code).toBe(code);
      expect(output.results[0]?.error).not.toContain('accepted');
      expect(output.results[0]?.note).toBeTruthy();
    });
  }

  test('malformed and network-failed state reads remain unconfirmed', async () => {
    for (const state of [
      new Error('network offline'),
      Response.json({ is_playing: 'invalid' }),
      new Response('not json'),
    ]) {
      const { result } = await verify(fixture({ states: [state] }));
      expect(result.ok).toBe(false);
      expect(result.code).toBe('bad_response');
    }
  });

  test('no active device error keeps its actionable next step', async () => {
    const f = fixture({
      writeResponse: () =>
        Response.json(
          { error: { message: 'No active device found' } },
          { status: 404 },
        ),
    });
    const { output } = await control(f, [play]);
    expect(output.results[0]?.ok).toBe(false);
    expect(output.results[0]?.note).toContain('open Spotify');
  });
});

describe('targeting and batch semantics', () => {
  test('omitted device prefers active desktop Computer over a Web Player reporting Computer', async () => {
    const f = fixture({ devices: [browser, desktop] });
    const { output } = await control(f, [{ action: 'play', uris: [trackUri] }]);
    expect(output.results[0]).toMatchObject({ ok: true, device_id: deviceId });
    expect(
      f.requests.find((r) => r.method === 'PUT')?.url.searchParams.get('device_id'),
    ).toBe(deviceId);
  });

  test('explicit browser target is respected, and inactive desktops are not silently activated', async () => {
    for (const explicit of [true, false]) {
      const f = fixture({
        devices: [browser, { ...desktop, is_active: explicit }],
        states: [{ ...playing, device: { id: browserId } }],
      });
      const { output } = await control(f, [
        { ...play, device_id: explicit ? browserId : undefined },
      ]);
      expect(output.results[0]).toMatchObject({ ok: true, device_id: browserId });
      expect(
        f.requests.find((r) => r.method === 'PUT')?.url.searchParams.get('device_id'),
      ).toBe(browserId);
    }
  });

  test('transfer then play waits for the transfer target before sending play', async () => {
    const f = fixture({
      states: [{ ...paused, device: { id: browserId } }, paused, playing],
    });
    const { output } = await control(f, [
      { action: 'transfer', device_id: deviceId },
      play,
    ]);
    expect(output.summary).toEqual({ ok: 2, failed: 0 });
    const paths = f.requests
      .filter((r) => !r.url.pathname.endsWith('/devices'))
      .map((r) => `${r.method} ${r.url.pathname}`);
    expect(paths.slice(0, 5)).toEqual([
      'PUT /v1/me/player',
      'GET /v1/me/player',
      'GET /v1/me/player',
      'PUT /v1/me/player/play',
      'GET /v1/me/player',
    ]);
  });

  test('successful play reports the same snapshot that verified playback', async () => {
    const f = fixture({ states: [playing, paused] });
    const { result, output } = await control(f, [play]);
    expect(result.isError).toBe(false);
    expect(output._msg).toContain('Now playing');
    expect(f.reads()).toBe(1);
    expect(output.results[0]).not.toHaveProperty('playbackState');
  });

  test('play then pause verifies each play before the intentional final pause', async () => {
    const { result, output } = await control(fixture({ states: [playing, paused] }), [
      play,
      { action: 'pause' },
    ]);
    expect(result.isError).toBe(false);
    expect(output.summary).toEqual({ ok: 2, failed: 0 });
    expect(output._msg).toContain('Playback is paused');
    expect(output._msg).not.toContain('Now playing the requested track');
  });

  test('conflicting parallel playback is rejected before any side effect', async () => {
    const f = fixture();
    const { result, output } = await control(
      f,
      [{ action: 'transfer', device_id: deviceId }, play],
      true,
    );
    expect(result.isError).toBe(true);
    expect(output._msg).toContain('parallel=false');
    expect(f.requests).toHaveLength(0);
  });

  test('nonconflicting parallel operations and mixed failures retain per-operation results', async () => {
    const { output } = await control(
      fixture(),
      [play, { action: 'volume', volume_percent: 40 }, { action: 'queue' }],
      true,
    );
    expect(output.summary).toEqual({ ok: 2, failed: 1 });
    expect(output.results.map((r) => [r.index, r.action, r.ok])).toEqual([
      [0, 'play', true],
      [1, 'volume', true],
      [2, 'queue', false],
    ]);
  });
});
