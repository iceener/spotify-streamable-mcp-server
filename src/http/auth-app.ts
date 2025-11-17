// Unified auth server entry point (Node.js/Hono) using shared modules
// This is the OAuth authorization server (typically runs on PORT+1)

import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { buildOAuthRoutes } from '../adapters/http-hono/routes.oauth.ts';
import { parseConfig } from '../shared/config/env.ts';
import { buildAuthorizationServerMetadata } from '../shared/oauth/discovery.ts';
import { getTokenStore } from '../shared/storage/singleton.ts';
import { corsMiddleware } from './middlewares/cors.ts';

export function buildAuthApp(): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();

  // Parse config from process.env
  const config = parseConfig(process.env as Record<string, unknown>);

  // Initialize storage (shared singleton to keep MCP+Auth in sync)
  const store = getTokenStore();

  // Middleware
  app.use('*', corsMiddleware());

  // CRITICAL: Add discovery endpoint (was missing!)
  app.get('/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const base = `${here.protocol}//${here.host}`;
    const scopes = config.OAUTH_SCOPES.split(' ').filter(Boolean);

    const metadata = buildAuthorizationServerMetadata(base, scopes, {
      authorizationEndpoint: config.OAUTH_AUTHORIZATION_URL,
      tokenEndpoint: config.OAUTH_TOKEN_URL,
      revocationEndpoint: config.OAUTH_REVOCATION_URL,
    });

    return c.json(metadata);
  });

  // Mount OAuth routes
  app.route('/', buildOAuthRoutes(store, config));

  return app;
}
