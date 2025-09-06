import { createHash, randomBytes } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from '../../config/env.ts';
import { ensureSession } from '../../core/session.ts';
import {
  generateOpaqueToken as genOpaque,
  getRecordByRsRefreshToken,
  storeRsTokenMapping,
  updateSpotifyTokensByRsRefreshToken,
} from '../../core/tokens.ts';

type Txn = {
  codeVerifierHash: string; // PKCE S256(challenge)
  state?: string;
  createdAt: number;
  scope?: string;
  sid?: string;
  spotify?: {
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
    scopes?: string[];
  };
};

const transactions = new Map<string, Txn>();
const codes = new Map<string, string>(); // code -> txnId

function b64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64urlEncodeJson(obj: unknown): string {
  try {
    const json = JSON.stringify(obj);
    return b64url(Buffer.from(json, 'utf8'));
  } catch {
    return '';
  }
}

function b64urlDecodeJson<T = unknown>(value: string): T | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(padded, 'base64');
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    return null;
  }
}

function sha256B64Url(input: string): string {
  const hash = createHash('sha256').update(input).digest();
  return b64url(hash);
}

function generateOpaqueToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

function isAllowedRedirect(uri: string): boolean {
  try {
    const allowRaw = config.OAUTH_REDIRECT_ALLOWLIST || '';
    const allowed = new Set(
      allowRaw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .concat([config.OAUTH_REDIRECT_URI]),
    );
    const url = new URL(uri);
    if (config.NODE_ENV === 'development') {
      const loopback = new Set(['localhost', '127.0.0.1', '::1']);
      if (loopback.has(url.hostname)) return true;
    }
    return (
      allowed.has(`${url.protocol}//${url.host}${url.pathname}`) || allowed.has(uri)
    );
  } catch {
    return false;
  }
}

// Periodic cleanup of old transactions
setInterval(() => {
  const now = Date.now();
  for (const [tid, txn] of transactions) {
    if (now - txn.createdAt > 10 * 60_000) {
      transactions.delete(tid);
    }
  }
}, 60_000).unref?.();

export function oauthRoutes() {
  const app = new Hono<{ Bindings: HttpBindings }>();

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const base = `${here.protocol}//${here.host}`;
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      revocation_endpoint: `${base}/revoke`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: (config.OAUTH_SCOPES || '').split(' ').filter(Boolean),
    });
  });

  app.get('/authorize', (c) => {
    const url = new URL(c.req.url);
    const state = url.searchParams.get('state') ?? undefined;
    const codeChallenge = url.searchParams.get('code_challenge');
    const codeChallengeMethod = url.searchParams.get('code_challenge_method');
    const redirectUri = url.searchParams.get('redirect_uri');
    const requestedScope = url.searchParams.get('scope') ?? undefined;
    const sid = url.searchParams.get('sid') ?? undefined;

    if (!redirectUri) return c.text('invalid_request: redirect_uri', 400);
    if (!codeChallenge || codeChallengeMethod !== 'S256')
      return c.text('invalid_request: pkce', 400);

    if (sid) {
      try {
        ensureSession(sid);
      } catch {}
    }

    const tid = generateOpaqueToken(16);
    transactions.set(tid, {
      codeVerifierHash: codeChallenge,
      state,
      createdAt: Date.now(),
      scope: requestedScope,
      sid,
    });

    if (config.SPOTIFY_CLIENT_ID && config.SPOTIFY_CLIENT_SECRET) {
      const accountsBase = config.SPOTIFY_ACCOUNTS_URL;
      const authUrl = new URL('/authorize', accountsBase);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', config.SPOTIFY_CLIENT_ID);
      const here = new URL(c.req.url);
      const cb = new URL(
        '/spotify/callback',
        `${here.protocol}//${here.host}`,
      ).toString();
      authUrl.searchParams.set('redirect_uri', cb);
      const oauthScopes = (config.OAUTH_SCOPES || '')
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' ');
      const scopeToUse = oauthScopes || requestedScope || '';
      if (scopeToUse) authUrl.searchParams.set('scope', scopeToUse);
      const compositeState =
        b64urlEncodeJson({ tid, cs: state, cr: redirectUri, sid }) || tid;
      authUrl.searchParams.set('state', compositeState);
      return c.redirect(authUrl.toString(), 302);
    }

    // Dev-only shortcut: immediately redirect back with a one-time code
    const code = generateOpaqueToken(16);
    codes.set(code, tid);
    const clientRedirect = redirectUri;
    const safe = isAllowedRedirect(clientRedirect)
      ? clientRedirect
      : config.OAUTH_REDIRECT_URI;
    const redirect = new URL(safe);
    redirect.searchParams.set('code', code);
    if (state) redirect.searchParams.set('state', state);
    return c.redirect(redirect.toString(), 302);
  });

  app.get('/spotify/callback', async (c) => {
    try {
      const here = new URL(c.req.url);
      const code = here.searchParams.get('code');
      const state = here.searchParams.get('state');
      if (!code || !state) return c.text('invalid_callback', 400);
      const decoded =
        b64urlDecodeJson<{
          tid?: string;
          cs?: string;
          cr?: string;
          sid?: string;
        }>(state) || {};
      const txnId = decoded.tid || state;
      const txn = transactions.get(txnId);
      if (!txn) return c.text('unknown_txn', 400);

      const tokenUrl = new URL('/api/token', config.SPOTIFY_ACCOUNTS_URL).toString();
      const hereBase = `${here.protocol}//${here.host}`;
      const cb = new URL('/spotify/callback', hereBase).toString();
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cb,
      });
      const basic = Buffer.from(
        `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`,
      ).toString('base64');
      const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basic}`,
        },
        body: form.toString(),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return c.text(`spotify_token_error: ${resp.status} ${t}`.trim(), 500);
      }
      const data = (await resp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number | string;
        scope?: string;
      };
      const access_token = String(data.access_token || '');
      if (!access_token) return c.text('spotify_no_token', 500);
      const expires_at = Date.now() + Number(data.expires_in ?? 3600) * 1000;
      const scopes = String(data.scope || '')
        .split(/\s+/)
        .filter(Boolean);
      (txn as unknown as { spotify?: unknown }).spotify = {
        access_token,
        refresh_token: data.refresh_token,
        expires_at,
        scopes,
      };
      // Issue AS code back to client
      const asCode = genOpaque(24);
      codes.set(asCode, txnId);
      transactions.set(txnId, txn);
      const clientRedirect = decoded.cr || config.OAUTH_REDIRECT_URI;
      const safe = isAllowedRedirect(clientRedirect)
        ? clientRedirect
        : config.OAUTH_REDIRECT_URI;
      const redirect = new URL(safe);
      redirect.searchParams.set('code', asCode);
      if (decoded.cs) redirect.searchParams.set('state', decoded.cs);
      // Session attachment
      if (decoded.sid) {
        try {
          const s = ensureSession(decoded.sid);
          s.spotify = {
            access_token,
            refresh_token: data.refresh_token,
            expires_at,
            scopes,
          };
        } catch {}
      }
      return c.redirect(redirect.toString(), 302);
    } catch (_e) {
      return c.text('spotify_callback_error', 500);
    }
  });

  app.post('/token', async (c) => {
    const contentType = c.req.header('content-type') || '';
    const form = new URLSearchParams(
      contentType.includes('application/x-www-form-urlencoded')
        ? await c.req.text().then((t) => Object.fromEntries(new URLSearchParams(t)))
        : ((await c.req.json().catch(() => ({}))) as Record<string, string>),
    );
    const grant = form.get('grant_type');

    if (grant === 'refresh_token') {
      const rsRefresh = form.get('refresh_token') || '';
      const rec = getRecordByRsRefreshToken(rsRefresh);
      if (!rec) return c.json({ error: 'invalid_grant' }, 400);
      const newAccess = genOpaque(24);
      const updated = updateSpotifyTokensByRsRefreshToken(
        rsRefresh,
        rec.spotify,
        newAccess,
      );
      return c.json({
        access_token: newAccess,
        refresh_token: rsRefresh,
        token_type: 'bearer',
        expires_in: 3600,
        scope: (updated?.spotify.scopes || []).join(' '),
      });
    }

    if (grant !== 'authorization_code')
      return c.json({ error: 'unsupported_grant_type' }, 400);

    const code = form.get('code') || '';
    const codeVerifier = form.get('code_verifier') || '';
    const txnId = codes.get(code);
    if (!txnId) return c.json({ error: 'invalid_grant' }, 400);
    const txn = transactions.get(txnId);
    if (!txn) return c.json({ error: 'invalid_grant' }, 400);
    const expected = txn.codeVerifierHash;
    const actual = sha256B64Url(codeVerifier);
    if (expected !== actual) return c.json({ error: 'invalid_grant' }, 400);

    const rsAccess = genOpaque(24);
    const rsRefresh = genOpaque(24);
    const spotifyTokens = (
      txn as unknown as {
        spotify?: {
          access_token: string;
          refresh_token?: string;
          expires_at?: number;
          scopes?: string[];
        };
      }
    ).spotify;
    if (spotifyTokens?.access_token) {
      storeRsTokenMapping(rsAccess, spotifyTokens, rsRefresh);
    }
    // single-use
    transactions.delete(txnId);
    codes.delete(code);
    return c.json({
      access_token: rsAccess,
      refresh_token: rsRefresh,
      token_type: 'bearer',
      expires_in: 3600,
      scope:
        (spotifyTokens?.scopes || []).join(' ') ||
        txn.scope ||
        (config.OAUTH_SCOPES || '').trim(),
    });
  });

  app.post('/revoke', async (c) => c.json({ status: 'ok' }));

  app.post('/register', async (c) => {
    const here = new URL(c.req.url);
    const base = `${here.protocol}//${here.host}`;
    const requested = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    const client_id = generateOpaqueToken(12);
    const redirects = Array.isArray(
      (requested as { redirect_uris?: unknown }).redirect_uris,
    )
      ? (requested as { redirect_uris: string[] }).redirect_uris || []
      : [config.OAUTH_REDIRECT_URI];
    return c.json(
      {
        client_id,
        client_id_issued_at: now,
        client_secret_expires_at: 0,
        token_endpoint_auth_method: 'none',
        redirect_uris: redirects,
        registration_client_uri: `${base}/register/${client_id}`,
        registration_access_token: generateOpaqueToken(12),
      },
      201,
    );
  });

  return app;
}
