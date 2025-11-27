// Hono adapter for OAuth discovery routes
// From Spotify MCP

import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import type { UnifiedConfig } from '../../shared/config/env.js';
import {
  createDiscoveryHandlers,
  nodeDiscoveryStrategy,
} from '../../shared/oauth/discovery-handlers.js';

export function buildDiscoveryRoutes(
  config: UnifiedConfig,
): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const { authorizationMetadata, protectedResourceMetadata } = createDiscoveryHandlers(
    config,
    nodeDiscoveryStrategy,
  );

  if (config.AUTH_ENABLED) {
    app.get('/.well-known/oauth-protected-resource', (c) => {
      const here = new URL(c.req.url);
      const sid = here.searchParams.get('sid') ?? undefined;
      const metadata = protectedResourceMetadata(here, sid);
      return c.json(metadata);
    });

    app.get('/mcp/.well-known/oauth-protected-resource', (c) => {
      const here = new URL(c.req.url);
      const sid = here.searchParams.get('sid') ?? undefined;
      const metadata = protectedResourceMetadata(here, sid);
      return c.json(metadata);
    });
  }

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const metadata = authorizationMetadata(here);
    return c.json(metadata);
  });

  app.get('/mcp/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const metadata = authorizationMetadata(here);
    return c.json(metadata);
  });

  return app;
}
