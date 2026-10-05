import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import * as z from 'zod/v4';
import { errorCodeFor } from './spotify';
import {
  MinimalEntityCodec,
  SearchResponseCodec,
  TrackCodec,
  toSlimAlbum,
  toSlimArtist,
  toSlimPlaylist,
  toSlimTrack,
} from './spotify-codecs';

export interface SearchParams {
  q: string;
  types: string[];
  market?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  include_external?: 'audio' | undefined;
}

export type SearchItem =
  | ReturnType<typeof toSlimTrack>
  | ReturnType<typeof toSlimAlbum>
  | ReturnType<typeof toSlimArtist>
  | ReturnType<typeof toSlimPlaylist>;

const PlaylistResultCodec = MinimalEntityCodec.extend({
  owner: z.object({ display_name: z.string().nullable().optional() }).optional(),
});

/**
 * One catalog search, with the app client: totals per type, and the items in the order
 * tracks, albums, artists, playlists. Items without an ID or name are skipped. A failure
 * throws `Error('Search failed: <message> [<code>]')`.
 */
export async function searchCatalog(
  client: SpotifyApi,
  params: SearchParams,
): Promise<{ totals: Record<string, number>; items: SearchItem[] }> {
  const query = new URLSearchParams();
  query.set('q', params.q);
  query.set('type', params.types.join(','));
  if (params.limit) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));
  if (params.market) query.set('market', params.market);
  if (params.include_external) query.set('include_external', params.include_external);

  try {
    const response = SearchResponseCodec.parse(
      await client.makeRequest<unknown>('GET', `search?${query}`),
    );
    const totals: Record<string, number> = {};
    const items: SearchItem[] = [];
    const collect = <T>(
      type: string,
      block: { items?: unknown[] | undefined; total?: number | undefined } | undefined,
      codec: z.ZodType<T>,
      slim: (value: T) => SearchItem,
    ) => {
      if (!block) return;
      totals[type] = block.total ?? 0;
      for (const raw of Array.isArray(block.items) ? block.items : []) {
        const parsed = codec.safeParse(raw);
        if (!parsed.success) continue;
        const item = slim(parsed.data);
        if (item.id && item.name) items.push(item);
      }
    };
    collect('track', response.tracks, TrackCodec, toSlimTrack);
    collect('album', response.albums, MinimalEntityCodec, toSlimAlbum);
    collect('artist', response.artists, MinimalEntityCodec, toSlimArtist);
    collect('playlist', response.playlists, PlaylistResultCodec, toSlimPlaylist);
    return { totals, items };
  } catch (error) {
    const status = (error as { status?: number }).status;
    const code = typeof status === 'number' ? errorCodeFor(status) : 'bad_response';
    throw new Error(`Search failed: ${(error as Error).message} [${code}]`);
  }
}
