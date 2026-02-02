import { z } from 'zod';

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
export const DeviceCodec = z.object({
  id: z.string().nullable(),
  name: z.string(),
  type: z.string(),
  is_active: z.boolean(),
  volume_percent: z.number().nullable().optional(),
});
export const DevicesResponseCodec = z.object({ devices: z.array(DeviceCodec) });
export type DevicesResponseCodecType = z.infer<typeof DevicesResponseCodec>;

// Player state
export const PlayerStateCodec = z.object({
  is_playing: z.boolean().optional(),
  shuffle_state: z.boolean().optional(),
  repeat_state: z.enum(['off', 'track', 'context']).optional(),
  progress_ms: z.number().optional(),
  timestamp: z.number().optional(),
  device: z.object({ id: z.string().optional() }).nullable().optional(),
  context: z.object({ uri: z.string().nullable().optional() }).nullable().optional(),
});
export type PlayerStateCodecType = z.infer<typeof PlayerStateCodec>;

// Currently playing
export const CurrentlyPlayingCodec = z.object({
  item: TrackCodec.nullable().optional(),
  is_playing: z.boolean().optional(),
});
export type CurrentlyPlayingCodecType = z.infer<typeof CurrentlyPlayingCodec>;

// Queue
export const QueueResponseCodec = z.object({
  currently_playing: TrackCodec.nullable().optional(),
  queue: z.array(TrackCodec).optional(),
});
export type QueueResponseCodecType = z.infer<typeof QueueResponseCodec>;

// Me
export const MeResponseCodec = z.object({ id: z.string().optional() });
export type MeResponseCodecType = z.infer<typeof MeResponseCodec>;

// Playlists (simplified)
export const PlaylistOwnerCodec = z
  .object({ display_name: z.string().nullable().optional() })
  .optional();
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
export type PlaylistListResponseCodecType = z.infer<typeof PlaylistListResponseCodec>;

export const PlaylistDetailsResponseCodec = PlaylistSimplifiedCodec.extend({
  description: z.string().nullable().optional(),
});
export type PlaylistDetailsResponseCodecType = z.infer<
  typeof PlaylistDetailsResponseCodec
>;

export const PlaylistTracksItemCodec = z.object({
  track: TrackCodec.nullable().optional(),
});
export const PlaylistTracksResponseCodec = z.object({
  items: z.array(PlaylistTracksItemCodec).optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  total: z.number().optional(),
});
export type PlaylistTracksResponseCodecType = z.infer<
  typeof PlaylistTracksResponseCodec
>;

// Library
export const SavedTracksItemCodec = z.object({
  track: TrackCodec.nullable().optional(),
});
export const SavedTracksResponseCodec = z.object({
  items: z.array(SavedTracksItemCodec).optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  total: z.number().optional(),
});
export type SavedTracksResponseCodecType = z.infer<typeof SavedTracksResponseCodec>;

// Snapshot
export const SnapshotResponseCodec = z.object({
  snapshot_id: z.string().optional(),
});
export type SnapshotResponseCodecType = z.infer<typeof SnapshotResponseCodec>;

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
export type SearchResponseCodecType = z.infer<typeof SearchResponseCodec>;

// Spotify Accounts Token response (refresh/access token exchange)
export const SpotifyTokenResponseCodec = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
export type SpotifyTokenResponseCodecType = z.infer<typeof SpotifyTokenResponseCodec>;




































