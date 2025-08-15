import type { HttpBindings } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import { config } from '../../config/env.ts';
import { validateOrigin, validateProtocolVersion } from '../../utils/security.ts';

export function createMcpSecurityMiddleware(): MiddlewareHandler<{
  Bindings: HttpBindings;
}> {
  return async (c, next) => {
    try {
      validateOrigin(c.req.raw.headers);
      validateProtocolVersion(c.req.raw.headers);

      if (config.AUTH_ENABLED) {
        // For now, just challenge with WWW-Authenticate when missing Authorization
        const auth = c.req.header('Authorization');
        if (!auth) {
          const md = new URL('/.well-known/oauth-protected-resource', c.req.url);
          c.header(
            'WWW-Authenticate',
            `Bearer realm="MCP", authorization_uri="${md.toString()}"`,
          );
          return c.json(
            {
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Unauthorized' },
              id: null,
            },
            401,
          );
        }
      }

      return next();
    } catch (error) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        },
        500,
      );
    }
  };
}
