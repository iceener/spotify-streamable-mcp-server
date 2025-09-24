import type { HttpBindings } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import { config } from '../../config/env.ts';
import { getSpotifyTokensByRsToken } from '../../core/tokens.ts';

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
      const lower = k.toLowerCase();
      if (accept.has(lower)) {
        forwarded[lower] = v;
      }
    }

    // If Authorization is our RS token, keep RS (downstream can exchange). In RS-only mode, strip unknown bearer.
    const auth = forwarded.authorization;
    const bearerMatch = auth?.match(/^\s*Bearer\s+(.+)$/i);
    const rs = bearerMatch?.[1];
    if (rs) {
      try {
        const mapped = getSpotifyTokensByRsToken(rs);
        if (!mapped && config.AUTH_REQUIRE_RS && !config.AUTH_ALLOW_DIRECT_BEARER) {
          delete forwarded.authorization;
        }
      } catch {
        // best-effort; leave header as-is on errors
      }
    }

    // Attach to context for later use (e.g., tools/services)
    (c as unknown as { authHeaders?: Record<string, string> }).authHeaders = forwarded;
    await next();
  };
}
