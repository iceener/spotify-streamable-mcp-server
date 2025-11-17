// Workers adapter for OAuth routes using itty-router

import type { Router } from 'itty-router';
import type { UnifiedConfig } from '../../shared/config/env.ts';
import { handleRegister, handleRevoke } from '../../shared/oauth/endpoints.ts';
import {
  handleAuthorize,
  handleSpotifyCallback,
  handleToken,
} from '../../shared/oauth/flow.ts';
import type { TokenStore } from '../../shared/storage/interface.ts';

function withCors(response: Response): Response {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', '*');
  return response;
}

export function attachOAuthRoutes(
  router: Router,
  store: TokenStore,
  config: UnifiedConfig,
): void {
  router.get('/authorize', async (request: Request) => {
    console.log('[WORKERS-AUTHORIZE] Hit /authorize endpoint');
    try {
      const url = new URL(request.url);
      const base = url.origin;

      const result = await handleAuthorize(
        {
          codeChallenge: url.searchParams.get('code_challenge') || '',
          codeChallengeMethod: url.searchParams.get('code_challenge_method') || '',
          redirectUri: url.searchParams.get('redirect_uri') || '',
          requestedScope: url.searchParams.get('scope') ?? undefined,
          state: url.searchParams.get('state') ?? undefined,
          sid:
            url.searchParams.get('sid') ||
            request.headers.get('Mcp-Session-Id') ||
            undefined,
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
          baseUrl: base,
          isDev: config.NODE_ENV === 'development',
        },
      );

      console.log('[WORKERS-AUTHORIZE] Redirecting to:', result.redirectTo);
      // Don't use withCors on redirects - redirect headers are immutable
      return Response.redirect(result.redirectTo, 302);
    } catch (error) {
      console.error('[WORKERS-AUTHORIZE] Error:', error);
      return withCors(
        new Response((error as Error).message || 'Authorization failed', {
          status: 400,
        }),
      );
    }
  });

  router.get('/spotify/callback', async (request: Request) => {
    console.log('[CALLBACK] Hit /spotify/callback');
    try {
      const url = new URL(request.url);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      console.log('[CALLBACK] Has code:', !!code, 'Has state:', !!state);

      if (!code || !state) {
        return withCors(new Response('invalid_callback', { status: 400 }));
      }

      const base = url.origin;

      // Debug: Check if credentials are present (don't log actual values!)
      console.log('[CALLBACK] Checking credentials...', {
        hasClientId: !!config.SPOTIFY_CLIENT_ID,
        hasClientSecret: !!config.SPOTIFY_CLIENT_SECRET,
        clientIdLength: config.SPOTIFY_CLIENT_ID?.length,
        clientSecretLength: config.SPOTIFY_CLIENT_SECRET?.length,
      });

      if (!config.SPOTIFY_CLIENT_ID || !config.SPOTIFY_CLIENT_SECRET) {
        console.error('[CALLBACK] Missing Spotify credentials!');
        return withCors(
          new Response('Server misconfigured: Missing Spotify credentials', {
            status: 500,
          }),
        );
      }

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
          baseUrl: base,
          isDev: config.NODE_ENV === 'development',
        },
      );

      console.log('[WORKERS-CALLBACK] Success! Redirecting to:', result.redirectTo);
      // Don't use withCors on redirects - redirect headers are immutable
      return Response.redirect(result.redirectTo, 302);
    } catch (error) {
      console.error('[WORKERS-CALLBACK] Error:', error);
      return withCors(
        new Response((error as Error).message || 'Callback failed', { status: 500 }),
      );
    }
  });

  router.post('/token', async (request: Request) => {
    console.log('[WORKERS-TOKEN] Hit /token endpoint');
    try {
      const contentType = request.headers.get('content-type') || '';
      let form: URLSearchParams;

      if (contentType.includes('application/x-www-form-urlencoded')) {
        const text = await request.text();
        form = new URLSearchParams(text);
      } else {
        const json = (await request.json().catch(() => ({}))) as Record<string, string>;
        form = new URLSearchParams(json);
      }

      const grant = form.get('grant_type');
      const code = form.get('code');
      console.log(
        '[WORKERS-TOKEN] Grant:',
        grant,
        'Code:',
        code?.substring(0, 10) + '...',
      );

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
        return withCors(
          new Response(JSON.stringify({ error: 'unsupported_grant_type' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }

      return withCors(
        new Response(JSON.stringify(result), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    } catch (error) {
      return withCors(
        new Response(
          JSON.stringify({ error: (error as Error).message || 'invalid_grant' }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    }
  });

  router.post('/revoke', async () => {
    const result = await handleRevoke();
    return withCors(
      new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  router.post('/register', async (request: Request) => {
    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const url = new URL(request.url);
      const base = url.origin;

      console.log('[REGISTER] Request body:', JSON.stringify(body));

      const result = await handleRegister(
        {
          redirect_uris: Array.isArray(body.redirect_uris)
            ? (body.redirect_uris as string[])
            : undefined,
          grant_types: Array.isArray(body.grant_types)
            ? (body.grant_types as string[])
            : undefined,
          response_types: Array.isArray(body.response_types)
            ? (body.response_types as string[])
            : undefined,
          client_name:
            typeof body.client_name === 'string' ? body.client_name : undefined,
        },
        base,
        config.OAUTH_REDIRECT_URI,
      );

      console.log('[REGISTER] Response:', JSON.stringify(result));

      return withCors(
        new Response(JSON.stringify(result), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    } catch (error) {
      return withCors(
        new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
  });
}
