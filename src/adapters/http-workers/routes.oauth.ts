// Workers adapter for OAuth routes using itty-router
// Provider-agnostic version from Spotify MCP

// itty-router types are complex; use generic interface
interface IttyRouter {
  get(path: string, handler: (request: Request) => Promise<Response>): void;
  post(path: string, handler: (request: Request) => Promise<Response>): void;
}

import type { UnifiedConfig } from '../../shared/config/env.js';
import {
  jsonResponse,
  oauthError,
  redirectResponse,
  textError,
} from '../../shared/http/response.js';
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

export function attachOAuthRoutes(
  router: IttyRouter,
  store: TokenStore,
  config: UnifiedConfig,
): void {
  const providerConfig = buildProviderConfig(config);
  const oauthConfig = buildOAuthConfig(config);

  router.get('/authorize', async (request: Request) => {
    logger.debug('oauth_workers', { message: 'Authorize request received' });

    try {
      const url = new URL(request.url);
      const sessionId = request.headers.get('Mcp-Session-Id') ?? undefined;
      const input = parseAuthorizeInput(url, sessionId);
      const options = buildFlowOptions(url, config);

      const result = await handleAuthorize(
        input,
        store,
        providerConfig,
        oauthConfig,
        options,
      );

      logger.info('oauth_workers', {
        message: 'Authorize redirect',
        url: result.redirectTo,
      });
      return redirectResponse(result.redirectTo);
    } catch (error) {
      logger.error('oauth_workers', {
        message: 'Authorize failed',
        error: (error as Error).message,
      });
      return textError((error as Error).message || 'Authorization failed');
    }
  });

  router.get('/oauth/callback', async (request: Request) => {
    logger.debug('oauth_workers', { message: 'Callback request received' });

    try {
      const url = new URL(request.url);
      const { code, state } = parseCallbackInput(url);

      if (!code || !state) {
        return textError('invalid_callback: missing code or state');
      }

      if (!config.PROVIDER_CLIENT_ID || !config.PROVIDER_CLIENT_SECRET) {
        logger.error('oauth_workers', { message: 'Missing provider credentials' });
        return textError('Server misconfigured: Missing provider credentials', {
          status: 500,
        });
      }

      const options = buildFlowOptions(url, config);

      const result = await handleProviderCallback(
        { providerCode: code, compositeState: state },
        store,
        providerConfig,
        oauthConfig,
        options,
      );

      logger.info('oauth_workers', { message: 'Callback success' });
      return redirectResponse(result.redirectTo);
    } catch (error) {
      logger.error('oauth_workers', {
        message: 'Callback failed',
        error: (error as Error).message,
      });
      return textError((error as Error).message || 'Callback failed', { status: 500 });
    }
  });

  router.post('/token', async (request: Request) => {
    logger.debug('oauth_workers', { message: 'Token request received' });

    try {
      const form = await parseTokenInput(request);
      const tokenInput = buildTokenInput(form);

      if ('error' in tokenInput) {
        return oauthError(tokenInput.error);
      }

      // Pass providerConfig for refresh_token grant to enable provider token refresh
      const result = await handleToken(tokenInput, store, providerConfig);

      logger.info('oauth_workers', { message: 'Token exchange success' });
      return jsonResponse(result);
    } catch (error) {
      logger.error('oauth_workers', {
        message: 'Token exchange failed',
        error: (error as Error).message,
      });
      return oauthError((error as Error).message || 'invalid_grant');
    }
  });

  router.post('/revoke', async () => {
    const result = await handleRevoke();
    return jsonResponse(result);
  });

  router.post('/register', async (request: Request) => {
    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const url = new URL(request.url);

      logger.debug('oauth_workers', { message: 'Register request' });

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
        url.origin,
        config.OAUTH_REDIRECT_URI,
      );

      logger.info('oauth_workers', { message: 'Client registered' });
      return jsonResponse(result, { status: 201 });
    } catch (error) {
      return oauthError((error as Error).message);
    }
  });
}
