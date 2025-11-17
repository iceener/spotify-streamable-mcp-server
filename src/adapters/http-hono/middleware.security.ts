// Hono adapter for MCP security middleware

import { randomUUID } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import { ensureSession } from '../../core/session.ts';
import type { UnifiedConfig } from '../../shared/config/env.ts';
import {
  buildUnauthorizedChallenge,
  validateOrigin,
  validateProtocolVersion,
} from '../../shared/mcp/security.ts';
import { getTokenStore } from '../../shared/storage/singleton.ts';

export function createMcpSecurityMiddleware(config: UnifiedConfig): MiddlewareHandler<{
  Bindings: HttpBindings;
}> {
  return async (c, next) => {
    try {
      validateOrigin(c.req.raw.headers, config.NODE_ENV === 'development');
      validateProtocolVersion(c.req.raw.headers, config.MCP_PROTOCOL_VERSION);

      if (config.AUTH_ENABLED) {
        const auth = c.req.header('Authorization') ?? undefined;

        // Challenge clients without Authorization and bind a session id
        if (!auth) {
          let sid = c.req.header('Mcp-Session-Id') ?? undefined;
          if (!sid) {
            sid = randomUUID();
            try {
              ensureSession(sid);
            } catch {}
          }

          const origin = new URL(c.req.url).origin;
          const challenge = buildUnauthorizedChallenge({
            origin,
            sid,
          });

          c.header('Mcp-Session-Id', sid);
          c.header('WWW-Authenticate', challenge.headers['WWW-Authenticate']);

          return c.json(challenge.body, challenge.status);
        }

        // RS-only: if a Bearer is present but not a known RS token (and fallback not allowed), 401-challenge
        try {
          if (config.AUTH_REQUIRE_RS && auth) {
            const [scheme, token] = auth.split(' ', 2);
            const bearer =
              scheme && scheme.toLowerCase() === 'bearer' ? (token || '').trim() : '';

            if (bearer) {
              const store = getTokenStore();
              const record = await store.getByRsAccess(bearer);
              const spotify = record?.spotify;
              if (!spotify && !config.AUTH_ALLOW_DIRECT_BEARER) {
                let sid = c.req.header('Mcp-Session-Id') ?? undefined;
                if (!sid) {
                  sid = randomUUID();
                }

                const origin = new URL(c.req.url).origin;
                const challenge = buildUnauthorizedChallenge({
                  origin,
                  sid,
                });

                c.header('Mcp-Session-Id', sid);
                c.header('WWW-Authenticate', challenge.headers['WWW-Authenticate']);

                return c.json(challenge.body, challenge.status);
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
          error: {
            code: -32603,
            message: (error as Error).message || 'Internal server error',
          },
          id: null,
        },
        500,
      );
    }
  };
}
