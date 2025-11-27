// Auth Strategy Pattern
// Supports: OAuth, API Key, Bearer Token, Custom Headers

/**
 * Auth strategy types supported by the template.
 *
 * - 'oauth': Full OAuth 2.1 PKCE flow with RS token mapping
 * - 'bearer': Simple static Bearer token (from env)
 * - 'api_key': API key in custom header (e.g., x-api-key)
 * - 'custom': Arbitrary headers from config
 * - 'none': No authentication required
 */
export type AuthStrategyType = 'oauth' | 'bearer' | 'api_key' | 'custom' | 'none';

/**
 * Resolved auth headers to inject into tool context.
 */
export interface ResolvedAuth {
  /** Auth strategy used */
  strategy: AuthStrategyType;
  /** Headers to pass to API calls */
  headers: Record<string, string>;
  /** Raw access token (if bearer/oauth) */
  accessToken?: string;
  /** Provider tokens (oauth only) */
  provider?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

/**
 * Strategy configuration parsed from env.
 */
export interface AuthStrategyConfig {
  type: AuthStrategyType;
  /** For api_key: header name (default: x-api-key) */
  headerName?: string;
  /** For api_key/bearer: the token/key value */
  value?: string;
  /** For custom: map of header name → value */
  customHeaders?: Record<string, string>;
}

/**
 * Parse custom headers from env string.
 * Format: "X-Header-1:value1,X-Header-2:value2"
 */
function parseCustomHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};

  const headers: Record<string, string> = {};
  const pairs = value.split(',');

  for (const pair of pairs) {
    const colonIndex = pair.indexOf(':');
    if (colonIndex === -1) continue;

    const key = pair.slice(0, colonIndex).trim();
    const val = pair.slice(colonIndex + 1).trim();

    if (key && val) {
      headers[key] = val;
    }
  }

  return headers;
}

/**
 * Parse auth strategy from config.
 *
 * Reads from:
 * - AUTH_STRATEGY: 'oauth' | 'bearer' | 'api_key' | 'custom' | 'none'
 * - API_KEY: The API key value (for api_key strategy)
 * - API_KEY_HEADER: Header name (default: x-api-key)
 * - BEARER_TOKEN: Static bearer token (for bearer strategy)
 * - CUSTOM_HEADERS: "Header1:value1,Header2:value2" format
 */
export function parseAuthStrategy(env: Record<string, unknown>): AuthStrategyConfig {
  const strategy = (env.AUTH_STRATEGY as string)?.toLowerCase() as AuthStrategyType;

  switch (strategy) {
    case 'api_key':
      return {
        type: 'api_key',
        headerName: (env.API_KEY_HEADER as string) || 'x-api-key',
        value: env.API_KEY as string,
      };

    case 'bearer':
      return {
        type: 'bearer',
        value: env.BEARER_TOKEN as string,
      };

    case 'custom':
      return {
        type: 'custom',
        customHeaders: parseCustomHeaders(env.CUSTOM_HEADERS as string),
      };

    case 'none':
      return { type: 'none' };

    default:
      // Default to OAuth if AUTH_ENABLED or no strategy specified (including 'oauth')
      return { type: 'oauth' };
  }
}

/**
 * Build auth headers from strategy config.
 * Used for non-OAuth strategies where headers are static.
 */
export function buildAuthHeaders(
  strategyConfig: AuthStrategyConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};

  switch (strategyConfig.type) {
    case 'api_key':
      if (strategyConfig.value && strategyConfig.headerName) {
        headers[strategyConfig.headerName] = strategyConfig.value;
      }
      break;

    case 'bearer':
      if (strategyConfig.value) {
        headers.Authorization = `Bearer ${strategyConfig.value}`;
      }
      break;

    case 'custom':
      if (strategyConfig.customHeaders) {
        Object.assign(headers, strategyConfig.customHeaders);
      }
      break;

    case 'oauth':
    case 'none':
      // OAuth headers are resolved dynamically via RS token mapping
      // 'none' has no headers
      break;
  }

  return headers;
}

/**
 * Resolve auth for a request.
 *
 * For OAuth: requires incoming RS token to be mapped
 * For other strategies: uses static config values
 */
export function resolveStaticAuth(strategyConfig: AuthStrategyConfig): ResolvedAuth {
  const headers = buildAuthHeaders(strategyConfig);

  return {
    strategy: strategyConfig.type,
    headers,
    accessToken: strategyConfig.type === 'bearer' ? strategyConfig.value : undefined,
  };
}

/**
 * Merge incoming request headers with strategy headers.
 * Strategy headers take precedence (they're the "real" auth).
 */
export function mergeAuthHeaders(
  incoming: Record<string, string>,
  strategy: Record<string, string>,
): Record<string, string> {
  return {
    ...incoming,
    ...strategy,
  };
}

/**
 * Check if auth strategy requires OAuth flow.
 */
export function isOAuthStrategy(config: AuthStrategyConfig): boolean {
  return config.type === 'oauth';
}

/**
 * Check if auth strategy requires any authentication.
 */
export function requiresAuth(config: AuthStrategyConfig): boolean {
  return config.type !== 'none';
}

/**
 * Validate that required config values are present for the strategy.
 */
export function validateAuthConfig(config: AuthStrategyConfig): string[] {
  const errors: string[] = [];

  switch (config.type) {
    case 'api_key':
      if (!config.value) {
        errors.push('API_KEY is required when AUTH_STRATEGY=api_key');
      }
      break;

    case 'bearer':
      if (!config.value) {
        errors.push('BEARER_TOKEN is required when AUTH_STRATEGY=bearer');
      }
      break;

    case 'custom':
      if (!config.customHeaders || Object.keys(config.customHeaders).length === 0) {
        errors.push('CUSTOM_HEADERS is required when AUTH_STRATEGY=custom');
      }
      break;
  }

  return errors;
}
