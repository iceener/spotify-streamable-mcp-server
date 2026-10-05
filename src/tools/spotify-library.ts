import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { defineTool } from '../platform/primitives';
import type { Deps } from '../server';
import { spotifyCall } from '../services/spotify';
import {
  SavedTracksResponseCodec,
  TrackCodec,
  type TrackCodecType,
  toSlimTrack,
} from '../services/spotify-codecs';
import { type SpotifyLibraryInput, SpotifyLibraryInputSchema } from './shared/inputs';
import { SpotifyLibraryOutputObject } from './shared/outputs';
import { describeFailure, endpoint, spotifyFor, textContent } from './shared/spotify';

type Method = 'GET' | 'PUT' | 'DELETE';

/** Tracks listed in the text the model reads; all of them are in the result. */
const PREVIEW_ITEMS = 20;

function fail(message: string, code: string | undefined, action: string) {
  const structured: SpotifyLibraryOutputObject = { ok: false, action, error: message, code };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
    structuredContent: structured,
  };
}

const call = <T = unknown>(client: SpotifyApi, method: Method, path: string, body?: unknown) =>
  spotifyCall(() => client.makeRequest<T>(method, path, body));

/** Name and URI of up to 50 tracks, for a message. */
async function describeTracks(
  client: SpotifyApi,
  ids: string[],
): Promise<Array<{ name: string; uri?: string | undefined }>> {
  try {
    const unique = [...new Set(ids)].slice(0, 50);
    if (unique.length === 0) return [];
    const params = new URLSearchParams({ ids: unique.join(',') });
    const response = await call<{ tracks?: unknown[] }>(client, 'GET', endpoint('tracks', params));
    return (Array.isArray(response?.tracks) ? response.tracks : []).flatMap((track) => {
      const parsed = TrackCodec.safeParse(track);
      if (!parsed.success) return [];
      const slim = toSlimTrack(parsed.data);
      return [{ name: slim.name, uri: slim.uri }];
    });
  } catch {
    return [];
  }
}

/** `:\n- A — uri\n…` or `.` */
function trackList(tracks: Array<{ name: string; uri?: string | undefined }>): string {
  if (tracks.length === 0) return '.';
  const preview = tracks
    .slice(0, 5)
    .map((track) => `- ${track.name}${track.uri ? ` — ${track.uri}` : ''}`)
    .join('\n');
  return `:\n${preview}${tracks.length > 5 ? '\n…' : ''}`;
}

export const spotifyLibrary = defineTool(
  'spotify_library',
  {
    title: 'Library: Saved Songs',
    description:
      'Manage saved songs: list, add, remove, and check if songs are saved for the current user.',
    inputSchema: SpotifyLibraryInputSchema,
    outputSchema: SpotifyLibraryOutputObject,
    annotations: { title: 'Library: Saved Songs', readOnlyHint: false, openWorldHint: true },
  },
  async (args, ctx, deps) => {
    try {
      const client = spotifyFor(ctx, deps);
      if (!client) return fail('Not signed in. Please authenticate.', 'unauthorized', args.action);
      return await run(client, args, deps);
    } catch (error) {
      deps.logger.warning('Spotify request failed', { tool: 'spotify_library', error });
      const { message, code } = describeFailure(error);
      return fail(message, code, 'unknown');
    }
  },
);

async function run(client: SpotifyApi, args: SpotifyLibraryInput, deps: Deps) {
  const ok = (data: unknown, message: string) => {
    const structured: SpotifyLibraryOutputObject = {
      ok: true,
      action: args.action,
      _msg: message,
      data,
    };
    return { content: textContent(deps, message, structured), structuredContent: structured };
  };
  if (args.action !== 'tracks_get' && (!args.ids || args.ids.length === 0)) {
    return fail(`ids are required for ${args.action}`, 'invalid_arguments', args.action);
  }
  const ids = args.ids ?? [];

  switch (args.action) {
    case 'tracks_get': {
      const params = new URLSearchParams();
      if (args.market) params.set('market', args.market);
      if (typeof args.limit === 'number') params.set('limit', String(args.limit));
      if (typeof args.offset === 'number') params.set('offset', String(args.offset));
      const response = SavedTracksResponseCodec.parse(
        await call(client, 'GET', endpoint('me/tracks', params)),
      );
      const tracks = (Array.isArray(response.items) ? response.items : [])
        .map((item) => item.track)
        .filter((track): track is TrackCodecType => !!track)
        .map(toSlimTrack);
      const lines = tracks
        .slice(0, PREVIEW_ITEMS)
        .map((track) => `- ${track.name} — ${track.uri}`)
        .join('\n');
      const more =
        tracks.length > PREVIEW_ITEMS ? `\n… and ${tracks.length - PREVIEW_ITEMS} more` : '';
      return ok(
        {
          limit: Number(response.limit ?? args.limit ?? 0) || tracks.length,
          offset: Number(response.offset ?? args.offset ?? 0) || 0,
          total: Number(response.total ?? tracks.length) || tracks.length,
          items: tracks,
        },
        tracks.length > 0
          ? `Loaded ${tracks.length} saved track(s):\n${lines}${more}`
          : `Loaded 0 saved track(s).`,
      );
    }
    case 'tracks_add': {
      await call(client, 'PUT', 'me/tracks', { ids });
      const noun = ids.length === 1 ? 'track' : 'tracks';
      return ok(
        { saved: ids.length, ids },
        `Saved ${ids.length} ${noun}${trackList(await describeTracks(client, ids))}`,
      );
    }
    case 'tracks_remove': {
      await call(client, 'DELETE', 'me/tracks', { ids });
      const noun = ids.length === 1 ? 'track' : 'tracks';
      return ok(
        { removed: ids.length, ids },
        `Removed ${ids.length} ${noun}${trackList(await describeTracks(client, ids))}`,
      );
    }
    case 'tracks_contains': {
      const params = new URLSearchParams({ ids: ids.join(',') });
      const contains = (await call(
        client,
        'GET',
        endpoint('me/tracks/contains', params),
      )) as boolean[];
      const saved = ids.filter((_, index) => contains[index]);
      const described = saved.length > 0 ? await describeTracks(client, saved) : [];
      const preview = described
        .slice(0, 5)
        .map((track) => `${track.name}${track.uri ? ` — ${track.uri}` : ''}`)
        .join(', ');
      const detail = described.length
        ? ` Saved: ${preview}${described.length > 5 ? ', …' : ''}`
        : '';
      return ok(
        { ids, contains },
        `Already saved: ${contains.filter(Boolean).length}/${ids.length}.${detail}`,
      );
    }
  }
}
