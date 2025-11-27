// Health check route
// From Spotify MCP

import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';

export function healthRoutes() {
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      transport: 'streamable-http',
      endpoints: { mcp: '/mcp', health: '/health' },
    });
  });
  return app;
}
