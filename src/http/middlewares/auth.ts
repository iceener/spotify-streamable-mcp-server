// Auth header middleware for Hono
// Supports multiple auth strategies: OAuth, API Key, Bearer, Custom Headers

import type { HttpBindings } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import { config } from '../../config/env.js';
import type { AuthStrategyType } from '../../shared/auth/strategy.js';
import type { ProviderTokens } from '../../shared/storage/interface.js';
import { getTokenStore } from '../../shared/storage/singleton.js';
import { logger } from '../../utils/logger.js';

/**
 * Auth context attached to Hono context.
 */
export interface AuthContext {
  /** Auth strategy in use */
  strategy: AuthStrategyType;
  /** Raw authorization headers from request */
  authHeaders: Record<string, string>;
  /** Resolved headers for API calls (includes static config headers) */
  resolvedHeaders: Record<string, string>;
  /** Provider access token (OAuth: mapped from RS token, Bearer: from config) */
  providerToken?: string;
  /** Full provider token info (OAuth only) */
  provider?: ProviderTokens;
  /** Original RS token (OAuth only) */
  rsToken?: string;
}

/**
 * Parse custom headers from config string.
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
      headers[key.toLowerCase()] = val;
    }
  }

  return headers;
}

/**
 * Build static headers from non-OAuth auth config.
 */
function buildStaticAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  switch (config.AUTH_STRATEGY) {
    case 'api_key':
      if (config.API_KEY) {
        headers[config.API_KEY_HEADER.toLowerCase()] = config.API_KEY;
      }
      break;

    case 'bearer':
      if (config.BEARER_TOKEN) {
        headers.authorization = `Bearer ${config.BEARER_TOKEN}`;
      }
      break;

    case 'custom':
      Object.assign(headers, parseCustomHeaders(config.CUSTOM_HEADERS));
      break;
  }

  return headers;
}

/**
 * Auth middleware that handles multiple strategies.
 *
 * Strategies:
 * - 'oauth': Map RS token → Provider token (full OAuth flow)
 * - 'bearer': Use static BEARER_TOKEN from config
 * - 'api_key': Use static API_KEY in API_KEY_HEADER
 * - 'custom': Use static CUSTOM_HEADERS
 * - 'none': No auth, pass through
 *
 * After this middleware:
 * - c.authContext.resolvedHeaders: Headers ready for API calls
 * - c.authContext.providerToken: Access token (if available)
 * - c.authContext.provider: Full token info (OAuth only)
 */
export function createAuthHeaderMiddleware(): MiddlewareHandler<{
  Bindings: HttpBindings;
}> {
  const accept = new Set(
    (config.MCP_ACCEPT_HEADERS as string[]).map((h) => h.toLowerCase()),
  );
  // Always include standard auth headers
  for (const h of ['authorization', 'x-api-key', 'x-auth-token']) {
    accept.add(h);
  }

  // Pre-compute static headers for non-OAuth strategies
  const staticHeaders = buildStaticAuthHeaders();
  const strategy = config.AUTH_STRATEGY;

  return async (c, next) => {
    const incoming = c.req.raw.headers;
    const forwarded: Record<string, string> = {};

    for (const [k, v] of incoming as unknown as Iterable<[string, string]>) {
      const lower = k.toLowerCase();
      if (accept.has(lower)) {
        forwarded[lower] = v;
      }
    }

    // Initialize auth context
    const authContext: AuthContext = {
      strategy,
      authHeaders: forwarded,
      resolvedHeaders: { ...forwarded },
    };

    // Handle based on strategy
    switch (strategy) {
      case 'oauth':
        await handleOAuthStrategy(authContext, forwarded);
        break;

      case 'bearer':
        // Use static bearer token from config
        authContext.resolvedHeaders = { ...forwarded, ...staticHeaders };
        authContext.providerToken = config.BEARER_TOKEN;
        break;

      case 'api_key':
        // Use static API key from config
        authContext.resolvedHeaders = { ...forwarded, ...staticHeaders };
        authContext.providerToken = config.API_KEY;
        break;

      case 'custom':
        // Merge custom headers
        authContext.resolvedHeaders = { ...forwarded, ...staticHeaders };
        break;

      default:
        // Pass through as-is (including 'none' strategy)
        break;
    }

    // Attach to context for downstream handlers
    (c as unknown as { authContext: AuthContext }).authContext = authContext;

    // Legacy: attach authHeaders for backward compatibility
    (c as unknown as { authHeaders?: Record<string, string> }).authHeaders =
      authContext.resolvedHeaders;

    await next();
  };
}

/**
 * Handle OAuth strategy: map RS token to provider token.
 */
async function handleOAuthStrategy(
  authContext: AuthContext,
  forwarded: Record<string, string>,
): Promise<void> {
  const auth = forwarded.authorization;
  const bearerMatch = auth?.match(/^\s*Bearer\s+(.+)$/i);
  const rsToken = bearerMatch?.[1];

  if (!rsToken) return;

  authContext.rsToken = rsToken;

  try {
    const store = getTokenStore();
    const record = await store.getByRsAccess(rsToken);

    if (record?.provider?.access_token) {
      const now = Date.now();
      const expiresAt = record.provider.expires_at ?? 0;

      if (expiresAt && now >= expiresAt - 60_000) {
        logger.warning('auth_middleware', {
          message: 'Provider token expired or expiring soon',
          expiresAt,
          now,
        });
      }

      authContext.providerToken = record.provider.access_token;
      authContext.provider = record.provider;

      // Replace RS token with provider token in resolved headers
      authContext.resolvedHeaders.authorization = `Bearer ${record.provider.access_token}`;

      logger.debug('auth_middleware', {
        message: 'Mapped RS token to provider token',
        hasRefreshToken: Boolean(record.provider.refresh_token),
        expiresAt: record.provider.expires_at,
      });
    } else if (config.AUTH_REQUIRE_RS && !config.AUTH_ALLOW_DIRECT_BEARER) {
      delete authContext.resolvedHeaders.authorization;
      logger.warning('auth_middleware', {
        message: 'RS token not found in store',
      });
    }
  } catch (error) {
    logger.error('auth_middleware', {
      message: 'Failed to look up RS token',
      error: (error as Error).message,
    });
  }
}
