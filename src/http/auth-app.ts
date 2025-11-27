// Unified auth server entry point (Node.js/Hono) using shared modules
// This is the OAuth authorization server (typically runs on PORT+1)
// From Spotify MCP

import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { buildOAuthRoutes } from '../adapters/http-hono/routes.oauth.js';
import { parseConfig } from '../shared/config/env.js';
import { buildAuthorizationServerMetadata } from '../shared/oauth/discovery.js';
import { getTokenStore } from '../shared/storage/singleton.js';
import { corsMiddleware } from './middlewares/cors.js';

export function buildAuthApp(): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();

  // Parse config from process.env
  const config = parseConfig(process.env as Record<string, unknown>);

  // Initialize storage (shared singleton to keep MCP+Auth in sync)
  const store = getTokenStore();

  // Middleware
  app.use('*', corsMiddleware());

  // Add discovery endpoint
  // IMPORTANT: Advertise OUR proxy endpoints, not the provider's directly!
  app.get('/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const base = `${here.protocol}//${here.host}`;
    const scopes = config.OAUTH_SCOPES.split(' ').filter(Boolean);

    const metadata = buildAuthorizationServerMetadata(base, scopes, {
      // Use our endpoints - they proxy to the provider
      authorizationEndpoint: `${base}/authorize`,
      tokenEndpoint: `${base}/token`,
      revocationEndpoint: `${base}/revoke`,
    });

    return c.json(metadata);
  });

  // Mount OAuth routes
  app.route('/', buildOAuthRoutes(store, config));

  return app;
}
