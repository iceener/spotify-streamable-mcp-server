### Spotify MCP Server — Minimal Reference

This server exposes three tools that integrate with the Spotify Web API. This page documents only what the code needs.

#### Base URLs

- Web API base: `https://api.spotify.com/v1`
- Accounts base: `https://accounts.spotify.com`

Note: When composing URLs, do not start the path with `/` against the base or you will drop `/v1`. Use `new URL("path", base)`.

#### Tools Overview

1. spotify_search (app token)

- Endpoint: `GET /v1/search`
- Query params: `q` (string, required), `type` (comma list of item types), `limit` (1..50), `offset` (0..1000), optional `market` (ISO 3166-1 alpha-2), `include_external=audio`.
- Auth: Client Credentials token from Accounts `POST /api/token` with `grant_type=client_credentials` and `Authorization: Basic <base64(client_id:client_secret)>`.
- Normalized output (in code): `items[]` with `{ type,id,name,uri?,url?,artists?[] }`, `totals` per type, plus `query/types/limit/offset`.

2. spotify_status (user token)

- Endpoints used (parallel):
  - `GET /v1/me/player`
  - `GET /v1/me/player/devices`
  - `GET /v1/me/player/queue`
  - `GET /v1/me/player/currently-playing`
- Scopes: `user-read-playback-state` (+ `user-read-currently-playing` if used).
- Output:
  - `player { is_playing, shuffle_state, repeat_state, progress_ms, timestamp, device_id, context_uri }`
  - `current_track { id, uri, name, artists[], album, duration_ms } | null`
  - `devices[]`
  - `queue { currently_playing, next_up[] }`

3. spotify_control (user token)

- Action → endpoint mapping:
  - play/resume → `PUT /v1/me/player/play?device_id=...`
  - pause → `PUT /v1/me/player/pause?device_id=...`
  - next → `POST /v1/me/player/next?device_id=...`
  - previous → `POST /v1/me/player/previous?device_id=...`
  - seek → `PUT /v1/me/player/seek?position_ms=...&device_id=...`
  - volume → `PUT /v1/me/player/volume?volume_percent=...&device_id=...`
  - shuffle → `PUT /v1/me/player/shuffle?state=true|false&device_id=...`
  - repeat → `PUT /v1/me/player/repeat?state=off|track|context&device_id=...`
  - transfer → `PUT /v1/me/player` body `{ device_ids:[id], play? }`
  - start (play with context/uris) → `PUT /v1/me/player/play?device_id=...` body `{ context_uri?, uris?, offset? }`
  - queue → `POST /v1/me/player/queue?uri=...&device_id=...`
- Scopes: `user-modify-playback-state` (read scopes if you also read state).
- Required args: seek→`position_ms`, volume→`volume_percent`, repeat→`repeat`, shuffle→`shuffle`, transfer→`device_id`, queue→`queue_uri`.

#### Auth Model

- Search uses app token (Client Credentials).
- Status/Control require a per-session user token. The local Authorization Server completes Spotify Authorization Code and stores tokens bound to the MCP session. Tools read bearer from the session. See `oauth.mcp.md` for the minimal flow used here.

#### Environment

- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_API_URL` (default `https://api.spotify.com/v1`)
- `SPOTIFY_ACCOUNTS_URL` (default `https://accounts.spotify.com`)
- Local AS/OAuth variables (see `oauth.mcp.md`).

#### Error handling expectations

- 401/403: refresh/mint token then retry once; else return `unauthorized`.
- 404 no active device on player ops: return clear error and suggest listing devices.
- Treat idempotent controls (pause when paused, shuffle true twice) as success.
