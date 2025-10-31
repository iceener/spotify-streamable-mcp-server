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
import { getSpotifyAppClient } from './sdk.ts';

export type SearchParams = {
  q: string;
  types: string[];
  market?: string;
  limit?: number;
  offset?: number;
  include_external?: 'audio';
};

export async function searchCatalog(params: SearchParams, _signal?: AbortSignal) {
  const client = getSpotifyAppClient();
  const searchParams = new URLSearchParams();
  searchParams.set('q', params.q);
  searchParams.set('type', params.types.join(','));
  if (params.limit) {
    searchParams.set('limit', String(params.limit));
  }
  if (params.offset) {
    searchParams.set('offset', String(params.offset));
  }
  if (params.market) {
    searchParams.set('market', params.market);
  }
  if (params.include_external) {
    searchParams.set('include_external', params.include_external);
  }

  try {
    const json = await client.makeRequest<unknown>(
      'GET',
      `search?${searchParams.toString()}`,
    );
    const parsedResponse = SearchResponseCodec.parse(json);

    const totals: Record<string, number> = {};
    const items: Array<
      | ReturnType<typeof toSlimTrack>
      | ReturnType<typeof toSlimAlbum>
      | ReturnType<typeof toSlimArtist>
      | ReturnType<typeof toSlimPlaylist>
    > = [];

    if (parsedResponse.tracks) {
      totals.track = parsedResponse.tracks.total ?? 0;
      const trackItems = Array.isArray(parsedResponse.tracks.items)
        ? parsedResponse.tracks.items
        : [];
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

    if (parsedResponse.albums) {
      totals.album = parsedResponse.albums.total ?? 0;
      const albumItems = Array.isArray(parsedResponse.albums.items)
        ? parsedResponse.albums.items
        : [];
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

    if (parsedResponse.artists) {
      totals.artist = parsedResponse.artists.total ?? 0;
      const artistItems = Array.isArray(parsedResponse.artists.items)
        ? parsedResponse.artists.items
        : [];
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

    if (parsedResponse.playlists) {
      totals.playlist = parsedResponse.playlists.total ?? 0;
      const playlistItems = Array.isArray(parsedResponse.playlists.items)
        ? parsedResponse.playlists.items
        : [];
      for (const raw of playlistItems) {
        const parsed = MinimalEntityCodec.extend({
          owner: z
            .object({ display_name: z.string().nullable().optional() })
            .optional(),
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
  } catch (error) {
    const status = (error as { status?: number }).status;
    const code = typeof status === 'number' ? mapStatusToCode(status) : 'bad_response';
    const message = (error as Error).message;
    throw new Error(`Search failed: ${message} [${code}]`);
  }
}
