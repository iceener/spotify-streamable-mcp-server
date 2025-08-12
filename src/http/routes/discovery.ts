import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import type { ProtectedResourceMetadata } from '../../config/auth.js';
import { config } from '../../config/env.js';

export function discoveryRoutes() {
  const app = new Hono<{ Bindings: HttpBindings }>();

  // OAuth2.1 Protected Resource Metadata (RFC9728)
  if (config.AUTH_ENABLED) {
    app.get('/.well-known/oauth-protected-resource', (c) => {
      const here = new URL(c.req.url);
      const authPort = Number(config.PORT) + 1;
      const defaultDiscovery = `${here.protocol}//${here.hostname}:${authPort}/.well-known/oauth-authorization-server`;
      const sid = here.searchParams.get('sid') ?? undefined;
      const resourceBase =
        config.AUTH_RESOURCE_URI ?? `${here.protocol}//${here.host}/mcp`;
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
      const metadata: ProtectedResourceMetadata = {
        authorization_servers: [config.AUTH_DISCOVERY_URL || defaultDiscovery],
        resource: resourceUrl,
      };
      return c.json(metadata);
    });

    // Alias under /mcp prefix for clients that resolve relative to MCP base URL
    app.get('/mcp/.well-known/oauth-protected-resource', (c) => {
      const here = new URL(c.req.url);
      const authPort = Number(config.PORT) + 1;
      const defaultDiscovery = `${here.protocol}//${here.hostname}:${authPort}/.well-known/oauth-authorization-server`;
      const sid = here.searchParams.get('sid') ?? undefined;
      const resourceBase =
        config.AUTH_RESOURCE_URI ?? `${here.protocol}//${here.host}/mcp`;
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
      const metadata: ProtectedResourceMetadata = {
        authorization_servers: [config.AUTH_DISCOVERY_URL || defaultDiscovery],
        resource: resourceUrl,
      };
      return c.json(metadata);
    });
  }

  // Authorization Server Metadata (RFC8414) – redirect callers to auth server on PORT+1
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

  // Alias under /mcp prefix (some clients fetch metadata relative to MCP base path)
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
