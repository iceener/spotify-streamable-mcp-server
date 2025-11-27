// Workers adapter for MCP security
// Provider-agnostic version from Spotify MCP

import type { UnifiedConfig } from '../../shared/config/env.js';
import { withCors } from '../../shared/http/cors.js';
import {
  buildUnauthorizedChallenge,
  validateOrigin,
  validateProtocolVersion,
} from '../../shared/mcp/security.js';
import type { TokenStore } from '../../shared/storage/interface.js';

/**
 * Check if request needs authentication and challenge if missing
 * Returns null if authorized, otherwise returns 401 challenge response
 */
export async function checkAuthAndChallenge(
  request: Request,
  store: TokenStore,
  config: UnifiedConfig,
  sid: string,
): Promise<Response | null> {
  try {
    validateOrigin(request.headers, config.NODE_ENV === 'development');
    validateProtocolVersion(request.headers, config.MCP_PROTOCOL_VERSION);
  } catch (error) {
    const challenge = buildUnauthorizedChallenge({
      origin: new URL(request.url).origin,
      sid,
      message: (error as Error).message,
    });

    const resp = new Response(JSON.stringify(challenge.body), {
      status: challenge.status,
      headers: {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sid,
        'WWW-Authenticate': challenge.headers['WWW-Authenticate'],
      },
    });
    return withCors(resp);
  }

  if (!config.AUTH_ENABLED) {
    return null;
  }

  const authHeader = request.headers.get('Authorization');
  const apiKeyHeader =
    request.headers.get('x-api-key') || request.headers.get('x-auth-token');

  // Challenge if no auth
  if (!authHeader && !apiKeyHeader) {
    const origin = new URL(request.url).origin;
    const challenge = buildUnauthorizedChallenge({ origin, sid });

    const resp = new Response(JSON.stringify(challenge.body), {
      status: challenge.status,
      headers: {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sid,
        'WWW-Authenticate': challenge.headers['WWW-Authenticate'],
      },
    });
    return withCors(resp);
  }

  // Check RS token if required
  if (config.AUTH_REQUIRE_RS && authHeader) {
    const match = authHeader.match(/^\s*Bearer\s+(.+)$/i);
    const bearer = match?.[1];

    if (bearer) {
      const record = await store.getByRsAccess(bearer);
      const hasMapping = !!record?.provider?.access_token;

      if (!hasMapping && !config.AUTH_ALLOW_DIRECT_BEARER) {
        const origin = new URL(request.url).origin;
        const challenge = buildUnauthorizedChallenge({ origin, sid });

        const resp = new Response(JSON.stringify(challenge.body), {
          status: challenge.status,
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': sid,
            'WWW-Authenticate': challenge.headers['WWW-Authenticate'],
          },
        });
        return withCors(resp);
      }
    }
  }

  return null;
}
