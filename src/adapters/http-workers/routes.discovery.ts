// Workers adapter for OAuth discovery routes using itty-router
// From Spotify MCP

// itty-router types are complex; use generic interface
interface IttyRouter {
  get(path: string, handler: (request: Request) => Promise<Response>): void;
  post(path: string, handler: (request: Request) => Promise<Response>): void;
}

import type { UnifiedConfig } from '../../shared/config/env.js';
import { jsonResponse } from '../../shared/http/response.js';
import {
  createDiscoveryHandlers,
  workerDiscoveryStrategy,
} from '../../shared/oauth/discovery-handlers.js';

export function attachDiscoveryRoutes(router: IttyRouter, config: UnifiedConfig): void {
  const { authorizationMetadata, protectedResourceMetadata } = createDiscoveryHandlers(
    config,
    workerDiscoveryStrategy,
  );

  router.get('/.well-known/oauth-authorization-server', async (request: Request) => {
    const metadata = authorizationMetadata(new URL(request.url));
    return jsonResponse(metadata);
  });

  router.get('/.well-known/oauth-protected-resource', async (request: Request) => {
    const here = new URL(request.url);
    const sid = here.searchParams.get('sid') ?? undefined;
    const metadata = protectedResourceMetadata(here, sid);
    return jsonResponse(metadata);
  });
}
