// Workers adapter for MCP security

import type { UnifiedConfig } from '../../shared/config/env.ts';
import {
  buildUnauthorizedChallenge,
  validateOrigin,
  validateProtocolVersion,
} from '../../shared/mcp/security.ts';
import type { TokenStore } from '../../shared/storage/interface.ts';

function withCors(response: Response): Response {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', '*');
  return response;
}

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
    });
    resp.headers.set('Mcp-Session-Id', sid);
    resp.headers.set('WWW-Authenticate', challenge.headers['WWW-Authenticate']);
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
    const challenge = buildUnauthorizedChallenge({
      origin,
      sid,
    });

    const resp = new Response(JSON.stringify(challenge.body), {
      status: challenge.status,
    });
    resp.headers.set('Mcp-Session-Id', sid);
    resp.headers.set('WWW-Authenticate', challenge.headers['WWW-Authenticate']);
    return withCors(resp);
  }

  // Check RS token if required
  if (config.AUTH_REQUIRE_RS && authHeader) {
    const m = authHeader.match(/^\s*Bearer\s+(.+)$/i);
    const bearer = m?.[1];

    if (bearer) {
      const record = await store.getByRsAccess(bearer);
      const hasMapping = !!record?.spotify?.access_token;

      if (!hasMapping && !config.AUTH_ALLOW_DIRECT_BEARER) {
        const origin = new URL(request.url).origin;
        const challenge = buildUnauthorizedChallenge({
          origin,
          sid,
        });

        const resp = new Response(JSON.stringify(challenge.body), {
          status: challenge.status,
        });
        resp.headers.set('Mcp-Session-Id', sid);
        resp.headers.set('WWW-Authenticate', challenge.headers['WWW-Authenticate']);
        return withCors(resp);
      }
    }
  }

  return null;
}









