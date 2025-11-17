// Hono adapter for OAuth discovery routes

import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import type { UnifiedConfig } from '../../shared/config/env.ts';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from '../../shared/oauth/discovery.ts';

export function buildDiscoveryRoutes(
  config: UnifiedConfig,
): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();

  if (config.AUTH_ENABLED) {
    app.get('/.well-known/oauth-protected-resource', (c) => {
      const here = new URL(c.req.url);
      const authPort = config.PORT + 1;
      const defaultDiscovery = `${here.protocol}//${here.hostname}:${authPort}/.well-known/oauth-authorization-server`;
      const sid = here.searchParams.get('sid') ?? undefined;
      const resourceBase = `${here.protocol}//${here.host}/mcp`;

      const metadata = buildProtectedResourceMetadata(
        resourceBase,
        config.AUTH_DISCOVERY_URL || defaultDiscovery,
        sid,
      );

      return c.json(metadata);
    });

    app.get('/mcp/.well-known/oauth-protected-resource', (c) => {
      const here = new URL(c.req.url);
      const authPort = config.PORT + 1;
      const defaultDiscovery = `${here.protocol}//${here.hostname}:${authPort}/.well-known/oauth-authorization-server`;
      const sid = here.searchParams.get('sid') ?? undefined;
      const resourceBase = `${here.protocol}//${here.host}/mcp`;

      const metadata = buildProtectedResourceMetadata(
        resourceBase,
        config.AUTH_DISCOVERY_URL || defaultDiscovery,
        sid,
      );

      return c.json(metadata);
    });
  }

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const authPort = config.PORT + 1;
    const base = `${here.protocol}//${here.hostname}:${authPort}`;

    const scopes = config.OAUTH_SCOPES.split(' ').filter(Boolean);

    const metadata = buildAuthorizationServerMetadata(base, scopes, {
      authorizationEndpoint: config.OAUTH_AUTHORIZATION_URL,
      tokenEndpoint: config.OAUTH_TOKEN_URL,
      revocationEndpoint: config.OAUTH_REVOCATION_URL,
    });

    return c.json(metadata);
  });

  app.get('/mcp/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const authPort = config.PORT + 1;
    const base = `${here.protocol}//${here.hostname}:${authPort}`;

    const scopes = config.OAUTH_SCOPES.split(' ').filter(Boolean);

    const metadata = buildAuthorizationServerMetadata(base, scopes, {
      authorizationEndpoint: config.OAUTH_AUTHORIZATION_URL,
      tokenEndpoint: config.OAUTH_TOKEN_URL,
      revocationEndpoint: config.OAUTH_REVOCATION_URL,
    });

    return c.json(metadata);
  });

  return app;
}









