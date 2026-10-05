# Deploy

The production server is the Cloudflare Worker `spotify-mcp`, on `workers.dev`. Its URL is `MCP_PUBLIC_URL`, for example `https://spotify-mcp.<subdomain>.workers.dev/mcp`. For the template's general deployment notes, refer to the template's `docs/deploy.md`.

## Spotify

The server uses one Spotify app from the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), with the **Web API** enabled.

- **Redirect URI:** `/oauth/callback` on the origin of `MCP_PUBLIC_URL`. This URI is registered at Spotify. Do not change the path or the host. For local development, also add `http://127.0.0.1:3000/oauth/callback` (Bun) or `http://127.0.0.1:8787/oauth/callback` (`wrangler dev`).
- **Scopes:** `playlist-read-private`, `playlist-read-collaborative`, `playlist-modify-public`, `playlist-modify-private`, `user-read-playback-state`, `user-modify-playback-state`, `user-read-currently-playing`, `user-library-read` and `user-library-modify`. They are in `src/services/spotify-oauth.ts`. MCP requests need no particular scope: `OAUTH_SCOPES` is unset, as before 1.1.0.
- While the app is in development mode, only the users listed in the dashboard can sign in.
- Playback commands need Spotify Premium. Search needs no user: it uses the app's client credentials.

## Cloudflare

`wrangler.jsonc` is for `bun run dev:worker`. It works only on loopback.

`wrangler.production.jsonc` is the production Wrangler config: the Worker name, the account, the variables, the KV namespace and the Durable Object. It is gitignored, because it names the deployed Worker and its storage. `wrangler.production.example.jsonc` has the same shape with stand-in values. To deploy your own copy, copy the example to `wrangler.production.jsonc` and put in your values. `bun run deploy` runs `wrangler deploy --config wrangler.production.jsonc`.

Where the real file exists, `tests/production.test.ts` checks it: it must have the example's shape, serve what the example serves, and match a pinned SHA-256 digest. A deliberate change to the file needs the new digest in that test, in the same commit. Without the file, those tests are skipped.

The production config has these bindings. Do not change them:

| Binding | Value |
|---|---|
| KV namespace `TOKENS` | The namespace that holds the signed-in users' tokens. Its ID is in `wrangler.production.jsonc`. |
| Durable Object `OAUTH_AUTHORITY` | class `NativeOAuthAuthority` |
| Migrations | `v1-oauth-authority`, `v2-remove-oauth-authority`, `v3-native-oauth-authority` (all applied, in this order). Only add new tags after them. |

The production secrets:

| Secret | Value |
|---|---|
| `SPOTIFY_CLIENT_ID` | The Spotify app's client ID. |
| `SPOTIFY_CLIENT_SECRET` | The Spotify app's client secret. |
| `RS_TOKENS_ENC_KEY` | 32 random bytes, base64url. It encrypts all stored tokens. Do not change it. |
| `TOKENS_ENC_KEY` | The older name of the key. The server uses it only when `RS_TOKENS_ENC_KEY` is unset. Keep it. |

To set a secret, run `bunx wrangler secret put NAME --config wrangler.production.jsonc`. To make a new key for a new deployment, run `openssl rand -base64 32 | tr -d '=' | tr '+/' '-_'`.

## Deploy

1. Run the checks:

   ```sh
   bun run check
   bun run test:smoke
   ```

2. Examine the bindings without a deploy:

   ```sh
   CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false bunx wrangler deploy --dry-run --config wrangler.production.jsonc --outdir /tmp/spotify-mcp-dryrun
   ```

   The list must show `env.TOKENS`, with the namespace ID from `wrangler.production.jsonc`, and `env.OAUTH_AUTHORITY (NativeOAuthAuthority)`.

3. Deploy:

   ```sh
   bun run deploy
   ```

   A deploy replaces all vars with the vars in `wrangler.production.jsonc`. Vars that are not in the file are removed. Secrets stay. To change the redirect allowlist, change `PROXY_REDIRECT_ALLOWLIST` in `wrangler.jsonc`, not in the dashboard: the next deploy replaces dashboard edits.

4. Examine the deployed server:

   ```sh
   ORIGIN=$(bun -e "console.log(new URL(Bun.JSONC.parse(await Bun.file('wrangler.production.jsonc').text()).vars.MCP_PUBLIC_URL).origin)")
   curl -s "$ORIGIN/.well-known/oauth-authorization-server"
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$ORIGIN/mcp"
   ```

   The first command shows the issuer, `$ORIGIN`. The second shows `401`.

5. Connect a client and call `player_status`.

## Logs

The Worker writes JSON logs to Workers Logs.

- A tool error that the model sees as an internal error includes a reference; search the logs for it.
- A failed Spotify call is logged as `Spotify request failed`, with the tool name and Spotify's answer.
- OAuth failures that clients see as `503 server_error` are logged as `OAuth request failed`, with the path.
- A failed Spotify refresh is logged as `Spotify token refresh failed; using the current token`.
