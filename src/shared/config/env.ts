// Unified config reader for both Node.js and Cloudflare Workers
// Spotify MCP implementation

import type { AuthStrategyType } from '../auth/strategy.js';

export type UnifiedConfig = {
  // Server
  HOST: string;
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';

  // MCP
  MCP_TITLE: string;
  MCP_INSTRUCTIONS: string;
  MCP_VERSION: string;
  MCP_PROTOCOL_VERSION: string;
  MCP_ACCEPT_HEADERS: string[];

  // Auth Strategy
  AUTH_STRATEGY: AuthStrategyType;
  AUTH_ENABLED: boolean;
  AUTH_REQUIRE_RS: boolean;
  AUTH_ALLOW_DIRECT_BEARER: boolean;
  AUTH_RESOURCE_URI?: string;
  AUTH_DISCOVERY_URL?: string;

  // API Key auth (AUTH_STRATEGY=api_key)
  API_KEY?: string;
  API_KEY_HEADER: string;

  // Bearer token auth (AUTH_STRATEGY=bearer)
  BEARER_TOKEN?: string;

  // Custom headers (AUTH_STRATEGY=custom)
  CUSTOM_HEADERS?: string;

  // OAuth (AUTH_STRATEGY=oauth)
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  OAUTH_SCOPES: string;
  OAUTH_AUTHORIZATION_URL?: string;
  OAUTH_TOKEN_URL?: string;
  OAUTH_REVOCATION_URL?: string;
  OAUTH_REDIRECT_URI: string;
  OAUTH_REDIRECT_ALLOWLIST: string[];
  OAUTH_REDIRECT_ALLOW_ALL: boolean;
  OAUTH_EXTRA_AUTH_PARAMS?: string;

  // Provider-specific (generic names for template compatibility)
  PROVIDER_CLIENT_ID?: string;
  PROVIDER_CLIENT_SECRET?: string;
  PROVIDER_API_URL?: string;
  PROVIDER_ACCOUNTS_URL?: string;

  // Spotify-specific
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_API_URL: string;
  SPOTIFY_ACCOUNTS_URL: string;
  SPOTIFY_SCOPES: string;
  /** Include raw JSON in tool content (for debugging) */
  SPOTIFY_INCLUDE_JSON_IN_CONTENT: boolean;

  // Storage
  RS_TOKENS_FILE?: string;
  RS_TOKENS_ENC_KEY?: string;

  // Rate limiting
  RPS_LIMIT: number;
  CONCURRENCY_LIMIT: number;

  // Logging
  LOG_LEVEL: 'debug' | 'info' | 'warning' | 'error';
};

function parseBoolean(value: unknown): boolean {
  return String(value || 'false').toLowerCase() === 'true';
}

function parseNumber(value: unknown, defaultValue: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : defaultValue;
}

function parseStringArray(value: unknown): string[] {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Determine auth strategy from env.
 * Priority: AUTH_STRATEGY > AUTH_ENABLED > default
 */
function parseAuthStrategy(env: Record<string, unknown>): AuthStrategyType {
  const explicit = (env.AUTH_STRATEGY as string)?.toLowerCase();
  if (explicit && ['oauth', 'bearer', 'api_key', 'custom', 'none'].includes(explicit)) {
    return explicit as AuthStrategyType;
  }

  // Fallback: if AUTH_ENABLED is true, default to OAuth
  if (parseBoolean(env.AUTH_ENABLED)) {
    return 'oauth';
  }

  // Check if SPOTIFY_CLIENT_ID is set → default to oauth for Spotify
  if (env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET) {
    return 'oauth';
  }

  // Check if API_KEY is set → default to api_key
  if (env.API_KEY) {
    return 'api_key';
  }

  // Check if BEARER_TOKEN is set → default to bearer
  if (env.BEARER_TOKEN) {
    return 'bearer';
  }

  return 'none';
}

// Default Spotify OAuth scopes
const DEFAULT_SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-library-read',
  'user-library-modify',
].join(' ');

/**
 * Parse environment variables into a unified config object
 * Works for both process.env (Node.js) and Workers env bindings
 */
export function parseConfig(env: Record<string, unknown>): UnifiedConfig {
  const authStrategy = parseAuthStrategy(env);

  // Use Spotify credentials for OAuth if OAUTH_CLIENT_ID not explicitly set
  const oauthClientId =
    (env.OAUTH_CLIENT_ID as string) || (env.SPOTIFY_CLIENT_ID as string);
  const oauthClientSecret =
    (env.OAUTH_CLIENT_SECRET as string) || (env.SPOTIFY_CLIENT_SECRET as string);
  const spotifyScopes = String(
    env.SPOTIFY_SCOPES || env.OAUTH_SCOPES || DEFAULT_SPOTIFY_SCOPES,
  );

  return {
    HOST: String(env.HOST || '127.0.0.1'),
    PORT: parseNumber(env.PORT, 3000),
    NODE_ENV: (env.NODE_ENV as UnifiedConfig['NODE_ENV']) || 'development',

    MCP_TITLE: String(env.MCP_TITLE || 'Spotify MCP'),
    MCP_INSTRUCTIONS: String(
      env.MCP_INSTRUCTIONS ||
        'Control Spotify playback, manage playlists, and search music. Use player_status to check device availability before control actions.',
    ),
    MCP_VERSION: String(env.MCP_VERSION || '1.0.0'),
    MCP_PROTOCOL_VERSION: String(env.MCP_PROTOCOL_VERSION || '2025-06-18'),
    MCP_ACCEPT_HEADERS: parseStringArray(env.MCP_ACCEPT_HEADERS),

    // Auth Strategy
    AUTH_STRATEGY: authStrategy,
    AUTH_ENABLED: authStrategy === 'oauth' || parseBoolean(env.AUTH_ENABLED),
    AUTH_REQUIRE_RS: parseBoolean(env.AUTH_REQUIRE_RS),
    AUTH_ALLOW_DIRECT_BEARER: parseBoolean(env.AUTH_ALLOW_DIRECT_BEARER),
    AUTH_RESOURCE_URI: env.AUTH_RESOURCE_URI as string | undefined,
    AUTH_DISCOVERY_URL: env.AUTH_DISCOVERY_URL as string | undefined,

    // API Key auth
    API_KEY: env.API_KEY as string | undefined,
    API_KEY_HEADER: String(env.API_KEY_HEADER || 'x-api-key'),

    // Bearer token auth
    BEARER_TOKEN: env.BEARER_TOKEN as string | undefined,

    // Custom headers
    CUSTOM_HEADERS: env.CUSTOM_HEADERS as string | undefined,

    // OAuth - use Spotify credentials as fallback
    OAUTH_CLIENT_ID: oauthClientId?.trim(),
    OAUTH_CLIENT_SECRET: oauthClientSecret?.trim(),
    OAUTH_SCOPES: spotifyScopes,
    OAUTH_AUTHORIZATION_URL: String(
      env.OAUTH_AUTHORIZATION_URL || 'https://accounts.spotify.com/authorize',
    ),
    OAUTH_TOKEN_URL: String(
      env.OAUTH_TOKEN_URL || 'https://accounts.spotify.com/api/token',
    ),
    OAUTH_REVOCATION_URL: env.OAUTH_REVOCATION_URL as string | undefined,
    OAUTH_REDIRECT_URI: String(env.OAUTH_REDIRECT_URI || 'alice://oauth/callback'),
    OAUTH_REDIRECT_ALLOWLIST: parseStringArray(env.OAUTH_REDIRECT_ALLOWLIST),
    OAUTH_REDIRECT_ALLOW_ALL: parseBoolean(env.OAUTH_REDIRECT_ALLOW_ALL),
    OAUTH_EXTRA_AUTH_PARAMS: env.OAUTH_EXTRA_AUTH_PARAMS as string | undefined,

    // Provider-specific (for template compatibility)
    PROVIDER_CLIENT_ID: (env.SPOTIFY_CLIENT_ID as string | undefined)?.trim(),
    PROVIDER_CLIENT_SECRET: (env.SPOTIFY_CLIENT_SECRET as string | undefined)?.trim(),
    PROVIDER_API_URL: String(env.SPOTIFY_API_URL || 'https://api.spotify.com/v1'),
    PROVIDER_ACCOUNTS_URL: String(
      env.SPOTIFY_ACCOUNTS_URL || 'https://accounts.spotify.com',
    ),

    // Spotify-specific
    SPOTIFY_CLIENT_ID: (env.SPOTIFY_CLIENT_ID as string | undefined)?.trim(),
    SPOTIFY_CLIENT_SECRET: (env.SPOTIFY_CLIENT_SECRET as string | undefined)?.trim(),
    SPOTIFY_API_URL: String(env.SPOTIFY_API_URL || 'https://api.spotify.com/v1'),
    SPOTIFY_ACCOUNTS_URL: String(
      env.SPOTIFY_ACCOUNTS_URL || 'https://accounts.spotify.com',
    ),
    SPOTIFY_SCOPES: spotifyScopes,
    SPOTIFY_INCLUDE_JSON_IN_CONTENT: parseBoolean(env.SPOTIFY_INCLUDE_JSON_IN_CONTENT),

    RS_TOKENS_FILE: env.RS_TOKENS_FILE as string | undefined,
    RS_TOKENS_ENC_KEY: env.RS_TOKENS_ENC_KEY as string | undefined,

    RPS_LIMIT: parseNumber(env.RPS_LIMIT, 10),
    CONCURRENCY_LIMIT: parseNumber(env.CONCURRENCY_LIMIT, 5),

    LOG_LEVEL: (env.LOG_LEVEL as UnifiedConfig['LOG_LEVEL']) || 'info',
  };
}

export function resolveConfig(): UnifiedConfig {
  return parseConfig(process.env as Record<string, unknown>);
}
