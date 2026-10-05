import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Logger } from '../platform/logger';
import { toHex } from './encoding';
import { exchangeAtProvider, type OAuthProvider, type ProviderCredentials } from './provider';
import { type RsRecord, type TokenStore, TokenStoreUnavailableError } from './token-store';

/**
 * Where the verifier puts the provider's access token in `authInfo.extra`. Tools read it with
 * `providerToken(ctx)`; the platform blanks the client's own token before tools run.
 */
export const PROVIDER_TOKEN = 'providerAccessToken';

/** The provider access token the verifier resolved for this request, if any. */
export function providerToken(authInfo: AuthInfo | undefined): string | undefined {
  const value = authInfo?.extra?.[PROVIDER_TOKEN];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Refresh a provider token this long before it expires. */
const EXPIRY_MARGIN_MS = 60_000;
/** After a refresh, don't refresh the same record again for this long. */
const REFRESH_COOLDOWN_MS = 30_000;

export interface VerifierOptions {
  tokens: TokenStore;
  provider: OAuthProvider;
  credentials: ProviderCredentials;
  /** The MCP endpoint URL. A record bound to another resource is refused. */
  resource: URL;
  logger: Logger;
  /** For calls to the provider. Injected in tests. */
  fetch?: typeof fetch | undefined;
}

/**
 * Checks the opaque access tokens the proxy issued. The token must name a stored record bound
 * to this server (records from before provenance carry no binding and pass). A provider token
 * that expires within a minute is refreshed first. Every failure is `invalid_token`, so the
 * client refreshes or signs in again, except a token store that can't be reached: that is a
 * 500, so the client keeps its token and retries.
 *
 * `scopes` are the record's granted provider scopes; records from before 2026-09 that stored
 * none get the provider's configured scopes. `clientId` is the registered client, or a hash
 * of the token for records without provenance.
 */
export function createProxyVerifier(options: VerifierOptions): OAuthTokenVerifier {
  const fresh = createRefresher(options);

  return {
    async verifyAccessToken(token): Promise<AuthInfo> {
      try {
        const stored = await options.tokens.getByRsAccess(token);
        if (!stored?.provider?.access_token) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is invalid');
        }
        if (stored.oauth && stored.oauth.resource !== options.resource.href) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is invalid');
        }

        const record = await fresh(token, stored);
        const expiresAtMs = record.provider.expires_at;
        if (!expiresAtMs) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is invalid');
        }
        const expiresAt = Math.floor(expiresAtMs / 1_000);
        if (expiresAt <= Math.floor(Date.now() / 1_000)) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Provider authorization is expired');
        }

        const recorded = record.provider.scopes ?? [];
        const scopes = recorded.length > 0 || record.oauth ? recorded : options.provider.scopes;
        return {
          token,
          clientId: record.oauth?.clientId ?? (await principalId(token)),
          scopes: [...new Set(scopes)],
          expiresAt,
          resource: new URL(record.oauth?.resource ?? options.resource.href),
          extra: { [PROVIDER_TOKEN]: record.provider.access_token },
        };
      } catch (error) {
        if (error instanceof OAuthError) throw error;
        if (error instanceof TokenStoreUnavailableError) {
          // The SDK answers 500 for anything that isn't an OAuthError; the client keeps its token.
          options.logger.error('Could not check an access token', { error });
          throw error;
        }
        options.logger.debug('Could not check an access token', { error });
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token could not be validated');
      }
    },
  };
}

/** A stable caller ID for records without provenance, without exposing the token. */
async function principalId(token: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
  );
  return `rs:${toHex(digest)}`;
}

/**
 * Returns the record with a provider token that is good for at least another minute when that
 * is possible. A failed refresh keeps the current token, and the expiry check decides. The
 * access token itself never changes here; only `/token` rotates it.
 */
function createRefresher(
  options: VerifierOptions,
): (token: string, record: RsRecord) => Promise<RsRecord> {
  const { logger } = options;
  // Per isolate: concurrent requests with one token refresh once, not once each.
  const refreshedAt = new Map<string, number>();

  return async (token, record) => {
    const expiresAt = record.provider.expires_at;
    if (!expiresAt || Date.now() < expiresAt - EXPIRY_MARGIN_MS) return record;
    if (Date.now() - (refreshedAt.get(token) ?? 0) < REFRESH_COOLDOWN_MS) return record;
    if (!record.provider.refresh_token) {
      logger.warning('The provider token is expiring and there is no refresh token');
      return record;
    }

    let provider: RsRecord['provider'];
    try {
      const refreshed = await exchangeAtProvider(
        options.provider,
        options.credentials,
        { grant_type: 'refresh_token', refresh_token: record.provider.refresh_token },
        { fetch: options.fetch },
      );
      provider = {
        ...refreshed,
        refresh_token: refreshed.refresh_token ?? record.provider.refresh_token,
        scopes: refreshed.scopes?.length ? refreshed.scopes : [...(record.provider.scopes ?? [])],
      };
    } catch (error) {
      logger.error(`${options.provider.name} token refresh failed; using the current token`, {
        error,
      });
      return record;
    }

    try {
      const updated = await options.tokens.updateByRsRefresh(record.rs_refresh_token, provider);
      // Only a stored refresh starts the cooldown, so a failed write is retried next time.
      markRefreshed(token);
      return updated ?? { ...record, provider };
    } catch (error) {
      logger.error('Could not store the refreshed provider token', { error });
      return { ...record, provider };
    }
  };

  function markRefreshed(token: string): void {
    refreshedAt.set(token, Date.now());
    if (refreshedAt.size <= 1000) return;
    for (const [key, at] of refreshedAt) {
      if (Date.now() - at > REFRESH_COOLDOWN_MS) refreshedAt.delete(key);
    }
  }
}
