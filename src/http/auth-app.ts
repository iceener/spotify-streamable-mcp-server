import { Hono } from 'hono';
import { buildOAuthRoutes } from '../adapters/http-hono/routes.oauth.js';
import type { UnifiedConfig } from '../shared/config/env.js';
import { buildAuthorizationServerMetadata } from '../shared/oauth/discovery.js';
import type { TokenStore } from '../shared/storage/interface.js';
import { requestSecurityResponse } from './security.js';

/** Build the Bun OAuth proxy server kept outside MCP dispatch. */
export function buildAuthApp(
  config: UnifiedConfig,
  store: TokenStore,
  authorizationServerUrl: URL,
): Hono {
  const app = new Hono();

  app.use('*', async (context, next) => {
    const rejected = requestSecurityResponse(context.req.raw, config);
    if (rejected) return rejected;
    await next();
  });

  app.get('/.well-known/oauth-authorization-server', () => {
    const base = authorizationServerUrl.href.replace(/\/$/, '');
    return Response.json(
      buildAuthorizationServerMetadata(
        base,
        config.SPOTIFY_SCOPES.split(/\s+/).filter(Boolean),
        {
          authorizationEndpoint: `${base}/authorize`,
          tokenEndpoint: `${base}/token`,
          revocationEndpoint: `${base}/revoke`,
        },
      ),
    );
  });

  app.route('/', buildOAuthRoutes(store, config));
  app.notFound((context) => context.text('Not Found', 404));
  return app;
}
