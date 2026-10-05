import type { Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Logger } from '../platform/logger';
import { CLIENT_ERRORS, errorCode, oauthError } from './errors';
import { authorize, callback, type Flow, register, token } from './flow';
import {
  boundedText,
  buildTokenInput,
  parseAuthorizeInput,
  parseCallbackInput,
  parseOAuthJson,
  parseTokenInput,
} from './input';

/** The proxy's endpoints. Their paths are public: clients and the provider call them. */
export const OAUTH_ROUTES = {
  authorize: '/authorize',
  callback: '/oauth/callback',
  token: '/token',
  register: '/register',
  revoke: '/revoke',
} as const;

/**
 * Mount the endpoints. They sit behind the platform's Host and Origin checks; an allowed
 * browser origin may read the answers. Every answer is `no-store`. Expected failures answer
 * `400 {"error": "<code>"}`; anything else answers `503 {"error": "server_error"}` and is
 * logged, so storage and provider details never reach the client.
 */
export function mountOAuthEndpoints(app: Hono, flow: Flow, logger: Logger): void {
  const readableByAllowedOrigins = cors({
    // The platform has already refused origins outside MCP_ALLOWED_ORIGIN_HOSTNAMES.
    origin: (origin) => origin,
    allowMethods: ['GET', 'POST'],
    maxAge: 600,
  });
  for (const path of Object.values(OAUTH_ROUTES)) {
    app.use(path, readableByAllowedOrigins, async (c, next) => {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      await next();
    });
  }

  const run = async (c: Context, handler: () => Promise<Response>): Promise<Response> => {
    try {
      return await handler();
    } catch (error) {
      const code = errorCode(error);
      if (CLIENT_ERRORS.has(code)) {
        return c.json({ error: code }, code === 'request_too_large' ? 413 : 400);
      }
      logger.error('OAuth request failed', { path: c.req.path, error });
      return c.json({ error: 'server_error' }, 503);
    }
  };

  app.get(OAUTH_ROUTES.authorize, (c) =>
    run(c, async () =>
      c.redirect(await authorize(parseAuthorizeInput(new URL(c.req.url)), flow), 302),
    ),
  );

  app.get(OAUTH_ROUTES.callback, (c) =>
    run(c, async () => {
      const url = new URL(c.req.url);
      const { code, state } = parseCallbackInput(url);
      if (!code || !state) return c.json({ error: 'invalid_callback' }, 400);
      if (`${url.origin}${url.pathname}` !== flow.callbackUrl) throw oauthError('invalid_callback');
      return c.redirect(await callback(code, state, flow), 302);
    }),
  );

  app.post(OAUTH_ROUTES.token, (c) =>
    run(c, async () => {
      const input = buildTokenInput(await parseTokenInput(c.req.raw));
      if ('error' in input) return c.json(input, 400);
      return c.json(await token(input, flow));
    }),
  );

  app.post(OAUTH_ROUTES.register, (c) =>
    run(c, async () =>
      c.json(await register(parseOAuthJson(await boundedText(c.req.raw)), flow), 201),
    ),
  );

  // Revocation is accepted and does nothing: tokens expire, and the provider's grant stays
  // until the user removes it at the provider. Clients call it on sign-out.
  app.post(OAUTH_ROUTES.revoke, (c) => c.json({ status: 'ok' }));
}
