/**
 * Output schemas for Spotify MCP tools.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Slim entities used across outputs
// ---------------------------------------------------------------------------

const SlimTrackSchema = z.object({
  type: z.literal('track'),
  id: z.string(),
  uri: z.string().optional(),
  name: z.string(),
  artists: z.array(z.string()),
  album: z.string().optional(),
  duration_ms: z.number().optional(),
  url: z.string().url().optional(),
});
export type SlimTrack = z.infer<typeof SlimTrackSchema>;

const SlimArtistSchema = z.object({
  type: z.literal('artist'),
  id: z.string(),
  uri: z.string().optional(),
  name: z.string(),
  url: z.string().url().optional(),
});
export type SlimArtist = z.infer<typeof SlimArtistSchema>;

const SlimAlbumSchema = z.object({
  type: z.literal('album'),
  id: z.string(),
  uri: z.string().optional(),
  name: z.string(),
  url: z.string().url().optional(),
});
export type SlimAlbum = z.infer<typeof SlimAlbumSchema>;

const SlimPlaylistSchema = z.object({
  type: z.literal('playlist'),
  id: z.string(),
  uri: z.string().optional(),
  name: z.string(),
  owner: z.string().optional(),
  url: z.string().url().optional(),
});
export type SlimPlaylist = z.infer<typeof SlimPlaylistSchema>;

const SlimDeviceSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  type: z.string(),
  is_active: z.boolean(),
  volume_percent: z.number().nullable().optional(),
});
export type SlimDevice = z.infer<typeof SlimDeviceSchema>;

// ---------------------------------------------------------------------------
// Search Output
// ---------------------------------------------------------------------------

export const SpotifySearchBatchOutput = z.object({
  _msg: z.string(),
  queries: z.array(z.string()),
  types: z.array(z.enum(['album', 'artist', 'playlist', 'track'])),
  limit: z.number(),
  offset: z.number(),
  batches: z.array(
    z.object({
      inputIndex: z.number().int().nonnegative(),
      query: z.string(),
      totals: z.record(z.number()),
      items: z.array(
        z.union([
          SlimTrackSchema,
          SlimAlbumSchema,
          SlimArtistSchema,
          SlimPlaylistSchema,
        ]),
      ),
    }),
  ),
});
export type SpotifySearchBatchOutput = z.infer<typeof SpotifySearchBatchOutput>;

// ---------------------------------------------------------------------------
// Status Output
// ---------------------------------------------------------------------------

export const SpotifyStatusOutput = z.object({
  _msg: z.string().optional(),
  player: z
    .object({
      is_playing: z.boolean(),
      shuffle_state: z.boolean().optional(),
      repeat_state: z.enum(['off', 'track', 'context']).optional(),
      progress_ms: z.number().optional(),
      timestamp: z.number().optional(),
      device_id: z.string().optional(),
      context_uri: z.string().nullable().optional(),
    })
    .optional(),
  current_track: SlimTrackSchema.nullable().optional(),
  devices: z.array(SlimDeviceSchema).optional(),
  devicesById: z.record(SlimDeviceSchema).optional(),
  queue: z
    .object({
      current_id: z.string().nullable().optional(),
      next_ids: z.array(z.string()),
      byId: z.record(SlimTrackSchema).optional(),
    })
    .optional(),
});
export type SpotifyStatusOutput = z.infer<typeof SpotifyStatusOutput>;

// Provide plain object schema for registration API
export const SpotifyStatusOutputObject = SpotifyStatusOutput;
export type SpotifyStatusOutputObject = SpotifyStatusOutput;

// ---------------------------------------------------------------------------
// Control Output
// ---------------------------------------------------------------------------

export const SpotifyControlBatchOutput = z.object({
  _msg: z.string(),
  results: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      action: z.string(),
      ok: z.boolean(),
      note: z.string().optional(),
      device_id: z.string().optional(),
      device_name: z.string().optional(),
      from_device_id: z.string().optional(),
      from_device_name: z.string().optional(),
      error: z.string().optional(),
      code: z
        .enum(['unauthorized', 'forbidden', 'rate_limited', 'bad_response'])
        .optional(),
    }),
  ),
  summary: z.object({ ok: z.number().int(), failed: z.number().int() }),
});
export type SpotifyControlBatchOutput = z.infer<typeof SpotifyControlBatchOutput>;

// ---------------------------------------------------------------------------
// Playlist Output
// ---------------------------------------------------------------------------

export const SpotifyPlaylistOutputObject = z.object({
  ok: z.boolean(),
  action: z.string(),
  _msg: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});
export type SpotifyPlaylistOutputObject = z.infer<typeof SpotifyPlaylistOutputObject>;

// ---------------------------------------------------------------------------
// Library Output
// ---------------------------------------------------------------------------

export const SpotifyLibraryOutputObject = z.object({
  ok: z.boolean(),
  action: z.string(),
  _msg: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});
export type SpotifyLibraryOutputObject = z.infer<typeof SpotifyLibraryOutputObject>;

// ---------------------------------------------------------------------------
// Health Output (kept from template)
// ---------------------------------------------------------------------------

export const HealthOutput = z.object({
  status: z.enum(['ok', 'degraded', 'error']),
  timestamp: z.number(),
  uptime: z.number(),
});
export type HealthOutput = z.infer<typeof HealthOutput>;
