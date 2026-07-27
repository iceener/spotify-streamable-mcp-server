import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { UnifiedConfig } from '../config/env.js';
import { buildProviderRefreshConfig, ensureFreshToken } from '../oauth/refresh.js';
import type { RsRecord, TokenStore } from '../storage/interface.js';

export const SPOTIFY_ACCESS_TOKEN_EXTRA_KEY = 'resolvedSpotifyAccessToken';

export interface OpaqueSpotifyTokenVerifierOptions {
  fetch?: typeof globalThis.fetch;
}

async function principalId(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const suffix = Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `spotify-rs-${suffix}`;
}

/**
 * Verify the opaque MCP Resource Server token and resolve its Spotify alias.
 * Refresh tokens stay inside TokenStore; only the resolved Spotify access
 * token crosses the MCP boundary in AuthInfo.extra.
 */
export function createOpaqueSpotifyTokenVerifier(
  store: TokenStore,
  config: UnifiedConfig,
  options: OpaqueSpotifyTokenVerifierOptions = {},
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token): Promise<AuthInfo> {
      let existing: RsRecord | null;
      try {
        existing = await store.getByRsAccess(token);
      } catch (error) {
        throw new OAuthError(
          OAuthErrorCode.ServerError,
          `Token storage unavailable: ${(error as Error).message}`,
        );
      }

      if (!existing?.provider?.access_token) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown access token');
      }

      const refreshConfig = buildProviderRefreshConfig(config);
      if (refreshConfig && options.fetch) refreshConfig.fetch = options.fetch;

      let accessToken: string;
      try {
        ({ accessToken } = await ensureFreshToken(token, store, refreshConfig));
      } catch (error) {
        throw new OAuthError(
          OAuthErrorCode.ServerError,
          `Token verification failed: ${(error as Error).message}`,
        );
      }

      const record = await store.getByRsAccess(token);
      if (!record?.provider?.access_token || !accessToken) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token');
      }

      const scopes = record.provider.scopes
        ? [...record.provider.scopes]
        : config.SPOTIFY_SCOPES.split(/\s+/).filter(Boolean);
      const expiresAt = record.provider.expires_at
        ? Math.floor(record.provider.expires_at / 1_000)
        : Math.floor(Date.now() / 1_000) + 3_600;

      return {
        token,
        clientId: await principalId(token),
        scopes,
        expiresAt,
        resource: new URL(config.MCP_PUBLIC_URL.href),
        extra: {
          [SPOTIFY_ACCESS_TOKEN_EXTRA_KEY]: accessToken,
        },
      };
    },
  };
}
