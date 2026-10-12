import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { defineTool } from '../platform/primitives';
import { spotifyCall } from '../services/spotify';
import {
  MeResponseCodec,
  PlaylistDetailsResponseCodec,
  PlaylistListResponseCodec,
  PlaylistTracksResponseCodec,
  SnapshotResponseCodec,
  TrackCodec,
  toPlaylistDetails,
  toPlaylistSummary,
  toSlimTrack,
} from '../services/spotify-codecs';
import { type SpotifyPlaylistInput, SpotifyPlaylistInputSchema } from './shared/inputs';
import { SpotifyPlaylistOutputObject } from './shared/outputs';
import { describeFailure, endpoint, spotifyFor } from './shared/spotify';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Items listed in the text the model reads; all of them are in the result. */
const PREVIEW_ITEMS = 20;

function ok(action: string, data: unknown, message: string) {
  const structured: SpotifyPlaylistOutputObject = { ok: true, action, _msg: message, data };
  return { content: [{ type: 'text' as const, text: message }], structuredContent: structured };
}

function fail(message: string, code: string | undefined, action: string) {
  const structured: SpotifyPlaylistOutputObject = { ok: false, action, error: message, code };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
    structuredContent: structured,
  };
}

const call = <T = unknown>(client: SpotifyApi, method: Method, path: string, body?: unknown) =>
  spotifyCall(() => client.makeRequest<T>(method, path, body));

/** The playlist's name for a message, or `undefined` if it can't be read. */
async function playlistName(client: SpotifyApi, playlistId: string): Promise<string | undefined> {
  try {
    const playlist = PlaylistDetailsResponseCodec.parse(
      await call(client, 'GET', `playlists/${playlistId}`),
    );
    return String(playlist.name ?? '');
  } catch {
    return undefined;
  }
}

/** Names of up to 50 tracks given as `spotify:track:` URIs, for a message. */
async function trackNames(client: SpotifyApi, uris: string[]): Promise<string[]> {
  try {
    const ids = uris.map((uri) => /^spotify:track:(.+)$/.exec(uri)?.[1]).filter(Boolean);
    if (ids.length === 0) return [];
    const params = new URLSearchParams({ ids: ids.slice(0, 50).join(',') });
    const response = await call<{ tracks?: unknown[] }>(client, 'GET', endpoint('tracks', params));
    return (Array.isArray(response?.tracks) ? response.tracks : [])
      .map((track) => {
        const parsed = TrackCodec.safeParse(track);
        return parsed.success ? toSlimTrack(parsed.data).name : undefined;
      })
      .filter(Boolean) as string[];
  } catch {
    return [];
  }
}

/** `: A, B, C, D, E, …` or `.` */
function nameList(names: string[]): string {
  return names.length ? `: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}` : '.';
}

/** The playlist's track total, or `undefined` if it can't be read. */
async function playlistTotal(client: SpotifyApi, playlistId: string): Promise<number | undefined> {
  try {
    const playlist = PlaylistDetailsResponseCodec.parse(
      await call(client, 'GET', `playlists/${playlistId}`),
    );
    const total = Number(playlist.tracks?.total ?? Number.NaN);
    return Number.isFinite(total) ? total : undefined;
  } catch {
    return undefined;
  }
}

/**
 * URIs currently present in the playlist, paged with slim fields. Stops early once
 * every URI in `interested` has been located, so verification cost scales with the
 * requested tracks' positions, not with the playlist size.
 */
async function presentUris(
  client: SpotifyApi,
  playlistId: string,
  interested?: Set<string>,
): Promise<Set<string>> {
  const present = new Set<string>();
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      limit: '50',
      offset: String(offset),
      fields: 'items(track(uri)),total',
    });
    const page = PlaylistTracksResponseCodec.parse(
      await call(client, 'GET', endpoint(`playlists/${playlistId}/tracks`, params)),
    );
    const items = Array.isArray(page.items) ? page.items : [];
    for (const item of items) {
      const uri = (item.track as { uri?: string } | null | undefined)?.uri;
      if (uri) present.add(uri);
    }
    offset += items.length;
    const total = Number(page.total ?? 0) || 0;
    if (items.length === 0 || (total > 0 && offset >= total)) break;
    if (interested && [...interested].every((uri) => present.has(uri))) break;
  }
  return present;
}

export const spotifyPlaylist = defineTool(
  'spotify_playlist',
  {
    title: 'Playlists: Create, Edit, and Browse',
    description:
      "Manage playlists for the signed-in user: list your playlists, read one, list its items, create a new one, update details, add or remove items, and reorder items.\n\nNotes:\n- The 'items' action returns playlist tracks annotated with a zero-based 'position' and includes 'playlist_uri' so the model can start playback at an exact track using 'spotify_control' → action 'play' with { context_uri: playlist_uri, offset: { position } }.",
    inputSchema: SpotifyPlaylistInputSchema,
    outputSchema: SpotifyPlaylistOutputObject,
    annotations: {
      title: 'Playlists: Create, Edit, and Browse',
      readOnlyHint: false,
      openWorldHint: true,
    },
  },
  async (args, ctx, deps) => {
    try {
      const client = spotifyFor(ctx, deps);
      if (!client) return fail('Not signed in. Please authenticate.', 'unauthorized', args.action);
      return await run(client, args);
    } catch (error) {
      deps.logger.warning('Spotify request failed', { tool: 'spotify_playlist', error });
      const { message, code } = describeFailure(error);
      return fail(message, code, args.action || 'unknown');
    }
  },
);

async function run(client: SpotifyApi, args: SpotifyPlaylistInput) {
  const required = (field: string) =>
    fail(`${field} required for ${args.action}`, 'invalid_arguments', args.action);

  switch (args.action) {
    case 'list_user': {
      const params = new URLSearchParams();
      if (args.limit != null) params.set('limit', String(args.limit));
      if (args.offset != null) params.set('offset', String(args.offset));
      const response = PlaylistListResponseCodec.parse(
        await call(client, 'GET', endpoint('me/playlists', params)),
      );
      const playlists = (Array.isArray(response.items) ? response.items : []).map(
        toPlaylistSummary,
      );
      const lines = playlists
        .slice(0, PREVIEW_ITEMS)
        .map((playlist) => `- ${playlist.name}${playlist.uri ? ` — ${playlist.uri}` : ''}`)
        .join('\n');
      const more =
        playlists.length > PREVIEW_ITEMS ? `\n… and ${playlists.length - PREVIEW_ITEMS} more` : '';
      return ok(
        args.action,
        {
          limit: Number(response.limit ?? args.limit ?? 0) || playlists.length,
          offset: Number(response.offset ?? args.offset ?? 0) || 0,
          total: Number(response.total ?? playlists.length) || playlists.length,
          items: playlists,
        },
        playlists.length > 0
          ? `Found ${playlists.length} playlists:\n${lines}${more}`
          : 'Found 0 playlists.',
      );
    }
    case 'get': {
      if (!args.playlist_id) return required('playlist_id is');
      const params = new URLSearchParams();
      if (args.market) params.set('market', args.market);
      if (args.fields) params.set('fields', args.fields);
      const playlist = PlaylistDetailsResponseCodec.parse(
        await call(client, 'GET', endpoint(`playlists/${args.playlist_id}`, params)),
      );
      const name = String(playlist.name ?? 'playlist');
      const uri = String(playlist.uri ?? '');
      return ok(
        args.action,
        toPlaylistDetails(playlist),
        uri ? `Fetched playlist '${name}' — ${uri}.` : `Fetched playlist '${name}'.`,
      );
    }
    case 'items': {
      if (!args.playlist_id) return required('playlist_id is');
      const params = new URLSearchParams();
      if (args.market) params.set('market', args.market);
      if (typeof args.limit === 'number') params.set('limit', String(args.limit));
      if (typeof args.offset === 'number') params.set('offset', String(args.offset));
      if (args.fields) params.set('fields', args.fields);
      if (args.additional_types) params.set('additional_types', args.additional_types);
      const response = PlaylistTracksResponseCodec.parse(
        await call(client, 'GET', endpoint(`playlists/${args.playlist_id}/tracks`, params)),
      );
      const baseOffset = Number(response.offset ?? args.offset ?? 0) || 0;
      const playlistUri = `spotify:playlist:${args.playlist_id}`;
      // Each track keeps its position in the playlist, for play with an offset.
      const tracks = (Array.isArray(response.items) ? response.items : [])
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !!item?.track)
        .map(({ item, index }) => ({
          ...toSlimTrack(TrackCodec.parse(item.track)),
          position: baseOffset + index,
        }));
      const name = await playlistName(client, args.playlist_id);
      const label = name ? `'${name}'` : `playlist ${args.playlist_id}`;
      const lines = tracks
        .slice(0, PREVIEW_ITEMS)
        .map((track) => `- #${track.position} ${track.name}${track.uri ? ` — ${track.uri}` : ''}`)
        .join('\n');
      const more =
        tracks.length > PREVIEW_ITEMS ? `\n… and ${tracks.length - PREVIEW_ITEMS} more` : '';
      return ok(
        args.action,
        {
          playlist_id: args.playlist_id,
          playlist_uri: playlistUri,
          limit: Number(response.limit ?? args.limit ?? 0) || tracks.length,
          offset: baseOffset,
          total: Number(response.total ?? tracks.length) || tracks.length,
          items: tracks,
        },
        `Loaded ${tracks.length} items from ${label} (context: ${playlistUri}).` +
          (tracks.length > 0 ? `\n${lines}${more}` : ''),
      );
    }
    case 'create': {
      const me = MeResponseCodec.parse(await call(client, 'GET', 'me'));
      const userId = me?.id?.trim();
      if (!userId) return fail('Unable to determine current user id.', 'bad_response', args.action);
      const playlist = PlaylistDetailsResponseCodec.parse(
        await call(client, 'POST', `users/${userId}/playlists`, {
          name: args.name ?? 'New Playlist',
          description: args.description,
          public: args.public,
          collaborative: args.collaborative,
        }),
      );
      const name = String(playlist.name ?? 'playlist');
      const uri = String(playlist.uri ?? '');
      return ok(
        args.action,
        toPlaylistDetails(playlist),
        uri ? `Created playlist '${name}' — ${uri}.` : `Created playlist '${name}'.`,
      );
    }
    case 'update_details': {
      if (!args.playlist_id) return required('playlist_id is');
      await call(client, 'PUT', `playlists/${args.playlist_id}`, {
        name: args.name,
        description: args.description,
        public: args.public,
        collaborative: args.collaborative,
      });
      const updated: string[] = [];
      if (typeof args.name === 'string') updated.push(`name='${args.name}'`);
      if (typeof args.public === 'boolean') updated.push(`public=${args.public}`);
      if (typeof args.collaborative === 'boolean') {
        updated.push(`collaborative=${args.collaborative}`);
      }
      if (typeof args.description === 'string' && args.description.length > 0) {
        updated.push('description set');
      }
      const details = updated.length > 0 ? ` (${updated.join(', ')})` : '';
      return ok(args.action, { updated: true }, `Updated playlist details${details}.`);
    }
    case 'add_items': {
      if (!args.playlist_id) return required('playlist_id is');
      if (!args.uris || args.uris.length === 0) return required('uris are');
      // Capture the pre-add total so an under-applied add is visible.
      const totalBefore = await playlistTotal(client, args.playlist_id);
      const snapshot = SnapshotResponseCodec.parse(
        await call(client, 'POST', `playlists/${args.playlist_id}/tracks`, { uris: args.uris }),
      );
      const name = await playlistName(client, args.playlist_id);
      const names = await trackNames(client, args.uris);
      const totalAfter = await playlistTotal(client, args.playlist_id);
      const count = args.uris.length;
      const grown =
        totalBefore !== undefined && totalAfter !== undefined ? totalAfter - totalBefore : null;
      const underAdd = grown !== null ? count - grown : 0;
      const caveat =
        underAdd > 0 && grown !== null
          ? ` (warning: playlist total only grew by ${grown}, ${underAdd} missing — verify)`
          : '';
      return ok(
        args.action,
        {
          snapshot_id: snapshot?.snapshot_id,
          uris: args.uris,
          total_before: totalBefore ?? null,
          total_after: totalAfter ?? null,
        },
        `I've added ${count} ${count === 1 ? 'item' : 'items'} to ${name ? `'${name}'` : `playlist ${args.playlist_id}`}${nameList(names)}${caveat}`,
      );
    }
    case 'remove_items': {
      if (!args.playlist_id) return required('playlist_id is');
      if (!args.tracks || args.tracks.length === 0) return required('tracks are');
      // Spotify's positions parameter is unusable on this endpoint: with a
      // snapshot_id it silently removes nothing, without one it silently
      // removes every occurrence of the URI (both return 200; verified
      // empirically 2026-10-12). Refuse rather than pretend.
      if (args.tracks.some((track) => track.positions?.length)) {
        return fail(
          'position-scoped removal is not supported: Spotify ignores positions (no-op with snapshot_id, remove-all-occurrences without). Send { uri } only; use reorder_items to rearrange.',
          'unsupported_operation',
          args.action,
        );
      }
      // Spotify can partially apply a delete and still return 200
      // (observed 2026-10-12: 63 of 68 URIs removed, 5 silently kept),
      // and it silently ignores URIs that were never in the playlist.
      // Snapshot before and after so the result reports what actually
      // happened: removed / still-present / not-found.
      const requested = [...new Set(args.tracks.map((track) => track.uri))];
      const requestedSet = new Set(requested);
      let presentBefore: Set<string> | null = null;
      try {
        presentBefore = await presentUris(client, args.playlist_id, requestedSet);
      } catch {
        /* advisory; must not block removal */
      }
      const snapshot = SnapshotResponseCodec.parse(
        await call(client, 'DELETE', `playlists/${args.playlist_id}/tracks`, {
          tracks: args.tracks,
          snapshot_id: args.snapshot_id,
        }),
      );
      let snapshotId = snapshot?.snapshot_id;
      let survivors: string[] = [];
      let verified = true;
      try {
        let present = await presentUris(client, args.playlist_id, requestedSet);
        const scope = presentBefore ? requested.filter((uri) => presentBefore.has(uri)) : requested;
        survivors = scope.filter((uri) => present.has(uri));
        if (survivors.length > 0) {
          try {
            const retry = SnapshotResponseCodec.safeParse(
              await call(client, 'DELETE', `playlists/${args.playlist_id}/tracks`, {
                tracks: survivors.map((uri) => ({ uri })),
              }),
            );
            if (retry.success && retry.data?.snapshot_id) snapshotId = retry.data.snapshot_id;
          } catch {
            /* a failed retry must not abort verification */
          }
          present = await presentUris(client, args.playlist_id, new Set(survivors));
          survivors = scope.filter((uri) => present.has(uri));
        }
      } catch {
        verified = false;
      }
      const notFound = presentBefore ? requested.filter((uri) => !presentBefore.has(uri)) : [];
      const survivorSet = new Set(survivors);
      const removed =
        verified && presentBefore
          ? requested.filter((uri) => presentBefore.has(uri) && !survivorSet.has(uri))
          : requested.filter((uri) => !survivorSet.has(uri));
      const removedSet = new Set(removed);
      const names = await trackNames(
        client,
        args.tracks.filter((track) => removedSet.has(track.uri)).map((track) => track.uri),
      );
      const count = removed.length;
      const name = await playlistName(client, args.playlist_id);
      const label = name ? `'${name}'` : `playlist ${args.playlist_id}`;
      const notes: string[] = [];
      if (survivors.length > 0) {
        notes.push(`${survivors.length} still present${verified ? ' after retry' : ''}`);
      }
      if (notFound.length > 0) notes.push(`${notFound.length} not found in playlist`);
      if (!verified) notes.push('result unverified');
      const partial = notes.length > 0 ? ` (${notes.join(', ')})` : '';
      const message = verified
        ? `I've removed ${count} ${count === 1 ? 'item' : 'items'} from ${label}${nameList(names)}${partial}`
        : // No verified count to report — never claim one.
          `Removal requested for ${args.tracks.length} items from ${label} — result unverified, playlist could not be re-read`;
      return ok(
        args.action,
        {
          snapshot_id: snapshotId,
          removed: verified ? count : null,
          remaining: verified ? survivors : null,
          not_found: presentBefore ? notFound : null,
          verified,
        },
        message,
      );
    }
    case 'reorder_items': {
      if (!args.playlist_id) return required('playlist_id is');
      if (args.range_start == null || args.insert_before == null) {
        return required('range_start and insert_before are');
      }
      const snapshot = SnapshotResponseCodec.parse(
        await call(client, 'PUT', `playlists/${args.playlist_id}/tracks`, {
          range_start: args.range_start,
          insert_before: args.insert_before,
          range_length: args.range_length,
          snapshot_id: args.snapshot_id,
        }),
      );
      return ok(
        args.action,
        { snapshot_id: snapshot?.snapshot_id },
        `Moved ${args.range_length ?? 1} item(s) in playlist ${args.playlist_id} starting at ${args.range_start} before ${args.insert_before}.`,
      );
    }
  }
}
