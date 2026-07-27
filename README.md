# Spotify MCP Server

Fetch-native MCP server for Spotify — search music, control playback, manage playlists, and manage saved songs. It runs on Bun and Cloudflare Workers.

Author: [overment](https://x.com/_overment)

> [!WARNING]
> This repository targets the **candidate** `2026-07-28` protocol with exact `@modelcontextprotocol/server@2.0.0-beta.5` and `@modelcontextprotocol/client@2.0.0-beta.5` pins. Do not describe it as conforming to the final dated release until the final specification and packages are published and verified.
>
> The MCP boundary validates Host and Origin, uses strict CORS and bounded bodies, and validates opaque Resource Server tokens. Production operators must still configure the public URL/allowlists, TLS-facing deployment, Spotify credentials and redirect URIs, encrypted storage, rate limits, audit policy, and Spotify compliance.

## Motivation

At first glance, a "Spotify MCP" may seem unnecessary—pressing play or skipping a song is often faster by hand. It becomes genuinely useful when you don't know the exact title (e.g., "soundtrack from [movie title]"), when you want to "create and play a playlist that matches my mood", or when you're using voice. This MCP lets an LLM handle the fuzzy intent → search → selection → control loop, and it returns clear confirmations of what happened. It works well with voice interfaces and can be connected to agents/workflows for smart‑home automations.

### Demo

![Alice App Demo](https://github.com/iceener/spotify-streamable-mcp-server/blob/main/_spec/heyalice-app.gif?raw=true)

*[Alice](https://heyalice.app) — a desktop AI assistant*

![Claude Desktop Demo](https://github.com/iceener/spotify-streamable-mcp-server/blob/main/_spec/claude-desktop.gif?raw=true)

*Claude Desktop*

## Features

- ✅ **Search** — Find tracks, albums, artists, playlists
- ✅ **Player Control** — Play, pause, skip, seek, volume, shuffle, repeat, queue
- ✅ **Device Transfer** — Move playback between devices
- ✅ **Playlists** — Create, edit, add/remove tracks, reorder
- ✅ **Library** — Save/remove tracks, check if saved
- **OAuth 2.1 proxy** — PKCE S256, CIMD/DCR metadata, opaque RS-token mapping, refresh and rotation
- **Dual runtime** — Bun and Cloudflare Workers
- **Protected storage** — Existing file/KV record formats and AES-256-GCM encryption remain compatible
- **MCP v2 candidate** — Modern `2026-07-28` plus SDK-owned stateless `2025-11-25` fallback

### Design Principles

- **LLM-friendly**: Tools don't mirror Spotify's API 1:1 — interfaces are simplified and unified
- **Batch-first**: Operations use arrays (`queries[]`, `operations[]`) to minimize tool calls
- **Clear feedback**: Every response includes human-readable `_msg` with what succeeded/failed
- **Best-effort verification**: Player control verifies device, context, and current track

## Quick Start

### 1. Install

```bash
cd spotify-mcp
bun install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=3000
AUTH_ENABLED=true
MCP_PUBLIC_URL=http://localhost:3000/mcp
MCP_ALLOWED_HOSTS=localhost,127.0.0.1,[::1]
MCP_ALLOWED_ORIGIN_HOSTNAMES=localhost,127.0.0.1,[::1]
MCP_LEGACY_MODE=stateless
MCP_MAX_REQUEST_BYTES=1048576

# From https://developer.spotify.com/dashboard
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret

# OAuth
OAUTH_SCOPES=playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read user-library-modify
OAUTH_REDIRECT_URI=alice://oauth/callback
OAUTH_REDIRECT_ALLOWLIST=alice://oauth/callback
```

### 3. Configure Spotify Dashboard

Add redirect URIs in [Spotify Developer Dashboard](https://developer.spotify.com/dashboard):

```
http://127.0.0.1:3001/oauth/callback
alice://oauth/callback
```

### 4. Run

```bash
bun dev
# MCP: http://127.0.0.1:3000/mcp
# OAuth: http://127.0.0.1:3001
```

## Server Instructions (What the Model Sees)

```text
Use these tools to find music, get the current player status, control and transfer playback, and manage playlists and saved songs.

Tools
- search_catalog: Find songs, artists, albums, or playlists
- player_status: Read current player, available devices, queue, and current track
- spotify_control: Batch control playback (play, pause, next, previous, seek, volume, shuffle, repeat, transfer, queue)
- spotify_playlist: Manage playlists (list, get, items, create, update, add/remove items, reorder)
- spotify_library: Manage saved songs (get, add, remove, contains)

CRITICAL: device_id
- device_id is a long alphanumeric hash, NOT a human-readable name
- NEVER use the device name (like "MacBook Pro" or "iPhone") as device_id — this will fail!
- Always copy the exact device_id value from player_status → devices[].id or player.device_id
```

## Tools

### `search_catalog`

Search songs, artists, albums, and playlists.

**Input:**
```ts
{
  queries: string[];                              // Search terms
  types: ("album"|"artist"|"playlist"|"track")[]; // What to search
  market?: string;                                // 2-letter country code
  limit?: number;                                 // 1-50 (default 20)
  offset?: number;                                // 0-1000 (default 0)
  include_external?: "audio";
}
```

**Output:**
```ts
{
  _msg: string;
  batches: Array<{
    query: string;
    totals: Record<string, number>;
    items: Array<{ type, id, uri, name, artists?, album? }>;
  }>;
}
```

### `player_status`

Read current player state, devices, queue, and current track.

**Input:**
```ts
{ include?: ("player"|"devices"|"queue"|"current_track")[] }
```

**Output:**
```ts
{
  _msg: string;
  player?: {
    is_playing: boolean;
    device_id?: string;       // Use this for control!
    shuffle_state?: boolean;
    repeat_state?: "off"|"track"|"context";
    progress_ms?: number;
    context_uri?: string|null;
  };
  current_track?: { type, id, uri, name, artists, album, duration_ms } | null;
  devices?: Array<{
    id: string;               // Use this for control!
    name: string;
    type: string;
    is_active: boolean;
    volume_percent?: number;
  }>;
  queue?: { current_id?: string; next_ids: string[] };
}
```

### `spotify_control`

Control playback with batch operations.

**Input:**
```ts
{
  operations: Array<{
    action: "play"|"pause"|"next"|"previous"|"seek"|"volume"|"shuffle"|"repeat"|"transfer"|"queue";
    device_id?: string;       // Long alphanumeric hash from player_status
    position_ms?: number;     // For seek or play start position
    volume_percent?: number;  // 0-100 for volume
    shuffle?: boolean;
    repeat?: "off"|"track"|"context";
    context_uri?: string;     // Album/playlist URI
    uris?: string[];          // Track URIs (don't combine with context_uri)
    offset?: { position?: number; uri?: string };
    queue_uri?: string;
    transfer_play?: boolean;
  }>;
  parallel?: boolean;         // Run concurrently (default: sequential)
}
```

**Output:**
```ts
{
  _msg: string;
  results: Array<{ index, action, ok, error?, device_id?, device_name? }>;
  summary: { ok: number; failed: number };
}
```

### `spotify_playlist`

Manage playlists.

**Input:**
```ts
// List user playlists
{ action: "list_user"; limit?: number; offset?: number }

// Get playlist details
{ action: "get"; playlist_id: string }

// Get playlist tracks (includes position for play offset)
{ action: "items"; playlist_id: string; limit?: number; offset?: number }

// Create playlist
{ action: "create"; name?: string; description?: string; public?: boolean }

// Update details
{ action: "update_details"; playlist_id: string; name?: string; description?: string }

// Add tracks
{ action: "add_items"; playlist_id: string; uris: string[] }

// Remove tracks
{ action: "remove_items"; playlist_id: string; tracks: { uri: string }[] }

// Reorder tracks
{ action: "reorder_items"; playlist_id: string; range_start: number; insert_before: number }
```

### `spotify_library`

Manage saved tracks.

**Input:**
```ts
// List saved tracks
{ action: "tracks_get"; limit?: number; offset?: number }

// Save tracks (use track IDs, not URIs)
{ action: "tracks_add"; ids: string[] }

// Remove saved tracks
{ action: "tracks_remove"; ids: string[] }

// Check if saved
{ action: "tracks_contains"; ids: string[] }
```

## Example Session

A complete walkthrough showing all tools working together.

### 1. "What's playing?"

**Tool:** `player_status`

```json
{ "include": ["player", "devices", "current_track"] }
```

**Response:**
```
'Come With Me - Radio Mix' is playing on 'MacBook Pro' (device_id: "8fc48c51d766...").

Available devices (use device_id for control):
• MacBook Pro (Computer) [ACTIVE] → device_id: "8fc48c51d766..."
```

### 2. "Play Protected from this playlist"

First, get playlist items to find the track position:

**Tool:** `spotify_playlist`

```json
{ "action": "items", "playlist_id": "2mMPIccnFiOd2xgkO0iABm", "limit": 50 }
```

**Response:**
```
Loaded 50 items from 'Nora' (context: spotify:playlist:2mMPIccnFiOd2xgkO0iABm).
- #0 Come with Me - Radio Mix — spotify:track:2FxwTax2LGVybNIrreiwXv
- #7 Protected — spotify:track:1cRRIRrUiPnLOvsnWNhoH9
… and more
```

Then play at position #7:

**Tool:** `spotify_control`

```json
{
  "operations": [{
    "action": "play",
    "context_uri": "spotify:playlist:2mMPIccnFiOd2xgkO0iABm",
    "offset": { "position": 7 }
  }]
}
```

**Response:**
```
Successful: play. Status: Now playing on 'MacBook Pro'. Current track: 'Protected'.
```

### 3. "Add this to my favorites"

**Tool:** `spotify_library`

```json
{ "action": "tracks_add", "ids": ["1cRRIRrUiPnLOvsnWNhoH9"] }
```

**Response:**
```
Saved 1 track:
- Protected — spotify:track:1cRRIRrUiPnLOvsnWNhoH9
```

### 4. "Turn volume up to 100%"

**Tool:** `spotify_control`

```json
{
  "operations": [{ "action": "volume", "volume_percent": 100 }]
}
```

**Response:**
```
Successful: volume. Status: Now playing on 'MacBook Pro'. Current track: 'Protected'. Volume: 100%
```

## HTTP and credential boundaries

- `POST /mcp` — MCP endpoint. A fresh `McpServer` is registered for each request.
- `GET /mcp` and `DELETE /mcp` — `405`; this server does not create MCP transport sessions.
- `GET /health` — Runtime health.
- `GET /.well-known/oauth-protected-resource/mcp` — RFC 9728 Resource Server metadata. Legacy metadata aliases remain available.
- `GET /.well-known/oauth-authorization-server` — OAuth Authorization Server metadata.

OAuth proxy routes stay outside MCP dispatch. Workers expose them on the same origin; Bun exposes them on `PORT + 1`:

- `GET /authorize` — Start the Spotify authorization flow.
- `GET /oauth/callback` — Exchange Spotify's provider code.
- `POST /token` — Exchange a client code or refresh an RS token.
- `POST /revoke` — Preserve the existing no-op revocation response.
- `POST /register` — Dynamic client registration/CIMD-compatible metadata flow.

The bearer presented to `/mcp` is an opaque MCP Resource Server token. A custom verifier looks up its stored alias, proactively refreshes Spotify when needed, and puts only `resolvedSpotifyAccessToken` in `AuthInfo.extra`. Tools never use `AuthInfo.token`, never forward the inbound MCP bearer, and never receive a Spotify refresh token. File/KV refresh records remain the only refresh-token boundary.

`MCP_REQUIRED_SCOPES` is optional and empty by default for rollout compatibility. When configured, missing trusted record scopes return `403 insufficient_scope`.

## Client Configuration (Claude Desktop)

```json
{
  "mcpServers": {
    "spotify": {
      "command": "bunx",
      "args": ["mcp-remote", "http://127.0.0.1:3000/mcp", "--transport", "http-only"],
      "env": { "NO_PROXY": "127.0.0.1,localhost" }
    }
  }
}
```

## Cloudflare Workers

### Setup

1. Create a KV namespace:
```bash
wrangler kv namespace create TOKENS
```

2. Copy `wrangler.example.jsonc` to `wrangler.jsonc`, set the KV ID, public deployment settings, and allowlists:
```jsonc
{
  "vars": {
    "AUTH_ENABLED": "true",
    "MCP_LEGACY_MODE": "stateless",
    "OAUTH_SCOPES": "playlist-read-private user-read-playback-state user-modify-playback-state user-library-read user-library-modify"
  },
  "kv_namespaces": [{ "binding": "TOKENS", "id": "your-kv-id" }]
}
```

Set `MCP_PUBLIC_URL`, `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGIN_HOSTNAMES`, and `AUTH_DISCOVERY_URL` for the production hostname. The Worker has a backward-compatible first-request origin fallback, but explicit values are the recommended production posture.

3. Set secrets:
```bash
wrangler secret put SPOTIFY_CLIENT_ID
wrangler secret put SPOTIFY_CLIENT_SECRET

# Generate encryption key (32-byte base64url):
openssl rand -base64 32 | tr -d '=' | tr '+/' '-_'
# Copy the output, then:
wrangler secret put TOKENS_ENC_KEY
# Paste the generated key when prompted
```

> **Note:** The Worker retains the deployed `TOKENS_ENC_KEY` binding and also accepts `RS_TOKENS_ENC_KEY`; Bun uses `RS_TOKENS_ENC_KEY`. Both feed the same AES-256-GCM record codec. Without a key, tokens are stored in plaintext (not recommended for production).

4. Deploy:
```bash
wrangler deploy
```

## Development

```bash
bun dev                    # Bun MCP + OAuth servers with reload
bun test                   # OAuth, protocol, provider mock, and storage compatibility tests
bun run typecheck          # Bun and Worker TypeScript projects
bun run lint               # Biome checks
bun run format:check       # Formatting check
bun run build              # Bun bundle
bun run types:worker:check # Generated Worker bindings
bun run build:worker       # Wrangler dry-run/workerd bundle
bun run test:workerd       # Actual local workerd, modern + legacy clients
bun start                  # Bun MCP + OAuth servers
```

### Candidate validation status

Automated tests use the official beta.5 client for modern and legacy flows, pin complete six-tool wire snapshots, exercise opaque-token `401`/`403` behavior, prove MCP/Spotify token separation and concurrent-principal isolation, mock all five Spotify provider tools, and verify plaintext/encrypted file and KV record compatibility. The Zod 4 projection preserves contract meaning while using draft 2020-12 `anyOf` for nullable fields and explicit JavaScript-safe bounds for integer schemas.

Credential-only validation remains for a real Spotify account and deployment: Spotify Dashboard redirect registration, a live authorize/callback/token/refresh cycle, account/Premium-dependent playback behavior, production KV bindings and secrets, and the final public hostname/TLS/allowlists. Final `2026-07-28` conformance also remains gated on the final specification and stable packages.

## Architecture

```
src/
├── shared/
│   ├── tools/           # Tool definitions (work in Node + Workers)
│   │   ├── player-status.ts
│   │   ├── search-catalog.ts
│   │   ├── spotify-control.ts
│   │   ├── spotify-playlist.ts
│   │   └── spotify-library.ts
│   ├── oauth/           # OAuth flow (PKCE, discovery)
│   └── storage/         # Token storage (file, KV, memory)
├── services/
│   └── spotify/         # Spotify API clients
│       ├── sdk.ts       # SpotifyApi wrapper
│       ├── player.ts    # Player API
│       └── catalog.ts   # Search API
├── schemas/
│   ├── inputs.ts        # Zod input schemas
│   └── outputs.ts       # Zod output schemas
├── config/
│   └── metadata.ts      # Server & tool descriptions
├── core/                # v2 fresh-server factory and fetch-native SDK handler
├── http/                # MCP security/body/auth boundary and Bun OAuth app
├── index.ts             # Bun dual-server entry
└── worker.ts            # Cloudflare Worker isolate entry
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Device not found" | You used device name instead of device_id. Get the actual ID from `player_status → devices[].id` |
| "No active device" | Open Spotify on a device, then use `player_status` to list devices |
| "Unauthorized" | Complete OAuth flow. Tokens may have expired. |
| "Rate limited" | Wait a moment and retry |

## License

MIT
