# Spotify MCP Server

This server is a remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for Spotify. A model can use it to search music, to read and control playback, and to manage playlists and saved songs. The server runs on **Cloudflare Workers** and on **Bun**. It uses the [MCP server template](https://github.com/iceener/streamable-mcp-server-template) 2.1 and the official MCP TypeScript SDK 2.3.0.

The server URL is the deployed Worker's `MCP_PUBLIC_URL`, for example `https://spotify-mcp.<subdomain>.workers.dev/mcp`.

The server uses protocol version `2026-07-28`. It also accepts clients that use the 2025 protocol versions.

Author: [overment](https://x.com/_overment)

> [!WARNING]
> You connect this server to your MCP client at your own risk. A model can make mistakes. The server can change your playlists and saved songs, and it can control playback on your devices.

![Alice App Demo](https://github.com/iceener/spotify-streamable-mcp-server/blob/main/_spec/heyalice-app.gif?raw=true)

*[Alice](https://heyalice.app), a desktop AI assistant*

![Claude Desktop Demo](https://github.com/iceener/spotify-streamable-mcp-server/blob/main/_spec/claude-desktop.gif?raw=true)

*Claude Desktop*

## Tools

The tools do not copy Spotify's API one to one. Each tool takes a batch (`queries[]`, `operations[]`), and each result has a sentence for the model (`_msg`) and structured data.

| Tool | Function |
|---|---|
| `player_status` | Shows the player state, the devices with their `device_id`, the queue and the current track. Call it before you control playback. |
| `search_catalog` | Finds tracks, albums, artists and playlists, for one or more queries. It uses the server's own Spotify app, not the user's account. |
| `spotify_control` | Runs a batch of playback operations: `play`, `pause`, `next`, `previous`, `seek`, `volume`, `shuffle`, `repeat`, `transfer` and `queue`. |
| `spotify_playlist` | Lists, reads, creates and changes playlists: `list_user`, `get`, `items`, `create`, `update_details`, `add_items`, `remove_items`, `reorder_items`. |
| `spotify_library` | Lists, adds, removes and checks saved songs: `tracks_get`, `tracks_add`, `tracks_remove`, `tracks_contains`. |

`spotify_control` reports a `play` or `transfer` as successful only after Spotify's player state confirms it. When `play` names no device, the tool prefers the active desktop app to a Web Player. For the details, refer to [docs/playback.md](docs/playback.md).

A `device_id` is a long identifier from `player_status`, not a device name such as "MacBook Pro".

## Connect a client

Use the server URL and the Streamable HTTP transport. The client signs you in with Spotify the first time.

| Client | Procedure |
|---|---|
| Claude | In **Settings → Connectors**, add a custom connector with the server URL. |
| Claude Code | Run `claude mcp add --transport http spotify <server URL>`. |
| MCP Inspector | Run `bun run inspector`. Select **Streamable HTTP**. Enter the server URL. |

Alice and Wonderlands use the same URL.

## Authentication

The server is its own OAuth authorization server, in front of Spotify's OAuth. MCP clients do not receive Spotify tokens.

1. The client registers at `/register` and signs the user in at `/authorize`. The client must use PKCE S256.
2. The server sends the user to Spotify. Spotify asks for the nine scopes of the server.
3. Spotify returns the user to the server's `/oauth/callback`. The server keeps the Spotify tokens, encrypted.
4. The client gets a code, and exchanges the code at `/token` for an access token and a refresh token. These tokens are opaque and have meaning only for this server.
5. On each MCP request, the server finds the Spotify token for the access token. If the Spotify token expires in less than one minute, the server refreshes it first. The tools use the Spotify token. They do not see the client's token.

For the complete flow, the storage and the redirect rules, refer to [docs/oauth.md](docs/oauth.md).

## Configuration

The deployment settings are in `wrangler.production.jsonc` (Workers; gitignored, with `wrangler.production.example.jsonc` as its shape) or `.env` (Bun). `.env.example` describes all variables.

| Variable | Production value | Function |
|---|---|---|
| `MCP_PUBLIC_URL` | `https://spotify-mcp.<subdomain>.workers.dev/mcp` | The public URL of the MCP endpoint. It is also the resource that tokens are issued for. |
| `MCP_ALLOWED_HOSTS` | `spotify-mcp.<subdomain>.workers.dev` | The `Host` headers that the server accepts. |
| `MCP_ALLOWED_ORIGIN_HOSTNAMES` | The server host, `claude.ai`, `claude.com`, and the hosts of the operator's own browser clients | The browser origins that the server accepts. |
| `AUTH_MODE` | `oauth` | The server checks the tokens that it issued. |
| `OAUTH_ISSUER_URL`, `OAUTH_AUTHORIZATION_URL`, `OAUTH_TOKEN_URL`, `OAUTH_REGISTRATION_URL` | This server's origin, `/authorize`, `/token` and `/register` | The authorization server that clients use. The server does not start if they name another server. |
| `PROXY_REDIRECT_ALLOWLIST` | Alice, Claude, Wonderlands and overment callbacks | The client redirect URIs that the proxy accepts, in addition to native loopback URIs. |
| `MCP_MAX_REQUEST_BYTES` | `1048576` | The largest MCP request body. |
| `MCP_LEGACY_MODE` | `stateless` | The server also accepts 2025-era clients. |
| `SPOTIFY_INCLUDE_JSON_IN_CONTENT` | unset (`false`) | When `true`, each tool result also has its structured data as JSON text, for clients that ignore structured content. |

Secrets:

| Secret | Function |
|---|---|
| `SPOTIFY_CLIENT_ID` | The client ID of the server's Spotify app. |
| `SPOTIFY_CLIENT_SECRET` | The client secret of the server's Spotify app. |
| `RS_TOKENS_ENC_KEY` | 32 random bytes, base64url. The key encrypts the stored tokens. If you change it, all users must sign in again. |
| `TOKENS_ENC_KEY` | The older name of the key. The server uses it only when `RS_TOKENS_ENC_KEY` is not set. |

The Spotify accounts endpoints and the scopes are constants in `src/services/spotify-oauth.ts`. For the setup at Spotify and at Cloudflare, refer to [docs/deploy.md](docs/deploy.md).

## Development

Requirements: [Bun](https://bun.sh) 1.4 or later, and Node.js 22.18 or later.

1. Install the dependencies:

   ```sh
   bun install
   ```

2. Copy `.env.example` to `.env`. Set `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and `RS_TOKENS_ENC_KEY`. In the Spotify dashboard, add the redirect URI `http://127.0.0.1:3000/oauth/callback`.
3. Start the server:

   ```sh
   bun run dev
   ```

   The server URL is `http://127.0.0.1:3000/mcp`. To use the Cloudflare local runtime, run `bun run dev:worker` (port 8787). Put its secrets in `.dev.vars`.

4. Before you commit, run the checks:

   ```sh
   bun run check
   bun run test:smoke
   ```

`bun run check` does the type check, the lint check and the tests. `bun run test:smoke` starts the real server on Bun and on workerd. It signs in through a Spotify stand-in on loopback and calls the tools. No test uses the network.

| Script | Function |
|---|---|
| `bun run dev` | Starts the server on Bun. |
| `bun run dev:worker` | Starts the server in the Cloudflare local runtime. |
| `bun run check` | Type check, lint check, tests, and the check of the generated Worker types. |
| `bun run test:smoke` | Smoke tests on Bun and on workerd. |
| `bun run deploy` | Deploys with the gitignored `wrangler.production.jsonc` (`wrangler deploy --config wrangler.production.jsonc`). |
| `bun run types:worker` | Makes the Worker types again after a change to `wrangler.jsonc`. |

## Project structure

```
src/
  server.ts       Identity, Runtime, Deps, and the hooks that connect the OAuth proxy
  settings.ts     The Spotify app, the encryption keys, the redirect allowlist
  tools/          One file for each tool; shared/ has the schemas, playback checks and helpers
  services/       Spotify Web API clients, and spotify-oauth.ts: Spotify as the OAuth provider
  oauth/          The OAuth proxy. It is the same as in gmail-mcp (docs/oauth.md)
  platform/       Template code. Do not change it
  bun.ts          Entry point for Bun: file storage
  worker.ts       Entry point for Workers: KV and the NativeOAuthAuthority Durable Object
tests/            Tests for the tools, the proxy and the platform; fixtures from before 1.1.0
scripts/          Smoke tests and the Spotify stand-in
```

For the template's concepts (the request path, `defineTool`, the error policy, the configuration checks), refer to the [template documentation](https://github.com/iceener/streamable-mcp-server-template#documentation).

## License

[MIT](LICENSE)
