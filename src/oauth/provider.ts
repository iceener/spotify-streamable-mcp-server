import { toBase64 } from './encoding';
import { oauthError } from './errors';
import { boundedText } from './input';
import type { ProviderTokens } from './token-store';

/**
 * Everything the proxy knows about one provider. Each project describes its provider in one
 * small module (Gmail: `src/services/google-oauth.ts`); the rest of `src/oauth/` is the same
 * for every provider.
 */
export interface OAuthProvider {
  /** For logs. */
  name: string;
  /** Where users sign in, and where codes and refresh tokens are exchanged. */
  authorizationUrl: string;
  tokenUrl: string;
  /** Scopes requested at the provider. Also published as the proxy's `scopes_supported`. */
  scopes: readonly string[];
  /** Extra authorization parameters, such as Google's `access_type=offline`. The protocol's own fields always win. */
  authorizationParams: Readonly<Record<string, string>>;
  /** Read a successful token endpoint response. Throw `oauthError(...)` when it is unusable. */
  readTokens(body: unknown): ProviderTokenResponse;
}

export interface ProviderTokenResponse {
  accessToken: string;
  refreshToken: string | undefined;
  /** Lifetime in seconds. */
  expiresIn: number;
  /** Granted scopes, or an empty list when the provider didn't say. */
  scopes: string[];
}

/** The proxy's own client at the provider. Secrets: `PROVIDER_CLIENT_ID`, `PROVIDER_CLIENT_SECRET`. */
export interface ProviderCredentials {
  clientId: string | undefined;
  clientSecret: string | undefined;
}

/**
 * An RFC 6749 token response: `access_token`, optional `refresh_token`, `expires_in` in
 * seconds (one hour when missing), and space-separated `scope`.
 */
export function readStandardTokenResponse(body: unknown): ProviderTokenResponse {
  const data = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw oauthError('provider_no_token');
  }
  const seconds = Number(data.expires_in ?? 3600);
  if (!Number.isFinite(seconds) || seconds <= 0) throw oauthError('provider_token_error');
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expiresIn: seconds,
    scopes: String(data.scope || '')
      .split(/\s+/)
      .filter(Boolean),
  };
}

/** Fails closed before any provider request when the proxy's own credentials are missing. */
export function requireCredentials(
  credentials: ProviderCredentials,
): asserts credentials is { clientId: string; clientSecret: string } {
  if (!credentials.clientId || !credentials.clientSecret) throw oauthError('server_error');
}

export interface ExchangeOptions {
  /** Used when the provider's answer names no scopes. */
  fallbackScopes?: readonly string[];
  /** Injected in tests. Defaults to the runtime's `fetch`. */
  fetch?: typeof fetch | undefined;
}

/**
 * POST a grant to the provider's token endpoint with HTTP Basic client authentication. The
 * provider's error bodies are never read or passed on: any failure is `provider_token_error`.
 */
export async function exchangeAtProvider(
  provider: OAuthProvider,
  credentials: ProviderCredentials,
  grant: Record<string, string>,
  options: ExchangeOptions = {},
): Promise<ProviderTokens> {
  requireCredentials(credentials);
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${toBase64(new TextEncoder().encode(`${credentials.clientId}:${credentials.clientSecret}`))}`,
      },
      body: new URLSearchParams(grant).toString(),
    });
  } catch {
    throw oauthError('provider_token_error');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw oauthError('provider_token_error');
  }
  const tokens = provider.readTokens(JSON.parse(await boundedText(response)));
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_at: Date.now() + tokens.expiresIn * 1000,
    scopes: tokens.scopes.length > 0 ? tokens.scopes : [...(options.fallbackScopes ?? [])],
  };
}
