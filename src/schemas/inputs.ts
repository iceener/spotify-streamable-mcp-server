import { z } from 'zod';

// Search
export const SpotifySearchInputSchema = z.object({
  queries: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe(
      "Search strings. Pass one or more; each runs separately. Supports field filters like 'track:', 'artist:', 'year:'.",
    ),
  types: z
    .array(z.enum(['album', 'artist', 'playlist', 'track']))
    .min(1)
    .describe(
      "Item categories to search across. Supported: 'album', 'artist', 'playlist', 'track'.",
    ),
  market: z
    .string()
    .length(2)
    .optional()
    .describe(
      '2-letter country code (ISO 3166-1). Returns only content available in that market.',
    ),
  limit: z
    .number()
    .min(1)
    .max(50)
    .default(20)
    .describe('Max results per item type (1-50).'),
  offset: z
    .number()
    .min(0)
    .max(1000)
    .default(0)
    .describe('Index of first result (0-1000).'),
  include_external: z
    .literal('audio')
    .optional()
    .describe("If set to 'audio', mark externally hosted audio as playable."),
});
export type SpotifySearchInput = z.infer<typeof SpotifySearchInputSchema>;

// Status
export const SpotifyStatusInputSchema = z.object({
  include: z
    .array(z.enum(['player', 'devices', 'queue', 'current_track']))
    .default(['player', 'devices', 'current_track'])
    .describe(
      "Which sections to fetch: 'player', 'devices', 'queue', 'current_track'.",
    ),
});
export type SpotifyStatusInput = z.infer<typeof SpotifyStatusInputSchema>;

// Control
export const SpotifyControlInputSchema = z.object({
  operations: z
    .array(
      z.object({
        action: z
          .enum([
            'play',
            'pause',
            'next',
            'previous',
            'seek',
            'volume',
            'shuffle',
            'repeat',
            'transfer',
            'queue',
          ])
          .describe('Operation to perform.'),
        device_id: z
          .string()
          .optional()
          .describe(
            "Target device. Get via 'player_status' → devices[].id. Required for 'transfer'; optional for others.",
          ),
        position_ms: z
          .number()
          .nonnegative()
          .optional()
          .describe('Seek or start playback from this position (milliseconds).'),
        volume_percent: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Volume level 0-100 for volume action.'),
        shuffle: z.boolean().optional().describe('Shuffle on/off for shuffle action.'),
        repeat: z
          .enum(['off', 'track', 'context'])
          .optional()
          .describe('Repeat mode for repeat action.'),
        context_uri: z
          .string()
          .optional()
          .describe(
            "Playback context URI (album/artist/playlist). Mutually exclusive with 'uris'. Use with 'offset' to pick a specific track (album/playlist only).",
          ),
        uris: z
          .array(z.string())
          .optional()
          .describe(
            "Track URIs to play directly. Do not provide together with 'context_uri'.",
          ),
        offset: z
          .object({
            position: z.number().nonnegative().optional(),
            uri: z.string().optional(),
          })
          .optional()
          .describe(
            'Start point within the context: zero-based position or an item URI present in the context (album/playlist).',
          ),
        queue_uri: z
          .string()
          .optional()
          .describe('Item URI to add to the queue (track or episode).'),
        transfer_play: z
          .boolean()
          .optional()
          .describe('When transferring, start playback immediately on the new device.'),
      }),
    )
    .min(1)
    .max(25)
    .describe('Batch of 1-25 operations.'),
  parallel: z
    .boolean()
    .optional()
    .describe(
      'If true, run all operations concurrently. Default is sequential execution in given order for safety.',
    ),
});
export type SpotifyControlInput = z.infer<typeof SpotifyControlInputSchema>;

// Playlist
export const SpotifyPlaylistInputSchema = z.object({
  action: z
    .enum([
      'list_user',
      'get',
      'items',
      'create',
      'update_details',
      'add_items',
      'remove_items',
      'reorder_items',
    ])
    .describe(
      'Playlist action: list_user, get, items, create, update_details, add_items, remove_items, reorder_items.',
    ),
  playlist_id: z
    .string()
    .optional()
    .describe(
      'Target playlist ID. Required for get/items/update_details/add_items/remove_items/reorder_items.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .optional()
    .describe('Pagination limit (1-50) for list_user/items.'),
  offset: z
    .number()
    .int()
    .min(0)
    .max(100000)
    .default(0)
    .optional()
    .describe('Pagination offset for list_user/items.'),
  market: z
    .string()
    .length(2)
    .optional()
    .describe('2-letter country code for get/items.'),
  fields: z
    .string()
    .optional()
    .describe("Spotify 'fields' filter to select response fields (get/items)."),
  additional_types: z
    .enum(['track', 'episode'])
    .optional()
    .describe("Include 'episode' items when listing playlist items (items)."),
  name: z.string().optional().describe('Playlist name (create/update_details).'),
  description: z
    .string()
    .optional()
    .describe('Playlist description (create/update_details).'),
  public: z
    .boolean()
    .optional()
    .describe('Whether the playlist is public (create/update_details).'),
  collaborative: z
    .boolean()
    .optional()
    .describe('Whether the playlist is collaborative (create/update_details).'),
  uris: z.array(z.string()).optional().describe('Track URIs to add (add_items).'),
  tracks: z
    .array(z.object({ uri: z.string() }))
    .optional()
    .describe('Tracks to remove by URI: [{ uri }] (remove_items).'),
  range_start: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Start index of the range to move (reorder_items).'),
  insert_before: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Insert the range before this index (reorder_items).'),
  range_length: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Length of the range (default 1) (reorder_items).'),
  snapshot_id: z
    .string()
    .optional()
    .describe(
      'Optional snapshot for concurrency control (remove_items/reorder_items).',
    ),
});
export type SpotifyPlaylistInput = z.infer<typeof SpotifyPlaylistInputSchema>;

// Library
export const SpotifyLibraryInputSchema = z.object({
  action: z
    .enum(['tracks_get', 'tracks_add', 'tracks_remove', 'tracks_contains'])
    .describe('Saved songs action.'),
  market: z
    .string()
    .length(2)
    .optional()
    .describe('2-letter country code (tracks_get only).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .optional()
    .describe('Pagination limit for tracks_get.'),
  offset: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(0)
    .optional()
    .describe('Pagination offset for tracks_get.'),
  ids: z
    .array(z.string())
    .max(50)
    .optional()
    .describe('Spotify track IDs (not URIs). Required for tracks_add/remove/contains.'),
});
export type SpotifyLibraryInput = z.infer<typeof SpotifyLibraryInputSchema>;

// Example tool inputs
export const AddInputSchema = z.object({ a: z.number(), b: z.number() }).strict();
export type AddInput = z.infer<typeof AddInputSchema>;
