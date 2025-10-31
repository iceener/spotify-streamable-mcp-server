import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { config } from '../config/env.ts';
import { toolsMetadata } from '../config/metadata.ts';
import {
  type SpotifyLibraryInput,
  SpotifyLibraryInputSchema,
} from '../schemas/inputs.ts';
import { SpotifyLibraryOutputObject } from '../schemas/outputs.ts';
import { getSpotifyUserClient } from '../services/spotify/sdk.ts';
import {
  SavedTracksResponseCodec,
  TrackCodec,
  type TrackCodecType,
} from '../types/spotify.codecs.ts';
import { mapStatusToCode } from '../utils/http-result.ts';
import { logger } from '../utils/logger.ts';
import { toSlimTrack } from '../utils/mappers.ts';
import { validateDev } from '../utils/validate.ts';

export const spotifyLibraryTool = {
  name: 'spotify_library',
  title: toolsMetadata.spotify_library.title,
  description: toolsMetadata.spotify_library.description,
  inputSchema: SpotifyLibraryInputSchema.shape,

  handler: async (
    args: SpotifyLibraryInput,
    _signal?: AbortSignal,
  ): Promise<CallToolResult> => {
    try {
      const parsed = SpotifyLibraryInputSchema.parse(args);
      const client = await getSpotifyUserClient();
      if (!client) {
        return fail(
          'Not signed in. Please authenticate.',
          'unauthorized',
          parsed.action,
        );
      }

      switch (parsed.action) {
        case 'tracks_get': {
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
          const endpoint = buildEndpoint('me/tracks', params);
          const json = SavedTracksResponseCodec.parse(
            await requestSpotify<unknown>(client, 'GET', endpoint),
          );
          const items = Array.isArray(json.items) ? json.items : [];
          const tracks = items
            .map((it) => it.track)
            .filter((t): t is TrackCodecType => !!t)
            .map((t) => toSlimTrack(t));
          const previewCount = 20;
          const lines = tracks
            .slice(0, previewCount)
            .map((t) => `- ${t.name} — ${t.uri}`)
            .join('\n');
          const moreNote =
            tracks.length > previewCount
              ? `\n… and ${tracks.length - previewCount} more`
              : '';
          const msg =
            tracks.length > 0
              ? `Loaded ${tracks.length} saved track(s):\n${lines}${moreNote}`
              : `Loaded 0 saved track(s).`;
          return ok(
            parsed.action,
            {
              limit: Number(json.limit ?? parsed.limit ?? 0) || tracks.length,
              offset: Number(json.offset ?? parsed.offset ?? 0) || 0,
              total: Number(json.total ?? tracks.length) || tracks.length,
              items: tracks,
            },
            msg,
          );
        }
        case 'tracks_add': {
          if (!parsed.ids || parsed.ids.length === 0) {
            return fail(
              'ids are required for tracks_add',
              'invalid_arguments',
              args.action,
            );
          }
          await requestSpotify<unknown>(client, 'PUT', 'me/tracks', {
            ids: parsed.ids,
          });
          let trackSlims: { name: string; uri?: string }[] = [];
          try {
            trackSlims = await fetchTrackSlims({
              client,
              ids: parsed.ids,
            });
          } catch {}
          const noun = parsed.ids.length === 1 ? 'track' : 'tracks';
          const preview = trackSlims
            .slice(0, 5)
            .map((t) => `- ${t.name}${t.uri ? ` — ${t.uri}` : ''}`)
            .join('\n');
          const list = trackSlims.length
            ? `:\n${preview}${trackSlims.length > 5 ? '\n…' : ''}`
            : '.';
          return ok(
            args.action,
            { saved: parsed.ids.length, ids: parsed.ids },
            `Saved ${parsed.ids.length} ${noun}${list}`,
          );
        }
        case 'tracks_remove': {
          if (!parsed.ids || parsed.ids.length === 0) {
            return fail(
              'ids are required for tracks_remove',
              'invalid_arguments',
              args.action,
            );
          }
          await requestSpotify<unknown>(client, 'DELETE', 'me/tracks', {
            ids: parsed.ids,
          });
          let trackSlims: { name: string; uri?: string }[] = [];
          try {
            trackSlims = await fetchTrackSlims({
              client,
              ids: parsed.ids,
            });
          } catch {}
          const noun = parsed.ids.length === 1 ? 'track' : 'tracks';
          const preview = trackSlims
            .slice(0, 5)
            .map((t) => `- ${t.name}${t.uri ? ` — ${t.uri}` : ''}`)
            .join('\n');
          const list = trackSlims.length
            ? `:\n${preview}${trackSlims.length > 5 ? '\n…' : ''}`
            : '.';
          return ok(
            args.action,
            { removed: parsed.ids.length, ids: parsed.ids },
            `Removed ${parsed.ids.length} ${noun}${list}`,
          );
        }
        case 'tracks_contains': {
          if (!parsed.ids || parsed.ids.length === 0) {
            return fail(
              'ids are required for tracks_contains',
              'invalid_arguments',
              args.action,
            );
          }
          const params = new URLSearchParams();
          params.set('ids', parsed.ids.join(','));
          const contains = (await requestSpotify<unknown>(
            client,
            'GET',
            buildEndpoint('me/tracks/contains', params),
          )) as boolean[];
          const yes = contains.filter(Boolean).length;
          let savedSlims: { name: string; uri?: string }[] = [];
          try {
            const savedIds = parsed.ids.filter((_, i) => contains[i]);
            if (savedIds.length > 0) {
              savedSlims = await fetchTrackSlims({
                client,
                ids: savedIds,
              });
            }
          } catch {}
          const savedPreview = savedSlims
            .slice(0, 5)
            .map((t) => `${t.name}${t.uri ? ` — ${t.uri}` : ''}`)
            .join(', ');
          const detail = savedSlims.length
            ? ` Saved: ${savedPreview}${savedSlims.length > 5 ? ', …' : ''}`
            : '';
          const msg = `Already saved: ${yes}/${parsed.ids.length}.${detail}`;
          return ok(args.action, { ids: parsed.ids, contains }, msg);
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      logger.error('spotify_library', { error: message });
      const codeMatch = message.match(
        /\[(unauthorized|forbidden|rate_limited|bad_response)\]$/,
      );
      const code = (codeMatch?.[1] as string | undefined) ?? 'bad_response';
      let userMessage = message.replace(/\s*\[[^\]]+\]$/, '');
      if (code === 'unauthorized') {
        userMessage = 'Not authenticated. Please sign in to Spotify.';
      } else if (code === 'forbidden') {
        userMessage =
          'Access denied. You may need additional permissions or Spotify Premium.';
      } else if (code === 'rate_limited') {
        userMessage = 'Too many requests. Please wait a moment and try again.';
      }
      return fail(userMessage, code, 'unknown');
    }
  },
};

function ok(action: string, data?: unknown, msg?: string): CallToolResult {
  const structured: SpotifyLibraryOutputObject = {
    ok: true,
    action,
    _msg: msg,
    data,
  };
  const contentParts: Array<{ type: 'text'; text: string }> = [
    { type: 'text', text: msg ?? `${action}: ok` },
  ];
  if (config.SPOTIFY_MCP_INCLUDE_JSON_IN_CONTENT) {
    contentParts.push({ type: 'text', text: JSON.stringify(structured) });
  }
  return {
    content: contentParts,
    structuredContent: validateDev(SpotifyLibraryOutputObject, structured),
  };
}

function fail(
  message: string,
  code: string | undefined,
  action: string,
): CallToolResult {
  const structured: SpotifyLibraryOutputObject = {
    ok: false,
    action,
    error: message,
    code,
  };
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: validateDev(SpotifyLibraryOutputObject, structured),
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

async function fetchTrackSlims(params: {
  client: SpotifyApi;
  ids: string[];
}): Promise<{ name: string; uri?: string }[]> {
  const { client, ids } = params;
  const unique = Array.from(new Set(ids)).slice(0, 50);
  if (unique.length === 0) {
    return [];
  }
  const paramsSearch = new URLSearchParams();
  paramsSearch.set('ids', unique.join(','));
  const tJson = (await requestSpotify<unknown>(
    client,
    'GET',
    buildEndpoint('tracks', paramsSearch),
  )) as { tracks?: unknown[] };
  const items = Array.isArray(tJson.tracks) ? tJson.tracks : [];
  return items
    .map((x) => {
      const parsed = TrackCodec.safeParse(x);
      return parsed.success
        ? {
            name: toSlimTrack(parsed.data).name,
            uri: toSlimTrack(parsed.data).uri,
          }
        : undefined;
    })
    .filter(Boolean) as { name: string; uri?: string }[];
}
