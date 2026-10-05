/**
 * The project's half of the template. `platform/` relies on exactly these exports:
 * `serverInfo`, `SERVER_ICON_PATH`, `SERVER_ICON_SVG`, `Runtime`, `Deps`, `createDeps`,
 * `createServer`, `createVerifier`, `oauthMetadata` and `routes`. Change what they contain,
 * but keep their names and shapes.
 */
import {
  type CacheHint,
  McpServer,
  type McpServerFactory,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import type { OAuthAuthority } from './oauth/authority';
import { createOAuthProxy, type OAuthProxy } from './oauth/proxy';
import type { TokenStore } from './oauth/token-store';
import type { Config, OAuthConfig } from './platform/config';
import type { Logger } from './platform/logger';
import { prompts } from './prompts';
import { resources } from './resources';
import { createSpotifyClients, type SpotifyClients } from './services/spotify';
import { spotifyOAuth } from './services/spotify-oauth';
import { tokenEncryptionKey } from './settings';
import { tools } from './tools';

/** Who this server is. `name` and `title` are the ones clients have always seen. */
export const serverInfo = {
  name: 'mcp-spotify',
  title: 'Spotify Music',
  version: '1.1.0',
  description: 'Search Spotify and manage playback, playlists, and saved songs.',
};

/** Sent to clients on connect. Many hosts add it to the model's system prompt. */
const instructions =
  'Control Spotify playback, manage playlists, and search music. Use player_status to check device availability before control actions.';

export const SERVER_ICON_PATH = '/icon.svg';
export const SERVER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Spotify MCP server">
  <rect width="64" height="64" rx="12" fill="#111827"/>
  <circle cx="32" cy="32" r="20" fill="none" stroke="#fff" stroke-width="4"/>
  <path d="M22 27c7-2 14-1 20 2M23 33c6-1.5 11-1 16 1.5M24 39c4.5-1 8.5-.5 12 1" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
</svg>`;

/**
 * Where the OAuth proxy keeps its state, handed in by the entry points: Workers KV and the
 * `NativeOAuthAuthority` Durable Object from `src/worker.ts`, files from `src/bun.ts`.
 */
export interface Runtime {
  tokens: TokenStore;
  authority: OAuthAuthority;
}

/** Everything tools, resources and prompts may use. Built once, shared by every request. */
export interface Deps {
  config: Config;
  logger: Logger;
  /** Spotify Web API clients: as the signed-in user, or as the server's own app. */
  spotify: SpotifyClients;
  /** This server as the OAuth authorization server, in front of Spotify (docs/oauth.md). */
  oauth: OAuthProxy;
}

export function createDeps(config: Config, logger: Logger, runtime: Runtime): Deps {
  const { settings } = config;
  const encryptionKey = tokenEncryptionKey(settings);
  if (!encryptionKey && config.environment === 'production') {
    logger.warning('RS_TOKENS_ENC_KEY is not set: tokens are stored unencrypted');
  }
  const credentials = {
    clientId: settings.SPOTIFY_CLIENT_ID,
    clientSecret: settings.SPOTIFY_CLIENT_SECRET,
  };
  return {
    config,
    logger,
    spotify: createSpotifyClients(credentials),
    oauth: createOAuthProxy({
      config,
      logger,
      provider: spotifyOAuth,
      credentials,
      redirectAllowlist: settings.PROXY_REDIRECT_ALLOWLIST,
      encryptionKey,
      tokens: runtime.tokens,
      authority: runtime.authority,
      // The deployed server never bound grants to a client, so a refresh needs no client_id.
      // Binding would sign out any client that refreshes without it (docs/oauth.md, Options).
      bindGrants: false,
    }),
  };
}

/**
 * How bearer tokens are checked when `AUTH_MODE=oauth`: they are the opaque tokens the proxy
 * issued. The verifier looks them up, refreshes the Spotify token when it is about to expire,
 * and puts it in `authInfo.extra` for the tools.
 */
export function createVerifier(_oauth: OAuthConfig, deps: Deps): OAuthTokenVerifier {
  return deps.oauth.verifier;
}

/**
 * The authorization server metadata (RFC 8414) published at
 * /.well-known/oauth-authorization-server: this server's own endpoints.
 */
export function oauthMetadata(oauth: OAuthConfig, deps: Deps): OAuthMetadata {
  return deps.oauth.metadata(oauth);
}

/** The proxy's endpoints and Spotify's callback, behind the platform's Host and Origin checks. */
export function routes(app: Hono, deps: Deps): void {
  if (deps.config.auth.mode === 'oauth') deps.oauth.mount(app, deps.config.auth, serverInfo.title);
}

/** Lists only change on deploy, and are the same for every caller. */
const LIST_CACHE: CacheHint = { ttlMs: 60_000, cacheScope: 'public' };

/**
 * The SDK calls this factory once per HTTP request and serves that request with the fresh
 * `McpServer` it returns. Keep it cheap and free of I/O: shared clients live in `deps`.
 */
export function createServer(deps: Deps): McpServerFactory {
  const icons = [
    {
      src: new URL(SERVER_ICON_PATH, deps.config.publicUrl).href,
      mimeType: 'image/svg+xml',
      sizes: ['any'],
    },
  ];

  return () => {
    const server = new McpServer(
      { ...serverInfo, icons },
      {
        instructions,
        // Lists change only on deploy, and each request has its own server instance, so there
        // is nothing to notify about. Prompts and resources stay advertised, with empty lists,
        // as they always were.
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
        },
        cacheHints: {
          'server/discover': LIST_CACHE,
          'tools/list': LIST_CACHE,
          'prompts/list': LIST_CACHE,
          'resources/list': LIST_CACHE,
          'resources/templates/list': LIST_CACHE,
        },
        // A batch has at most 25 operations, a search 20 queries, a library call 50 IDs.
        maxToolInputElements: 1_000,
      },
    );

    for (const primitive of [...tools, ...resources, ...prompts]) {
      primitive.register(server, deps);
    }
    return server;
  };
}
