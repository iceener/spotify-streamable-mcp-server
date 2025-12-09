/**
 * Spotify Library Tool - Manage saved tracks.
 */

import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { config } from '../../config/env.js';
import { toolsMetadata } from '../../config/metadata.js';
import {
  type SpotifyLibraryInput,
  SpotifyLibraryInputSchema,
} from '../../schemas/inputs.js';
import { SpotifyLibraryOutputObject } from '../../schemas/outputs.js';
import { getSpotifyUserClient } from '../../services/spotify/sdk.js';
import {
  SavedTracksResponseCodec,
  TrackCodec,
  type TrackCodecType,
} from '../../types/spotify.codecs.js';
import { mapStatusToCode } from '../../utils/http-result.js';
import { toSlimTrack } from '../../utils/mappers.js';
import { sharedLogger as logger } from '../utils/logger.js';
import { defineTool, type ToolContext, type ToolResult } from './types.js';

function ok(action: string, data?: unknown, msg?: string): ToolResult {
  const structured: SpotifyLibraryOutputObject = {
    ok: true,
    action,
    _msg: msg,
    data,
  };
  const contentParts: Array<{ type: 'text'; text: string }> = [
    { type: 'text', text: msg ?? `${action}: ok` },
  ];
  if (config.SPOTIFY_INCLUDE_JSON_IN_CONTENT) {
    contentParts.push({ type: 'text', text: JSON.stringify(structured) });
  }
  return {
    content: contentParts,
    structuredContent: structured,
  };
}

function fail(message: string, code: string | undefined, action: string): ToolResult {
  const structured: SpotifyLibraryOutputObject = {
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

export const spotifyLibraryTool = defineTool({
  name: toolsMetadata.spotify_library.name,
  title: toolsMetadata.spotify_library.title,
  description: toolsMetadata.spotify_library.description,
  inputSchema: SpotifyLibraryInputSchema,
  outputSchema: SpotifyLibraryOutputObject.shape,
  annotations: {
    title: toolsMetadata.spotify_library.title,
    readOnlyHint: false,
    openWorldHint: true,
  },

  handler: async (
    args: SpotifyLibraryInput,
    context: ToolContext,
  ): Promise<ToolResult> => {
    try {
      const client = await getSpotifyUserClient(context);
      if (!client) {
        return fail('Not signed in. Please authenticate.', 'unauthorized', args.action);
      }

      switch (args.action) {
        case 'tracks_get': {
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
            args.action,
            {
              limit: Number(json.limit ?? args.limit ?? 0) || tracks.length,
              offset: Number(json.offset ?? args.offset ?? 0) || 0,
              total: Number(json.total ?? tracks.length) || tracks.length,
              items: tracks,
            },
            msg,
          );
        }
        case 'tracks_add': {
          if (!args.ids || args.ids.length === 0) {
            return fail(
              'ids are required for tracks_add',
              'invalid_arguments',
              args.action,
            );
          }
          await requestSpotify<unknown>(client, 'PUT', 'me/tracks', {
            ids: args.ids,
          });
          let trackSlims: { name: string; uri?: string }[] = [];
          try {
            trackSlims = await fetchTrackSlims({
              client,
              ids: args.ids,
            });
          } catch {}
          const noun = args.ids.length === 1 ? 'track' : 'tracks';
          const preview = trackSlims
            .slice(0, 5)
            .map((t) => `- ${t.name}${t.uri ? ` — ${t.uri}` : ''}`)
            .join('\n');
          const list = trackSlims.length
            ? `:\n${preview}${trackSlims.length > 5 ? '\n…' : ''}`
            : '.';
          return ok(
            args.action,
            { saved: args.ids.length, ids: args.ids },
            `Saved ${args.ids.length} ${noun}${list}`,
          );
        }
        case 'tracks_remove': {
          if (!args.ids || args.ids.length === 0) {
            return fail(
              'ids are required for tracks_remove',
              'invalid_arguments',
              args.action,
            );
          }
          await requestSpotify<unknown>(client, 'DELETE', 'me/tracks', {
            ids: args.ids,
          });
          let trackSlims: { name: string; uri?: string }[] = [];
          try {
            trackSlims = await fetchTrackSlims({
              client,
              ids: args.ids,
            });
          } catch {}
          const noun = args.ids.length === 1 ? 'track' : 'tracks';
          const preview = trackSlims
            .slice(0, 5)
            .map((t) => `- ${t.name}${t.uri ? ` — ${t.uri}` : ''}`)
            .join('\n');
          const list = trackSlims.length
            ? `:\n${preview}${trackSlims.length > 5 ? '\n…' : ''}`
            : '.';
          return ok(
            args.action,
            { removed: args.ids.length, ids: args.ids },
            `Removed ${args.ids.length} ${noun}${list}`,
          );
        }
        case 'tracks_contains': {
          if (!args.ids || args.ids.length === 0) {
            return fail(
              'ids are required for tracks_contains',
              'invalid_arguments',
              args.action,
            );
          }
          const params = new URLSearchParams();
          params.set('ids', args.ids.join(','));
          const contains = (await requestSpotify<unknown>(
            client,
            'GET',
            buildEndpoint('me/tracks/contains', params),
          )) as boolean[];
          const yes = contains.filter(Boolean).length;
          let savedSlims: { name: string; uri?: string }[] = [];
          try {
            const savedIds = args.ids.filter((_, i) => contains[i]);
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
          const msg = `Already saved: ${yes}/${args.ids.length}.${detail}`;
          return ok(args.action, { ids: args.ids, contains }, msg);
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      logger.error('spotify_library', { message: 'Library error', error: message });
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
});














