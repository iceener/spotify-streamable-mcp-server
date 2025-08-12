### Spotify MCP Tools Catalog

Purpose: a concise, use-case–driven catalog of tools the agent can use to search, inspect, and control Spotify. Tools are grouped to minimize noise while preserving flexibility. Inputs are shown as Zod-like shapes; all tools enforce validation and timeouts.

Notes

- Authentication: some tools require user OAuth (see oauth.md). If a call returns Unauthorized, complete OAuth and retry.
- Annotations: readOnlyHint indicates no side effects; openWorldHint indicates external network calls.
- Error shape: failures set isError: true with a short message. Control per-operation results include `{ ok, error?, note?, device_id?, device_name?, from_device_id?, from_device_name?, code? }` plus a top-level `_msg` and `summary`.
- Post-action verification: `spotify_control` automatically fetches player status after actions and reports whether playback is active, the target device, current volume, and (when applicable) verifies the requested context/track.

### Design Rules & Conventions

These rules make tools robust and LLM-friendly, especially for bulk operations and low-token outputs.

- Batch-only interfaces where applicable

  - Search uses `queries: string[]` only (use a single-element array for one query); results are always batch-shaped.
  - Player control uses `operations: Operation[]` only; even one action is an array of length 1.
  - Playlist/Library accept arrays for URIs/IDs; batching is preferred. If a single item is needed, pass an array of length 1.
  - Batch semantics are per-item atomic; partial success is allowed and reported.

- Deterministic, scan-friendly outputs

  - Prefer inline, ordered `items: T[]` arrays for each batch/query, with each item containing its `id` and minimal fields needed to act.
  - You may include totals and counts, but avoid splitting identity and data across separate maps in the default output.
  - Each result echoes a correlation key: `inputIndex` plus an `echo` of the originating input (e.g., `query` or `operation` subset without secrets).

- Token-efficient shapes (Slim mappers)
  - Default outputs are "slim" to reduce tokens and avoid confusion.
  - Outputs are fixed; we do not include raw payloads.
  - Slim entity shapes used across tools:

```ts
type SlimTrack = {
  type: "track";
  id: string;
  uri: string;
  name: string;
  artists: string[];
  album?: string;
  duration_ms?: number;
  url?: string; // external_urls.spotify when available
};

type SlimPlaylist = {
  type: "playlist";
  id: string;
  uri: string;
  name: string;
  owner?: string;
  url?: string;
};

type SlimArtist = {
  type: "artist";
  id: string;
  uri: string;
  name: string;
  url?: string;
};
type SlimAlbum = {
  type: "album";
  id: string;
  uri: string;
  name: string;
  url?: string;
};

type SlimDevice = {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  volume_percent?: number | null;
};
```

- Device ID guidance (player control)

  - Many player endpoints accept an optional `device_id`. If omitted, the "currently active device" is targeted. Quote from Spotify docs:
    - “The device ID. This ID is unique and persistent to some extent. However, this is not guaranteed and any cached device_id should periodically be cleared out and refetched as necessary.” (Player Get State)
    - “device_id … If not supplied, the user's currently active device is the target.” (Pause/Play/Next/Previous/Seek/Repeat/Shuffle/Volume)
  - Recommended flow: call `spotify_status` to enumerate devices and select a `device_id`; if there is no active device, transfer first.

- Pagination and limits

  - Respect Spotify limits (search: `limit<=50`, offsets, library batch ids `<=50`). Always echo effective `limit`/`offset` and totals.

- Error reporting

  - Per-call failure: `{ isError:true, content:[{ type:"text", text }] }` — used only when the entire call cannot be processed.
  - Batch success cases: per-item `{ index, ok, error?, note? }` and an aggregate `{ ok, failed }` summary.

- Output message and minimalism
  - Every output includes `_msg: string` with actionable details the AI needs to proceed (names, URIs, device IDs, context URIs) and next‑step guidance. When listing items, `_msg` includes a compact preview (up to 20) as `- Name — URI`.
  - Control outputs are intentionally minimal per operation, but `_msg` still summarizes results and verification (device/context/track) and suggests remediation (e.g., run `player_status` to pick a device).

### Available Now

#### spotify_search

When to use: find tracks, artists, albums, playlists to act on. This uses app-level client credentials (no user auth), ideal for discovery before control.

- Auth: none (app token)
- Annotations: readOnlyHint=true, openWorldHint=true
- Input schema (batch-only; outputs are slim only)

```ts
{
  queries: z.array(z.string().min(1)).min(1).max(20).describe("Search queries; use a single-element array for one query."),
  types: z.array(z.enum([
    "album","artist","playlist","track"
  ])).min(1).describe("Item types to search across"),
  market: z.string().length(2).optional().describe("Market filter (ISO 3166-1 alpha-2), e.g., 'US'"),
  limit: z.number().min(1).max(50).default(20).describe("Max results per type"),
  offset: z.number().min(0).max(1000).default(0).describe("Pagination offset"),
  include_external: z.literal("audio").optional().describe("Whether externally hosted audio is playable"),
  // output shape is slim and fixed; raw payloads are not returned
}
```

- Output (batch) — SpotifySearchBatchOutput (slim)

```ts
{
  _msg: string; // e.g., "Processed 2 queries — 3× \"q1\", 0× \"q2\". No results for \"q2\". Review and select URIs to proceed."
  queries: string[]; // echo
  types: ("album"|"artist"|"playlist"|"track")[]; // echo
  limit: number;
  offset: number;
  batches: Array<{
    inputIndex: number; // correlates to queries[index]
    query: string; // echo
    totals: Record<string, number>; // counts by type
    items: (SlimTrack|SlimAlbum|SlimArtist|SlimPlaylist)[]; // ordered results for this query
  }>;
}
```

- Typical flows

  - “Play Instant Crush” → search for type "track" then control.play with that track URI.
    -- Examples

  - Request (batch, single query)

  ```json
  {
    "queries": ["Instant Crush daft punk"],
    "types": ["track"],
    "limit": 3,
    "mode": "slim"
  }
  ```

  - Minimal result

  ```json
  {
    "_msg": "Results for \"Instant Crush daft punk\":\n- [track] Instant Crush — spotify:track:4cJPC6Y0d1ias1xK2lB9S2",
    "queries": ["Instant Crush daft punk"],
    "types": ["track"],
    "limit": 3,
    "offset": 0,
    "batches": [
      {
        "inputIndex": 0,
        "query": "Instant Crush daft punk",
        "totals": { "track": 3 },
        "items": [
          {
            "type": "track",
            "id": "4cJPC6Y0d1ias1xK2lB9S2",
            "uri": "spotify:track:4cJPC6Y0d1ias1xK2lB9S2",
            "name": "Instant Crush",
            "artists": ["Daft Punk", "Julian Casablancas"]
          }
        ]
      }
    ]
  }
  ```

  - “Make a playlist with 10 upbeat Daft Punk tracks” → search tracks, then playlist add (planned).

#### spotify_status

When to use: inspect player state, list devices, fetch queue, or get the currently playing track. Run this before control actions to learn device_id. Note: `spotify_control` already returns a concise post-action status; use `spotify_status` for full detail.

- Auth: user OAuth required
- Annotations: readOnlyHint=true, openWorldHint=true
- Input schema

```ts
{
  include: z.array(
    z.enum(["player", "devices", "queue", "current_track"])
  ).default(["player", "devices", "current_track"]).describe("Sections to include in the response"),
  // output is slim only
}
```

- Output (SpotifyStatusOutput)

```ts
{
  _msg: string; // e.g., "status: player+devices"
  player?: { is_playing:boolean; shuffle_state?:boolean; repeat_state?:"off"|"track"|"context";
             progress_ms?:number; timestamp?:number; device_id?:string; context_uri?:string|null };
  current_track?: SlimTrack | null;
  devices?: SlimDevice[];
  devicesById?: Record<string, SlimDevice>; // convenience keying by device id
  queue?: { current_id?: string | null; next_ids: string[]; byId?: Record<string, SlimTrack> };
}
```

- Tips
  - If no active device is available, surface devices and prompt the user to pick one, then use control.transfer.
  - Treat 204 from currently‑playing as “nothing playing”.
  - Device ID stability: “This ID is unique and persistent to some extent … any cached device_id should periodically be cleared out and refetched.”

-- Examples

- Request

```json
{
  "include": ["player", "devices", "current_track"]
}
```

- Minimal result

```json
{
  "_msg": "'Instant Crush' is playing on device 'Kitchen speaker'. Context: spotify:album:...",
  "player": { "is_playing": true, "device_id": "74ASZWbe4lXaubB36ztrGX" },
  "current_track": {
    "type": "track",
    "id": "4cJPC6Y0d1ias1xK2lB9S2",
    "uri": "spotify:track:4cJPC6Y0d1ias1xK2lB9S2",
    "name": "Instant Crush",
    "artists": ["Daft Punk", "Julian Casablancas"],
    "album": "Random Access Memories",
    "duration_ms": 337093
  },
  "devices": [
    {
      "id": "74ASZWbe4lXaubB36ztrGX",
      "name": "Kitchen speaker",
      "type": "computer",
      "is_active": true
    }
  ],
  "devicesById": {
    "74ASZWbe4lXaubB36ztrGX": {
      "id": "74ASZWbe4lXaubB36ztrGX",
      "name": "Kitchen speaker",
      "type": "computer",
      "is_active": true
    }
  }
}
```

#### spotify_control

When to use: play/pause/seek/volume/shuffle/repeat, transfer to a device, start playback of a context or specific tracks, and queue a track.

- Auth: user OAuth required
- Annotations: readOnlyHint=false, openWorldHint=true
- Input schema (batch-only)

```ts
{
  operations: z.array(
    z.object({
      action: z
        .enum([
          "play",
          "pause",
          "next",
          "previous",
          "seek",
          "volume",
          "shuffle",
          "repeat",
          "transfer",
          "queue",
        ])
        .describe("Player command"),
      device_id: z
        .string()
        .optional()
        .describe("Target device; if omitted, uses active device"),
      position_ms: z
        .number()
        .nonnegative()
        .optional()
        .describe("Seek position in ms (seek)"),
      volume_percent: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Volume 0-100 (volume)"),
      shuffle: z
        .boolean()
        .optional()
        .describe("Enable/disable shuffle (shuffle)"),
      repeat: z
        .enum(["off", "track", "context"])
        .optional()
        .describe("Repeat mode (repeat)"),
      context_uri: z
        .string()
        .optional()
        .describe("Spotify context URI (playlist/album/artist) for play"),
      uris: z.array(z.string()).optional().describe("Track URIs for play"),
      offset: z
        .object({
          position: z.number().nonnegative().optional(),
          uri: z.string().optional(),
        })
        .optional()
        .describe("Start offset within context"),
      queue_uri: z
        .string()
        .optional()
        .describe("Track/episode URI to queue (queue)"),
      transfer_play: z
        .boolean()
        .optional()
        .describe("Start playing after transfer (transfer)"),
    })
  )
    .min(1)
    .max(25)
    .describe(
      "Actions to perform in order; each item is executed independently"
    );
}
```

- Output (batch-only)

```ts
{
  _msg: string; // e.g., "All 3 actions succeeded. Playback started on 'Kitchen speaker'."
  results: Array<{
    index: number; // correlates to operations[index]
    action: string;
    ok: boolean;
    note?: string; // short extra info e.g., "volume set to 50"
    device_id?: string; // effective device used
    error?: string; // present if ok=false
  }>;
  summary: {
    ok: number;
    failed: number;
  }
}
```

- Decision rules

  - Unknown device → call spotify_status first; choose device_id; then control.transfer or control.play with device_id.
  - “Play this playlist” → control.play with context_uri of the playlist.
  - “Queue this track” → control.queue with queue_uri.

- Required fields per action

  - `seek` → `position_ms` required
  - `volume` → `volume_percent` required
  - `shuffle` → `shuffle` required
  - `repeat` → `repeat` required
  - `queue` → `queue_uri` required
  - `play` (start new context) → at least one of `context_uri` or `uris` required; `offset` optional

- Defaults

  - `transfer` → `transfer_play` defaults to `true` if omitted

- Device note
  - For actions that target a specific device, include `device_id`. If omitted, the active device is targeted. If no device is active or control is restricted, fetch devices then transfer. (See `player-api.md` “device_id” parameter on play/pause/seek/… and “Transfer Playback”).

### Planned Tools (Next)

The following consolidate related operations into a small number of tools with an action field to avoid flooding the tool list while keeping expressiveness.

#### spotify_playlist

Manage playlists for the current user: list, read details/items, create, update, add/remove/reorder items. Use after search to materialize results into a playlist.

- Auth: user OAuth required
- Annotations: readOnlyHint=false for mutating actions; true for read ones; openWorldHint=true
- Input schema

```ts
{
  action: z.enum([
    "list_user",      // list current user's playlists
    "get",            // get a playlist's core details
    "items",          // list items of a playlist
    "create",         // create a playlist for the current user
    "update_details", // change name/description/public/collaborative
    "add_items",      // add track/episode URIs (supports bulk)
    "remove_items",   // remove by URIs (supports bulk)
    "reorder_items"   // reorder a span
  ]),
  playlist_id?: z.string(),
  // listing
  limit?: z.number().int().min(1).max(50).default(20).describe("Max items per page"),
  offset?: z.number().int().min(0).max(100000).default(0).describe("Offset for pagination"),
  // details/items
  market?: z.string().length(2).optional().describe("Market filter (ISO country code)"),
  fields?: z.string().optional().describe("Spotify fields filter (advanced)"),
  additional_types?: z.enum(["track","episode"]).optional().describe("Include episodes where applicable"),
  // create/update
  name?: z.string().describe("Playlist name"),
  description?: z.string().optional().describe("Playlist description"),
  public?: z.boolean().optional().describe("Visibility"),
  collaborative?: z.boolean().optional().describe("Collaborative flag (requires public=false in some cases)"),
  // add/remove/reorder
  uris?: z.array(z.string()).max(100).optional().describe("Track/episode URIs to add/remove; chunked internally"),
  tracks?: z.array(z.object({ uri: z.string() })).optional().describe("Alternative add payload form"),
  range_start?: z.number().int().nonnegative().optional().describe("Start index for reorder"),
  insert_before?: z.number().int().nonnegative().optional().describe("Insertion index for reorder"),
  range_length?: z.number().int().positive().optional().describe("Length for reorder"),
  snapshot_id?: z.string().optional().describe("Snapshot id for concurrency control")
}
```

- Outputs
  - list/get/items: `{ _msg: string, byId?: Record<string, SlimTrack|SlimPlaylist>, ids?: string[], limit?: number, offset?: number, total?: number }` (prefer slim mappers). When returning many items, include `byId` + ordered `ids`.
  - create/update: playlist object (create) or empty (update), with `_msg` summarizing the action.
  - add/remove/reorder: `{ _msg: string, snapshot_id?: string, ok?: true }`
- Example flows
  - “Create a ‘Focus’ playlist with these 10 tracks” → playlist.create (name/description/public) → playlist.add_items with URIs.
  - “Move track 1 to the end” → playlist.reorder_items with positions.

-- Examples

- Request (list current user's playlists)

```json
{ "action": "list_user", "limit": 2 }
```

- Minimal result

```json
{
  "_msg": "Found 2 playlists:\n- Today's Top Hits — spotify:playlist:37i9dQZF1DXcBWIGoYBM5M\n- Focus — spotify:playlist:4hSGs6Xsyi6bG7iWQKZKQ2",
  "byId": {
    "37i9dQZF1DXcBWIGoYBM5M": {
      "type": "playlist",
      "id": "37i9dQZF1DXcBWIGoYBM5M",
      "uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
      "name": "Today's Top Hits"
    },
    "4hSGs6Xsyi6bG7iWQKZKQ2": {
      "type": "playlist",
      "id": "4hSGs6Xsyi6bG7iWQKZKQ2",
      "uri": "spotify:playlist:4hSGs6Xsyi6bG7iWQKZKQ2",
      "name": "Focus"
    }
  },
  "ids": ["37i9dQZF1DXcBWIGoYBM5M", "4hSGs6Xsyi6bG7iWQKZKQ2"],
  "limit": 2,
  "offset": 0,
  "total": 42
}
```

- Request (add items to playlist)

```json
{
  "action": "add_items",
  "playlist_id": "37i9dQZF1DXcBWIGoYBM5M",
  "uris": [
    "spotify:track:4iV5W9uYEdYUVa79Axb7Rh",
    "spotify:track:1301WleyT98MSxVHPZCA6M"
  ]
}
```

- Minimal result

```json
{ "_msg": "playlist.add_items: 2 added", "snapshot_id": "abc123" }
```

#### spotify_library

Manage the user’s saved tracks. Use to pin songs to Your Library or check if certain tracks are already saved.

- Auth: user OAuth required
- Annotations: readOnlyHint=true for read actions; false for write; openWorldHint=true
- Input schema

```ts
{
  action: z.enum(["tracks_get","tracks_add","tracks_remove","tracks_contains"]),
  // get
  market?: z.string().length(2).optional().describe("Market filter (ISO country code)"),
  limit?: z.number().int().min(1).max(50).default(20).describe("Max items per page"),
  offset?: z.number().int().min(0).max(1000).default(0).describe("Offset for pagination"),
  // add/remove/contains
  ids?: z.array(z.string()).max(50).optional().describe("Track IDs; up to 50 per request")
}
```

- Outputs
  - tracks_get: `{ _msg: string, byId: Record<string, SlimTrack>, ids: string[], limit: number, offset: number, total: number }`
  - tracks_add/remove: `{ _msg: string, ids?: string[] }`
  - tracks_contains: `{ _msg: string, ids: string[], contains: boolean[] }` with positional alignment and identical `ids` echo
- Example flows
  - “Save this song” → library.tracks_add with the track’s ID.
  - “Am I already saving these?” → library.tracks_contains with IDs.

-- Examples

- Request (check if tracks are saved)

```json
{
  "action": "tracks_contains",
  "ids": ["4iV5W9uYEdYUVa79Axb7Rh", "1301WleyT98MSxVHPZCA6M"]
}
```

- Minimal result

```json
{
  "_msg": "Already saved: 1/2. Saved: Instant Crush",
  "ids": ["4iV5W9uYEdYUVa79Axb7Rh", "1301WleyT98MSxVHPZCA6M"],
  "contains": [true, false]
}
```

- Request (get saved tracks)

```json
{ "action": "tracks_get", "limit": 2, "offset": 0 }
```

- Minimal result

```json
{
  "_msg": "Loaded 2 saved track(s):\n- Instant Crush — spotify:track:4cJPC6Y0d1ias1xK2lB9S2\n- Get Lucky — spotify:track:1301WleyT98MSxVHPZCA6M",
  "byId": {
    "4cJPC6Y0d1ias1xK2lB9S2": {
      "type": "track",
      "id": "4cJPC6Y0d1ias1xK2lB9S2",
      "uri": "spotify:track:4cJPC6Y0d1ias1xK2lB9S2",
      "name": "Instant Crush",
      "artists": ["Daft Punk", "Julian Casablancas"]
    },
    "1301WleyT98MSxVHPZCA6M": {
      "type": "track",
      "id": "1301WleyT98MSxVHPZCA6M",
      "uri": "spotify:track:1301WleyT98MSxVHPZCA6M",
      "name": "Get Lucky",
      "artists": ["Daft Punk", "Pharrell Williams"]
    }
  },
  "ids": ["4cJPC6Y0d1ias1xK2lB9S2", "1301WleyT98MSxVHPZCA6M"],
  "limit": 2,
  "offset": 0,
  "total": 350
}
```

### Decision Guide (Agent Heuristics)

- Play something by name

  1. spotify_search (type=track|album|playlist) → choose URI
  2. spotify_status (devices) if needed → pick device_id
  3. spotify_control.play with context_uri/uris (+device_id). The tool will verify playback and context/track.

- Resume or transfer playback

  1. spotify_status (player, devices)
  2. If target device different → spotify_control.transfer
  3. Else spotify_control.play

- Queue a track next

  1. spotify_search (track)
  2. spotify_control.queue with queue_uri

- Build or edit a playlist (planned)
  1. spotify_playlist.create
  2. spotify_search then spotify_playlist.add_items
  3. spotify_playlist.reorder_items or update_details as needed

### References

- Player endpoints used: see `player-api.md`
  - Search normalization: see `spotify-api.md`
- Tracks/library endpoints: see `spotify-tracks-api.md`
- Playlists endpoints: see `spotify-playlist-api`
