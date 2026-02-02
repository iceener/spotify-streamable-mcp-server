/**
 * Spotify Playlist Tool - Manage user playlists.
 */

import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { toolsMetadata } from '../../config/metadata.js';
import {
  type SpotifyPlaylistInput,
  SpotifyPlaylistInputSchema,
} from '../../schemas/inputs.js';
import { SpotifyPlaylistOutputObject } from '../../schemas/outputs.js';
import { getSpotifyUserClient } from '../../services/spotify/sdk.js';
import {
  MeResponseCodec,
  PlaylistDetailsResponseCodec,
  PlaylistListResponseCodec,
  PlaylistTracksResponseCodec,
  SnapshotResponseCodec,
  TrackCodec,
} from '../../types/spotify.codecs.js';
import { type ErrorCode, mapStatusToCode } from '../../utils/http-result.js';
import {
  toPlaylistDetails,
  toPlaylistSummary,
  toSlimTrack,
} from '../../utils/mappers.js';
import { sharedLogger as logger } from '../utils/logger.js';
import { defineTool, type ToolContext, type ToolResult } from './types.js';

function ok(action: string, data?: unknown, msg?: string): ToolResult {
  const structured: SpotifyPlaylistOutputObject = {
    ok: true,
    action,
    _msg: msg,
    data,
  };
  return {
    content: [{ type: 'text', text: msg ?? `${action}: ok` }],
    structuredContent: structured,
  };
}

function fail(message: string, code: string | undefined, action: string): ToolResult {
  const structured: SpotifyPlaylistOutputObject = {
    ok: false,
    action,
    error: message,
    code,
  };
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: structured,
  };
}

function buildEndpoint(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

async function requestSpotify<T>(
  client: SpotifyApi,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  allowEmpty = false,
): Promise<T> {
  try {
    return await client.makeRequest<T>(method, path, body);
  } catch (error) {
    if (
      allowEmpty &&
      error instanceof SyntaxError &&
      !(error as { status?: number }).status
    ) {
      return undefined as T;
    }
    throw wrapSpotifyError(error);
  }
}

function wrapSpotifyError(error: unknown): Error {
  const status = (error as { status?: number }).status;
  if (typeof status === 'number') {
    const code = mapStatusToCode(status);
    const raw = (error as Error).message;
    const cleaned = raw.replace(/\s*\[[^\]]+\]$/, '');
    const err = new Error(`${cleaned} [${code}]`);
    (err as { status?: number }).status = status;
    return err;
  }
  return error instanceof Error ? error : new Error(String(error));
}

export const spotifyPlaylistTool = defineTool({
  name: toolsMetadata.spotify_playlist.name,
  title: toolsMetadata.spotify_playlist.title,
  description: toolsMetadata.spotify_playlist.description,
  inputSchema: SpotifyPlaylistInputSchema,
  outputSchema: SpotifyPlaylistOutputObject.shape,
  annotations: {
    title: toolsMetadata.spotify_playlist.title,
    readOnlyHint: false,
    openWorldHint: true,
  },

  handler: async (
    args: SpotifyPlaylistInput,
    context: ToolContext,
  ): Promise<ToolResult> => {
    try {
      const client = await getSpotifyUserClient(context);
      if (!client) {
        return fail('Not signed in. Please authenticate.', 'unauthorized', args.action);
      }

      switch (args.action) {
        case 'list_user': {
          const params = new URLSearchParams();
          if (args.limit != null) {
            params.set('limit', String(args.limit));
          }
          if (args.offset != null) {
            params.set('offset', String(args.offset));
          }
          const endpoint = buildEndpoint('me/playlists', params);
          const json = PlaylistListResponseCodec.parse(
            await requestSpotify<unknown>(client, 'GET', endpoint),
          );
          const items = Array.isArray(json.items) ? json.items : [];
          const normalized = items.map(toPlaylistSummary);
          const previewCount = 20;
          const lines = normalized
            .slice(0, previewCount)
            .map((pl) => {
              const rec = pl as Record<string, unknown>;
              const name = String((rec?.name as string | undefined) ?? '');
              const uri = String((rec?.uri as string | undefined) ?? '');
              return `- ${name}${uri ? ` — ${uri}` : ''}`;
            })
            .join('\n');
          const moreNote =
            normalized.length > previewCount
              ? `\n… and ${normalized.length - previewCount} more`
              : '';
          const msg =
            normalized.length > 0
              ? `Found ${normalized.length} playlists:\n${lines}${moreNote}`
              : 'Found 0 playlists.';
          return ok(
            args.action,
            {
              limit: Number(json.limit ?? args.limit ?? 0) || normalized.length,
              offset: Number(json.offset ?? args.offset ?? 0) || 0,
              total: Number(json.total ?? normalized.length) || normalized.length,
              items: normalized,
            },
            msg,
          );
        }
        case 'get': {
          if (!args.playlist_id) {
            return fail(
              'playlist_id is required for get',
              'invalid_arguments',
              args.action,
            );
          }
          const params = new URLSearchParams();
          if (args.market) {
            params.set('market', args.market);
          }
          if (args.fields) {
            params.set('fields', args.fields);
          }
          const endpoint = buildEndpoint(`playlists/${args.playlist_id}`, params);
          const json = PlaylistDetailsResponseCodec.parse(
            await requestSpotify<unknown>(client, 'GET', endpoint),
          );
          const details = toPlaylistDetails(json);
          const jrec = json as unknown as Record<string, unknown>;
          const name = String((jrec?.name as string | undefined) ?? 'playlist');
          const uri = String((jrec?.uri as string | undefined) ?? '');
          const msg = uri
            ? `Fetched playlist '${name}' — ${uri}.`
            : `Fetched playlist '${name}'.`;
          return ok(args.action, details, msg);
        }
        case 'items': {
          if (!args.playlist_id) {
            return fail(
              'playlist_id is required for items',
              'invalid_arguments',
              args.action,
            );
          }
          const params = new URLSearchParams();
          if (args.market) {
            params.set('market', args.market);
          }
          if (typeof args.limit === 'number') {
            params.set('limit', String(args.limit));
          }
          if (typeof args.offset === 'number') {
            params.set('offset', String(args.offset));
          }
          if (args.fields) {
            params.set('fields', args.fields);
          }
          if (args.additional_types) {
            params.set('additional_types', args.additional_types);
          }
          const endpoint = buildEndpoint(
            `playlists/${args.playlist_id}/tracks`,
            params,
          );
          const json = PlaylistTracksResponseCodec.parse(
            await requestSpotify<unknown>(client, 'GET', endpoint),
          );
          const items = Array.isArray(json.items) ? json.items : [];
          const baseOffset = Number(json.offset ?? args.offset ?? 0) || 0;
          const playlistUri = `spotify:playlist:${args.playlist_id}`;
          const tracksWithPositions = items
            .map((item, i) => ({ item, i }))
            .filter(({ item }) => !!item?.track)
            .map(({ item, i }) => {
              const track = toSlimTrack(TrackCodec.parse(item.track as unknown));
              return { ...track, position: baseOffset + i } as unknown;
            });
          let playlistName: string | undefined;
          try {
            const plJson = PlaylistDetailsResponseCodec.parse(
              await requestSpotify<unknown>(
                client,
                'GET',
                `playlists/${args.playlist_id}`,
              ),
            );
            const plr = plJson as unknown as Record<string, unknown>;
            playlistName = String((plr?.name as string | undefined) ?? '');
          } catch {}
          const label = playlistName
            ? `'${playlistName}'`
            : `playlist ${args.playlist_id}`;
          const previewCount = 20;
          const lines = tracksWithPositions
            .slice(0, previewCount)
            .map((t) => {
              const trec = t as Record<string, unknown>;
              const pos = String(
                (trec?.position as string | number | undefined) ?? '?',
              );
              const name = String((trec?.name as string | undefined) ?? '');
              const uri = String((trec?.uri as string | undefined) ?? '');
              return `- #${pos} ${name}${uri ? ` — ${uri}` : ''}`;
            })
            .join('\n');
          const moreNote =
            tracksWithPositions.length > previewCount
              ? `\n… and ${tracksWithPositions.length - previewCount} more`
              : '';
          const msg =
            `Loaded ${tracksWithPositions.length} items from ${label} (context: ${playlistUri}).` +
            (tracksWithPositions.length > 0 ? `\n${lines}${moreNote}` : '');
          return ok(
            args.action,
            {
              playlist_id: args.playlist_id,
              playlist_uri: playlistUri,
              limit:
                Number(json.limit ?? args.limit ?? 0) || tracksWithPositions.length,
              offset: baseOffset,
              total:
                Number(json.total ?? tracksWithPositions.length) ||
                tracksWithPositions.length,
              items: tracksWithPositions,
            },
            msg,
          );
        }
        case 'create': {
          const meData = MeResponseCodec.parse(
            await requestSpotify<unknown>(client, 'GET', 'me'),
          );
          const userId = meData?.id?.trim();
          if (!userId) {
            return fail(
              'Unable to determine current user id.',
              'bad_response',
              args.action,
            );
          }
          const json = PlaylistDetailsResponseCodec.parse(
            await requestSpotify<unknown>(client, 'POST', `users/${userId}/playlists`, {
              name: args.name ?? 'New Playlist',
              description: args.description,
              public: args.public,
              collaborative: args.collaborative,
            }),
          );
          const details = toPlaylistDetails(json);
          const jrec2 = json as unknown as Record<string, unknown>;
          const name = String((jrec2?.name as string | undefined) ?? 'playlist');
          const uri = String((jrec2?.uri as string | undefined) ?? '');
          const msg = uri
            ? `Created playlist '${name}' — ${uri}.`
            : `Created playlist '${name}'.`;
          return ok(args.action, details, msg);
        }
        case 'update_details': {
          if (!args.playlist_id) {
            return fail(
              'playlist_id is required for update_details',
              'invalid_arguments',
              args.action,
            );
          }
          await requestSpotify<unknown>(
            client,
            'PUT',
            `playlists/${args.playlist_id}`,
            {
              name: args.name,
              description: args.description,
              public: args.public,
              collaborative: args.collaborative,
            },
            true,
          );
          const updatedBits: string[] = [];
          if (typeof args.name === 'string') {
            updatedBits.push(`name='${args.name}'`);
          }
          if (typeof args.public === 'boolean') {
            updatedBits.push(`public=${args.public}`);
          }
          if (typeof args.collaborative === 'boolean') {
            updatedBits.push(`collaborative=${args.collaborative}`);
          }
          if (typeof args.description === 'string' && args.description.length > 0) {
            updatedBits.push('description set');
          }
          const detailsMsg =
            updatedBits.length > 0 ? ` (${updatedBits.join(', ')})` : '';
          return ok(
            args.action,
            { updated: true },
            `Updated playlist details${detailsMsg}.`,
          );
        }
        case 'add_items': {
          if (!args.playlist_id) {
            return fail(
              'playlist_id is required for add_items',
              'invalid_arguments',
              args.action,
            );
          }
          if (!args.uris || args.uris.length === 0) {
            return fail(
              'uris are required for add_items',
              'invalid_arguments',
              args.action,
            );
          }
          const json = SnapshotResponseCodec.parse(
            await requestSpotify<unknown>(
              client,
              'POST',
              `playlists/${args.playlist_id}/tracks`,
              { uris: args.uris },
            ),
          );
          const count = args.uris.length;
          let playlistName: string | undefined;
          let trackNames: string[] = [];
          try {
            const plJson = PlaylistDetailsResponseCodec.parse(
              await requestSpotify<unknown>(
                client,
                'GET',
                `playlists/${args.playlist_id}`,
              ),
            );
            const plr2 = plJson as unknown as Record<string, unknown>;
            playlistName = String((plr2?.name as string | undefined) ?? '');
          } catch {}
          try {
            const ids = args.uris
              .map((u) => {
                const m = /^spotify:track:(.+)$/.exec(u);
                return m?.[1];
              })
              .filter(Boolean) as string[];
            if (ids.length > 0) {
              const trackParams = new URLSearchParams();
              trackParams.set('ids', ids.slice(0, 50).join(','));
              const tJson = (await requestSpotify<unknown>(
                client,
                'GET',
                buildEndpoint('tracks', trackParams),
              )) as { tracks?: unknown[] };
              const items = Array.isArray(tJson.tracks) ? tJson.tracks : [];
              trackNames = items
                .map((x) => {
                  const parsedT = TrackCodec.safeParse(x);
                  return parsedT.success ? toSlimTrack(parsedT.data).name : undefined;
                })
                .filter(Boolean) as string[];
            }
          } catch {}
          const list = trackNames.length
            ? `: ${trackNames.slice(0, 5).join(', ')}${
                trackNames.length > 5 ? ', …' : ''
              }`
            : '.';
          const playlistLabel = playlistName
            ? `'${playlistName}'`
            : `playlist ${args.playlist_id}`;
          const noun = count === 1 ? 'item' : 'items';
          const msg = `I've added ${count} ${noun} to ${playlistLabel}${list}`;
          return ok(
            args.action,
            { snapshot_id: json?.snapshot_id, uris: args.uris },
            msg,
          );
        }
        case 'remove_items': {
          if (!args.playlist_id) {
            return fail(
              'playlist_id is required for remove_items',
              'invalid_arguments',
              args.action,
            );
          }
          if (!args.tracks || args.tracks.length === 0) {
            return fail(
              'tracks are required for remove_items',
              'invalid_arguments',
              args.action,
            );
          }
          const json = SnapshotResponseCodec.parse(
            await requestSpotify<unknown>(
              client,
              'DELETE',
              `playlists/${args.playlist_id}/tracks`,
              {
                tracks: args.tracks,
                snapshot_id: args.snapshot_id,
              },
            ),
          );
          const count = args.tracks.length;
          let playlistName: string | undefined;
          try {
            const plJson = PlaylistDetailsResponseCodec.parse(
              await requestSpotify<unknown>(
                client,
                'GET',
                `playlists/${args.playlist_id}`,
              ),
            );
            const plr3 = plJson as unknown as Record<string, unknown>;
            playlistName = String((plr3?.name as string | undefined) ?? '');
          } catch {}
          let trackNames: string[] = [];
          try {
            const ids = (args.tracks || [])
              .map((t) => {
                const m = /^spotify:track:(.+)$/.exec(t.uri);
                return m?.[1];
              })
              .filter(Boolean) as string[];
            if (ids.length > 0) {
              const trackParams = new URLSearchParams();
              trackParams.set('ids', ids.slice(0, 50).join(','));
              const tJson = (await requestSpotify<unknown>(
                client,
                'GET',
                buildEndpoint('tracks', trackParams),
              )) as { tracks?: unknown[] };
              const items = Array.isArray(tJson.tracks) ? tJson.tracks : [];
              trackNames = items
                .map((x) => {
                  const parsedT = TrackCodec.safeParse(x);
                  return parsedT.success ? toSlimTrack(parsedT.data).name : undefined;
                })
                .filter(Boolean) as string[];
            }
          } catch {}
          const playlistLabel = playlistName
            ? `'${playlistName}'`
            : `playlist ${args.playlist_id}`;
          const listR = trackNames.length
            ? `: ${trackNames.slice(0, 5).join(', ')}${
                trackNames.length > 5 ? ', …' : ''
              }`
            : '.';
          const noun = count === 1 ? 'item' : 'items';
          const msg = `I've removed ${count} ${noun} from ${playlistLabel}${listR}`;
          return ok(args.action, { snapshot_id: json?.snapshot_id }, msg);
        }
        case 'reorder_items': {
          if (!args.playlist_id) {
            return fail(
              'playlist_id is required for reorder_items',
              'invalid_arguments',
              args.action,
            );
          }
          if (args.range_start == null || args.insert_before == null) {
            return fail(
              'range_start and insert_before are required for reorder_items',
              'invalid_arguments',
              args.action,
            );
          }
          const json = SnapshotResponseCodec.parse(
            await requestSpotify<unknown>(
              client,
              'PUT',
              `playlists/${args.playlist_id}/tracks`,
              {
                range_start: args.range_start,
                insert_before: args.insert_before,
                range_length: args.range_length,
                snapshot_id: args.snapshot_id,
              },
            ),
          );
          const moved = args.range_length ?? 1;
          const msg = `Moved ${moved} item(s) in playlist ${args.playlist_id} starting at ${args.range_start} before ${args.insert_before}.`;
          return ok(args.action, { snapshot_id: json?.snapshot_id }, msg);
        }
      }
    } catch (error) {
      const err = error as Error;
      logger.error('spotify_playlist', {
        message: 'Playlist error',
        error: err.message,
      });
      const codeMatch = err.message.match(/\[(\w+)\]$/);
      const code = codeMatch ? (codeMatch[1] as ErrorCode) : 'bad_response';
      let userMessage = err.message.replace(/\s*\[\w+\]$/, '');
      if (code === 'unauthorized') {
        userMessage = 'Not authenticated. Please sign in to Spotify.';
      } else if (code === 'forbidden') {
        userMessage =
          'Access denied. You may need additional permissions or Spotify Premium.';
      } else if (code === 'rate_limited') {
        userMessage = 'Too many requests. Please wait a moment and try again.';
      }
      return fail(userMessage, code, args.action || 'unknown');
    }
  },
});




































