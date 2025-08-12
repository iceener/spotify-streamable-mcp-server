import { z } from 'zod';

const envSchema = z.object({
  PORT: z.string().default('3030').transform(Number),
  HOST: z.string().default('127.0.0.1'),
  MCP_TITLE: z.string().default(''),
  MCP_INSTRUCTIONS: z.string().default(''),
  MCP_VERSION: z.string().default('1.0.0'),
  MCP_PROTOCOL_VERSION: z.string().default('2024-11-05'),
  // Authentication configuration
  AUTH_ENABLED: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  AUTH_RESOURCE_URI: z.string().url().optional(),
  AUTH_DISCOVERY_URL: z.string().url().optional(),
  OAUTH_SCOPES: z.string().default(''),
  OAUTH_AUTHORIZATION_URL: z.string().url().optional(),
  OAUTH_TOKEN_URL: z.string().url().optional(),
  OAUTH_REVOCATION_URL: z.string().url().optional(),
  OAUTH_REDIRECT_URI: z
    .string()
    .default('https://ai.overment.com/mcp/oauth/Spotify/callback'),
  // Comma-separated allowlist of exact redirect URIs permitted for final AS → client redirect
  OAUTH_REDIRECT_ALLOWLIST: z.string().default(''),
  REDIRECT_URI: z.string().url().optional(),
  // Rate limiting
  RPS_LIMIT: z.string().default('10').transform(Number),
  CONCURRENCY_LIMIT: z.string().default('5').transform(Number),
  // Node environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // CORS/Origin allowlist (comma-separated list like "https://a.com,https://b.com")
  ALLOWED_ORIGINS: z.string().default(''),
  // Spotify API (client-credentials) configuration
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),
  SPOTIFY_API_URL: z.string().url().default('https://api.spotify.com/v1'),
  SPOTIFY_ACCOUNTS_URL: z.string().url().default('https://accounts.spotify.com'),

  // MCP content behavior flags
  SPOTIFY_MCP_INCLUDE_JSON_IN_CONTENT: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),

  // Optional persistence for RS→Spotify token mappings (development convenience)
  RS_TOKENS_FILE: z.string().optional(),

  // HTTPS / TLS configuration removed (no longer used)
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  try {
    const parsed = envSchema.parse(process.env);
    // Validation checks
    // When AUTH_ENABLED=true, AUTH_RESOURCE_URI and AUTH_DISCOVERY_URL may be inferred from the
    // incoming request URL and PORT+1 respectively, so they are optional at runtime.
    return Object.freeze(parsed);
  } catch (error) {
    console.error('Environment configuration error:', error);
    process.exit(1);
  }
}

export const config = loadConfig();
