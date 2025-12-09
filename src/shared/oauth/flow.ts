// Core OAuth flow logic: PKCE, state encoding, provider token exchange
// Provider-agnostic version from Spotify MCP

import { createHash, randomBytes } from 'node:crypto';
import type { ProviderTokens, TokenStore } from '../storage/interface.js';
import { sharedLogger as logger } from '../utils/logger.js';
import type {
  AuthorizeInput,
  AuthorizeResult,
  CallbackInput,
  CallbackResult,
  OAuthConfig,
  ProviderConfig,
  TokenInput,
  TokenResult,
} from './types.js';

// Base64 encoding (works in both Node.js and Workers)
function base64Encode(input: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'utf8').toString('base64');
  }
  return btoa(input);
}

// Base64 URL encoding
function b64url(input: Buffer | Uint8Array): string {
  let base64: string;
  if (typeof Buffer !== 'undefined' && input instanceof Buffer) {
    base64 = input.toString('base64');
  } else {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    base64 = btoa(binary);
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlEncodeJson(obj: unknown): string {
  try {
    const json = JSON.stringify(obj);
    if (typeof Buffer !== 'undefined') {
      return b64url(Buffer.from(json, 'utf8'));
    }
    const encoder = new TextEncoder();
    return b64url(encoder.encode(json));
  } catch {
    return '';
  }
}

function b64urlDecodeJson<T = unknown>(value: string): T | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    let json: string;
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(padded, 'base64');
      json = buf.toString('utf8');
    } else {
      json = atob(padded);
    }
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// Async version for Workers/Node
async function sha256B64UrlAsync(input: string): Promise<string> {
  if (typeof Buffer !== 'undefined') {
    const hash = createHash('sha256').update(input).digest();
    return b64url(hash);
  }
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return b64url(new Uint8Array(hashBuffer));
}

export function generateOpaqueToken(bytes = 32): string {
  if (typeof Buffer !== 'undefined') {
    return b64url(randomBytes(bytes));
  }
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return b64url(array);
}

function isAllowedRedirect(uri: string, config: OAuthConfig, isDev: boolean): boolean {
  try {
    const allowed = new Set(
      config.redirectAllowlist.concat([config.redirectUri]).filter(Boolean),
    );
    const url = new URL(uri);

    if (isDev) {
      const loopback = new Set(['localhost', '127.0.0.1', '::1']);
      if (loopback.has(url.hostname)) {
        return true;
      }
    }

    if (config.redirectAllowAll) {
      return true;
    }

    return (
      allowed.has(`${url.protocol}//${url.host}${url.pathname}`) || allowed.has(uri)
    );
  } catch {
    return false;
  }
}

/**
 * Handle authorization request - redirect to provider or issue dev code
 */
export async function handleAuthorize(
  input: AuthorizeInput,
  store: TokenStore,
  providerConfig: ProviderConfig,
  oauthConfig: OAuthConfig,
  options: {
    baseUrl: string;
    isDev: boolean;
    callbackPath?: string;
  },
): Promise<AuthorizeResult> {
  if (!input.redirectUri) {
    throw new Error('invalid_request: redirect_uri is required');
  }
  if (!input.codeChallenge || input.codeChallengeMethod !== 'S256') {
    throw new Error(
      'invalid_request: PKCE code_challenge with S256 method is required',
    );
  }

  const txnId = generateOpaqueToken(16);
  await store.saveTransaction(txnId, {
    codeChallenge: input.codeChallenge,
    state: input.state,
    createdAt: Date.now(),
    scope: input.requestedScope,
    sid: input.sid,
  });

  logger.debug('oauth_authorize', {
    message: 'Checking provider configuration',
    hasClientId: !!providerConfig.clientId,
    hasClientSecret: !!providerConfig.clientSecret,
  });

  // Production: redirect to provider
  if (providerConfig.clientId && providerConfig.clientSecret) {
    logger.info('oauth_authorize', {
      message: 'Using production flow - redirecting to provider',
    });

    const authUrl = new URL('/authorize', providerConfig.accountsUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', providerConfig.clientId);

    const callbackPath = options.callbackPath || '/oauth/callback';
    const cb = new URL(callbackPath, options.baseUrl).toString();
    authUrl.searchParams.set('redirect_uri', cb);

    const scopeToUse = providerConfig.oauthScopes || input.requestedScope || '';
    if (scopeToUse) {
      authUrl.searchParams.set('scope', scopeToUse);
    }

    const compositeState =
      b64urlEncodeJson({
        tid: txnId,
        cs: input.state,
        cr: input.redirectUri,
        sid: input.sid,
      }) || txnId;

    authUrl.searchParams.set('state', compositeState);

    logger.debug('oauth_authorize', {
      message: 'Redirect URL constructed',
      url: authUrl.origin + authUrl.pathname,
    });

    return {
      redirectTo: authUrl.toString(),
      txnId,
    };
  }

  logger.warning('oauth_authorize', {
    message: 'Missing provider credentials - using dev shortcut',
  });

  // Dev-only shortcut: immediately redirect with code
  const code = generateOpaqueToken(16);
  await store.saveCode(code, txnId);

  const safe = isAllowedRedirect(input.redirectUri, oauthConfig, options.isDev)
    ? input.redirectUri
    : oauthConfig.redirectUri;

  const redirect = new URL(safe);
  redirect.searchParams.set('code', code);
  if (input.state) {
    redirect.searchParams.set('state', input.state);
  }

  return {
    redirectTo: redirect.toString(),
    txnId,
  };
}

/**
 * Handle provider callback - exchange code for tokens
 */
export async function handleProviderCallback(
  input: CallbackInput,
  store: TokenStore,
  providerConfig: ProviderConfig,
  oauthConfig: OAuthConfig,
  options: {
    baseUrl: string;
    isDev: boolean;
    callbackPath?: string;
    tokenEndpointPath?: string;
  },
): Promise<CallbackResult> {
  const decoded =
    b64urlDecodeJson<{
      tid?: string;
      cs?: string;
      cr?: string;
      sid?: string;
    }>(input.compositeState) || {};

  const txnId = decoded.tid || input.compositeState;
  const txn = await store.getTransaction(txnId);

  if (!txn) {
    logger.error('oauth_callback', {
      message: 'Transaction not found',
      txnId,
    });
    throw new Error('unknown_txn');
  }

  // Exchange code with provider
  const tokenEndpointPath = options.tokenEndpointPath || '/api/token';
  const tokenUrl = new URL(tokenEndpointPath, providerConfig.accountsUrl).toString();
  const callbackPath = options.callbackPath || '/oauth/callback';
  const cb = new URL(callbackPath, options.baseUrl).toString();

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.providerCode,
    redirect_uri: cb,
  });

  logger.debug('oauth_callback', {
    message: 'Exchanging code for tokens',
    tokenUrl,
  });

  const basic = base64Encode(
    `${providerConfig.clientId}:${providerConfig.clientSecret}`,
  );

  let resp: Response;
  try {
    resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      body: form.toString(),
    });

    logger.debug('oauth_callback', {
      message: 'Token response received',
      status: resp.status,
    });
  } catch (fetchError) {
    logger.error('oauth_callback', {
      message: 'Token fetch failed',
      error: (fetchError as Error).message,
    });
    throw new Error(`fetch_failed: ${(fetchError as Error).message}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    logger.error('oauth_callback', {
      message: 'Provider token error',
      status: resp.status,
      body: text.substring(0, 200),
    });
    throw new Error(`provider_token_error: ${resp.status} ${text}`.trim());
  }

  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number | string;
    scope?: string;
  };

  const accessToken = String(data.access_token || '');
  if (!accessToken) {
    logger.error('oauth_callback', {
      message: 'No access token in provider response',
    });
    throw new Error('provider_no_token');
  }

  const expiresAt = Date.now() + Number(data.expires_in ?? 3600) * 1000;
  const scopes = String(data.scope || '')
    .split(/\s+/)
    .filter(Boolean);

  const providerTokens: ProviderTokens = {
    access_token: accessToken,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    scopes,
  };

  logger.info('oauth_callback', {
    message: 'Provider tokens received',
    hasRefreshToken: !!data.refresh_token,
    expiresIn: data.expires_in,
  });

  // Update transaction with provider tokens
  txn.provider = providerTokens;
  await store.saveTransaction(txnId, txn);

  // Issue RS code back to client
  const asCode = generateOpaqueToken(24);
  await store.saveCode(asCode, txnId);

  logger.debug('oauth_callback', {
    message: 'RS code generated',
  });

  const clientRedirect = decoded.cr || oauthConfig.redirectUri;
  const safe = isAllowedRedirect(clientRedirect, oauthConfig, options.isDev)
    ? clientRedirect
    : oauthConfig.redirectUri;

  const redirect = new URL(safe);
  redirect.searchParams.set('code', asCode);
  if (decoded.cs) {
    redirect.searchParams.set('state', decoded.cs);
  }

  return {
    redirectTo: redirect.toString(),
    txnId,
    providerTokens,
  };
}

/**
 * Refresh provider token using refresh_token grant
 */
async function refreshProviderToken(
  providerRefreshToken: string,
  providerConfig: ProviderConfig,
): Promise<ProviderTokens> {
  const tokenUrl = new URL('/api/token', providerConfig.accountsUrl).toString();

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: providerRefreshToken,
  });

  const basic = base64Encode(
    `${providerConfig.clientId}:${providerConfig.clientSecret}`,
  );

  logger.debug('oauth_refresh_provider', {
    message: 'Refreshing provider token',
    tokenUrl,
  });

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: form.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    logger.error('oauth_refresh_provider', {
      message: 'Provider refresh failed',
      status: resp.status,
      body: text.substring(0, 200),
    });
    throw new Error('provider_refresh_failed');
  }

  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number | string;
    scope?: string;
  };

  const accessToken = String(data.access_token || '');
  if (!accessToken) {
    throw new Error('provider_no_token');
  }

  logger.info('oauth_refresh_provider', {
    message: 'Provider token refreshed',
    hasNewRefreshToken: !!data.refresh_token,
  });

  return {
    access_token: accessToken,
    refresh_token: data.refresh_token ?? providerRefreshToken, // Some providers don't rotate
    expires_at: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    scopes: String(data.scope || '')
      .split(/\s+/)
      .filter(Boolean),
  };
}

/**
 * Handle token exchange (authorization_code or refresh_token grant)
 */
export async function handleToken(
  input: TokenInput,
  store: TokenStore,
  providerConfig?: ProviderConfig,
): Promise<TokenResult> {
  if (input.grant === 'refresh_token') {
    logger.debug('oauth_token', {
      message: 'Processing refresh_token grant',
    });

    const rec = await store.getByRsRefresh(input.refreshToken);
    if (!rec) {
      logger.error('oauth_token', {
        message: 'Invalid refresh token',
      });
      throw new Error('invalid_grant');
    }

    // Check if provider token is expired or expiring soon (1 minute buffer)
    const now = Date.now();
    const providerExpiresAt = rec.provider.expires_at ?? 0;
    const isExpiringSoon = now >= providerExpiresAt - 60_000;

    let provider = rec.provider;

    if (isExpiringSoon && providerConfig) {
      logger.info('oauth_token', {
        message: 'Provider token expired/expiring, refreshing',
        expiresAt: providerExpiresAt,
        now,
      });

      if (!rec.provider.refresh_token) {
        logger.error('oauth_token', {
          message: 'No provider refresh token available',
        });
        throw new Error('provider_token_expired');
      }

      try {
        provider = await refreshProviderToken(
          rec.provider.refresh_token,
          providerConfig,
        );
      } catch (error) {
        logger.error('oauth_token', {
          message: 'Provider refresh failed',
          error: (error as Error).message,
        });
        throw new Error('provider_refresh_failed');
      }
    }

    // Conditional RS access token rotation:
    // Only rotate when provider refresh_token changed (security vs KV quota trade-off)
    // When provider rotates its refresh_token, we rotate RS token for security.
    // Otherwise, keep the same RS token to save KV write operations.
    const providerRefreshRotated = provider.refresh_token !== rec.provider.refresh_token;
    const newAccess = providerRefreshRotated ? generateOpaqueToken(24) : undefined;

    const updated = await store.updateByRsRefresh(
      input.refreshToken,
      provider,
      newAccess,
    );

    // Calculate expires_in based on provider token expiry
    const expiresIn = provider.expires_at
      ? Math.max(1, Math.floor((provider.expires_at - Date.now()) / 1000))
      : 3600;

    logger.info('oauth_token', {
      message: 'Token refreshed successfully',
      providerRefreshed: isExpiringSoon,
      rsAccessRotated: providerRefreshRotated,
    });

    return {
      access_token: newAccess ?? rec.rs_access_token,
      refresh_token: input.refreshToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      scope: (updated?.provider.scopes || []).join(' '),
    };
  }

  // authorization_code grant
  logger.debug('oauth_token', {
    message: 'Processing authorization_code grant',
  });

  const txnId = await store.getTxnIdByCode(input.code);
  if (!txnId) {
    logger.error('oauth_token', {
      message: 'Authorization code not found',
    });
    throw new Error('invalid_grant');
  }

  const txn = await store.getTransaction(txnId);
  if (!txn) {
    logger.error('oauth_token', {
      message: 'Transaction not found for code',
    });
    throw new Error('invalid_grant');
  }

  // Verify PKCE
  const expected = txn.codeChallenge;
  const actual = await sha256B64UrlAsync(input.codeVerifier);
  if (expected !== actual) {
    logger.error('oauth_token', {
      message: 'PKCE verification failed',
    });
    throw new Error('invalid_grant');
  }

  // Mint RS tokens
  const rsAccess = generateOpaqueToken(24);
  const rsRefresh = generateOpaqueToken(24);

  logger.debug('oauth_token', {
    message: 'Minting RS tokens',
    hasProviderTokens: !!txn.provider?.access_token,
  });

  if (txn.provider?.access_token) {
    await store.storeRsMapping(rsAccess, txn.provider, rsRefresh);
    logger.info('oauth_token', {
      message: 'RS→Provider mapping stored',
    });
  } else {
    logger.warning('oauth_token', {
      message: 'No provider tokens in transaction - RS mapping not created',
    });
  }

  // Single-use code
  await store.deleteTransaction(txnId);
  await store.deleteCode(input.code);

  logger.info('oauth_token', {
    message: 'Token exchange completed',
  });

  return {
    access_token: rsAccess,
    refresh_token: rsRefresh,
    token_type: 'bearer',
    expires_in: 3600,
    scope: (txn.provider?.scopes || []).join(' ') || txn.scope || '',
  };
}
