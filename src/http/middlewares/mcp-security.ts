import { randomUUID } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import {
  composeWwwAuthenticate,
  validateAudience,
  validateBearer,
} from '../../config/auth.js';
import { config } from '../../config/env.js';
import { ensureSession } from '../../core/session.js';
import { getSpotifyTokensByRsToken } from '../../core/tokens.js';
import { logger } from '../../utils/logger.js';
import { validateOrigin, validateProtocolVersion } from '../../utils/security.js';

export function createMcpSecurityMiddleware(): MiddlewareHandler<{
  Bindings: HttpBindings;
}> {
  return async (c, next) => {
    try {
      // Validate Origin (CORS-like protection)
      validateOrigin(c.req.raw.headers);

      // Validate MCP Protocol Version
      validateProtocolVersion(c.req.raw.headers);

      // Handle authentication if enabled
      if (config.AUTH_ENABLED) {
        // Ensure we bind a session ID even on 401 to correlate OAuth → RS session
        let sid = c.req.header('Mcp-Session-Id');
        if (!sid) {
          sid = randomUUID();
          // Create a session slot now so AS can attach tokens later
          try {
            ensureSession(sid);
          } catch {}
        }
        // Include ?sid= in the RS metadata URL to carry it through to AS via resource parameter
        const md = new URL('/.well-known/oauth-protected-resource', c.req.url);
        md.searchParams.set('sid', sid);
        const resourceMdUrl = md.toString();
        const token = validateBearer(c.req.raw.headers);

        if (!token) {
          c.header('WWW-Authenticate', composeWwwAuthenticate(resourceMdUrl));
          // Surface the session id even on 401 so clients can reuse it
          c.header('Mcp-Session-Id', sid);
          logger.info('auth', {
            message: '401 Unauthorized - prompting OAuth',
            sessionId: sid,
            resourceMetadata: resourceMdUrl,
          });
          return c.json(
            {
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Unauthorized' },
              id: null,
            },
            401,
          );
        }

        const validAudience = await validateAudience(
          token,
          config.AUTH_RESOURCE_URI ?? '',
        );
        if (!validAudience) {
          c.header('WWW-Authenticate', composeWwwAuthenticate(resourceMdUrl));
          return c.json(
            {
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Invalid token audience' },
              id: null,
            },
            401,
          );
        }

        // Attach rsToken to context so tools can look up Spotify tokens if needed
        const spotify = getSpotifyTokensByRsToken(token);
        if (!spotify) {
          // RS token is valid for RS, but we have no mapping to Spotify tokens (e.g., server restart)
          // Prompt a fresh OAuth so client obtains a new RS token we can map
          c.header('WWW-Authenticate', composeWwwAuthenticate(resourceMdUrl));
          c.header('Mcp-Session-Id', sid);
          logger.info('auth', {
            message: 'Unknown RS token → prompting OAuth',
            sessionId: sid,
          });
          return c.json(
            {
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Unauthorized' },
              id: null,
            },
            401,
          );
        }
        if (spotify) {
          // create/update session if missing and write tokens for convenience
          let currentSid = c.req.header('Mcp-Session-Id');
          if (!currentSid) {
            currentSid = randomUUID();
            try {
              ensureSession(currentSid);
            } catch {}
            c.header('Mcp-Session-Id', currentSid);
          }
          try {
            const s = ensureSession(currentSid);
            s.spotify = {
              access_token: spotify.access_token,
              refresh_token: spotify.refresh_token,
              expires_at: spotify.expires_at,
              scopes: spotify.scopes,
            };
          } catch {}
        }
      }

      return next();
    } catch (error) {
      logger.error('http', { error: (error as Error).message });
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
