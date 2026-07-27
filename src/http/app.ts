import {
  type AuthInfo,
  type OAuthTokenVerifier,
  oauthMetadataResponse,
  type ServerNotifier,
} from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { buildOAuthRoutes } from '../adapters/http-hono/routes.oauth.js';
import { createMcpRuntime } from '../core/runtime.js';
import { createOpaqueSpotifyTokenVerifier } from '../shared/auth/opaque-token-verifier.js';
import type { UnifiedConfig } from '../shared/config/env.js';
import type { TokenStore } from '../shared/storage/interface.js';
import { sharedLogger as logger } from '../shared/utils/logger.js';
import {
  createAuthServices,
  legacyAuthorizationServerMetadata,
  legacyProtectedResourceMetadata,
} from './auth.js';
import { boundedMcpRequest } from './body.js';
import {
  corsPreflightResponse,
  requestSecurityResponse,
  withCors,
} from './security.js';

export interface HttpRuntimeOptions {
  runtimeName: string;
  tokenStore: TokenStore;
  authorizationServerUrl: URL;
  verifier?: OAuthTokenVerifier;
  includeOAuthRoutes?: boolean;
  spotifyFetch?: typeof globalThis.fetch;
}

export interface HttpRuntime {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  notify: ServerNotifier;
}

/** Fetch-native Bun/Workers shell with OAuth routes outside MCP dispatch. */
export function buildHttpApp(
  config: UnifiedConfig,
  options: HttpRuntimeOptions,
): HttpRuntime {
  logger.setLevel(config.LOG_LEVEL);

  const mcp = createMcpRuntime(config, {
    runtimeName: options.runtimeName,
    ...(options.spotifyFetch ? { spotifyFetch: options.spotifyFetch } : {}),
  });
  const verifier =
    options.verifier ??
    createOpaqueSpotifyTokenVerifier(options.tokenStore, config, {
      ...(options.spotifyFetch ? { fetch: options.spotifyFetch } : {}),
    });
  const auth = createAuthServices(config, verifier, options.authorizationServerUrl);
  const mcpPath = config.MCP_PUBLIC_URL.pathname;
  const app = new Hono();

  app.use('*', async (context, next) => {
    const request = context.req.raw;
    const rejected = requestSecurityResponse(request, config);
    if (rejected) return rejected;

    if (auth) {
      const metadata = oauthMetadataResponse(request, auth.metadata);
      if (metadata) return metadata;
    }

    await next();
  });

  app.get('/health', (context) =>
    context.json({
      status: 'ok',
      runtime: options.runtimeName,
      protocol: '2026-07-28',
      legacyMode: config.MCP_LEGACY_MODE,
      authEnabled: config.AUTH_ENABLED,
      timestamp: new Date().toISOString(),
    }),
  );

  if (auth) {
    // Backward-compatible aliases retained alongside RFC 9728's path form.
    app.get('/.well-known/oauth-protected-resource', () =>
      legacyProtectedResourceMetadata(auth),
    );
    app.get('/mcp/.well-known/oauth-protected-resource', () =>
      legacyProtectedResourceMetadata(auth),
    );
    app.get('/mcp/.well-known/oauth-authorization-server', () =>
      legacyAuthorizationServerMetadata(auth),
    );
  }

  if (options.includeOAuthRoutes) {
    app.route('/', buildOAuthRoutes(options.tokenStore, config));
  }

  app.options(mcpPath, (context) => corsPreflightResponse(context.req.raw));

  app.all(mcpPath, async (context) => {
    const request = context.req.raw;
    let authInfo: AuthInfo | undefined;
    if (auth) {
      const authResult = await auth.gate(request);
      if (authResult instanceof Response) {
        return withCors(request, authResult);
      }
      authInfo = authResult;
    }

    const bounded = await boundedMcpRequest(request, config.MCP_MAX_REQUEST_BYTES);
    if (bounded.rejection) return withCors(request, bounded.rejection);

    const response = await mcp.fetch(
      bounded.request,
      authInfo ? { authInfo } : undefined,
    );
    return withCors(request, response);
  });

  app.notFound((context) => context.text('Not Found', 404));

  return {
    fetch: async (request) => app.fetch(request),
    close: mcp.close,
    notify: mcp.notify,
  };
}
