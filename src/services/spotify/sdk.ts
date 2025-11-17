import {
  type AccessToken,
  ClientCredentialsStrategy,
  type IAuthStrategy,
  type IValidateResponses,
  type SdkConfiguration,
  SpotifyApi,
} from '@spotify/web-api-ts-sdk';
import { config } from '../../config/env.ts';
import { getUserBearer } from '../../core/auth.ts';
import { getCurrentSessionId } from '../../core/context.ts';
import { ensureSession, getSession } from '../../core/session.ts';
import { updateSpotifyTokensByRsRefreshToken } from '../../core/tokens-compat.ts';
import { logger } from '../../utils/logger.ts';
import { refreshSpotifyTokens } from './oauth.ts';

const responseValidator: IValidateResponses = {
  async validateResponse(response: Response): Promise<void> {
    if (response.status === 204) {
      return;
    }
    if (response.ok) {
      return;
    }
    const body = await response.text().catch(() => '');
    const error = new Error(
      `Spotify request failed: ${response.status} ${response.statusText}${
        body ? ` - ${body}` : ''
      }`,
    );
    (error as { status?: number }).status = response.status;
    throw error;
  },
};

const sdkOptions = { responseValidator } as const;

let appClient: SpotifyApi | null = null;

export function getSpotifyAppClient(): SpotifyApi {
  if (!config.SPOTIFY_CLIENT_ID || !config.SPOTIFY_CLIENT_SECRET) {
    throw new Error('Spotify client credentials are not configured');
  }

  if (!appClient) {
    const strategy = new ClientCredentialsStrategy(
      config.SPOTIFY_CLIENT_ID,
      config.SPOTIFY_CLIENT_SECRET,
    );
    appClient = new SpotifyApi(strategy, sdkOptions);
  }

  return appClient;
}

export async function getSpotifyUserClient(): Promise<SpotifyApi | null> {
  if (!config.SPOTIFY_CLIENT_ID) {
    throw new Error('Spotify client id is not configured');
  }

  const accessToken = await getUserBearer();
  if (!accessToken) {
    return null;
  }

  const sessionId = getCurrentSessionId();
  if (!sessionId) {
    await logger.warning('spotify_sdk', {
      message: 'getSpotifyUserClient: Missing session id',
    });
    return null;
  }

  const session = getSession(sessionId);
  if (!session?.spotify) {
    await logger.warning('spotify_sdk', {
      message: 'getSpotifyUserClient: Missing spotify session data',
      sessionId,
    });
    return null;
  }

  const strategy = new SessionAuthStrategy(sessionId);

  return new SpotifyApi(strategy, sdkOptions);
}

async function refreshSpotifyAccessToken(
  sessionId: string,
  currentToken: AccessToken,
): Promise<AccessToken> {
  const session = ensureSession(sessionId);
  const refreshToken =
    currentToken.refresh_token || session.spotify?.refresh_token || '';
  if (!refreshToken) {
    throw new Error('No Spotify refresh token available for session');
  }

  const refreshed = await refreshSpotifyTokens({ refreshToken });
  const accessToken = refreshed.access_token?.trim();
  if (!accessToken) {
    throw new Error('Spotify refresh payload missing access_token');
  }
  const newRefreshToken = refreshed.refresh_token?.trim() || refreshToken;
  const expiresInSeconds = Number(refreshed.expires_in ?? 3600);
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  const scopes = String(refreshed.scope ?? '')
    .split(' ')
    .map((v) => v.trim())
    .filter(Boolean);

  session.spotify = {
    access_token: accessToken,
    refresh_token: newRefreshToken,
    expires_at: expiresAt,
    scopes: scopes.length ? scopes : session.spotify?.scopes,
  };

  const rsRefreshToken = session.rs?.refresh_token;
  if (rsRefreshToken) {
    updateSpotifyTokensByRsRefreshToken(rsRefreshToken, {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      expires_at: expiresAt,
      scopes: session.spotify?.scopes,
    });
  }

  return {
    access_token: accessToken,
    refresh_token: newRefreshToken,
    token_type: refreshed.token_type ?? currentToken.token_type ?? 'Bearer',
    expires_in: expiresInSeconds,
    expires: expiresAt,
  };
}

class SessionAuthStrategy implements IAuthStrategy {
  private current: AccessToken | null = null;

  constructor(private readonly sessionId: string) {}

  public setConfiguration(_configuration: SdkConfiguration): void {
    // No-op: not needed for our session-based approach
  }

  public async getOrCreateAccessToken(): Promise<AccessToken> {
    let token = this.buildAccessTokenFromSession();
    const now = Date.now();
    if (token.expires && token.expires <= now) {
      token = await refreshSpotifyAccessToken(this.sessionId, token);
    } else if (token.expires && token.expires - now < 30_000) {
      try {
        token = await refreshSpotifyAccessToken(this.sessionId, token);
      } catch (error) {
        await logger.warning('spotify_sdk', {
          message: 'Silent refresh failed, continuing with existing token',
          sessionId: this.sessionId,
          error: (error as Error).message,
        });
      }
    }
    this.current = token;
    return token;
  }

  public async getAccessToken(): Promise<AccessToken | null> {
    if (!this.current) {
      try {
        this.current = this.buildAccessTokenFromSession();
      } catch {
        return null;
      }
    }
    return this.current;
  }

  public removeAccessToken(): void {
    this.current = null;
  }

  private buildAccessTokenFromSession(): AccessToken {
    const session = ensureSession(this.sessionId);
    const spotify = session.spotify;
    if (!spotify?.access_token) {
      throw new Error('Spotify access token missing for session');
    }
    const expiresAt = spotify.expires_at ?? Date.now() + 60 * 60 * 1000;
    const expiresIn = Math.max(1, Math.round((expiresAt - Date.now()) / 1000));
    return {
      access_token: spotify.access_token,
      refresh_token: spotify.refresh_token ?? '',
      token_type: 'Bearer',
      expires_in: expiresIn,
      expires: expiresAt,
    };
  }
}
