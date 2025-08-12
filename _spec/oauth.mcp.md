### MCP Auth + Spotify User Tokens — Minimal flow used by this server

Two independent concerns:

1. MCP transport OAuth (optional): protects `/mcp`.
2. Spotify user OAuth: server obtains and stores user tokens per session.

Server behavior (summary):

- Client discovers the server’s Authorization Server (AS) via `.well-known/oauth-protected-resource` when `AUTH_ENABLED=true` and completes OAuth to get an RS access token for `/mcp`.
- Separately, the AS drives Spotify Authorization Code (server-side) and stores `{ access_token, refresh_token?, expires_at, scopes }` bound to the active MCP session. Spotify tokens never leave the server.
- Tools that need user context read the bearer from the session; search uses app token.

Relevant endpoints implemented locally (see code under `src/core/http.ts` and `src/core/auth-http.ts`):

- RS metadata: `GET /.well-known/oauth-protected-resource` (exposes AS URL and resource)
- AS metadata: `GET /.well-known/oauth-authorization-server`
- AS authorize: `GET /authorize` (starts client OAuth; also redirects user agent to Spotify authorize)
- Spotify callback: `GET /spotify/callback` (exchanges code → Spotify tokens; binds to session)
- AS token: `POST /token` (issues RS token for `/mcp`)

Scopes to request from Spotify depend on tools used:

- Status: `user-read-playback-state` (+ `user-read-currently-playing`)
- Control: `user-modify-playback-state`

Notes

- Never forward MCP RS tokens to Spotify.
- Treat expired user tokens by refreshing or re-linking; current code stores tokens and TODO’s refresh.
