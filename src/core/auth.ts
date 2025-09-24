import { config } from '../config/env.ts';
import { createHttpClient } from '../services/http-client.ts';
import { refreshSpotifyTokens } from '../services/spotify/oauth.ts';
import { logger } from '../utils/logger.ts';
import { apiBase } from '../utils/spotify.ts';
import { getCurrentSessionId, getCurrentSpotifyAccessToken } from './context.ts';
import { getSession } from './session.ts';
import { updateSpotifyTokensByRsRefreshToken } from './tokens.ts';

const http = createHttpClient({
  baseHeaders: {
    'Content-Type': 'application/json',
    'User-Agent': `mcp-spotify/${config.MCP_VERSION}`,
  },
  rateLimit: { rps: 5, burst: 10 },
  timeout: 10000, // Shorter timeout for validation
  retries: 0, // No retries for validation
});

/**
 * Validates a Spotify access token by making a lightweight API call
 * @param accessToken The access token to validate
 * @returns true if token is valid, false if expired/invalid
 */
export async function validateSpotifyToken(accessToken: string): Promise<boolean> {
  try {
    const base = apiBase(config.SPOTIFY_API_URL);
    const response = await http(new URL('me', base).toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000), // Quick validation
    });

    // 200 OK means token is valid
    return response.status === 200;
  } catch (error) {
    await logger.warning('auth', {
      message: 'Token validation failed',
      error: (error as Error).message,
    });
    return false;
  }
}

export async function getUserBearer(): Promise<string | null> {
  // Linear-style: prefer per-request token passed via context from the Worker
  const fromContext = getCurrentSpotifyAccessToken();
  void logger.info('auth', {
    message: 'getUserBearer: Checking for token sources',
    hasContextToken: !!fromContext,
    contextTokenLength: fromContext?.length ?? 0,
  });

  if (fromContext?.trim()) {
    void logger.info('auth', {
      message: 'getUserBearer: Using token from request context',
    });
    return fromContext;
  }

  const sessionId = getCurrentSessionId();
  void logger.info('auth', {
    message: 'getUserBearer: Checking session-based token',
    sessionId,
    hasSessionId: !!sessionId,
  });

  if (!sessionId) {
    void logger.warning('auth', {
      message: 'getUserBearer: No session ID available',
    });
    return null;
  }

  const session = getSession(sessionId);
  void logger.info('auth', {
    message: 'getUserBearer: Retrieved session',
    sessionExists: !!session,
    sessionAge: session ? Date.now() - session.createdAt : null,
    sessionHasSpotify: !!session?.spotify,
  });

  const token = session?.spotify?.access_token ?? null;
  const expiresAt = session?.spotify?.expires_at ?? 0;
  const refreshToken = session?.spotify?.refresh_token;

  void logger.info('auth', {
    message: 'getUserBearer: Token details',
    hasToken: !!token,
    tokenLength: token?.length ?? 0,
    hasRefreshToken: !!refreshToken,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    tokenExpired: Date.now() > expiresAt,
    timeToExpiry: expiresAt ? expiresAt - Date.now() : null,
  });

  if (!token) {
    void logger.warning('auth', {
      message: 'getUserBearer: No token found in session',
      sessionId,
    });
    return null;
  }

  if (refreshToken && Date.now() > expiresAt - 30_000) {
    void logger.info('auth', {
      message: 'getUserBearer: Token needs refresh, attempting refresh',
      sessionId,
      timeToExpiry: expiresAt - Date.now(),
      hasRefreshToken: !!refreshToken,
    });

    // Minimal, bounded retry with jittered backoff
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        try {
          const refreshed = await refreshSpotifyTokens({
            refreshToken,
            signal: AbortSignal.timeout(10_000),
          });
          const newAccess = refreshed.access_token || token;
          const newRt = refreshed.refresh_token ?? refreshToken;
          const newExp = Date.now() + Number(refreshed.expires_in ?? 3600) * 1000;
          const scopes = String(refreshed.scope || '')
            .split(' ')
            .filter(Boolean);
          if (session?.spotify) {
            session.spotify.access_token = newAccess;
            session.spotify.refresh_token = newRt;
            session.spotify.expires_at = newExp;
            session.spotify.scopes = scopes.length ? scopes : session.spotify.scopes;
          }
          const rsRefreshToken = session?.rs?.refresh_token;
          if (rsRefreshToken) {
            updateSpotifyTokensByRsRefreshToken(rsRefreshToken, {
              access_token: newAccess,
              refresh_token: newRt,
              expires_at: newExp,
              scopes: session?.spotify?.scopes,
            });
          }
          return newAccess;
        } catch (err) {
          const status = (err as { status?: number }).status;
          const shouldRetry =
            typeof status === 'number' && (status >= 500 || status === 429);
          await logger.warning('auth', {
            message: 'Silent refresh failed',
            error: (err as Error).message,
            status,
            attempt,
          });
          if (!shouldRetry || attempt === maxAttempts) {
            return Date.now() <= expiresAt ? token : null;
          }
          const backoffMs = 300 * attempt + Math.floor(Math.random() * 200);
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      } catch (error) {
        await logger.warning('auth', {
          message: 'Silent refresh attempt error',
          error: (error as Error).message,
          attempt,
        });
        if (attempt === maxAttempts) {
          return Date.now() <= expiresAt ? token : null;
        }
        const backoffMs = 300 * attempt + Math.floor(Math.random() * 200);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  void logger.info('auth', {
    message: 'getUserBearer: Returning token',
    sessionId,
    hasToken: !!token,
    tokenLength: token?.length ?? 0,
    tokenSource: fromContext ? 'context' : 'session',
  });

  return token ?? null;
}
