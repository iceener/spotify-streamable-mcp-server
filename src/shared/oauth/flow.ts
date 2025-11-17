// Core OAuth flow logic: PKCE, state encoding, Spotify exchange

import { createHash, randomBytes } from 'node:crypto';
import type { SpotifyTokens, TokenStore } from '../storage/interface.ts';
import type {
  AuthorizeInput,
  AuthorizeResult,
  CallbackInput,
  CallbackResult,
  OAuthConfig,
  SpotifyConfig,
  TokenInput,
  TokenResult,
} from './types.ts';

// Base64 encoding (works in both Node.js and Workers)
function base64Encode(input: string): string {
  if (typeof Buffer !== 'undefined') {
    // Node.js
    return Buffer.from(input, 'utf8').toString('base64');
  } else {
    // Workers/Browser
    return btoa(input);
  }
}

// Base64 URL encoding
function b64url(input: Buffer | Uint8Array): string {
  let base64: string;
  if (typeof Buffer !== 'undefined' && input instanceof Buffer) {
    // Node.js
    base64 = input.toString('base64');
  } else {
    // Workers - convert Uint8Array to base64
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
    } else {
      const encoder = new TextEncoder();
      return b64url(encoder.encode(json));
    }
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
    // Node.js
    const hash = createHash('sha256').update(input).digest();
    return b64url(hash);
  } else {
    // Workers - use Web Crypto API
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return b64url(new Uint8Array(hashBuffer));
  }
}

export function generateOpaqueToken(bytes = 32): string {
  if (typeof Buffer !== 'undefined') {
    // Node.js
    return b64url(randomBytes(bytes));
  } else {
    // Workers
    const array = new Uint8Array(bytes);
    crypto.getRandomValues(array);
    return b64url(array);
  }
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
 * Handle authorization request - redirect to Spotify or issue dev code
 */
export async function handleAuthorize(
  input: AuthorizeInput,
  store: TokenStore,
  spotifyConfig: SpotifyConfig,
  oauthConfig: OAuthConfig,
  options: {
    baseUrl: string;
    isDev: boolean;
  },
): Promise<AuthorizeResult> {
  if (!input.redirectUri) {
    throw new Error('invalid_request: redirect_uri');
  }
  if (!input.codeChallenge || input.codeChallengeMethod !== 'S256') {
    throw new Error('invalid_request: pkce');
  }

  const txnId = generateOpaqueToken(16);
  await store.saveTransaction(txnId, {
    codeChallenge: input.codeChallenge,
    state: input.state,
    createdAt: Date.now(),
    scope: input.requestedScope,
    sid: input.sid,
  });

  // Production: redirect to Spotify
  console.log('[AUTHORIZE] Checking Spotify config:', {
    hasClientId: !!spotifyConfig.clientId,
    hasClientSecret: !!spotifyConfig.clientSecret,
    clientIdType: typeof spotifyConfig.clientId,
    clientSecretType: typeof spotifyConfig.clientSecret,
    clientIdLength: spotifyConfig.clientId?.length,
    clientSecretLength: spotifyConfig.clientSecret?.length,
  });

  if (spotifyConfig.clientId && spotifyConfig.clientSecret) {
    console.log('[AUTHORIZE] Using production flow - redirecting to Spotify');
    const authUrl = new URL('/authorize', spotifyConfig.accountsUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', spotifyConfig.clientId);

    const cb = new URL('/spotify/callback', options.baseUrl).toString();
    authUrl.searchParams.set('redirect_uri', cb);

    const scopeToUse = spotifyConfig.oauthScopes || input.requestedScope || '';
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

    console.log('[AUTHORIZE] Redirecting to Spotify:', authUrl.toString());

    return {
      redirectTo: authUrl.toString(),
      txnId,
    };
  }

  console.warn('[AUTHORIZE] Missing Spotify credentials! Using dev shortcut');

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
 * Handle Spotify callback - exchange code for tokens
 */
export async function handleSpotifyCallback(
  input: CallbackInput,
  store: TokenStore,
  spotifyConfig: SpotifyConfig,
  oauthConfig: OAuthConfig,
  options: {
    baseUrl: string;
    isDev: boolean;
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
    throw new Error('unknown_txn');
  }

  // Exchange code with Spotify
  const tokenUrl = new URL('/api/token', spotifyConfig.accountsUrl).toString();
  const cb = new URL('/spotify/callback', options.baseUrl).toString();

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.providerCode,
    redirect_uri: cb,
  });

  console.log('[FLOW] Encoding Basic auth...', {
    hasClientId: !!spotifyConfig.clientId,
    hasClientSecret: !!spotifyConfig.clientSecret,
    clientIdLength: spotifyConfig.clientId?.length,
    clientSecretLength: spotifyConfig.clientSecret?.length,
  });

  const basic = base64Encode(`${spotifyConfig.clientId}:${spotifyConfig.clientSecret}`);

  console.log('[FLOW] Basic auth encoded, length:', basic.length);
  console.log('[FLOW] Fetching token from:', tokenUrl);
  console.log('[FLOW] Form data:', form.toString());

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
    console.log('[FLOW] Token response received, status:', resp.status);
  } catch (fetchError) {
    console.error('[FLOW] Fetch failed:', fetchError);
    throw new Error(`fetch_failed: ${(fetchError as Error).message}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error('[FLOW] Token error:', resp.status, text);
    throw new Error(`spotify_token_error: ${resp.status} ${text}`.trim());
  }

  console.log('[FLOW] Token response OK, parsing JSON...');

  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number | string;
    scope?: string;
  };

  const accessToken = String(data.access_token || '');
  if (!accessToken) {
    throw new Error('spotify_no_token');
  }

  const expiresAt = Date.now() + Number(data.expires_in ?? 3600) * 1000;
  const scopes = String(data.scope || '')
    .split(/\s+/)
    .filter(Boolean);

  const spotifyTokens: SpotifyTokens = {
    access_token: accessToken,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    scopes,
  };

  console.log('[FLOW] Spotify tokens received, storing...');

  // Update transaction with Spotify tokens
  txn.spotify = spotifyTokens;
  await store.saveTransaction(txnId, txn);

  console.log('[FLOW] Transaction updated, generating RS code...');

  // Issue RS code back to client
  const asCode = generateOpaqueToken(24);
  await store.saveCode(asCode, txnId);

  console.log('[FLOW] RS code saved:', asCode.substring(0, 8) + '...');

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
    spotifyTokens,
  };
}

/**
 * Handle token exchange (authorization_code or refresh_token grant)
 */
export async function handleToken(
  input: TokenInput,
  store: TokenStore,
): Promise<TokenResult> {
  if (input.grant === 'refresh_token') {
    const rec = await store.getByRsRefresh(input.refreshToken);
    if (!rec) {
      throw new Error('invalid_grant');
    }

    const newAccess = generateOpaqueToken(24);
    const updated = await store.updateByRsRefresh(
      input.refreshToken,
      rec.spotify,
      newAccess,
    );

    return {
      access_token: newAccess,
      refresh_token: input.refreshToken,
      token_type: 'bearer',
      expires_in: 3600,
      scope: (updated?.spotify.scopes || []).join(' '),
    };
  }

  // authorization_code grant
  console.log('[TOKEN-FLOW] Looking up code:', input.code.substring(0, 10) + '...');
  const txnId = await store.getTxnIdByCode(input.code);
  console.log('[TOKEN-FLOW] TxnId found:', txnId?.substring(0, 10) || 'null');

  if (!txnId) {
    console.error('[TOKEN-FLOW] Code not found in store - invalid_grant');
    throw new Error('invalid_grant');
  }

  const txn = await store.getTransaction(txnId);
  console.log('[TOKEN-FLOW] Transaction found:', !!txn);

  if (!txn) {
    console.error('[TOKEN-FLOW] Transaction not found - invalid_grant');
    throw new Error('invalid_grant');
  }

  // Verify PKCE
  const expected = txn.codeChallenge;
  const actual = await sha256B64UrlAsync(input.codeVerifier);
  if (expected !== actual) {
    throw new Error('invalid_grant');
  }

  // Mint RS tokens
  const rsAccess = generateOpaqueToken(24);
  const rsRefresh = generateOpaqueToken(24);

  console.log('[TOKEN] Minting RS tokens...', {
    hasSpotifyTokens: !!txn.spotify?.access_token,
    rsAccessPrefix: rsAccess.substring(0, 8),
  });

  if (txn.spotify?.access_token) {
    console.log('[TOKEN] Storing RS→Spotify mapping...');
    const record = await store.storeRsMapping(rsAccess, txn.spotify, rsRefresh);
    console.log('[TOKEN] Mapping stored:', {
      rsAccessToken: record.rs_access_token.substring(0, 8) + '...',
      rsRefreshToken: record.rs_refresh_token.substring(0, 8) + '...',
      hasSpotifyAccess: !!record.spotify.access_token,
    });
  } else {
    console.warn('[TOKEN] No Spotify tokens in transaction! RS mapping not created.');
  }

  // Single-use code
  await store.deleteTransaction(txnId);
  await store.deleteCode(input.code);

  console.log('[TOKEN] Returning RS tokens to client');

  return {
    access_token: rsAccess,
    refresh_token: rsRefresh,
    token_type: 'bearer',
    expires_in: 3600,
    scope: (txn.spotify?.scopes || []).join(' ') || txn.scope || '',
  };
}
