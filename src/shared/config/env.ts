import type { AuthStrategyType } from '../auth/strategy.js';

export type LegacyMode = 'stateless' | 'reject';

export type UnifiedConfig = {
  // Server
  HOST: string;
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';

  // MCP
  MCP_NAME: string;
  MCP_TITLE: string;
  MCP_INSTRUCTIONS: string;
  MCP_VERSION: string;
  MCP_PUBLIC_URL: URL;
  MCP_ALLOWED_HOSTS: string[];
  MCP_ALLOWED_ORIGIN_HOSTNAMES: string[];
  MCP_LEGACY_MODE: LegacyMode;
  MCP_MAX_REQUEST_BYTES: number;

  // Auth strategy
  AUTH_STRATEGY: AuthStrategyType;
  AUTH_ENABLED: boolean;
  AUTH_DISCOVERY_URL?: string;
  MCP_REQUIRED_SCOPES: string[];

  // API key auth
  API_KEY?: string;
  API_KEY_HEADER: string;

  // Static bearer auth
  BEARER_TOKEN?: string;

  // Custom headers
  CUSTOM_HEADERS?: string;

  // OAuth proxy
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

  // Provider-compatible aliases
  PROVIDER_CLIENT_ID?: string;
  PROVIDER_CLIENT_SECRET?: string;
  PROVIDER_API_URL?: string;
  PROVIDER_ACCOUNTS_URL?: string;

  // Spotify
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_API_URL: string;
  SPOTIFY_ACCOUNTS_URL: string;
  SPOTIFY_SCOPES: string;
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

function stringValue(env: Record<string, unknown>, key: string, fallback = ''): string {
  const value = env[key];
  return value === undefined || value === null || value === ''
    ? fallback
    : String(value).trim();
}

function booleanValue(
  env: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  const raw = stringValue(env, key);
  if (!raw) return fallback;
  const value = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${key} must be true or false`);
}

function numberValue(
  env: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(stringValue(env, key, String(fallback)));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function commaListValue(env: Record<string, unknown>, key: string): string[] {
  const value = stringValue(env, key);
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

function scopeListValue(env: Record<string, unknown>, key: string): string[] {
  const value = stringValue(env, key);
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(/[ ,]+/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

function enumValue<T extends string>(
  env: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = stringValue(env, key, fallback) as T;
  if (!values.includes(value)) {
    throw new Error(`${key} must be one of: ${values.join(', ')}`);
  }
  return value;
}

function absoluteUrl(value: string, key: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute URL`);
  }
}

function optionalUrlString(
  env: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = stringValue(env, key);
  if (!value) return undefined;
  absoluteUrl(value, key);
  return value;
}

function parseAuthStrategy(env: Record<string, unknown>): AuthStrategyType {
  const explicit = stringValue(env, 'AUTH_STRATEGY').toLowerCase();
  if (explicit) {
    const strategies: AuthStrategyType[] = [
      'oauth',
      'bearer',
      'api_key',
      'custom',
      'none',
    ];
    if (!strategies.includes(explicit as AuthStrategyType)) {
      throw new Error(`AUTH_STRATEGY must be one of: ${strategies.join(', ')}`);
    }
    return explicit as AuthStrategyType;
  }

  if (booleanValue(env, 'AUTH_ENABLED')) return 'oauth';
  if (env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET) return 'oauth';
  if (env.API_KEY) return 'api_key';
  if (env.BEARER_TOKEN) return 'bearer';
  return 'none';
}

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

/** Parse deployment-scoped settings without creating request-scoped state. */
export function parseConfig(env: Record<string, unknown>): UnifiedConfig {
  const port = numberValue(env, 'PORT', 3000, 1, 65_535);
  const nodeEnv = enumValue(
    env,
    'NODE_ENV',
    ['development', 'production', 'test'] as const,
    'development',
  );
  const configuredPublicUrl = stringValue(env, 'MCP_PUBLIC_URL');
  const publicUrl = absoluteUrl(
    configuredPublicUrl || `http://localhost:${port}/mcp`,
    configuredPublicUrl ? 'MCP_PUBLIC_URL' : 'default MCP public URL',
  );
  if (publicUrl.search || publicUrl.hash) {
    throw new Error('MCP_PUBLIC_URL must not include a query string or fragment');
  }

  const defaultHosts = [publicUrl.hostname];
  if (nodeEnv !== 'production') {
    defaultHosts.push('localhost', '127.0.0.1', '[::1]');
  }
  const allowedHosts = commaListValue(env, 'MCP_ALLOWED_HOSTS');
  const allowedOrigins = commaListValue(env, 'MCP_ALLOWED_ORIGIN_HOSTNAMES');

  const configuredAuthEnabled = booleanValue(env, 'AUTH_ENABLED');
  const authStrategy = parseAuthStrategy(env);
  const authEnabled = authStrategy === 'oauth' || configuredAuthEnabled;
  const spotifyClientId =
    stringValue(env, 'SPOTIFY_CLIENT_ID') ||
    stringValue(env, 'OAUTH_CLIENT_ID') ||
    undefined;
  const spotifyClientSecret =
    stringValue(env, 'SPOTIFY_CLIENT_SECRET') ||
    stringValue(env, 'OAUTH_CLIENT_SECRET') ||
    undefined;
  const spotifyScopes = stringValue(
    env,
    'SPOTIFY_SCOPES',
    stringValue(env, 'OAUTH_SCOPES', DEFAULT_SPOTIFY_SCOPES),
  );

  return {
    HOST: stringValue(env, 'HOST', '127.0.0.1'),
    PORT: port,
    NODE_ENV: nodeEnv,

    MCP_NAME: stringValue(env, 'MCP_NAME', 'mcp-spotify'),
    MCP_TITLE: stringValue(env, 'MCP_TITLE', 'Spotify Music'),
    MCP_INSTRUCTIONS: stringValue(
      env,
      'MCP_INSTRUCTIONS',
      'Control Spotify playback, manage playlists, and search music. Use player_status to check device availability before control actions.',
    ),
    MCP_VERSION: stringValue(env, 'MCP_VERSION', '1.0.0'),
    MCP_PUBLIC_URL: publicUrl,
    MCP_ALLOWED_HOSTS:
      allowedHosts.length > 0 ? allowedHosts : [...new Set(defaultHosts)],
    MCP_ALLOWED_ORIGIN_HOSTNAMES:
      allowedOrigins.length > 0 ? allowedOrigins : [...new Set(defaultHosts)],
    MCP_LEGACY_MODE: enumValue(
      env,
      'MCP_LEGACY_MODE',
      ['stateless', 'reject'] as const,
      'stateless',
    ),
    MCP_MAX_REQUEST_BYTES: numberValue(
      env,
      'MCP_MAX_REQUEST_BYTES',
      1_048_576,
      1_024,
      10_485_760,
    ),

    AUTH_STRATEGY: authStrategy,
    AUTH_ENABLED: authEnabled,
    AUTH_DISCOVERY_URL: optionalUrlString(env, 'AUTH_DISCOVERY_URL'),
    MCP_REQUIRED_SCOPES: scopeListValue(
      env,
      stringValue(env, 'MCP_REQUIRED_SCOPES')
        ? 'MCP_REQUIRED_SCOPES'
        : 'OAUTH_REQUIRED_SCOPES',
    ),

    API_KEY: stringValue(env, 'API_KEY') || undefined,
    API_KEY_HEADER: stringValue(env, 'API_KEY_HEADER', 'x-api-key'),
    BEARER_TOKEN: stringValue(env, 'BEARER_TOKEN') || undefined,
    CUSTOM_HEADERS: stringValue(env, 'CUSTOM_HEADERS') || undefined,

    OAUTH_CLIENT_ID: spotifyClientId,
    OAUTH_CLIENT_SECRET: spotifyClientSecret,
    OAUTH_SCOPES: spotifyScopes,
    OAUTH_AUTHORIZATION_URL: optionalUrlString(env, 'OAUTH_AUTHORIZATION_URL'),
    OAUTH_TOKEN_URL: optionalUrlString(env, 'OAUTH_TOKEN_URL'),
    OAUTH_REVOCATION_URL: optionalUrlString(env, 'OAUTH_REVOCATION_URL'),
    OAUTH_REDIRECT_URI: stringValue(
      env,
      'OAUTH_REDIRECT_URI',
      'alice://oauth/callback',
    ),
    OAUTH_REDIRECT_ALLOWLIST: commaListValue(env, 'OAUTH_REDIRECT_ALLOWLIST'),
    OAUTH_REDIRECT_ALLOW_ALL: booleanValue(env, 'OAUTH_REDIRECT_ALLOW_ALL'),
    OAUTH_EXTRA_AUTH_PARAMS: stringValue(env, 'OAUTH_EXTRA_AUTH_PARAMS') || undefined,

    PROVIDER_CLIENT_ID: spotifyClientId,
    PROVIDER_CLIENT_SECRET: spotifyClientSecret,
    PROVIDER_API_URL: stringValue(env, 'SPOTIFY_API_URL', 'https://api.spotify.com/v1'),
    PROVIDER_ACCOUNTS_URL: stringValue(
      env,
      'SPOTIFY_ACCOUNTS_URL',
      'https://accounts.spotify.com',
    ),

    SPOTIFY_CLIENT_ID: spotifyClientId,
    SPOTIFY_CLIENT_SECRET: spotifyClientSecret,
    SPOTIFY_API_URL: stringValue(env, 'SPOTIFY_API_URL', 'https://api.spotify.com/v1'),
    SPOTIFY_ACCOUNTS_URL: stringValue(
      env,
      'SPOTIFY_ACCOUNTS_URL',
      'https://accounts.spotify.com',
    ),
    SPOTIFY_SCOPES: spotifyScopes,
    SPOTIFY_INCLUDE_JSON_IN_CONTENT: booleanValue(
      env,
      'SPOTIFY_INCLUDE_JSON_IN_CONTENT',
    ),

    RS_TOKENS_FILE: stringValue(env, 'RS_TOKENS_FILE') || undefined,
    RS_TOKENS_ENC_KEY: stringValue(env, 'RS_TOKENS_ENC_KEY') || undefined,

    RPS_LIMIT: numberValue(env, 'RPS_LIMIT', 10, 1, 10_000),
    CONCURRENCY_LIMIT: numberValue(env, 'CONCURRENCY_LIMIT', 5, 1, 10_000),

    LOG_LEVEL: enumValue(
      env,
      'LOG_LEVEL',
      ['debug', 'info', 'warning', 'error'] as const,
      'info',
    ),
  };
}

export function resolveConfig(): UnifiedConfig {
  return parseConfig(process.env as Record<string, unknown>);
}
