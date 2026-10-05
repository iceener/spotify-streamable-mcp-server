# The OAuth proxy

MCP clients cannot use Spotify's OAuth directly. A Spotify token is not issued for this server, and the MCP specification forbids passing a client's token to another API. So this server is the **authorization server** that MCP clients use. Behind it, the server signs the user in with Spotify and keeps the Spotify tokens. The template calls this pattern "Be your own authorization server" (template `docs/auth.md`).

The code in `src/oauth/` is the same in every proxy that follows the template (gmail-mcp, spotify-mcp). It is a byte-for-byte copy of gmail-mcp's `src/oauth/`. Do not change it here: change it in all copies, or not at all. Only one small module describes Spotify.

## Layout

| File | Provider-specific? | Function |
|---|---|---|
| `src/services/spotify-oauth.ts` | **Yes** | Spotify's accounts endpoints and the scopes. Spotify answers standard RFC 6749 token responses. |
| `src/settings.ts` | **Yes** | The deployed secret names, and which encryption key is in use (`tokenEncryptionKey`). |
| `src/oauth/proxy.ts` | No | `createOAuthProxy`: the verifier, the metadata and the routes. Checks that `OAUTH_*` name this server. Serves the older discovery locations. |
| `src/oauth/routes.ts` | No | The HTTP endpoints, CORS, `no-store`, and the error answers. |
| `src/oauth/flow.ts` | No | Authorize, provider callback, token (code and refresh), registration. |
| `src/oauth/verifier.ts` | No | Checks the issued tokens for MCP requests, refreshes the provider token, and puts it in `authInfo.extra`. |
| `src/oauth/provider.ts` | No | The `OAuthProvider` interface, and the call to the provider's token endpoint. |
| `src/oauth/redirect-policy.ts` | No | Which client redirect URIs are allowed. |
| `src/oauth/authority.ts` | No | The state machine for registrations, transactions and codes. |
| `src/oauth/authority-do.ts` | No | The authority on Workers: the `NativeOAuthAuthority` Durable Object. |
| `src/oauth/authority-file.ts` | No | The authority on Bun: one file for each client. |
| `src/oauth/token-store*.ts` | No | Issued tokens: the interface and memory store, Workers KV, a file on Bun. |
| `src/oauth/crypto.ts`, `encoding.ts`, `errors.ts`, `input.ts` | No | AES-GCM, PKCE, base64, the error convention, request parsing. |

The proxy connects to the template only through the hooks in `src/server.ts`. `src/platform/` does not change.

| Template hook | What the proxy puts there |
|---|---|
| `Runtime` | `{ tokens, authority }`: KV and the Durable Object from `src/worker.ts`, files from `src/bun.ts`. |
| `Deps.oauth` | The proxy, made by `createOAuthProxy` in `createDeps`. |
| `createVerifier` | `deps.oauth.verifier`. |
| `oauthMetadata` | `deps.oauth.metadata(oauth)`: the published RFC 8414 document. |
| `routes` | `deps.oauth.mount(app, oauth, serverInfo.title)`, in OAuth mode only. |

The platform does the rest: it publishes the protected-resource document, checks every token's audience (`expectedResource`), and removes the client's token before tools run.

## Options

`createOAuthProxy` has two options. The defaults are the stricter behavior. This server sets `bindGrants`, so that it behaves as it did before 1.1.0.

| Option | Default | This server | Effect |
|---|---|---|---|
| `bindGrants` | `true` | `false` | With `true`, each issued token record carries `oauth: { clientId, resource }`, and a refresh needs the same `client_id`. With `false`, records have no binding, and a refresh needs no `client_id`. |
| `discoveryAliases` | `true` | `true` | With `true`, the discovery documents are also served at `/.well-known/oauth-protected-resource`, `/mcp/.well-known/oauth-protected-resource` and `/mcp/.well-known/oauth-authorization-server`, the locations some 2025-era clients try. These are routes, so the Origin check applies. |

These are rules, not options:

- When the token store can't be reached (a KV outage), an MCP request gets `500`, so the client keeps its token and retries. A token that isn't stored, or a record that won't decrypt, gets `401`, and the client refreshes or signs in again.
- KV errors name only the operation and the kind of record (`KV write failed (refresh record)`): the KV keys contain the tokens, and KV's own messages can repeat the key.
- On Bun, records loaded from the token file stay for a week, even when the provider access token has expired, so the verifier can refresh them.

## The flow

1. **Register.** The client sends `POST /register` with its redirect URIs. Only public clients are accepted (`token_endpoint_auth_method: none`). The authority stores the client in a new Durable Object. The answer has a `client_id` of 32 characters. There is no registration access token.
2. **Authorize.** The client sends the user to `GET /authorize` with `client_id`, `redirect_uri`, `code_challenge` (S256 only), and optionally `state` and `resource`. If `resource` is given, it must be `MCP_PUBLIC_URL` exactly. The proxy stores a transaction for 10 minutes and sends the user to `https://accounts.spotify.com/authorize`. Spotify receives the proxy's client ID, the proxy's callback, the nine scopes and an opaque handle as `state`. Spotify never sees the client's redirect URI or state.
3. **Callback.** Spotify sends the user to `GET /oauth/callback?code=…&state=<handle>`. The proxy claims the transaction **before** it calls Spotify, so a replayed or concurrent callback fails. Then the proxy exchanges the code at `https://accounts.spotify.com/api/token` (HTTP Basic authentication) and encrypts the Spotify tokens into a code for the client. The code is valid for 2 minutes. The proxy sends the user to the client's redirect URI, exactly as registered, with `code` and the client's `state`.
4. **Token.** The client sends `POST /token` with the code, `client_id`, `redirect_uri` and `code_verifier`. The authority redeems the code once, and only if all four match. The proxy issues two opaque tokens (32 characters each). A failed match leaves the code usable; a redeemed code never comes back, even if a later step fails.
5. **MCP requests.** The client sends `Authorization: Bearer <access token>`. The verifier finds the record. If the Spotify token expires in less than one minute, the verifier refreshes it at Spotify and stores it. The tools get the Spotify token as `authInfo.extra.providerAccessToken`.
6. **Refresh.** The client sends `POST /token` with `grant_type=refresh_token`. `client_id` is optional here: the records have no client binding. The proxy refreshes the Spotify token if it expires in less than one minute. The access token changes only when Spotify returns a new refresh token; the refresh token never changes.

**Records have no binding** (`oauth` field), as before 1.1.0: the server does not record which client a token was issued to. A refresh token works with any `client_id`, or none. The verifier reports the caller ID as a hash of the token. Binding can be turned on later with `bindGrants: true`; check first that every client sends `client_id` on refresh.

Catalog search does not use the user's token. It uses the server's own Spotify app with the client credentials grant (`src/services/spotify.ts`).

## Endpoints

| Endpoint | Answers |
|---|---|
| `POST /register` | `201` with the client. `400 invalid_client_metadata` or `invalid_redirect_uri`. |
| `GET /authorize` | `302` to Spotify. `400` with `unsupported_response_type`, `invalid_client`, `invalid_request` or `invalid_target`. |
| `GET /oauth/callback` | `302` to the client. `400 invalid_callback` or `invalid_grant`. `503 server_error` if Spotify refuses the code. |
| `POST /token` | `200` with `access_token`, `refresh_token`, `token_type: bearer`, `expires_in`, `scope`. `400` with `invalid_grant`, `invalid_target`, `unsupported_grant_type`, `missing_refresh_token` or `invalid_request`. |
| `POST /revoke` | `200 {"status":"ok"}`. It changes nothing (see "Limits"). |
| `/.well-known/oauth-authorization-server` | The metadata, from any origin (the platform serves it). |
| `/.well-known/oauth-protected-resource/mcp` | The protected-resource metadata, from any origin (the platform serves it). |
| `/.well-known/oauth-protected-resource`, `/mcp/.well-known/oauth-protected-resource`, `/mcp/.well-known/oauth-authorization-server` | The same documents, at the locations that the server used before 1.1.0. 2025-era clients use the first one as a fallback. These are routes, so the Origin check applies, as it did before. |

Every OAuth answer has `Cache-Control: no-store`. An allowed browser origin can read the answers and send a CORS preflight. Bodies are limited to 16 KiB (`413 request_too_large`). A repeated field is `400 invalid_request`. Any other failure (storage, Spotify, a bug) is `503 server_error`; the details go to the log, not to the client.

Errors travel as `Error` messages that start with the OAuth error code. Only a plain message survives the Durable Object RPC boundary, so do not replace the convention with error classes.

## Redirect URIs

A client may use a redirect URI only if it registered the URI and one of these rules allows it:

1. **Native loopback.** A client with `application_type: native` may use `http://127.0.0.1:<port>/<path>`. At `/authorize` it may use another port, but the same path. The server refuses `localhost`, IPv6, numeric aliases of 127.0.0.1, user info, queries, fragments and dot segments. The raw spelling is kept, so `:80` stays.
2. **Allowlist.** An entry in `PROXY_REDIRECT_ALLOWLIST`: an exact URI (HTTPS or a custom scheme such as `alice://oauth/callback`), or an HTTPS origin (`https://app.example.com`) that allows every path on that origin. Plain `http` entries never match: loopback uses rule 1 only. So the production entries `http://127.0.0.1:3000/v1/mcp/oauth/callback` and `http://127.0.0.1:*/oauth/callback` have no effect; they are kept so that the value did not change.

The callback checks the rules again before it calls Spotify. If you remove an entry, transactions in progress for it fail.

## Storage

Do not change these formats. Records that exist in production use them.

**Issued tokens (Workers KV `TOKENS`).** Each record is written twice, as `rs:access:<access token>` and `rs:refresh:<refresh token>`:

```json
{
  "rs_access_token": "…",
  "rs_refresh_token": "…",
  "oauth": { "clientId": "…", "resource": "https://spotify-mcp.example.workers.dev/mcp" },
  "provider": { "access_token": "…", "refresh_token": "…", "expires_at": 1790000000000, "scopes": ["…"] },
  "created_at": 1790000000000
}
```

Records written before 1.1.0 have no `oauth` field. The value is AES-256-GCM: `base64url(iv[12] || ciphertext || tag[16])`. Without a key, the value is plain JSON. Every write also goes to memory, so a failed KV write still works in the same isolate. KV is eventually consistent, so it never decides whether a code was used: the authority does.

**The encryption key.** Two secrets are deployed. `RS_TOKENS_ENC_KEY` is the key in use: it encrypts the KV records, the grants inside codes, and the Bun token file, and it has since November 2025. `TOKENS_ENC_KEY` is the older name; the server uses it only when `RS_TOKENS_ENC_KEY` is unset (`tokenEncryptionKey` in `src/settings.ts`). With both set, `TOKENS_ENC_KEY` encrypts nothing. A record is never tried with the other key.

**Authorization state (Durable Object `OAUTH_AUTHORITY`, class `NativeOAuthAuthority`).** There is one object for each client, named by its `client_id`, with one SQLite row (`authority` table, `id = 1`) that holds a JSON document: `{ client, transactions, codes }`. Each command reads, checks and writes in one `transactionSync`. A client has at most 100 open transactions and codes. An alarm removes expired entries. Inside a code, the Spotify tokens are `enc:` and the KV layout.

The applied migrations are, in order: `v1-oauth-authority` (created `OAuthAuthorityDurableObject`), `v2-remove-oauth-authority` (deleted it), and `v3-native-oauth-authority` (created `NativeOAuthAuthority`). Keep all three in `wrangler.production.jsonc` and `wrangler.jsonc`, in this order. Only append.

**Bun.** The tokens are in one file (`RS_TOKENS_FILE`, default `.data/rs-tokens.json`): `{ version: 1, encrypted, records }`, encrypted whole as `base64url(iv[12] || tag[16] || ciphertext)`. The authority keeps one file for each client in `<RS_TOKENS_FILE>.oauth-authority/`. Only one Bun process may use these files.

`tests/fixtures/storage-before.json` holds records that the 1.0.0 code wrote. `tests/oauth/storage.test.ts` reads, verifies and refreshes them.

## Limits

- **Revocation does nothing.** `/revoke` answers `200` and keeps the tokens. Tokens end when the user removes the app at Spotify (spotify.com → Account → Apps), or when the refresh at Spotify fails.
- **Refresh tokens are not bound to a client and are not rotated.** Anyone who has a refresh token can use it, with any `client_id`, for the life of the grant. Replay of a stolen refresh token is not detected. Turning on `bindGrants` binds new records; check first that every client sends `client_id` on refresh.
- **Client ID metadata documents (CIMD) are not supported.** The metadata says `client_id_metadata_document_supported: false`. Clients must register.
- **No rate limit on `/register`.** Each registration makes a Durable Object.
- **Refresh races.** Two requests at the same moment can both refresh the Spotify token. Both results are valid.

## Rollback

A Durable Object migration does not reverse when you deploy older code. Keep the `NativeOAuthAuthority` class, the `OAUTH_AUTHORITY` binding and the migration list. Fix forward. Do not restore an authority backup: it can bring back codes that were already used. Do not change `RS_TOKENS_ENC_KEY`: all stored tokens become unreadable, and all users must sign in again.

Version 1.0.0 reads the records that 1.1.0 writes: the layout is the same.
