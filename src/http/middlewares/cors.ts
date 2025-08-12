import type { HttpBindings } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';

export function corsMiddleware(): MiddlewareHandler<{
  Bindings: HttpBindings;
}> {
  return async (c, next) => {
    const requestOrigin = c.req.header('Origin') || c.req.header('origin');
    const allowOrigin = requestOrigin || 'http://localhost';
    c.header('Access-Control-Allow-Origin', allowOrigin);
    c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    c.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Protocol-Version',
    );
    c.header('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');

    if (c.req.method === 'OPTIONS') {
      return c.text('', 200);
    }

    await next();
  };
}
