/** Spotify SDK client factories with request-local resolved user credentials. */

import {
  type AccessToken,
  ClientCredentialsStrategy,
  type IAuthStrategy,
  type IValidateResponses,
  type SdkConfiguration,
  SpotifyApi,
} from '@spotify/web-api-ts-sdk';
import type {
  SpotifyToolConfiguration,
  ToolContext,
} from '../../shared/tools/types.js';
import { sharedLogger as logger } from '../../shared/utils/logger.js';

const responseValidator: IValidateResponses = {
  async validateResponse(response: Response): Promise<void> {
    if (response.status === 204 || response.ok) return;
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

const responseDeserializer = {
  async deserialize<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (text.length > 0) {
      try {
        return JSON.parse(text) as T;
      } catch {
        return null as T;
      }
    }
    return null as T;
  },
};

function sdkOptions(config: SpotifyToolConfiguration) {
  return {
    responseValidator,
    deserializer: responseDeserializer,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  } as const;
}

let appClient: SpotifyApi | null = null;
let appClientKey = '';
let appClientFetch: typeof globalThis.fetch | undefined;

/** Preserve the deployment-scoped client-credentials client cache. */
export function getSpotifyAppClient(config: SpotifyToolConfiguration): SpotifyApi {
  const clientId = config.clientId;
  const clientSecret = config.clientSecret;
  if (!clientId || !clientSecret) {
    throw new Error('Spotify client credentials are not configured');
  }

  const key = `${clientId}\u0000${clientSecret}`;
  if (!appClient || appClientKey !== key || appClientFetch !== config.fetch) {
    appClient = new SpotifyApi(
      new ClientCredentialsStrategy(clientId, clientSecret),
      sdkOptions(config),
    );
    appClientKey = key;
    appClientFetch = config.fetch;
  }
  return appClient;
}

/** Build a user client from only the verifier-resolved Spotify access token. */
export async function getSpotifyUserClient(
  context: ToolContext,
): Promise<SpotifyApi | null> {
  if (!context.spotify.clientId) {
    throw new Error('Spotify client id is not configured');
  }

  if (!context.spotifyAccessToken) {
    logger.info('spotify_sdk', {
      message: 'No resolved Spotify token in tool context',
      requestId: context.requestId,
    });
    return null;
  }

  const accessToken: AccessToken = {
    access_token: context.spotifyAccessToken,
    refresh_token: '',
    token_type: 'Bearer',
    expires_in: 3_600,
    expires: Date.now() + 3_600_000,
  };

  return new SpotifyApi(
    new ResolvedAccessTokenStrategy(accessToken),
    sdkOptions(context.spotify),
  );
}

/**
 * The OAuth verifier refreshes aliases before tool dispatch. This strategy
 * intentionally cannot see or refresh provider refresh tokens.
 */
class ResolvedAccessTokenStrategy implements IAuthStrategy {
  constructor(private readonly accessToken: AccessToken) {}

  setConfiguration(_configuration: SdkConfiguration): void {}

  async getOrCreateAccessToken(): Promise<AccessToken> {
    return this.accessToken;
  }

  async getAccessToken(): Promise<AccessToken> {
    return this.accessToken;
  }

  removeAccessToken(): void {}
}
