import { config } from '../config/env.ts';
import { createHttpClient } from '../services/http-client.ts';
import { refreshSpotifyTokens } from '../services/spotify/oauth.ts';
import { logger } from '../utils/logger.ts';
import { apiBase } from '../utils/spotify.ts';
import {
  getCurrentRsToken,
  getCurrentSessionId,
  getCurrentSpotifyAccessToken,
} from './context.ts';
import { ensureSession, getSession } from './session.ts';
import {
  getRecordByRsAccessToken,
  getSpotifyTokensByRsToken,
  getSpotifyTokensWithRefreshByRsAccessToken,
  updateSpotifyTokensByRsRefreshToken,
} from './tokens.ts';

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
    const rsFromContext = getCurrentRsToken();
    if (rsFromContext) {
      void logger.info('auth', {
        message:
          'getUserBearer: No session ID available but RS token present, attempting recovery',
      });
    }
    void logger.warning('auth', {
      message: 'getUserBearer: No session ID available',
    });
    return null;
  }

  let session = getSession(sessionId);
  void logger.info('auth', {
    message: 'getUserBearer: Retrieved session',
    sessionExists: !!session,
    sessionAge: session ? Date.now() - session.createdAt : null,
    sessionHasSpotify: !!session?.spotify,
  });

  if (!session) {
    const rsToken = getCurrentRsToken();
    if (rsToken) {
      void logger.warning('auth', {
        message: 'getUserBearer: Session missing, attempting to restore from RS token',
        sessionId,
      });
      const restored = await restoreSessionFromRsToken({ sessionId, rsToken });
      if (restored) {
        session = restored.session;
      } else {
        void logger.warning('auth', {
          message:
            'getUserBearer: Failed to restore session from RS token; returning null',
          sessionId,
        });
        return null;
      }
    }
  }

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

async function restoreSessionFromRsToken(params: {
  sessionId: string;
  rsToken: string;
}): Promise<{ session: ReturnType<typeof ensureSession> } | null> {
  const { sessionId, rsToken } = params;
  try {
    const restored = await getSpotifyTokensWithRefreshByRsAccessToken(rsToken, {
      signal: AbortSignal.timeout(10_000),
      refreshWindowMs: 60_000,
    });
    let tokens = restored?.tokens ?? null;
    const refreshed = restored?.refreshed ?? false;

    if (!tokens) {
      tokens = getSpotifyTokensByRsToken(rsToken);
    }

    if (!tokens) {
      void logger.warning('auth', {
        message: 'restoreSessionFromRsToken: No Spotify tokens linked to RS token',
        sessionId,
      });
      return null;
    }

    const session = ensureSession(sessionId);
    session.spotify = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
      scopes: tokens.scopes,
    };
    session.rs = {
      access_token: rsToken,
      refresh_token: getRecordByRsAccessToken(rsToken)?.rs_refresh_token ?? '',
    };

    if (refreshed) {
      const rsRefresh = session.rs?.refresh_token;
      if (rsRefresh) {
        updateSpotifyTokensByRsRefreshToken(rsRefresh, tokens, rsToken);
      }
    }

    void logger.info('auth', {
      message: 'restoreSessionFromRsToken: Session restored',
      sessionId,
      refreshed,
    });

    return { session };
  } catch (error) {
    void logger.error('auth', {
      message: 'restoreSessionFromRsToken: Error restoring session',
      sessionId,
      error: (error as Error).message,
    });
    return null;
  }
}
