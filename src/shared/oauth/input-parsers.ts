// Shared OAuth input parsing for both Node.js and Cloudflare Workers

import type { UnifiedConfig } from '../config/env.js';
import type {
  AuthorizeInput,
  OAuthConfig,
  ProviderConfig,
  TokenInput,
} from './types.js';

/**
 * Parse authorization request from URL search params.
 */
export function parseAuthorizeInput(url: URL, sessionId?: string): AuthorizeInput {
  return {
    codeChallenge: url.searchParams.get('code_challenge') || '',
    codeChallengeMethod: url.searchParams.get('code_challenge_method') || '',
    redirectUri: url.searchParams.get('redirect_uri') || '',
    requestedScope: url.searchParams.get('scope') ?? undefined,
    state: url.searchParams.get('state') ?? undefined,
    sid: url.searchParams.get('sid') || sessionId || undefined,
  };
}

/**
 * Parse callback request from URL search params.
 */
export function parseCallbackInput(url: URL): {
  code: string | null;
  state: string | null;
} {
  return {
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
  };
}

/**
 * Parse token request from form data or JSON body.
 */
export async function parseTokenInput(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await request.text();
    return new URLSearchParams(text);
  }

  // Try JSON fallback
  const json = (await request.json().catch(() => ({}))) as Record<string, string>;
  return new URLSearchParams(json);
}

/**
 * Build TokenInput from parsed form data.
 */
export function buildTokenInput(form: URLSearchParams): TokenInput | { error: string } {
  const grant = form.get('grant_type');

  if (grant === 'refresh_token') {
    const refreshToken = form.get('refresh_token');
    if (!refreshToken) {
      return { error: 'missing_refresh_token' };
    }
    return { grant: 'refresh_token', refreshToken };
  }

  if (grant === 'authorization_code') {
    const code = form.get('code');
    const codeVerifier = form.get('code_verifier');
    if (!code || !codeVerifier) {
      return { error: 'missing_code_or_verifier' };
    }
    return { grant: 'authorization_code', code, codeVerifier };
  }

  return { error: 'unsupported_grant_type' };
}

/**
 * Build ProviderConfig from UnifiedConfig.
 */
export function buildProviderConfig(config: UnifiedConfig): ProviderConfig {
  return {
    clientId: config.PROVIDER_CLIENT_ID,
    clientSecret: config.PROVIDER_CLIENT_SECRET,
    accountsUrl: config.PROVIDER_ACCOUNTS_URL || 'https://provider.example.com',
    oauthScopes: config.OAUTH_SCOPES,
  };
}

/**
 * Build OAuthConfig from UnifiedConfig.
 */
export function buildOAuthConfig(config: UnifiedConfig): OAuthConfig {
  return {
    redirectUri: config.OAUTH_REDIRECT_URI,
    redirectAllowlist: config.OAUTH_REDIRECT_ALLOWLIST,
    redirectAllowAll: config.OAUTH_REDIRECT_ALLOW_ALL,
  };
}

/**
 * Build flow options from request URL.
 */
export function buildFlowOptions(
  url: URL,
  config: UnifiedConfig,
  overrides: { callbackPath?: string; tokenEndpointPath?: string } = {},
): {
  baseUrl: string;
  isDev: boolean;
  callbackPath: string;
  tokenEndpointPath: string;
} {
  return {
    baseUrl: url.origin,
    isDev: config.NODE_ENV === 'development',
    callbackPath: overrides.callbackPath ?? '/oauth/callback',
    tokenEndpointPath: overrides.tokenEndpointPath ?? '/api/token',
  };
}
