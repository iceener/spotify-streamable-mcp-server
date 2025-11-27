/**
 * Cloudflare Workers entry point.
 *
 * This is a thin wrapper that initializes storage and delegates to the router.
 * All logic is in:
 * - adapters/http-workers/index.ts - Router factory and storage init
 * - adapters/http-workers/mcp.handler.ts - MCP endpoint handler
 * - shared/mcp/dispatcher.ts - JSON-RPC dispatch logic
 */

import {
  createWorkerRouter,
  initializeWorkerStorage,
  shimProcessEnv,
  type WorkerEnv,
} from './adapters/http-workers/index.js';
import { parseConfig } from './shared/config/env.js';
import { withCors } from './shared/http/cors.js';

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // Shim process.env for shared modules
    shimProcessEnv(env);

    // Parse config
    const config = parseConfig(env as Record<string, unknown>);

    // Initialize storage
    const storage = initializeWorkerStorage(env, config);
    if (!storage) {
      return withCors(
        new Response('Server misconfigured: Storage unavailable', { status: 503 }),
      );
    }

    // Create and invoke router
    const router = createWorkerRouter({
      tokenStore: storage.tokenStore,
      sessionStore: storage.sessionStore,
      config,
    });

    return router.fetch(request);
  },
};
