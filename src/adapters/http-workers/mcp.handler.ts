/**
 * MCP endpoint handler for Cloudflare Workers.
 * Uses the shared dispatcher for JSON-RPC processing.
 */

import type { UnifiedConfig } from '../../shared/config/env.js';
import { withCors } from '../../shared/http/cors.js';
import { jsonResponse } from '../../shared/http/response.js';
import {
  type CancellationRegistry,
  dispatchMcpMethod,
  handleMcpNotification,
  type McpDispatchContext,
  type McpSessionState,
} from '../../shared/mcp/dispatcher.js';
import {
  ensureFreshToken,
  type ProviderRefreshConfig,
} from '../../shared/oauth/refresh.js';
import type { SessionStore, TokenStore } from '../../shared/storage/interface.js';
import type { AuthStrategy, ToolContext } from '../../shared/tools/types.js';
import { sharedLogger as logger } from '../../shared/utils/logger.js';
import { checkAuthAndChallenge } from './security.js';

// ─────────────────────────────────────────────────────────────────────────────
// Session State (in-memory, persists within worker instance)
// Note: These are ephemeral in Workers - each request may hit a different isolate
// ─────────────────────────────────────────────────────────────────────────────

const sessionStateMap = new Map<string, McpSessionState>();

// Cancellation registry for tracking in-flight requests per session
// This enables notifications/cancelled to abort running tool calls
const cancellationRegistryMap = new Map<string, CancellationRegistry>();

/**
 * Get or create cancellation registry for a session.
 */
function getCancellationRegistry(sessionId: string): CancellationRegistry {
  let registry = cancellationRegistryMap.get(sessionId);
  if (!registry) {
    registry = new Map();
    cancellationRegistryMap.set(sessionId, registry);
  }
  return registry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse custom headers from config string.
 * Format: "X-Header-1:value1,X-Header-2:value2"
 */
function parseCustomHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};

  const headers: Record<string, string> = {};
  for (const pair of value.split(',')) {
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
 * Build static auth headers from config.
 */
function buildStaticAuthHeaders(config: UnifiedConfig): Record<string, string> {
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
 * Build provider config for token refresh from unified config.
 */
function buildProviderRefreshConfig(
  config: UnifiedConfig,
): ProviderRefreshConfig | undefined {
  if (
    !config.PROVIDER_CLIENT_ID ||
    !config.PROVIDER_CLIENT_SECRET ||
    !config.PROVIDER_ACCOUNTS_URL
  ) {
    return undefined;
  }
  return {
    clientId: config.PROVIDER_CLIENT_ID,
    clientSecret: config.PROVIDER_CLIENT_SECRET,
    accountsUrl: config.PROVIDER_ACCOUNTS_URL,
  };
}

/**
 * Resolve auth context from request and config.
 * Includes proactive token refresh for OAuth strategy.
 */
async function resolveAuthContext(
  request: Request,
  tokenStore: TokenStore,
  config: UnifiedConfig,
): Promise<ToolContext> {
  // Extract raw headers
  const rawHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    rawHeaders[key.toLowerCase()] = value;
  });

  const strategy = config.AUTH_STRATEGY as AuthStrategy;
  let providerToken: string | undefined;
  let provider: ToolContext['provider'];
  let resolvedHeaders = { ...rawHeaders };

  if (strategy === 'oauth') {
    // OAuth: map RS token to provider token
    const authHeader = rawHeaders.authorization;
    const match = authHeader?.match(/^\s*Bearer\s+(.+)$/i);
    const rsToken = match?.[1];

    if (rsToken) {
      try {
        // Proactively refresh token if near expiry
        const providerConfig = buildProviderRefreshConfig(config);
        const { accessToken, wasRefreshed } = await ensureFreshToken(
          rsToken,
          tokenStore,
          providerConfig,
        );

        if (accessToken) {
          providerToken = accessToken;

          // Re-fetch record if it was refreshed to get updated info
          const record = await tokenStore.getByRsAccess(rsToken);
          if (record?.provider) {
            provider = {
              accessToken: record.provider.access_token,
              refreshToken: record.provider.refresh_token,
              expiresAt: record.provider.expires_at,
              scopes: record.provider.scopes,
            };
          }

          resolvedHeaders.authorization = `Bearer ${accessToken}`;

          if (wasRefreshed) {
            logger.info('mcp_handler', {
              message: 'Using proactively refreshed token',
            });
          }
        }
      } catch (error) {
        logger.debug('mcp_handler', {
          message: 'Token resolution failed',
          error: (error as Error).message,
        });
      }
    }
  } else if (strategy === 'bearer' || strategy === 'api_key' || strategy === 'custom') {
    // Static auth: use config values
    const staticHeaders = buildStaticAuthHeaders(config);
    resolvedHeaders = { ...rawHeaders, ...staticHeaders };
    providerToken = strategy === 'bearer' ? config.BEARER_TOKEN : config.API_KEY;
  }

  return {
    sessionId: '', // Will be set by caller
    authStrategy: strategy,
    providerToken,
    provider,
    resolvedHeaders,
    authHeaders: rawHeaders,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Handler
// ─────────────────────────────────────────────────────────────────────────────

export interface McpHandlerDeps {
  tokenStore: TokenStore;
  sessionStore: SessionStore;
  config: UnifiedConfig;
}

/**
 * Handle MCP POST request.
 */
export async function handleMcpRequest(
  request: Request,
  deps: McpHandlerDeps,
): Promise<Response> {
  const { tokenStore, sessionStore, config } = deps;

  // Get or create session ID
  const incomingSessionId = request.headers.get('Mcp-Session-Id');
  const sessionId = incomingSessionId?.trim() || crypto.randomUUID();

  // Ensure session exists
  try {
    await sessionStore.ensure(sessionId);
  } catch {
    // Ignore session creation errors
  }

  // Check auth and get challenge response if needed
  const challengeResponse = await checkAuthAndChallenge(
    request,
    tokenStore,
    config,
    sessionId,
  );
  if (challengeResponse) {
    return challengeResponse;
  }

  // Resolve auth context
  const authContext = await resolveAuthContext(request, tokenStore, config);
  authContext.sessionId = sessionId;

  // Parse JSON-RPC body
  const body = (await request.json().catch(() => ({}))) as {
    jsonrpc?: string;
    method?: string;
    params?: Record<string, unknown>;
    id?: string | number | null;
  };

  const { method, params, id } = body;

  // Get cancellation registry for this session
  const cancellationRegistry = getCancellationRegistry(sessionId);

  // Build dispatch context
  const dispatchContext: McpDispatchContext = {
    sessionId,
    auth: authContext,
    config: {
      title: config.MCP_TITLE,
      version: config.MCP_VERSION,
      instructions: config.MCP_INSTRUCTIONS,
    },
    getSessionState: () => sessionStateMap.get(sessionId),
    setSessionState: (state) => sessionStateMap.set(sessionId, state),
    cancellationRegistry,
  };

  // Handle notifications (no id) - return 202 Accepted
  if (!('id' in body) || id === null || id === undefined) {
    if (method) {
      handleMcpNotification(method, params, dispatchContext);
    }
    return withCors(new Response(null, { status: 202 }));
  }

  // Dispatch JSON-RPC request with requestId for cancellation tracking
  const result = await dispatchMcpMethod(method, params, dispatchContext, id);

  // Build response
  const response = jsonResponse({
    jsonrpc: '2.0',
    ...(result.error ? { error: result.error } : { result: result.result }),
    id,
  });

  response.headers.set('Mcp-Session-Id', sessionId);
  return withCors(response);
}

/**
 * Handle MCP GET request (returns 405 per spec).
 */
export function handleMcpGet(): Response {
  return withCors(new Response('Method Not Allowed', { status: 405 }));
}
