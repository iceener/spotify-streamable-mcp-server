import type { HttpBindings } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import { config } from '../../config/env.ts';

// Pass through certain auth headers to downstream handlers in a normalized way
// without enforcing validation here (validation belongs to the specific server/tool).
export function createAuthHeaderMiddleware(): MiddlewareHandler<{
  Bindings: HttpBindings;
}> {
  const accept = new Set(
    (config.MCP_ACCEPT_HEADERS as string[]).map((h) => h.toLowerCase()),
  );
  // Always include standard auth headers
  ['authorization', 'x-api-key', 'x-auth-token'].forEach((h) => accept.add(h));

  return async (c, next) => {
    const incoming = c.req.raw.headers;
    const forwarded: Record<string, string> = {};
    for (const [k, v] of incoming as unknown as Iterable<[string, string]>) {
      if (accept.has(k.toLowerCase())) {
        forwarded[k] = v;
      }
    }
    // Attach to context for later use (e.g., tools/services)
    (c as unknown as { authHeaders?: Record<string, string> }).authHeaders = forwarded;
    await next();
  };
}
