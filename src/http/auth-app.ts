import { createHash, randomUUID } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from '../config/env.js';
import { ensureSession } from '../core/session.js';
import {
  generateOpaqueToken,
  getRecordByRsRefreshToken,
  storeRsTokenMapping,
  updateSpotifyTokensByRsRefreshToken,
} from '../core/tokens.js';
import { logger } from '../utils/logger.js';

type Txn = {
  id: string;
  client_state: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  resource?: string;
  sessionId?: string;
  // Client-provided redirect target (from MCP client)
  client_redirect_uri?: string;
  // After Spotify callback
  spotify?: {
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
    scopes?: string[];
  };
  // For issuing AS code to client
  as_code?: string;
  createdAt: number;
};

const txns = new Map<string, Txn>();
const TXN_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Cleanup loop
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of txns) {
    if (now - t.createdAt > TXN_TTL_MS) {
      txns.delete(id);
    }
  }
}, 60 * 1000).unref?.();

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

export function buildAuthApp(): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const base = `${here.protocol}//${here.host}`;
    const metadata = {
      issuer: base,
      authorization_endpoint: config.OAUTH_AUTHORIZATION_URL || `${base}/authorize`,
      token_endpoint: config.OAUTH_TOKEN_URL || `${base}/token`,
      revocation_endpoint: config.OAUTH_REVOCATION_URL || `${base}/revoke`,
      // Some clients (e.g., rmcp) require dynamic registration even if optional in spec
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'client_credentials',
      ],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
      scopes_supported: (config.OAUTH_SCOPES || '').split(' ').filter(Boolean),
    };
    return c.json(metadata);
  });

  // OIDC discovery document for clients expecting OpenID Provider metadata
  app.get('/.well-known/openid-configuration', (c) => {
    const here = new URL(c.req.url);
    const base = `${here.protocol}//${here.host}`;
    const doc = {
      issuer: base,
      authorization_endpoint: config.OAUTH_AUTHORIZATION_URL || `${base}/authorize`,
      token_endpoint: config.OAUTH_TOKEN_URL || `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: (config.OAUTH_SCOPES || '').split(' ').filter(Boolean),
      grant_types_supported: ['authorization_code', 'refresh_token'],
    } as const;
    return c.json(doc);
  });

  // AS /authorize — starts client OAuth (PKCE) and then redirects to Spotify authorize
  app.get('/authorize', (c) => {
    const incoming = new URL(c.req.url);
    const client_state = incoming.searchParams.get('state') ?? randomUUID();
    const code_challenge = incoming.searchParams.get('code_challenge');
    const code_challenge_method = incoming.searchParams.get('code_challenge_method');
    const resource = incoming.searchParams.get('resource') ?? undefined;
    const redirectUri = incoming.searchParams.get('redirect_uri') ?? '';
    // Accept sid via dedicated query param or embedded in resource URL (RS metadata trick)
    const sessionId =
      incoming.searchParams.get('sid') ??
      (() => {
        try {
          return resource
            ? (new URL(resource).searchParams.get('sid') ?? undefined)
            : undefined;
        } catch {
          return undefined;
        }
      })();

    // Accept client-provided redirect URI; we'll validate later before final AS redirect
    if (!code_challenge || code_challenge_method !== 'S256') {
      return c.json({ error: 'invalid_code_challenge' }, 400);
    }

    if (sessionId) {
      try {
        ensureSession(sessionId);
      } catch {}
    }

    logger.info('auth', {
      message: 'AS /authorize',
      sessionId,
      client_state,
      resource,
    });

    const txn: Txn = {
      id: generateOpaqueToken(),
      client_state,
      code_challenge,
      code_challenge_method: 'S256',
      resource,
      sessionId,
      client_redirect_uri: redirectUri || undefined,
      createdAt: Date.now(),
    };
    txns.set(txn.id, txn);
    logger.info('auth', {
      message: 'Created AS txn',
      txnId: txn.id,
      sessionId: txn.sessionId,
    });

    // Redirect to Spotify authorize
    const spotifyAuth = new URL('/authorize', config.SPOTIFY_ACCOUNTS_URL);
    const scopes = (config.OAUTH_SCOPES || '').split(' ').filter(Boolean).join(' ');
    spotifyAuth.searchParams.set('client_id', config.SPOTIFY_CLIENT_ID || '');
    spotifyAuth.searchParams.set('response_type', 'code');
    spotifyAuth.searchParams.set(
      'redirect_uri',
      config.REDIRECT_URI || `${new URL(c.req.url).origin}/spotify/callback`,
    );
    if (scopes) {
      spotifyAuth.searchParams.set('scope', scopes);
    }
    // Encode a composite state so callback can recover across process restarts
    const compositeState = b64urlEncodeJson({
      tid: txn.id,
      sid: txn.sessionId,
      cs: txn.client_state,
      cr: txn.client_redirect_uri,
      cc: txn.code_challenge,
      ccm: txn.code_challenge_method,
      res: txn.resource,
    });
    spotifyAuth.searchParams.set('state', compositeState || txn.id);
    // PKCE for Spotify (optional, not required if using secret); here we forward client PKCE as-is is not appropriate.
    // For simplicity, we'll use client_secret on token instead of PKCE with Spotify.

    logger.info('auth', {
      message: 'Redirecting to Spotify authorize',
      url: spotifyAuth.toString(),
    });
    return c.redirect(spotifyAuth.toString(), 302);
  });

  // Dynamic Client Registration (minimal stub)
  // Accepts JSON per RFC 7591 and returns a public client registration.
  app.post('/register', async (c) => {
    try {
      const here = new URL(c.req.url);
      const base = `${here.protocol}//${here.host}`;
      const requested = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const now = Math.floor(Date.now() / 1000);

      // Generate a public client_id; no secret (PKCE expected)
      const client_id = randomUUID();

      const resp = {
        client_id,
        client_id_issued_at: now,
        client_secret_expires_at: 0,
        token_endpoint_auth_method: 'none',
        redirect_uris: Array.isArray(requested?.redirect_uris)
          ? requested.redirect_uris
          : [config.OAUTH_REDIRECT_URI],
        registration_client_uri: `${base}/register/${client_id}`,
        registration_access_token: randomUUID(),
      };
      return c.json(resp, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // AS /token — exchanges our AS code (not Spotify) for RS tokens
  app.post('/token', async (c) => {
    const contentType = c.req.header('content-type') || '';
    const form = new URLSearchParams(
      contentType.includes('application/x-www-form-urlencoded')
        ? await c.req.text().then((t) => Object.fromEntries(new URLSearchParams(t)))
        : ((await c.req.json().catch(() => ({}))) as Record<string, string>),
    );

    const grant = form.get('grant_type');
    if (grant === 'refresh_token') {
      // RS refresh: rotate RS access, refresh Spotify if needed
      const rsRefreshToken = form.get('refresh_token') || '';
      const rec = getRecordByRsRefreshToken(rsRefreshToken);
      if (!rec) {
        return c.json({ error: 'invalid_grant' }, 400);
      }

      // If Spotify access expired, attempt refresh with Spotify
      const needsRefresh =
        !rec.spotify.expires_at || Date.now() > rec.spotify.expires_at - 30_000;
      if (needsRefresh && rec.spotify.refresh_token) {
        try {
          const tokenUrl = new URL(
            '/api/token',
            config.SPOTIFY_ACCOUNTS_URL,
          ).toString();
          const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: rec.spotify.refresh_token,
          }).toString();
          const basic = Buffer.from(
            `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`,
          ).toString('base64');
          const resp = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: `Basic ${basic}`,
            },
            body,
          });
          if (resp.ok) {
            const data = (await resp.json()) as {
              access_token?: string;
              refresh_token?: string;
              expires_in?: number | string;
              scope?: string;
            };
            const expires_at = Date.now() + Number(data.expires_in ?? 3600) * 1000;
            const refreshedSpotify = {
              access_token: String(data.access_token || rec.spotify.access_token),
              refresh_token:
                (data.refresh_token as string | undefined) ?? rec.spotify.refresh_token,
              expires_at,
              scopes: String(data.scope || (rec.spotify.scopes || []).join(' '))
                .split(' ')
                .filter(Boolean),
            } as const;
            updateSpotifyTokensByRsRefreshToken(rsRefreshToken, refreshedSpotify);
          } else {
            // invalid_grant on refresh, surface as 400 for client to re-auth
            return c.json({ error: 'invalid_grant' }, 400);
          }
        } catch (_e) {
          return c.json({ error: 'server_error' }, 500);
        }
      }

      const newAccess = generateOpaqueToken();
      const updated = updateSpotifyTokensByRsRefreshToken(
        rsRefreshToken,
        getRecordByRsRefreshToken(rsRefreshToken)?.spotify ?? rec.spotify,
        newAccess,
      );
      logger.info('auth', {
        message: 'RS refresh_token grant',
        rotated: Boolean(updated),
      });
      return c.json({
        access_token: newAccess,
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: rsRefreshToken, // keep same RS refresh (or rotate if desired)
        scope: (updated?.spotify.scopes || []).join(' '),
      });
    }

    if (grant !== 'authorization_code') {
      return c.json({ error: 'unsupported_grant_type' }, 400);
    }

    const code = form.get('code') || '';
    const code_verifier = form.get('code_verifier') || '';

    // Lookup txn by AS code
    const txn = Array.from(txns.values()).find((t) => t.as_code === code);
    if (!txn) {
      return c.json({ error: 'invalid_grant' }, 400);
    }

    // Verify PKCE
    const expected = b64url(createHash('sha256').update(code_verifier).digest());
    if (expected !== txn.code_challenge) {
      return c.json({ error: 'invalid_grant' }, 400);
    }

    // Mint RS tokens (strong opaque)
    const rsAccess = generateOpaqueToken();
    let spotifyFromSessionOrTxn: Txn['spotify'] | undefined;
    if (txn.sessionId) {
      const s = ensureSession(txn.sessionId);
      if (s.spotify?.access_token) {
        spotifyFromSessionOrTxn = {
          access_token: s.spotify.access_token,
          refresh_token: s.spotify.refresh_token,
          expires_at: s.spotify.expires_at,
          scopes: s.spotify.scopes,
        };
      }
    }
    if (!spotifyFromSessionOrTxn && txn.spotify?.access_token) {
      spotifyFromSessionOrTxn = txn.spotify;
    }
    if (!spotifyFromSessionOrTxn) {
      return c.json({ error: 'invalid_grant' }, 400);
    }

    const rec = storeRsTokenMapping(rsAccess, spotifyFromSessionOrTxn);
    logger.info('auth', { message: 'AS /token issued RS tokens' });

    // Single-use: remove txn
    txns.delete(txn.id);

    return c.json({
      access_token: rec.rs_access_token,
      refresh_token: rec.rs_refresh_token,
      token_type: 'bearer',
      expires_in: 3600,
      scope: (spotifyFromSessionOrTxn.scopes || []).join(' '),
    });
  });

  app.post('/revoke', async (c) => {
    const revocationUrl = config.OAUTH_REVOCATION_URL;
    if (!revocationUrl) {
      return c.json({ error: 'OAuth revocation endpoint not configured' }, 501);
    }
    const bodyRaw = await c.req.text().catch(() => '');
    const resp = await fetch(revocationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: bodyRaw,
    });
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: {
        'content-type': resp.headers.get('content-type') || 'application/json',
      },
    });
  });

  // Spotify callback → exchange code for tokens; issue AS code back to client
  app.get('/spotify/callback', async (c) => {
    try {
      const url = new URL(c.req.url);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) {
        return c.text('Invalid callback', 400);
      }

      // Try normal lookup by state key
      let txn = txns.get(state);
      // If not found, attempt to decode composite state and recover
      if (!txn) {
        const decoded = b64urlDecodeJson<{
          tid?: string;
          sid?: string;
          cs?: string;
          cr?: string;
          cc?: string;
          ccm?: 'S256';
          res?: string;
        }>(state);
        if (decoded?.tid) {
          txn = txns.get(decoded.tid);
          if (!txn) {
            // Synthesize a minimal txn so we can complete Spotify exchange and redirect
            txn = {
              id: decoded.tid,
              client_state: decoded.cs || randomUUID(),
              code_challenge: decoded.cc || '',
              code_challenge_method: decoded.ccm || 'S256',
              resource: decoded.res,
              sessionId: decoded.sid,
              client_redirect_uri: decoded.cr,
              createdAt: Date.now(),
            };
            txns.set(txn.id, txn);
          }
        }
      }
      if (!txn) {
        return c.text('Unknown transaction', 400);
      }

      // Exchange with Spotify
      const tokenUrl = new URL('/api/token', config.SPOTIFY_ACCOUNTS_URL).toString();
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri:
          config.REDIRECT_URI || `${new URL(c.req.url).origin}/spotify/callback`,
      }).toString();
      const basic = Buffer.from(
        `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`,
      ).toString('base64');
      const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body,
      });
      if (!resp.ok) {
        const t = await resp.text();
        return c.text(`Spotify token error: ${t}`, 500);
      }
      const data = (await resp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number | string;
        scope?: string;
      };
      const expires_at = Date.now() + Number(data.expires_in ?? 3600) * 1000;

      const existingRt = txn.sessionId
        ? ensureSession(txn.sessionId).spotify?.refresh_token
        : txn.spotify?.refresh_token;
      const mergedRefresh = (data.refresh_token as string | undefined) ?? existingRt;
      const tokenPayload = {
        access_token: data.access_token as string,
        refresh_token: mergedRefresh,
        expires_at,
        scopes: String(data.scope || '')
          .split(' ')
          .filter(Boolean),
      } as const;

      if (txn.sessionId) {
        const s = ensureSession(txn.sessionId);
        s.spotify = { ...tokenPayload };
        logger.info('auth', {
          message: 'Stored Spotify tokens for session',
          sessionId: txn.sessionId,
          scopes: s.spotify.scopes,
          expires_at,
        });
      }
      // Persist on txn for fallback mapping during /token
      txn.spotify = { ...tokenPayload };
      txns.set(state, txn);

      // Issue single-use AS code and redirect
      txn.as_code = generateOpaqueToken();
      txns.set(state, txn);
      const redirectTargetCandidate =
        txn.client_redirect_uri || config.OAUTH_REDIRECT_URI;
      const allowed = new Set(
        (config.OAUTH_REDIRECT_ALLOWLIST || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .concat([config.OAUTH_REDIRECT_URI]),
      );
      const isAllowedRedirect = (u: string) => {
        try {
          const url = new URL(u);
          // In development, allow loopback callback targets (for local bridges like mcp-remote)
          if (config.NODE_ENV === 'development') {
            const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
            if (loopbackHosts.has(url.hostname)) {
              return true;
            }
          }
          return (
            allowed.has(`${url.protocol}//${url.host}${url.pathname}`) || allowed.has(u)
          );
        } catch {
          return false;
        }
      };
      const redirectTarget = isAllowedRedirect(redirectTargetCandidate)
        ? redirectTargetCandidate
        : config.OAUTH_REDIRECT_URI;
      const redirect = new URL(redirectTarget);
      redirect.searchParams.set('code', txn.as_code);
      redirect.searchParams.set('state', txn.client_state);
      logger.info('auth', {
        message: 'Redirecting back to client',
        redirect: redirect.toString(),
        sessionId: txn.sessionId,
        txnId: txn.id,
      });
      return c.redirect(redirect.toString(), 302);
    } catch (e) {
      return c.text(`Callback error: ${(e as Error).message}`, 500);
    }
  });

  return app;
}
