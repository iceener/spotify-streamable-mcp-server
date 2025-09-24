import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from '../../config/env.ts';

export function discoveryRoutes() {
  const app = new Hono<{ Bindings: HttpBindings }>();

  if (config.AUTH_ENABLED) {
    app.get('/.well-known/oauth-protected-resource', (c) => {
      const here = new URL(c.req.url);
      const authPort = Number(config.PORT) + 1;
      const defaultDiscovery = `${here.protocol}//${here.hostname}:${authPort}/.well-known/oauth-authorization-server`;
      const sid = here.searchParams.get('sid') ?? undefined;
      const resourceBase = `${here.protocol}//${here.host}/mcp`;
      const resourceUrl = (() => {
        try {
          if (!sid) {
            return resourceBase;
          }
          const u = new URL(resourceBase);
          u.searchParams.set('sid', sid);
          return u.toString();
        } catch {
          return resourceBase;
        }
      })();
      const metadata = {
        authorization_servers: [config.AUTH_DISCOVERY_URL || defaultDiscovery],
        resource: resourceUrl,
      } as const;
      return c.json(metadata);
    });

    app.get('/mcp/.well-known/oauth-protected-resource', (c) => {
      const here = new URL(c.req.url);
      const authPort = Number(config.PORT) + 1;
      const defaultDiscovery = `${here.protocol}//${here.hostname}:${authPort}/.well-known/oauth-authorization-server`;
      const sid = here.searchParams.get('sid') ?? undefined;
      const resourceBase = `${here.protocol}//${here.host}/mcp`;
      const resourceUrl = (() => {
        try {
          if (!sid) {
            return resourceBase;
          }
          const u = new URL(resourceBase);
          u.searchParams.set('sid', sid);
          return u.toString();
        } catch {
          return resourceBase;
        }
      })();
      const metadata = {
        authorization_servers: [config.AUTH_DISCOVERY_URL || defaultDiscovery],
        resource: resourceUrl,
      } as const;
      return c.json(metadata);
    });
  }

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const authPort = Number(config.PORT) + 1;
    const base = `${here.protocol}//${here.hostname}:${authPort}`;
    const metadata = {
      issuer: base,
      authorization_endpoint: config.OAUTH_AUTHORIZATION_URL || `${base}/authorize`,
      token_endpoint: config.OAUTH_TOKEN_URL || `${base}/token`,
      revocation_endpoint: config.OAUTH_REVOCATION_URL || `${base}/revoke`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'client_credentials',
      ],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
      scopes_supported: (config.OAUTH_SCOPES || '').split(' ').filter(Boolean),
    } as const;
    return c.json(metadata);
  });

  app.get('/mcp/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const authPort = Number(config.PORT) + 1;
    const base = `${here.protocol}//${here.hostname}:${authPort}`;
    const metadata = {
      issuer: base,
      authorization_endpoint: config.OAUTH_AUTHORIZATION_URL || `${base}/authorize`,
      token_endpoint: config.OAUTH_TOKEN_URL || `${base}/token`,
      revocation_endpoint: config.OAUTH_REVOCATION_URL || `${base}/revoke`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'client_credentials',
      ],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
      scopes_supported: (config.OAUTH_SCOPES || '').split(' ').filter(Boolean),
    } as const;
    return c.json(metadata);
  });

  return app;
}
