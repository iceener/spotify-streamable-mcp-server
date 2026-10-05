import * as z from 'zod/v4';

/**
 * The parts of Spotify Web API responses the tools read, validated before use, and the slim
 * shapes the tools return. Unknown fields are dropped.
 */

// Basic primitives
const ImageCodec = z.object({
  url: z.string().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
});

// Track (subset)
export const TrackCodec = z.object({
  id: z.string().nullable().optional(),
  uri: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  linked_from: z.object({ uri: z.string().optional() }).nullable().optional(),
  artists: z.array(z.object({ name: z.string().nullable().optional() })).optional(),
  album: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  external_urls: z.object({ spotify: z.string().optional() }).optional(),
});
export type TrackCodecType = z.infer<typeof TrackCodec>;

// Minimal entity for album/artist/playlist-like results
export const MinimalEntityCodec = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  uri: z.string().optional(),
  external_urls: z.object({ spotify: z.string().optional() }).optional(),
});
export type MinimalEntityCodecType = z.infer<typeof MinimalEntityCodec>;

// Devices
const DeviceCodec = z.object({
  id: z.string().nullable(),
  name: z.string(),
  type: z.string(),
  is_active: z.boolean(),
  volume_percent: z.number().nullable().optional(),
});
export const DevicesResponseCodec = z.object({ devices: z.array(DeviceCodec) });

// Player state
export const PlayerStateCodec = z.object({
  is_playing: z.boolean().optional(),
  shuffle_state: z.boolean().optional(),
  repeat_state: z.enum(['off', 'track', 'context']).optional(),
  progress_ms: z.number().optional(),
  timestamp: z.number().optional(),
  device: z.object({ id: z.string().nullable().optional() }).nullable().optional(),
  item: TrackCodec.nullable().optional(),
  context: z.object({ uri: z.string().nullable().optional() }).nullable().optional(),
});

// Currently playing
export const CurrentlyPlayingCodec = z.object({
  item: TrackCodec.nullable().optional(),
  is_playing: z.boolean().optional(),
});

// Queue
export const QueueResponseCodec = z.object({
  currently_playing: TrackCodec.nullable().optional(),
  queue: z.array(TrackCodec).optional(),
});

// Me
export const MeResponseCodec = z.object({ id: z.string().optional() });

// Playlists (simplified)
const PlaylistOwnerCodec = z.object({ display_name: z.string().nullable().optional() }).optional();
export const PlaylistSimplifiedCodec = z.object({
  id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  uri: z.string().nullable().optional(),
  external_urls: z.object({ spotify: z.string().optional() }).optional(),
  public: z.boolean().nullable().optional(),
  owner: PlaylistOwnerCodec,
  images: z.array(ImageCodec).nullable().optional(),
  tracks: z.object({ total: z.number().nullable().optional() }).optional(),
});
export type PlaylistSimplifiedCodecType = z.infer<typeof PlaylistSimplifiedCodec>;

export const PlaylistListResponseCodec = z.object({
  items: z.array(PlaylistSimplifiedCodec).optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  total: z.number().optional(),
});

export const PlaylistDetailsResponseCodec = PlaylistSimplifiedCodec.extend({
  description: z.string().nullable().optional(),
});
export type PlaylistDetailsResponseCodecType = z.infer<typeof PlaylistDetailsResponseCodec>;

const PlaylistTracksItemCodec = z.object({
  track: TrackCodec.nullable().optional(),
});
export const PlaylistTracksResponseCodec = z.object({
  items: z.array(PlaylistTracksItemCodec).optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  total: z.number().optional(),
});

// Library
const SavedTracksItemCodec = z.object({
  track: TrackCodec.nullable().optional(),
});
export const SavedTracksResponseCodec = z.object({
  items: z.array(SavedTracksItemCodec).optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  total: z.number().optional(),
});

// Snapshot
export const SnapshotResponseCodec = z.object({
  snapshot_id: z.string().optional(),
});

// Search response (minimal structure)
const SearchBlockCodec = z.object({
  items: z.array(z.unknown()).optional(),
  total: z.number().optional(),
});
export const SearchResponseCodec = z.object({
  tracks: SearchBlockCodec.optional(),
  artists: SearchBlockCodec.optional(),
  albums: SearchBlockCodec.optional(),
  playlists: SearchBlockCodec.optional(),
  shows: SearchBlockCodec.optional(),
  episodes: SearchBlockCodec.optional(),
  audiobooks: SearchBlockCodec.optional(),
});

// ---------------------------------------------------------------------------
// Slim shapes for tool results
// ---------------------------------------------------------------------------

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
  const list: Array<{ url?: string; width?: number; height?: number }> = Array.isArray(images)
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
  p: MinimalEntityCodecType & {
    owner?: { display_name?: string | null | undefined } | undefined;
  },
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
