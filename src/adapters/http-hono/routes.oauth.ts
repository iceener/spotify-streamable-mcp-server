// Hono adapter for OAuth routes
// Provider-agnostic version from Spotify MCP

import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import type { UnifiedConfig } from '../../shared/config/env.js';
import { handleRegister, handleRevoke } from '../../shared/oauth/endpoints.js';
import {
  handleAuthorize,
  handleProviderCallback,
  handleToken,
} from '../../shared/oauth/flow.js';
import {
  buildFlowOptions,
  buildOAuthConfig,
  buildProviderConfig,
  buildTokenInput,
  parseAuthorizeInput,
  parseCallbackInput,
  parseTokenInput,
} from '../../shared/oauth/input-parsers.js';
import type { TokenStore } from '../../shared/storage/interface.js';
import { sharedLogger as logger } from '../../shared/utils/logger.js';

export function buildOAuthRoutes(
  store: TokenStore,
  config: UnifiedConfig,
): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const providerConfig = buildProviderConfig(config);
  const oauthConfig = buildOAuthConfig(config);

  app.get('/authorize', async (c) => {
    logger.debug('oauth_hono', { message: 'Authorize request received' });

    try {
      const url = new URL(c.req.url);
      const input = parseAuthorizeInput(url);
      const options = buildFlowOptions(url, config);

      const result = await handleAuthorize(
        input,
        store,
        providerConfig,
        oauthConfig,
        options,
      );

      logger.info('oauth_hono', { message: 'Authorize redirect' });
      return c.redirect(result.redirectTo, 302);
    } catch (error) {
      logger.error('oauth_hono', {
        message: 'Authorize failed',
        error: (error as Error).message,
      });
      return c.text((error as Error).message || 'Authorization failed', 400);
    }
  });

  app.get('/oauth/callback', async (c) => {
    logger.debug('oauth_hono', { message: 'Callback request received' });

    try {
      const url = new URL(c.req.url);
      const { code, state } = parseCallbackInput(url);

      if (!code || !state) {
        return c.text('invalid_callback: missing code or state', 400);
      }

      const options = buildFlowOptions(url, config);

      const result = await handleProviderCallback(
        { providerCode: code, compositeState: state },
        store,
        providerConfig,
        oauthConfig,
        options,
      );

      logger.info('oauth_hono', { message: 'Callback success' });
      return c.redirect(result.redirectTo, 302);
    } catch (error) {
      logger.error('oauth_hono', {
        message: 'Callback failed',
        error: (error as Error).message,
      });
      return c.text((error as Error).message || 'Callback failed', 500);
    }
  });

  app.post('/token', async (c) => {
    logger.debug('oauth_hono', { message: 'Token request received' });

    try {
      const form = await parseTokenInput(c.req.raw);
      const tokenInput = buildTokenInput(form);

      if ('error' in tokenInput) {
        return c.json({ error: tokenInput.error }, 400);
      }

      // Pass providerConfig for refresh_token grant to enable provider token refresh
      const result = await handleToken(tokenInput, store, providerConfig);

      logger.info('oauth_hono', { message: 'Token exchange success' });
      return c.json(result);
    } catch (error) {
      logger.error('oauth_hono', {
        message: 'Token exchange failed',
        error: (error as Error).message,
      });
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
      const url = new URL(c.req.url);

      logger.debug('oauth_hono', { message: 'Register request' });

      const result = await handleRegister(
        {
          redirect_uris: Array.isArray(body.redirect_uris)
            ? (body.redirect_uris as string[])
            : undefined,
        },
        url.origin,
        config.OAUTH_REDIRECT_URI,
      );

      logger.info('oauth_hono', { message: 'Client registered' });
      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  return app;
}
