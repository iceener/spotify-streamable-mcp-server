// Workers adapter for OAuth discovery routes using itty-router

import type { Router } from 'itty-router';
import type { UnifiedConfig } from '../../shared/config/env.ts';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from '../../shared/oauth/discovery.ts';

function withCors(response: Response): Response {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', '*');
  return response;
}

export function attachDiscoveryRoutes(router: Router, config: UnifiedConfig): void {
  router.get('/.well-known/oauth-authorization-server', async (request: Request) => {
    const base = new URL(request.url).origin;
    const scopes = config.OAUTH_SCOPES.split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const metadata = buildAuthorizationServerMetadata(base, scopes, {
      authorizationEndpoint: config.OAUTH_AUTHORIZATION_URL,
      tokenEndpoint: config.OAUTH_TOKEN_URL,
      revocationEndpoint: config.OAUTH_REVOCATION_URL,
    });

    return withCors(
      new Response(JSON.stringify(metadata), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    );
  });

  router.get('/.well-known/oauth-protected-resource', async (request: Request) => {
    const here = new URL(request.url);
    const base = here.origin;
    const sid = here.searchParams.get('sid') ?? undefined;
    const resourceBase = `${base}/mcp`;

    const metadata = buildProtectedResourceMetadata(
      resourceBase,
      `${base}/.well-known/oauth-authorization-server`,
      sid,
    );

    return withCors(
      new Response(JSON.stringify(metadata), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    );
  });
}









