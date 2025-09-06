import { z } from 'zod';

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const OptionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    MCP_TITLE: z.string().default('MCP Server Template'),
    MCP_INSTRUCTIONS: z
      .string()
      .default(
        'Use these tools responsibly. Prefer minimal scopes and small page sizes.',
      ),
    MCP_VERSION: z.string().default('0.1.0'),
    MCP_PROTOCOL_VERSION: z.string().default('2025-06-18'),
    MCP_ACCEPT_HEADERS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    AUTH_ENABLED: z
      .string()
      .default('false')
      .transform((v) => v.toLowerCase() === 'true'),
    // RS-only mode: only accept RS-minted bearer tokens at the resource server.
    AUTH_REQUIRE_RS: z
      .string()
      .default('false')
      .transform((v) => v.toLowerCase() === 'true'),
    // When RS-only is enabled, optionally allow falling back to a provider access token in Authorization: Bearer
    AUTH_ALLOW_DIRECT_BEARER: z
      .string()
      .default('false')
      .transform((v) => v.toLowerCase() === 'true'),
    AUTH_RESOURCE_URI: OptionalUrl,
    AUTH_DISCOVERY_URL: OptionalUrl,
    OAUTH_CLIENT_ID: z.string().optional(),
    OAUTH_CLIENT_SECRET: z.string().optional(),
    OAUTH_SCOPES: z.string().default(''),
    OAUTH_AUTHORIZATION_URL: OptionalUrl,
    OAUTH_TOKEN_URL: OptionalUrl,
    OAUTH_REVOCATION_URL: OptionalUrl,
    OAUTH_REDIRECT_URI: z.string().default('alice://oauth/callback'),
    // Comma-separated allowlist of exact redirect URIs permitted for final AS → client redirect
    OAUTH_REDIRECT_ALLOWLIST: z.string().default(''),
    // Dev helper to accept any client redirect. Do NOT enable in production.
    OAUTH_REDIRECT_ALLOW_ALL: z
      .string()
      .default('false')
      .transform((v) => v.toLowerCase() === 'true'),

    SPOTIFY_CLIENT_ID: z.string().optional(),
    SPOTIFY_CLIENT_SECRET: z.string().optional(),
    SPOTIFY_API_URL: z.string().url().default('https://api.spotify.com/v1'),
    SPOTIFY_ACCOUNTS_URL: z.string().url().default('https://accounts.spotify.com'),
    REDIRECT_URI: OptionalUrl,
    SPOTIFY_MCP_INCLUDE_JSON_IN_CONTENT: z
      .string()
      .default('false')
      .transform((val) => val.toLowerCase() === 'true'),
    RS_TOKENS_FILE: z.string().optional(),

    RPS_LIMIT: z.coerce.number().default(10),
    CONCURRENCY_LIMIT: z.coerce.number().default(5),

    LOG_LEVEL: z.enum(['debug', 'info', 'warning', 'error']).default('info'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  })
  .passthrough();

export type Config = z.infer<typeof EnvSchema> & {
  AUTH_ALLOW_DIRECT_BEARER: boolean;
};

function loadConfig(): Config {
  const parsed = EnvSchema.parse(process.env);
  // provider-agnostic flag only
  const allowDirect = parsed.AUTH_ALLOW_DIRECT_BEARER;
  // When AUTH_ENABLED=true, AUTH_RESOURCE_URI and AUTH_DISCOVERY_URL are optional.
  // They can be inferred from the incoming request URL and PORT+1 for local dev.
  return Object.freeze({ ...parsed, AUTH_ALLOW_DIRECT_BEARER: allowDirect });
}

export const config = loadConfig();
