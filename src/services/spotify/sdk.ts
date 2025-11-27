/**
 * Spotify SDK client factory.
 * Provides user-authenticated Spotify API clients using the template's auth context.
 */

import {
  type AccessToken,
  ClientCredentialsStrategy,
  type IAuthStrategy,
  type IValidateResponses,
  type SdkConfiguration,
  SpotifyApi,
} from '@spotify/web-api-ts-sdk';
import { config } from '../../config/env.js';
import { getTokenStore } from '../../shared/storage/singleton.js';
import type { ToolContext } from '../../shared/tools/types.js';
import { sharedLogger as logger } from '../../shared/utils/logger.js';
import { refreshSpotifyTokens } from './oauth.js';

// ---------------------------------------------------------------------------
// Response Validator
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// App Client (Client Credentials - for non-user APIs like search)
// ---------------------------------------------------------------------------

let appClient: SpotifyApi | null = null;

export function getSpotifyAppClient(): SpotifyApi {
  const clientId = config.SPOTIFY_CLIENT_ID || config.OAUTH_CLIENT_ID;
  const clientSecret = config.SPOTIFY_CLIENT_SECRET || config.OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Spotify client credentials are not configured');
  }

  if (!appClient) {
    const strategy = new ClientCredentialsStrategy(clientId, clientSecret);
    appClient = new SpotifyApi(strategy, sdkOptions);
  }

  return appClient;
}

// ---------------------------------------------------------------------------
// User Client (OAuth - for user-specific APIs)
// ---------------------------------------------------------------------------

/**
 * Get a Spotify API client for the authenticated user.
 * Uses the provider token from the tool context.
 */
export async function getSpotifyUserClient(
  context: ToolContext,
): Promise<SpotifyApi | null> {
  const clientId = config.SPOTIFY_CLIENT_ID || config.OAUTH_CLIENT_ID;

  if (!clientId) {
    throw new Error('Spotify client id is not configured');
  }

  // Get provider token from context (set by auth middleware)
  const providerToken = context.providerToken || context.provider?.accessToken;

  if (!providerToken) {
    logger.info('spotify_sdk', {
      message: 'No provider token in context',
      sessionId: context.sessionId,
      hasProviderToken: !!context.providerToken,
      hasProvider: !!context.provider,
    });
    return null;
  }

  // Build access token from context
  const accessToken: AccessToken = {
    access_token: providerToken,
    refresh_token: context.provider?.refreshToken || '',
    token_type: 'Bearer',
    expires_in: context.provider?.expiresAt
      ? Math.max(1, Math.round((context.provider.expiresAt - Date.now()) / 1000))
      : 3600,
    expires: context.provider?.expiresAt || Date.now() + 3600 * 1000,
  };

  const strategy = new ContextAuthStrategy(accessToken, context);
  return new SpotifyApi(strategy, sdkOptions);
}

// ---------------------------------------------------------------------------
// Context-based Auth Strategy
// ---------------------------------------------------------------------------

/**
 * Auth strategy that uses tokens from the request context.
 * Handles token refresh automatically.
 */
class ContextAuthStrategy implements IAuthStrategy {
  private current: AccessToken;
  private context: ToolContext;

  constructor(initialToken: AccessToken, context: ToolContext) {
    this.current = initialToken;
    this.context = context;
  }

  public setConfiguration(_configuration: SdkConfiguration): void {
    // No-op: not needed for our context-based approach
  }

  public async getOrCreateAccessToken(): Promise<AccessToken> {
    const now = Date.now();

    // Check if token is expired or about to expire
    if (this.current.expires && this.current.expires <= now) {
      return this.refreshToken();
    }

    // Proactive refresh if within 30 seconds of expiry
    if (this.current.expires && this.current.expires - now < 30_000) {
      try {
        return await this.refreshToken();
      } catch (error) {
        logger.warning('spotify_sdk', {
          message: 'Silent refresh failed, continuing with existing token',
          error: (error as Error).message,
        });
      }
    }

    return this.current;
  }

  public async getAccessToken(): Promise<AccessToken | null> {
    return this.current;
  }

  public removeAccessToken(): void {
    // No-op: we don't persist tokens in this strategy
  }

  private async refreshToken(): Promise<AccessToken> {
    const refreshToken =
      this.current.refresh_token || this.context.provider?.refreshToken;

    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const refreshed = await refreshSpotifyTokens({ refreshToken });
    const accessToken = refreshed.access_token?.trim();

    if (!accessToken) {
      throw new Error('Spotify refresh payload missing access_token');
    }

    const newRefreshToken = refreshed.refresh_token?.trim() || refreshToken;
    const expiresInSeconds = Number(refreshed.expires_in ?? 3600);
    const expiresAt = Date.now() + expiresInSeconds * 1000;

    // Update the token store if we have an RS token reference
    const rsToken = this.context.authHeaders?.authorization?.replace('Bearer ', '');
    if (rsToken) {
      try {
        const store = getTokenStore();
        const record = await store.getByRsAccess(rsToken);
        if (record) {
          // Update the token store with refreshed provider tokens
          await store.storeRsMapping(
            rsToken,
            {
              access_token: accessToken,
              refresh_token: newRefreshToken,
              expires_at: expiresAt,
            },
            record.rs_refresh_token,
          );
        }
      } catch (error) {
        logger.warning('spotify_sdk', {
          message: 'Failed to update token store after refresh',
          error: (error as Error).message,
        });
      }
    }

    this.current = {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      token_type: refreshed.token_type ?? 'Bearer',
      expires_in: expiresInSeconds,
      expires: expiresAt,
    };

    return this.current;
  }
}
