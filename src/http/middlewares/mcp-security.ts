import { randomUUID } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import { config } from '../../config/env.ts';
import { ensureSession } from '../../core/session.ts';
import { getSpotifyTokensByRsToken } from '../../core/tokens.ts';
import { validateOrigin, validateProtocolVersion } from '../../utils/security.ts';

export function createMcpSecurityMiddleware(): MiddlewareHandler<{
  Bindings: HttpBindings;
}> {
  return async (c, next) => {
    try {
      validateOrigin(c.req.raw.headers);
      validateProtocolVersion(c.req.raw.headers);

      if (config.AUTH_ENABLED) {
        const MCP_SESSION_HEADER = 'Mcp-Session-Id';
        const auth = c.req.header('Authorization') ?? undefined;

        // Challenge clients without Authorization and bind a session id
        if (!auth) {
          // Reuse incoming session if present, else mint one so clients can correlate OAuth
          let sid = c.req.header(MCP_SESSION_HEADER) ?? undefined;
          if (!sid) {
            sid = randomUUID();
            try {
              ensureSession(sid);
            } catch {}
          }
          const md = new URL('/.well-known/oauth-protected-resource', c.req.url);
          md.searchParams.set('sid', sid);
          c.header(MCP_SESSION_HEADER, sid);
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

        // RS-only: if a Bearer is present but not a known RS token (and fallback not allowed), 401-challenge
        try {
          if (config.AUTH_REQUIRE_RS && auth) {
            const [scheme, token] = auth.split(' ', 2);
            const bearer =
              scheme && scheme.toLowerCase() === 'bearer' ? (token || '').trim() : '';
            if (bearer) {
              const spotify = getSpotifyTokensByRsToken(bearer);
              if (!spotify && !config.AUTH_ALLOW_DIRECT_BEARER) {
                let sid = c.req.header(MCP_SESSION_HEADER) ?? undefined;
                if (!sid) {
                  sid = randomUUID();
                }
                const md = new URL('/.well-known/oauth-protected-resource', c.req.url);
                md.searchParams.set('sid', sid);
                c.header(MCP_SESSION_HEADER, sid);
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
          }
        } catch {}
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
