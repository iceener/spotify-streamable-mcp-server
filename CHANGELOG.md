# Changelog

## 1.2.0 — 2026-10-10

### Changed for clients

- **Images:** tracks, albums, artists and playlists carry `image`, a thumbnail URL: the smallest image Spotify has that is at least 300 px wide (else the widest). For a track, it is the album cover. The field is absent when Spotify has no image. It is in:
  - `search_catalog`: every result type;
  - `player_status`: `current_track`;
  - `spotify_playlist` `items` and `spotify_library` `tracks_get`: each track.
- **Output schemas:** `search_catalog` and `player_status` list `image` on their slim entities. The other tools' output schemas are unchanged (`data` is untyped). `spotify_playlist` `list_user` and `get` keep `images`, the URL of the largest playlist image, as before.
- The text the model reads is unchanged: the URLs are only in the structured result (and in the JSON text when `SPOTIFY_INCLUDE_JSON_IN_CONTENT` is `true`).
- **Server identity:** version `1.2.0`.

The output schemas forbid unknown fields, as before. A client that checks results against a tool list it fetched before this version rejects the new field until it lists the tools again.

## 1.1.0 — 2026-10-05

The server now follows the [MCP server template](https://github.com/iceener/streamable-mcp-server-template) 2.1 and uses `@modelcontextprotocol/server` 2.3.0. The OAuth proxy is the provider-neutral `src/oauth/` that gmail-mcp uses. The tool contract, the stored tokens, the Spotify callback and the redirect allowlist are the same as before. `tests/fixtures/` records the deployed code (commit `213a57b`); `tests/contract.test.ts`, `tests/routes.test.ts` and `tests/oauth/storage.test.ts` compare the server with it.

### Changed for clients

- **Removed tool:** `health`, a template sample that reported the runtime and uptime. The five Spotify tools are unchanged: names, order, input schemas, annotations and descriptions.
- **Tools** have titles (`Player Status`, `Find Music (Catalog Search)`, …). They were defined before, but never sent.
- **Output schemas:** `player_status` writes its nullable fields as `type: [X, "null"]` (Zod 4.6) instead of `anyOf` (Zod 4.4). Both accept the same values.
- **Server identity:** version `1.1.0`, and an icon at `/icon.svg`. Name, title, description and instructions are the same.
- **Capabilities:** `listChanged` and `subscribe` are `false` in both protocol eras. They were `true` for 2026-07-28 clients, but nothing ever sent a notification. Prompts and resources are still advertised, with empty lists.
- **List caching:** the lists are cacheable by every caller (`cacheScope: public`, was `private`).
- **Protected-resource metadata** no longer lists `scopes_supported`. The platform publishes there the scopes every request must carry, and this server, as before, requires none. The nine Spotify scopes are still in the authorization server metadata, and the proxy asks Spotify for all nine whatever scope the client requests, so sign-in is unchanged.
- **Authorization server metadata** also says `client_id_metadata_document_supported: false`. This is the default when the field is absent; every other field is the same.
- **OAuth endpoints** answer CORS for allowed browser origins: `Access-Control-Allow-Origin` on `/register`, `/token` and the other endpoints, and `204` to a preflight (was `404`).
- **Discovery aliases** (`/.well-known/oauth-protected-resource`, `/mcp/.well-known/oauth-protected-resource`, `/mcp/.well-known/oauth-authorization-server`) answer exactly as the standard locations do: `Access-Control-Allow-Origin: *`, `204` to a preflight and `405` to other methods (was `404`). They stay behind the Origin check, as before.
- **Unknown paths** answer `404 {"error":"not_found"}` as JSON, not as plain text. `/health` reports the name and version.
- **A Worker that is configured wrong** answers `500 {"error":"server_misconfigured"}` to every request (was `503 {"error":"server_error"}`).
- **A token that cannot be read** (storage failure) answers `401 invalid_token` (was `500`), as in gmail-mcp.
- **Token store outage:** when KV can't be reached, an MCP request gets `500` and the client keeps its token. Before, it got `401`, and the client signed in again.

### Changed for operators

- **Bun token file:** records loaded after a restart stay for a week, even when the provider access token has expired, and are refreshed on use. Before, they were dropped, and users signed in again after a restart.
- `wrangler.jsonc` for development, and the gitignored `wrangler.production.jsonc` for production, with `wrangler.production.example.jsonc` as its committed shape. `bun run deploy` is `wrangler deploy --config wrangler.production.jsonc`. A deploy replaces the vars; it no longer keeps vars that are not in the file (`--keep-vars`). Edit the redirect allowlist in `wrangler.jsonc`, not in the dashboard.
- Compatibility date `2026-09-08`.
- Bun serves MCP and OAuth on one port. The separate OAuth listener on `PORT + 1` is gone.
- Bun keeps tokens in `.data/rs-tokens.json` by default (before: in memory, unless `RS_TOKENS_FILE` was set).
- Spotify failures, OAuth failures (`503 server_error`) and failed Spotify refreshes are logged as JSON.
- `player_status` no longer fails when Spotify returns a track without an album name or duration.

### Environment variables

| Before | Now |
|---|---|
| `AUTH_ENABLED=true` (`AUTH_STRATEGY` unset) | `AUTH_MODE=oauth` |
| `AUTH_DISCOVERY_URL` | `OAUTH_ISSUER_URL` (same value) |
| — | `OAUTH_AUTHORIZATION_URL`, `OAUTH_TOKEN_URL`, `OAUTH_REGISTRATION_URL`: this server's `/authorize`, `/token`, `/register` |
| `OAUTH_SCOPES` | Removed. The scopes requested at Spotify are the constant `SPOTIFY_SCOPES` in `src/services/spotify-oauth.ts`. The platform's `OAUTH_SCOPES` (the scopes every MCP request needs) stays unset: no scope was required before, and none is now. |
| `SPOTIFY_SCOPES`, `MCP_REQUIRED_SCOPES`, `OAUTH_REQUIRED_SCOPES` | Removed, as above. |
| `SPOTIFY_ACCOUNTS_URL` | Constant `SPOTIFY_ACCOUNTS_URL` in `src/services/spotify-oauth.ts` |
| `SPOTIFY_API_URL` | Removed. The Spotify SDK has a fixed API URL, so the var was never used. |
| `OAUTH_REDIRECT_ALLOWLIST` | `PROXY_REDIRECT_ALLOWLIST` (same value) |
| `OAUTH_REDIRECT_URI` | Removed. Its production value is also in the allowlist. |
| `OAUTH_REDIRECT_ALLOW_ALL` | Removed. It was never read. |
| `OAUTH_REVOCATION_URL`, `OAUTH_EXTRA_AUTH_PARAMS` | Removed. They were never used. |
| `MCP_NAME`, `MCP_TITLE`, `MCP_VERSION`, `MCP_INSTRUCTIONS` | `serverInfo` and `instructions` in `src/server.ts` (same values) |
| `RPS_LIMIT`, `CONCURRENCY_LIMIT` | Removed. They were never read. |
| `AUTH_STRATEGY`, `API_KEY`, `API_KEY_HEADER`, `CUSTOM_HEADERS`, and `BEARER_TOKEN` as a static Spotify token | Removed with the unused auth strategies. `BEARER_TOKEN` now belongs to the template's `AUTH_MODE=bearer`. |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` (aliases of the Spotify secrets) | Removed. Use `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`. |

Unchanged: the secrets `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `RS_TOKENS_ENC_KEY` and `TOKENS_ENC_KEY` (the fallback when `RS_TOKENS_ENC_KEY` is unset), and `MCP_PUBLIC_URL`, `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGIN_HOSTNAMES`, `MCP_LEGACY_MODE`, `MCP_MAX_REQUEST_BYTES`, `LOG_LEVEL`, `NODE_ENV`, `HOST`, `PORT`, `RS_TOKENS_FILE` and `SPOTIFY_INCLUDE_JSON_IN_CONTENT`.

### Removed

- The old adapters, `core/`, and the hand-written HTTP, security, body, logger and configuration modules. The template's `src/platform/` replaces them.
- The project's own OAuth flow, storage and crypto modules. The shared `src/oauth/` replaces them; it reads and writes the same formats.
- The session store, and the KV transaction and code methods. The authority Durable Object replaced them before 1.0.0 was deployed.
- Unused helpers: `utils/formatting.ts`, `utils/pagination.ts`, `utils/limits.ts`, `schemas/common.ts`, `core/errors.ts`, the tool registry and its `executeSharedTool`.
- `docs/MCP_SDK_COMPATIBILITY.md`, `docs/MCP_2026_DEPLOYMENT.md`, `docs/ALICE_NATIVE_OAUTH.md`, `notes/` and `.limen/` (audit logs and agent job records). The facts that still apply are in `docs/oauth.md`, `docs/deploy.md` and `docs/playback.md`.
- The `wrangler.production.jsonc`, `wrangler.example.jsonc` and `scripts/types.env` files, and the old test snapshots and workerd scripts. `tests/` and `scripts/` replace them.
- The dependencies `@cloudflare/workers-types`, `@types/node` and `bun-types`. The generated Worker types and `@types/bun` replace them.
