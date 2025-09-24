import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config/env.ts';
import { toolsMetadata } from '../config/metadata.ts';
import { getUserBearer } from '../core/auth.ts';
import {
  type SpotifyLibraryInput,
  SpotifyLibraryInputSchema,
} from '../schemas/inputs.ts';
import { SpotifyLibraryOutputObject } from '../schemas/outputs.ts';
import { createHttpClient } from '../services/http-client.ts';
import {
  SavedTracksResponseCodec,
  TrackCodec,
  type TrackCodecType,
} from '../types/spotify.codecs.ts';
import { expectOkOr204 } from '../utils/http-result.ts';
import { logger } from '../utils/logger.ts';
import { toSlimTrack } from '../utils/mappers.ts';
import { apiBase } from '../utils/spotify.ts';
import { validateDev } from '../utils/validate.ts';

const http = createHttpClient({
  baseHeaders: {
    'Content-Type': 'application/json',
    'User-Agent': `mcp-spotify/${config.MCP_VERSION}`,
  },
  rateLimit: { rps: 5, burst: 10 },
  timeout: 20000,
  retries: 1,
});

export const spotifyLibraryTool = {
  name: 'spotify_library',
  title: toolsMetadata.spotify_library.title,
  description: toolsMetadata.spotify_library.description,
  inputSchema: SpotifyLibraryInputSchema.shape,

  handler: async (
    args: SpotifyLibraryInput,
    signal?: AbortSignal,
  ): Promise<CallToolResult> => {
    try {
      const parsed = SpotifyLibraryInputSchema.parse(args);
      const token = await getUserBearer();
      if (!token) {
        return fail(
          'Not signed in. Please authenticate.',
          'unauthorized',
          parsed.action,
        );
      }
      const headers = { Authorization: `Bearer ${token}` };
      const baseUrl = apiBase(config.SPOTIFY_API_URL);

      switch (parsed.action) {
        case 'tracks_get': {
          const url = new URL('me/tracks', baseUrl);
          if (parsed.market) {
            url.searchParams.set('market', parsed.market);
          }
          if (typeof parsed.limit === 'number') {
            url.searchParams.set('limit', String(parsed.limit));
          }
          if (typeof parsed.offset === 'number') {
            url.searchParams.set('offset', String(parsed.offset));
          }
          const response = await http(url.toString(), { headers, signal });
          await expectOkOr204(response, 'List saved tracks failed');
          const json = SavedTracksResponseCodec.parse(await response.json());
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
          const url = new URL('me/tracks', baseUrl).toString();
          const body = JSON.stringify({ ids: parsed.ids });
          const response = await http(url, {
            method: 'PUT',
            headers,
            body,
            signal,
          });
          await expectOkOr204(response, 'Save tracks failed');
          let trackSlims: { name: string; uri?: string }[] = [];
          try {
            trackSlims = await fetchTrackSlims({
              http,
              baseUrl,
              headers,
              ids: parsed.ids,
              signal,
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
          const url = new URL('me/tracks', baseUrl).toString();
          const body = JSON.stringify({ ids: parsed.ids });
          const response = await http(url, {
            method: 'DELETE',
            headers,
            body,
            signal,
          });
          await expectOkOr204(response, 'Remove saved tracks failed');
          let trackSlims: { name: string; uri?: string }[] = [];
          try {
            trackSlims = await fetchTrackSlims({
              http,
              baseUrl,
              headers,
              ids: parsed.ids,
              signal,
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
          const url = new URL('me/tracks/contains', baseUrl);
          url.searchParams.set('ids', parsed.ids.join(','));
          const response = await http(url.toString(), { headers, signal });
          await expectOkOr204(response, 'Check saved tracks failed');
          const contains = (await response.json()) as boolean[];
          const yes = contains.filter(Boolean).length;
          let savedSlims: { name: string; uri?: string }[] = [];
          try {
            const savedIds = parsed.ids.filter((_, i) => contains[i]);
            if (savedIds.length > 0) {
              savedSlims = await fetchTrackSlims({
                http,
                baseUrl,
                headers,
                ids: savedIds,
                signal,
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

async function fetchTrackSlims(params: {
  http: typeof http;
  baseUrl: string;
  headers: { Authorization: string };
  ids: string[];
  signal?: AbortSignal;
}): Promise<{ name: string; uri?: string }[]> {
  const { http: client, baseUrl, headers, ids, signal } = params;
  const unique = Array.from(new Set(ids)).slice(0, 50);
  if (unique.length === 0) {
    return [];
  }
  const tUrl = new URL('tracks', baseUrl);
  tUrl.searchParams.set('ids', unique.join(','));
  const tResp = await client(tUrl.toString(), { headers, signal });
  await expectOkOr204(tResp, 'Fetch tracks failed');
  const tJson = (await tResp.json()) as { tracks?: unknown[] };
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
