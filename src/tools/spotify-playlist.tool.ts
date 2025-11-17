import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { toolsMetadata } from '../config/metadata.ts';
import {
  type SpotifyPlaylistInput,
  SpotifyPlaylistInputSchema,
} from '../schemas/inputs.ts';
import { SpotifyPlaylistOutputObject } from '../schemas/outputs.ts';
import { getSpotifyUserClient } from '../services/spotify/sdk.ts';
import {
  MeResponseCodec,
  PlaylistDetailsResponseCodec,
  PlaylistListResponseCodec,
  PlaylistTracksResponseCodec,
  SnapshotResponseCodec,
  TrackCodec,
} from '../types/spotify.codecs.ts';
import { type ErrorCode, mapStatusToCode } from '../utils/http-result.ts';
import { logger } from '../utils/logger.ts';
import { toPlaylistDetails, toPlaylistSummary, toSlimTrack } from '../utils/mappers.ts';
import { validateDev } from '../utils/validate.ts';

export const spotifyPlaylistTool = {
  name: 'spotify_playlist',
  title: toolsMetadata.spotify_playlist.title,
  description: toolsMetadata.spotify_playlist.description,
  inputSchema: SpotifyPlaylistInputSchema.shape,

  handler: async (
    args: SpotifyPlaylistInput,
    _signal?: AbortSignal,
  ): Promise<CallToolResult> => {
    try {
      const parsed = SpotifyPlaylistInputSchema.parse(args);
      const client = await getSpotifyUserClient();
      if (!client) {
        return fail(
          'Not signed in. Please authenticate.',
          'unauthorized',
          parsed.action,
        );
      }

      switch (parsed.action) {
        case 'list_user': {
          const params = new URLSearchParams();
          if (parsed.limit != null) {
            params.set('limit', String(parsed.limit));
          }
          if (parsed.offset != null) {
            params.set('offset', String(parsed.offset));
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
              limit: Number(json.limit ?? parsed.limit ?? 0) || normalized.length,
              offset: Number(json.offset ?? parsed.offset ?? 0) || 0,
              total: Number(json.total ?? normalized.length) || normalized.length,
              items: normalized,
            },
            msg,
          );
        }
        case 'get': {
          if (!parsed.playlist_id) {
            return fail(
              'playlist_id is required for get',
              'invalid_arguments',
              args.action,
            );
          }
          const params = new URLSearchParams();
          if (parsed.market) {
            params.set('market', parsed.market);
          }
          if (parsed.fields) {
            params.set('fields', parsed.fields);
          }
          const endpoint = buildEndpoint(`playlists/${parsed.playlist_id}`, params);
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
          if (!parsed.playlist_id) {
            return fail(
              'playlist_id is required for items',
              'invalid_arguments',
              args.action,
            );
          }
          const params = new URLSearchParams();
          if (parsed.market) {
            params.set('market', parsed.market);
          }
          if (typeof parsed.limit === 'number') {
            params.set('limit', String(parsed.limit));
          }
          if (typeof parsed.offset === 'number') {
            params.set('offset', String(parsed.offset));
          }
          if (parsed.fields) {
            params.set('fields', parsed.fields);
          }
          if (parsed.additional_types) {
            params.set('additional_types', parsed.additional_types);
          }
          const endpoint = buildEndpoint(
            `playlists/${parsed.playlist_id}/tracks`,
            params,
          );
          const json = PlaylistTracksResponseCodec.parse(
            await requestSpotify<unknown>(client, 'GET', endpoint),
          );
          const items = Array.isArray(json.items) ? json.items : [];
          const baseOffset = Number(json.offset ?? parsed.offset ?? 0) || 0;
          const playlistUri = `spotify:playlist:${parsed.playlist_id}`;
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
                `playlists/${parsed.playlist_id}`,
              ),
            );
            const plr = plJson as unknown as Record<string, unknown>;
            playlistName = String((plr?.name as string | undefined) ?? '');
          } catch {}
          const label = playlistName
            ? `'${playlistName}'`
            : `playlist ${parsed.playlist_id}`;
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
              playlist_id: parsed.playlist_id,
              playlist_uri: playlistUri,
              limit:
                Number(json.limit ?? parsed.limit ?? 0) || tracksWithPositions.length,
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
            name: parsed.name ?? 'New Playlist',
            description: parsed.description,
            public: parsed.public,
            collaborative: parsed.collaborative,
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
          if (!parsed.playlist_id) {
            return fail(
              'playlist_id is required for update_details',
              'invalid_arguments',
              args.action,
            );
          }
          await requestSpotify<unknown>(
            client,
            'PUT',
            `playlists/${parsed.playlist_id}`,
            {
            name: parsed.name,
            description: parsed.description,
            public: parsed.public,
            collaborative: parsed.collaborative,
            },
            true,
          );
          const updatedBits: string[] = [];
          if (typeof parsed.name === 'string') {
            updatedBits.push(`name='${parsed.name}'`);
          }
          if (typeof parsed.public === 'boolean') {
            updatedBits.push(`public=${parsed.public}`);
          }
          if (typeof parsed.collaborative === 'boolean') {
            updatedBits.push(`collaborative=${parsed.collaborative}`);
          }
          if (typeof parsed.description === 'string' && parsed.description.length > 0) {
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
          if (!parsed.playlist_id) {
            return fail(
              'playlist_id is required for add_items',
              'invalid_arguments',
              args.action,
            );
          }
          if (!parsed.uris || parsed.uris.length === 0) {
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
              `playlists/${parsed.playlist_id}/tracks`,
              { uris: parsed.uris },
            ),
          );
          const count = parsed.uris.length;
          let playlistName: string | undefined;
          let trackNames: string[] = [];
          try {
            const plJson = PlaylistDetailsResponseCodec.parse(
              await requestSpotify<unknown>(
                client,
                'GET',
                `playlists/${parsed.playlist_id}`,
              ),
            );
            const plr2 = plJson as unknown as Record<string, unknown>;
            playlistName = String((plr2?.name as string | undefined) ?? '');
          } catch {}
          try {
            const ids = parsed.uris
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
            : `playlist ${parsed.playlist_id}`;
          const noun = count === 1 ? 'item' : 'items';
          const msg = `I've added ${count} ${noun} to ${playlistLabel}${list}`;
          return ok(
            args.action,
            { snapshot_id: json?.snapshot_id, uris: parsed.uris },
            msg,
          );
        }
        case 'remove_items': {
          if (!parsed.playlist_id) {
            return fail(
              'playlist_id is required for remove_items',
              'invalid_arguments',
              args.action,
            );
          }
          if (!parsed.tracks || parsed.tracks.length === 0) {
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
              `playlists/${parsed.playlist_id}/tracks`,
              {
                tracks: parsed.tracks,
                snapshot_id: parsed.snapshot_id,
              },
            ),
          );
          const count = parsed.tracks.length;
          let playlistName: string | undefined;
          try {
            const plJson = PlaylistDetailsResponseCodec.parse(
              await requestSpotify<unknown>(
                client,
                'GET',
                `playlists/${parsed.playlist_id}`,
              ),
            );
            const plr3 = plJson as unknown as Record<string, unknown>;
            playlistName = String((plr3?.name as string | undefined) ?? '');
          } catch {}
          let trackNames: string[] = [];
          try {
            const ids = (parsed.tracks || [])
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
            : `playlist ${parsed.playlist_id}`;
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
          if (!parsed.playlist_id) {
            return fail(
              'playlist_id is required for reorder_items',
              'invalid_arguments',
              args.action,
            );
          }
          if (parsed.range_start == null || parsed.insert_before == null) {
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
            `playlists/${parsed.playlist_id}/tracks`,
              {
            range_start: parsed.range_start,
            insert_before: parsed.insert_before,
            range_length: parsed.range_length,
            snapshot_id: parsed.snapshot_id,
              },
            ),
          );
          const moved = parsed.range_length ?? 1;
          const msg = `Moved ${moved} item(s) in playlist ${parsed.playlist_id} starting at ${parsed.range_start} before ${parsed.insert_before}.`;
          return ok(args.action, { snapshot_id: json?.snapshot_id }, msg);
        }
      }
    } catch (error) {
      const err = error as Error;
      logger.error('spotify_playlist', { error: err.message });
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
};

function ok(action: string, data?: unknown, msg?: string): CallToolResult {
  const structured: SpotifyPlaylistOutputObject = {
    ok: true,
    action,
    _msg: msg,
    data,
  };
  const contentParts: Array<{ type: 'text'; text: string }> = [
    { type: 'text', text: msg ?? `${action}: ok` },
  ];
  return {
    content: contentParts,
    structuredContent: validateDev(SpotifyPlaylistOutputObject, structured),
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

function fail(
  message: string,
  code: string | undefined,
  action: string,
): CallToolResult {
  const structured: SpotifyPlaylistOutputObject = {
    ok: false,
    action,
    error: message,
    code,
  };
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: validateDev(SpotifyPlaylistOutputObject, structured),
  };
}
