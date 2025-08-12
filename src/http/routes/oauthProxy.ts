import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from '../../config/env.js';

export function oauthProxyRoutes() {
  const app = new Hono<{ Bindings: HttpBindings }>();

  // OAuth Proxy Endpoints (Hono-based) for interactive flows
  app.get('/authorize', (c) => {
    const authUrl = config.OAUTH_AUTHORIZATION_URL;
    if (!authUrl) {
      return c.json(
        {
          error: 'OAuth authorization endpoint not configured',
        },
        501,
      );
    }
    const incoming = new URL(c.req.url);
    const forward = new URL(authUrl);
    // Copy over all search params verbatim
    incoming.searchParams.forEach((v, k) => forward.searchParams.set(k, v));
    // If not provided by the client, default to configured OOB URI
    if (!forward.searchParams.get('redirect_uri') && config.OAUTH_REDIRECT_URI) {
      forward.searchParams.set('redirect_uri', config.OAUTH_REDIRECT_URI);
    }
    return c.redirect(forward.toString(), 302);
  });

  app.post('/token', async (c) => {
    const tokenUrl = config.OAUTH_TOKEN_URL;
    if (!tokenUrl) {
      return c.json({ error: 'OAuth token endpoint not configured' }, 501);
    }
    const contentType = c.req.header('content-type') || '';
    let bodyRaw = '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      bodyRaw = await c.req.text();
    } else if (contentType.includes('application/json')) {
      const json = (await c.req.json().catch(() => ({}))) as Record<string, string>;
      bodyRaw = new URLSearchParams(json).toString();
    } else {
      bodyRaw = await c.req.text().catch(() => '');
    }
    const resp = await fetch(tokenUrl, {
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

  return app;
}
