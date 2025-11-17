// Unified config reader for both Node.js and Cloudflare Workers

export type UnifiedConfig = {
  // Server
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';

  // MCP
  MCP_TITLE: string;
  MCP_INSTRUCTIONS: string;
  MCP_VERSION: string;
  MCP_PROTOCOL_VERSION: string;
  MCP_ACCEPT_HEADERS: string[];

  // Auth
  AUTH_ENABLED: boolean;
  AUTH_REQUIRE_RS: boolean;
  AUTH_ALLOW_DIRECT_BEARER: boolean;
  AUTH_RESOURCE_URI?: string;
  AUTH_DISCOVERY_URL?: string;

  // OAuth
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  OAUTH_SCOPES: string;
  OAUTH_AUTHORIZATION_URL?: string;
  OAUTH_TOKEN_URL?: string;
  OAUTH_REVOCATION_URL?: string;
  OAUTH_REDIRECT_URI: string;
  OAUTH_REDIRECT_ALLOWLIST: string[];
  OAUTH_REDIRECT_ALLOW_ALL: boolean;

  // Spotify
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_API_URL: string;
  SPOTIFY_ACCOUNTS_URL: string;
  REDIRECT_URI?: string;
  SPOTIFY_MCP_INCLUDE_JSON_IN_CONTENT: boolean;

  // Storage
  RS_TOKENS_FILE?: string;

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
 * Parse environment variables into a unified config object
 * Works for both process.env (Node.js) and Workers env bindings
 */
export function parseConfig(env: Record<string, unknown>): UnifiedConfig {
  return {
    PORT: parseNumber(env.PORT, 3000),
    NODE_ENV: (env.NODE_ENV as UnifiedConfig['NODE_ENV']) || 'development',

    MCP_TITLE: String(env.MCP_TITLE || 'MCP Server Template'),
    MCP_INSTRUCTIONS: String(
      env.MCP_INSTRUCTIONS ||
        'Use these tools responsibly. Prefer minimal scopes and small page sizes.',
    ),
    MCP_VERSION: String(env.MCP_VERSION || '0.1.0'),
    MCP_PROTOCOL_VERSION: String(env.MCP_PROTOCOL_VERSION || '2025-06-18'),
    MCP_ACCEPT_HEADERS: parseStringArray(env.MCP_ACCEPT_HEADERS),

    AUTH_ENABLED: parseBoolean(env.AUTH_ENABLED),
    AUTH_REQUIRE_RS: parseBoolean(env.AUTH_REQUIRE_RS),
    AUTH_ALLOW_DIRECT_BEARER: parseBoolean(env.AUTH_ALLOW_DIRECT_BEARER),
    AUTH_RESOURCE_URI: env.AUTH_RESOURCE_URI as string | undefined,
    AUTH_DISCOVERY_URL: env.AUTH_DISCOVERY_URL as string | undefined,

    OAUTH_CLIENT_ID: env.OAUTH_CLIENT_ID as string | undefined,
    OAUTH_CLIENT_SECRET: env.OAUTH_CLIENT_SECRET as string | undefined,
    OAUTH_SCOPES: String(env.OAUTH_SCOPES || ''),
    OAUTH_AUTHORIZATION_URL: env.OAUTH_AUTHORIZATION_URL as string | undefined,
    OAUTH_TOKEN_URL: env.OAUTH_TOKEN_URL as string | undefined,
    OAUTH_REVOCATION_URL: env.OAUTH_REVOCATION_URL as string | undefined,
    OAUTH_REDIRECT_URI: String(env.OAUTH_REDIRECT_URI || 'alice://oauth/callback'),
    OAUTH_REDIRECT_ALLOWLIST: parseStringArray(env.OAUTH_REDIRECT_ALLOWLIST),
    OAUTH_REDIRECT_ALLOW_ALL: parseBoolean(env.OAUTH_REDIRECT_ALLOW_ALL),

    SPOTIFY_CLIENT_ID: (env.SPOTIFY_CLIENT_ID as string | undefined)?.trim(),
    SPOTIFY_CLIENT_SECRET: (env.SPOTIFY_CLIENT_SECRET as string | undefined)?.trim(),
    SPOTIFY_API_URL: String(env.SPOTIFY_API_URL || 'https://api.spotify.com/v1'),
    SPOTIFY_ACCOUNTS_URL: String(
      env.SPOTIFY_ACCOUNTS_URL || 'https://accounts.spotify.com',
    ),
    REDIRECT_URI: env.REDIRECT_URI as string | undefined,
    SPOTIFY_MCP_INCLUDE_JSON_IN_CONTENT: parseBoolean(
      env.SPOTIFY_MCP_INCLUDE_JSON_IN_CONTENT,
    ),

    RS_TOKENS_FILE: env.RS_TOKENS_FILE as string | undefined,

    RPS_LIMIT: parseNumber(env.RPS_LIMIT, 10),
    CONCURRENCY_LIMIT: parseNumber(env.CONCURRENCY_LIMIT, 5),

    LOG_LEVEL: (env.LOG_LEVEL as UnifiedConfig['LOG_LEVEL']) || 'info',
  };
}
