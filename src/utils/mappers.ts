/**
 * Mapper utilities to convert Spotify API responses to slim representations.
 */

import type {
  MinimalEntityCodecType,
  PlaylistDetailsResponseCodecType,
  PlaylistSimplifiedCodecType,
  TrackCodecType,
} from '../types/spotify.codecs.js';

export function toSlimTrack(t: TrackCodecType) {
  return {
    type: 'track' as const,
    id: String(t.id ?? ''),
    name: String(t.name ?? ''),
    uri: t.uri ?? undefined,
    url: t.external_urls?.spotify ?? undefined,
    artists: Array.isArray(t.artists)
      ? (t.artists.map((a) => a?.name).filter(Boolean) as string[])
      : [],
    album: t.album?.name ?? undefined,
    duration_ms: t.duration_ms ?? undefined,
  };
}

export function toPlaylistSummary(p: PlaylistSimplifiedCodecType) {
  return {
    id: String(p.id ?? ''),
    name: String(p.name ?? ''),
    uri: p.uri ?? undefined,
    url: p.external_urls?.spotify ?? undefined,
    public: typeof p.public === 'boolean' ? p.public : undefined,
    owner_name: p.owner?.display_name ?? undefined,
    images: pickLargestImageUrl(p.images),
    tracks_total: p.tracks?.total ?? undefined,
  };
}

export function toPlaylistDetails(p: PlaylistDetailsResponseCodecType) {
  return {
    id: String(p.id ?? ''),
    name: String(p.name ?? ''),
    description: p.description ?? undefined,
    uri: p.uri ?? undefined,
    url: p.external_urls?.spotify ?? undefined,
    public: typeof p.public === 'boolean' ? p.public : undefined,
    owner_name: p.owner?.display_name ?? undefined,
    images: pickLargestImageUrl(p.images),
    tracks_total: p.tracks?.total ?? undefined,
  };
}

function pickLargestImageUrl(
  images: Array<{ url?: string; width?: number; height?: number }> | unknown,
): string | undefined {
  const list: Array<{ url?: string; width?: number; height?: number }> = Array.isArray(
    images,
  )
    ? (images as Array<{ url?: string; width?: number; height?: number }>)
    : [];
  if (list.length === 0) {
    return undefined;
  }
  const sorted = [...list].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted[0]?.url || undefined;
}

export function toSlimAlbum(a: MinimalEntityCodecType) {
  return {
    type: 'album' as const,
    id: String(a.id ?? ''),
    name: String(a.name ?? ''),
    uri: a.uri ?? undefined,
    url: a.external_urls?.spotify ?? undefined,
  };
}

export function toSlimArtist(a: MinimalEntityCodecType) {
  return {
    type: 'artist' as const,
    id: String(a.id ?? ''),
    name: String(a.name ?? ''),
    uri: a.uri ?? undefined,
    url: a.external_urls?.spotify ?? undefined,
  };
}

export function toSlimPlaylist(
  p: MinimalEntityCodecType & { owner?: { display_name?: string | null } },
) {
  return {
    type: 'playlist' as const,
    id: String(p.id ?? ''),
    name: String(p.name ?? ''),
    uri: p.uri ?? undefined,
    url: p.external_urls?.spotify ?? undefined,
    owner: p.owner?.display_name ?? undefined,
  };
}
