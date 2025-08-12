## Spotify MCP Server (Streamable HTTP / OAuth / Remote)

Streamable HTTP MCP server for Spotify exposes tools to search the catalog, read player status, control playback and devices, manage playlists, and manage your saved songs.

Author: [overment](https://x.com/_overment).

> [!WARNING]
> This warning applies only to the HTTP transport and OAuth wrapper (Authorization Server / Resource Server) included for convenience. They are intended for personal/local use and are not production‑hardened. The bundled HTTP server exists solely to make it easy to connect your agent or UI.
>
> The MCP tools and schemas themselves are implemented with strong validation, slim outputs, clear error handling, and other best practices.
>
> If you plan to deploy remotely, replace the OAuth/HTTP layer with production infrastructure: proper token validation/introspection, secure storage, TLS termination, strict CORS/origin checks, rate limiting, audit logging, persistence for sessions/tokens, and compliance with Spotify’s terms.

### Motivation

At first glance, a "Spotify MCP" may seem unnecessary—pressing play or skipping a song is often faster by hand. It becomes genuinely useful when you don’t know the exact title (e.g., “soundtrack from [movie title]”), when you want to “create and play a playlist that matches my mood”, or when you’re using voice. This MCP lets an LLM handle the fuzzy intent → search → selection → control loop, and it returns clear confirmations of what happened. It works well with voice interfaces and can be connected to agents/workflows for smart‑home automations.

Example:

![](https://github.com/iceener/spotify-streamable-mcp-server/_spec/heyalice-app.gif)

Note: This UI ^ is [Alice](https://heyalice.app), a desktop app. That’s one of my projects.

![](https://github.com/iceener/spotify-streamable-mcp-server/_spec/claude-desktop.gif)

This UI ^ is Claude Desktop.

### Installation

1. Clone and install

```bash
git clone https://github.com/overment/mcp.git
cd mcp/servers/spotify
bun install
```

2. Prepare environment

```bash
cp env.example .env
```

Edit `.env` and set at minimum:

```env
PORT=3030
HOST=127.0.0.1
AUTH_ENABLED=true

# Spotify developer app credentials
SPOTIFY_CLIENT_ID=<your_client_id>
SPOTIFY_CLIENT_SECRET=<your_client_secret>

# Redirect URIs Allowlist
OAUTH_REDIRECT_ALLOWLIST=https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback

# Authorization Server callback (this server) used to receive Spotify code
REDIRECT_URI=http://127.0.0.1:3031/spotify/callback

# Spotify endpoints (defaults)
SPOTIFY_API_URL=https://api.spotify.com/v1
SPOTIFY_ACCOUNTS_URL=https://accounts.spotify.com
```

3. Configure Redirect URIs in Spotify Dashboard

In your Spotify Developer Dashboard → App → Redirect URIs, add:

```text
alice://oauth/callback - that's for Alice app if you use it.
http://127.0.0.1:3031/spotify/callback
```

4. Run the server

```bash
bun dev
# MCP endpoint:        http://127.0.0.1:3030/mcp
# Authorization Server: http://127.0.0.1:3031
```

5. Connect your agent/UI

Point your bridge/client to the MCP endpoint, for example `http://127.0.0.1:3030/mcp` (see “Client configuration” below for Claude Desktop).

### What the model sees (server instructions)

The server advertises a concise description to clients so models can use it effectively without loading the full schema. This description summarizes tools, key rules, and usage patterns.

Design notes (LLM-friendly by intent):

- Tools do not mirror Spotify’s API 1:1. Interfaces are simplified and unified to reduce confusion.
- Wherever possible, operations are batch-first (e.g., `queries[]`, `operations[]`) to minimize tool invocations and make intent explicit.
- Every tool returns human-friendly feedback that clearly states what succeeded and what didn’t, with next-step guidance.
- For player control, the server performs best‑effort background verification (e.g., checking device, context, and current track) because Spotify’s API can be ambiguous about immediate state.

---

### MCP identity

- Name: `Spotify Music`
- Instructions (shown to the model):

> [!NOTE]
> Server description below is what clients present to the model as the MCP Server’s "instructions." It’s designed to give a clear mental model of the server’s capabilities without diving into every schema detail.

```text
Use these tools to find music, get the current player status, control and transfer playback, and manage playlists and saved songs.

Tools
- search_catalog: Find songs, artists, albums, or playlists. Inputs: queries[], types[album|artist|playlist|track], optional market (2-letter), limit (1-50), offset (0-1000), include_external['audio']. Returns per-query ordered items (slim fields like id, name, uri; tracks include artists).
- player_status: Read current player, available devices, queue, and current track. Use this first to discover device_id before control.
- spotify_control: Batch control with operations[]. action ∈ {play,pause,next,previous,seek,volume,shuffle,repeat,transfer,queue}. Provide matching params (position_ms, volume_percent, repeat, device_id, context_uri/uris, offset, queue_uri, transfer_play). Optional parallel=true runs operations concurrently. The tool automatically fetches player status after actions and reports whether playback is active, the target device, and current volume. Before transfer, call player_status to pick a device; if no active device exists, ask the user to open Spotify.
- spotify_playlist: Manage playlists. action ∈ {list_user,get,items,create,update_details,add_items,remove_items,reorder_items}.
- spotify_library: Manage saved songs. action ∈ {tracks_get,tracks_add,tracks_remove,tracks_contains}.

Notes
- If a call returns Unauthorized, ask the user to authenticate and retry.
- Prefer small limits and minimal polling unless asked to do otherwise.
- Use player_status to pick device_id before control. If no active device is found, prompt the user to open Spotify and/or transfer to a listed device.
- After control actions, the tool includes a concise status. For full details, you can still call player_status. If not playing, ask the user to open Spotify or transfer to a listed device.
```

### Tool design and conventions (LLM-friendly)

- Batch-only where applicable: `queries: string[]` for search; `operations[]` for control.
- Deterministic slim outputs: fixed shapes with minimal fields (`id`, `uri`, `name`, etc.).
- Every tool returns a human-readable `_msg` summary. Control verifies context/track and device when possible.
- Error handling: whole-call errors set `isError: true`; batch results include per-item `{ ok, error? }` and an aggregate summary.

#### Returned messages

- Each tool returns a concise human message in two places:
  - `structuredContent._msg` (or `structuredContent.error` on failure)
  - `content: [{ type: "text", text: "<same message>" }, ... ]`

These are intended to be shown directly to users, with one of them designed for older MCP clients.

### Tools catalog (name, description, inputs, outputs)

1. `search_catalog`

- Description: Search songs, artists, albums, and playlists. Inputs: `queries[]`, `types[album|artist|playlist|track]`, optional `market`, `limit(1-50)`, `offset(0-1000)`, `include_external['audio']`.
- Auth/annotations: readOnlyHint=true, openWorldHint=true (app token; no user OAuth).
- Input shape:

```ts
{
  queries: string[];
  types: ("album"|"artist"|"playlist"|"track")[];
  market?: string; // 2-letter
  limit?: number;  // 1..50 (default 20)
  offset?: number; // 0..1000 (default 0)
  include_external?: "audio";
}
```

- Output shape (SpotifySearchBatchOutput, slim):

```ts
{
  _msg: string;
  queries: string[];
  types: ("album"|"artist"|"playlist"|"track")[];
  limit: number;
  offset: number;
  batches: Array<{
    inputIndex: number;
    query: string;
    totals: Record<string, number>;
    items: Array<SlimTrack|SlimAlbum|SlimArtist|SlimPlaylist>;
  }>;
}
```

2. `player_status`

- Description: Read the current player state, devices, queue, and current track. Use this to learn `device_id` before control.
- Auth/annotations: readOnlyHint=true, openWorldHint=true (user OAuth required).
- Input shape:

```ts
{ include?: ("player"|"devices"|"queue"|"current_track")[] }
```

- Output shape (SpotifyStatusOutput):

```ts
{
  _msg: string;
  player?: {
    is_playing: boolean;
    shuffle_state?: boolean;
    repeat_state?: "off"|"track"|"context";
    progress_ms?: number;
    timestamp?: number;
    device_id?: string;
    context_uri?: string|null;
  };
  current_track?: SlimTrack | null;
  devices?: SlimDevice[];
  devicesById?: Record<string, SlimDevice>;
  queue?: { current_id?: string | null; next_ids: string[] };
}
```

3. `spotify_control`

- Description: Control Spotify playback: play, pause, next/previous, seek, shuffle, repeat, volume, transfer, and queue. Batch interface; optional `parallel=true`. Verifies device/context/track when possible and returns a concise status.
- Auth/annotations: readOnlyHint=false, openWorldHint=true (user OAuth required).
- Input shape:

```ts
{
  operations: Array<{
    action: "play"|"pause"|"next"|"previous"|"seek"|"volume"|"shuffle"|"repeat"|"transfer"|"queue";
    device_id?: string;
    position_ms?: number;
    volume_percent?: number;
    shuffle?: boolean;
    repeat?: "off"|"track"|"context";
    context_uri?: string;
    uris?: string[];
    offset?: { position?: number; uri?: string };
    queue_uri?: string;
    transfer_play?: boolean;
  }>;
  parallel?: boolean;
}
```

- Output shape (SpotifyControlBatchOutput):

```ts
{
  _msg: string;
  results: Array<{
    index: number;
    action: string;
    ok: boolean;
    error?: string;
    note?: string;
    device_id?: string;
    device_name?: string;
    from_device_id?: string;
    from_device_name?: string;
  }>;
  summary: {
    ok: number;
    failed: number;
  }
}
```

Notes:

- For play, set either `context_uri` (with optional `offset`) or `uris`, not both.
- After actions, a concise status is included; use `player_status` for full details.

4. `spotify_playlist`

- Description: Manage playlists for the current user.
- Actions: `list_user`, `get`, `items`, `create`, `update_details`, `add_items`, `remove_items`, `reorder_items`.
- Auth/annotations: readOnlyHint=false for mutating actions; true for reads; openWorldHint=true (user OAuth required).
- Input shape:

```ts
// List current user's playlists
{ action: "list_user"; limit?: number; offset?: number }

// Get playlist details
{ action: "get"; playlist_id: string; market?: string; fields?: string }

// Get playlist items
{
  action: "items";
  playlist_id: string;
  market?: string;
  limit?: number;
  offset?: number;
  fields?: string;
  additional_types?: string;
}

// Create playlist
{
  action: "create";
  name?: string;
  description?: string;
  public?: boolean;
  collaborative?: boolean;
}

// Update playlist details
{
  action: "update_details";
  playlist_id: string;
  name?: string;
  description?: string;
  public?: boolean;
  collaborative?: boolean;
}

// Add items to a playlist (URIs like spotify:track:ID)
{ action: "add_items"; playlist_id: string; uris: string[] }

// Remove items from a playlist
{
  action: "remove_items";
  playlist_id: string;
  tracks: { uri: string; positions?: number[] }[];
  snapshot_id?: string;
}

// Reorder items within a playlist
{
  action: "reorder_items";
  playlist_id: string;
  range_start: number;
  insert_before: number;
  range_length?: number;
  snapshot_id?: string;
}
```

- Output shape:

```ts
// Generic envelope used by all actions
type SpotifyPlaylistOutputObject = {
  ok: boolean;
  action: string;
  _msg?: string; // concise human message
  error?: string; // present when ok=false
  code?:
    | "unauthorized"
    | "forbidden"
    | "rate_limited"
    | "bad_response"
    | "invalid_arguments";
  data?: unknown; // varies by action (see below)
};

// list_user → playlists summary
type ListUserData = {
  limit: number;
  offset: number;
  total: number;
  items: Array<{ id: string; uri: string; name: string; type: "playlist" }>;
};

// get → full playlist details (slimmed)
type GetData = {
  id: string;
  uri: string;
  name: string;
  description?: string;
  owner_name?: string;
  public?: boolean;
  collaborative?: boolean;
  tracks_total?: number;
};

// items → tracks with zero-based positions and the playlist context_uri
type ItemsData = {
  playlist_id: string;
  playlist_uri: string; // spotify:playlist:...
  limit: number;
  offset: number;
  total: number;
  items: Array<{
    type: "track";
    id: string;
    uri: string;
    name: string;
    artists: string[];
    album?: string;
    duration_ms?: number;
    position: number; // zero-based position for play offset
  }>;
};

// create → details of the created playlist
type CreateData = GetData;

// update_details → confirmation only
type UpdateDetailsData = { updated: true };

// add_items/remove_items/reorder_items → snapshot id for resulting state
type SnapshotData = { snapshot_id?: string };
```

- Notes:
  - Success responses set `{ ok: true, action, _msg?, data? }`; failures set `{ isError: true, structuredContent: { ok:false, action, error, code? } }`.
  - `items` annotates each returned track with zero-based `position` and includes `playlist_uri` for precise `spotify_control.play` with `{ context_uri, offset: { position } }`.

5. `spotify_library`

- Description: Manage saved songs (Your Library).
- Actions: `tracks_get`, `tracks_add`, `tracks_remove`, `tracks_contains`.
- Auth/annotations: readOnlyHint=true for reads; false for writes; openWorldHint=true (user OAuth required).
- Input shape:

```ts
// List saved tracks
{ action: "tracks_get"; limit?: number; offset?: number; market?: string }

// Save tracks by ID
{ action: "tracks_add"; ids: string[] }      // track IDs (not URIs)

// Remove saved tracks by ID
{ action: "tracks_remove"; ids: string[] }

// Check if tracks are saved
{ action: "tracks_contains"; ids: string[] }
```

- Output shape:

```ts
// Generic envelope used by all actions
type SpotifyLibraryOutputObject = {
  ok: boolean;
  action: string;
  _msg?: string; // concise human message
  error?: string; // present when ok=false
  code?:
    | "unauthorized"
    | "forbidden"
    | "rate_limited"
    | "bad_response"
    | "invalid_arguments";
  data?: unknown; // varies by action (see below)
};

// tracks_get → saved tracks
type TracksGetData = {
  limit: number;
  offset: number;
  total: number;
  items: Array<{
    type: "track";
    id: string;
    uri: string;
    name: string;
    artists: string[];
    album?: string;
    duration_ms?: number;
  }>;
};

// tracks_add → confirmation
type TracksAddData = { saved: number; ids: string[] };

// tracks_remove → confirmation
type TracksRemoveData = { removed: number; ids: string[] };

// tracks_contains → lookup results
type TracksContainsData = { ids: string[]; contains: boolean[] };
```

- Notes:
  - Success responses set `{ ok: true, action, _msg?, data? }`; failures set `{ isError: true, structuredContent: { ok:false, action, error, code? } }`.
  - Use track IDs for library actions; use full track URIs for playlist add/remove.

### HTTP Endpoints

- `POST /mcp` — JSON-RPC 2.0 messages over Streamable HTTP. Initializes sessions and handles requests.
- `GET /mcp` — Server-to-client notifications stream for an existing session; requires `Mcp-Session-Id` header.
- `DELETE /mcp` — End a session; requires `Mcp-Session-Id` header.
- `GET /health` — Health probe.
- `GET /.well-known/oauth-authorization-server` — AS metadata (points to port `PORT+1`). Alias also at `/mcp/.well-known/oauth-authorization-server`.
- `GET /.well-known/oauth-protected-resource` — RS metadata when `AUTH_ENABLED=true`. Alias also at `/mcp/.well-known/oauth-protected-resource`.

Security middleware validates Origin and MCP protocol version headers, attaches a session ID when needed, challenges with `WWW-Authenticate` on 401, and maps RS tokens to Spotify tokens for session hydration.

### Client configuration (Claude Desktop)

Claude Desktop connects to remote MCP servers through a local stdio bridge. Example configuration:

```json
{
  "mcpServers": {
    "spotify": {
      "command": "bunx",
      "args": [
        "mcp-remote",
        "http://127.0.0.1:3030/mcp",
        "--transport",
        "http-only"
      ],
      "env": { "NO_PROXY": "127.0.0.1,localhost" }
    }
  }
}
```

If you enable local HTTPS in front of the server, change the URL to `https://localhost:3030/mcp` and ensure your client trusts the certificate.

### Use cases

1. Play a specific track on a target device at a given volume

User message:

```text
Play "Instant Crush" by Daft Punk on Kitchen speaker at 50% volume.
```

Possible server messages:

```text
Successful: transfer, play, volume. Status: Now playing on 'Kitchen speaker'. Volume: 50%
```

```text
No active device. Ask the user to open Spotify on any device and retry, or use transfer to a listed device.
```

2. Queue a song next

User message:

```text
Queue "Get Lucky" next.
```

Possible server message:

```text
Successful: queue. Status: Unable to confirm playback immediately.
```

3. Resume playback on another device

User message:

```text
Resume playback on John's iPhone.
```

Possible server message:

```text
Successful: transfer, play. Status: Now playing on 'John's iPhone'.
```

4. Create a playlist and add tracks

User message:

```text
Create a playlist called "Focus" and add 10 upbeat Daft Punk tracks.
```

Possible server messages (sequence):

```text
Created playlist 'Focus'.
```

```text
I've added 10 items to 'Focus': Instant Crush, Get Lucky, Lose Yourself to Dance, …
```

5. What’s playing right now?

User message:

```text
What's playing?
```

Possible server messages:

```text
Now playing on 'Kitchen speaker'. Current track: 'Instant Crush'.
```

```text
No active playback. Last track was 'Instant Crush'. You can transfer to an available device and play.
```

6. Check if tracks are saved

User message:

```text
Am I already saving "Instant Crush" and "Get Lucky"?
```

Possible server message:

```text
Already saved: 1/2.
```

### Troubleshooting

- Missing user token: complete the OAuth flow. The server will log mapping/attachment events.
- Unknown RS token: restart or mapping loss triggers a new OAuth prompt; the client should re-auth automatically.
- No devices: open Spotify on a device, then use `player_status` to list devices or `spotify_control` → `transfer`.

### Development

```bash
bun dev                 # start with hot reloading
bun run test:client     # run the included MCP test client

bun run lint            # code style
bun run format          # formatting
bun run typecheck       # TypeScript validation

bun run build           # production build
bun start               # start production server
```

### Architecture (high level)

```
src/
├── config/        # env + auth helpers
├── core/          # MCP server bootstrap, context, session
├── http/          # Hono app, routes, security, auth-proxy
├── tools/         # spotify_* and search_catalog tools
├── services/      # Spotify API clients
├── schemas/       # Zod input/output schemas
├── utils/         # logging, security, rate limiting
└── index.ts       # entry point
```

### License

MIT — see `LICENSE`.
