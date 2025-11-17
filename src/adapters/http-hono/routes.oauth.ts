// Hono adapter for OAuth routes

import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import type { UnifiedConfig } from '../../shared/config/env.ts';
import { handleRegister, handleRevoke } from '../../shared/oauth/endpoints.ts';
import {
  handleAuthorize,
  handleSpotifyCallback,
  handleToken,
} from '../../shared/oauth/flow.ts';
import type { TokenStore } from '../../shared/storage/interface.ts';

export function buildOAuthRoutes(
  store: TokenStore,
  config: UnifiedConfig,
): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();

  app.get('/authorize', async (c) => {
    try {
      const url = new URL(c.req.url);
      const here = new URL(c.req.url);
      const baseUrl = `${here.protocol}//${here.host}`;

      const result = await handleAuthorize(
        {
          codeChallenge: url.searchParams.get('code_challenge') || '',
          codeChallengeMethod: url.searchParams.get('code_challenge_method') || '',
          redirectUri: url.searchParams.get('redirect_uri') || '',
          requestedScope: url.searchParams.get('scope') ?? undefined,
          state: url.searchParams.get('state') ?? undefined,
          sid: url.searchParams.get('sid') ?? undefined,
        },
        store,
        {
          clientId: config.SPOTIFY_CLIENT_ID,
          clientSecret: config.SPOTIFY_CLIENT_SECRET,
          accountsUrl: config.SPOTIFY_ACCOUNTS_URL,
          oauthScopes: config.OAUTH_SCOPES,
        },
        {
          redirectUri: config.OAUTH_REDIRECT_URI,
          redirectAllowlist: config.OAUTH_REDIRECT_ALLOWLIST,
          redirectAllowAll: config.OAUTH_REDIRECT_ALLOW_ALL,
        },
        {
          baseUrl,
          isDev: config.NODE_ENV === 'development',
        },
      );

      return c.redirect(result.redirectTo, 302);
    } catch (error) {
      return c.text((error as Error).message || 'Authorization failed', 400);
    }
  });

  app.get('/spotify/callback', async (c) => {
    try {
      const url = new URL(c.req.url);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (!code || !state) {
        return c.text('invalid_callback', 400);
      }

      const here = new URL(c.req.url);
      const baseUrl = `${here.protocol}//${here.host}`;

      const result = await handleSpotifyCallback(
        {
          providerCode: code,
          compositeState: state,
        },
        store,
        {
          clientId: config.SPOTIFY_CLIENT_ID,
          clientSecret: config.SPOTIFY_CLIENT_SECRET,
          accountsUrl: config.SPOTIFY_ACCOUNTS_URL,
          oauthScopes: config.OAUTH_SCOPES,
        },
        {
          redirectUri: config.OAUTH_REDIRECT_URI,
          redirectAllowlist: config.OAUTH_REDIRECT_ALLOWLIST,
          redirectAllowAll: config.OAUTH_REDIRECT_ALLOW_ALL,
        },
        {
          baseUrl,
          isDev: config.NODE_ENV === 'development',
        },
      );

      console.log('[CALLBACK] Success! Redirecting to:', result.redirectTo);

      return c.redirect(result.redirectTo, 302);
    } catch (error) {
      console.error('[CALLBACK] Error:', error);
      return c.text((error as Error).message || 'Callback failed', 500);
    }
  });

  app.post('/token', async (c) => {
    console.log('[TOKEN] Hit /token endpoint');
    try {
      const contentType = c.req.header('content-type') || '';
      const form = new URLSearchParams(
        contentType.includes('application/x-www-form-urlencoded')
          ? await c.req.text().then((t) => Object.fromEntries(new URLSearchParams(t)))
          : ((await c.req.json().catch(() => ({}))) as Record<string, string>),
      );

      const grant = form.get('grant_type');
      console.log('[TOKEN] Grant type:', grant);

      let result;
      if (grant === 'refresh_token') {
        result = await handleToken(
          {
            grant: 'refresh_token',
            refreshToken: form.get('refresh_token') || '',
          },
          store,
        );
      } else if (grant === 'authorization_code') {
        result = await handleToken(
          {
            grant: 'authorization_code',
            code: form.get('code') || '',
            codeVerifier: form.get('code_verifier') || '',
          },
          store,
        );
      } else {
        return c.json({ error: 'unsupported_grant_type' }, 400);
      }

      return c.json(result);
    } catch (error) {
      return c.json({ error: (error as Error).message || 'invalid_grant' }, 400);
    }
  });

  app.post('/revoke', async (c) => {
    const result = await handleRevoke();
    return c.json(result);
  });

  app.post('/register', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const here = new URL(c.req.url);
      const baseUrl = `${here.protocol}//${here.host}`;

      const result = await handleRegister(
        {
          redirect_uris: Array.isArray(body.redirect_uris)
            ? (body.redirect_uris as string[])
            : undefined,
        },
        baseUrl,
        config.OAUTH_REDIRECT_URI,
      );

      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  return app;
}
