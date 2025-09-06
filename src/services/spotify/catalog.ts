import { z } from 'zod';
import {
  MinimalEntityCodec,
  SearchResponseCodec,
  TrackCodec,
} from '../../types/spotify.codecs.ts';
import { mapStatusToCode } from '../../utils/http-result.ts';
import {
  toSlimAlbum,
  toSlimArtist,
  toSlimPlaylist,
  toSlimTrack,
} from '../../utils/mappers.ts';
import type { HttpClient } from '../http-client.ts';

export type SearchParams = {
  q: string;
  types: string[];
  market?: string;
  limit?: number;
  offset?: number;
  include_external?: 'audio';
};

export async function searchCatalog(
  http: HttpClient,
  apiBaseUrl: string,
  getAppToken: (signal?: AbortSignal) => Promise<string>,
  params: SearchParams,
  signal?: AbortSignal,
) {
  const token = await getAppToken(signal);
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL('search', base);
  url.searchParams.set('q', params.q);
  url.searchParams.set('type', params.types.join(','));
  if (params.limit) {
    url.searchParams.set('limit', String(params.limit));
  }
  if (params.offset) {
    url.searchParams.set('offset', String(params.offset));
  }
  if (params.market) {
    url.searchParams.set('market', params.market);
  }
  if (params.include_external) {
    url.searchParams.set('include_external', params.include_external);
  }

  const response = await http(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const code = mapStatusToCode(response.status);
    throw new Error(
      `Search failed: ${response.status} ${response.statusText}${
        text ? ` - ${text}` : ''
      } [${code}]`,
    );
  }
  const json = SearchResponseCodec.parse(await response.json());

  const totals: Record<string, number> = {};
  const items: Array<
    | ReturnType<typeof toSlimTrack>
    | ReturnType<typeof toSlimAlbum>
    | ReturnType<typeof toSlimArtist>
    | ReturnType<typeof toSlimPlaylist>
  > = [];

  if (json.tracks) {
    totals.track = json.tracks.total ?? 0;
    const trackItems = Array.isArray(json.tracks.items) ? json.tracks.items : [];
    for (const raw of trackItems) {
      const parsed = TrackCodec.safeParse(raw);
      if (parsed.success) {
        const slim = toSlimTrack(parsed.data);
        if (slim.id && slim.name) {
          items.push(slim);
        }
      }
    }
  }

  if (json.albums) {
    totals.album = json.albums.total ?? 0;
    const albumItems = Array.isArray(json.albums.items) ? json.albums.items : [];
    for (const raw of albumItems) {
      const parsed = MinimalEntityCodec.safeParse(raw);
      if (parsed.success) {
        const slim = toSlimAlbum(parsed.data);
        if (slim.id && slim.name) {
          items.push(slim);
        }
      }
    }
  }

  if (json.artists) {
    totals.artist = json.artists.total ?? 0;
    const artistItems = Array.isArray(json.artists.items) ? json.artists.items : [];
    for (const raw of artistItems) {
      const parsed = MinimalEntityCodec.safeParse(raw);
      if (parsed.success) {
        const slim = toSlimArtist(parsed.data);
        if (slim.id && slim.name) {
          items.push(slim);
        }
      }
    }
  }

  if (json.playlists) {
    totals.playlist = json.playlists.total ?? 0;
    const playlistItems = Array.isArray(json.playlists.items)
      ? json.playlists.items
      : [];
    for (const raw of playlistItems) {
      const parsed = MinimalEntityCodec.extend({
        owner: z.object({ display_name: z.string().nullable().optional() }).optional(),
      }).safeParse(raw);
      if (parsed.success) {
        const slim = toSlimPlaylist(parsed.data);
        if (slim.id && slim.name) {
          items.push(slim);
        }
      }
    }
  }

  return { totals, items } as const;
}
