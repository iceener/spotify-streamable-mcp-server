import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from '../config/env.ts';
import { serverMetadata } from '../config/metadata.ts';
import { buildServer } from '../core/mcp.ts';
import { createAuthHeaderMiddleware } from './middlewares/auth.ts';
import { corsMiddleware } from './middlewares/cors.ts';
import { createMcpSecurityMiddleware } from './middlewares/mcp-security.ts';
import { discoveryRoutes } from './routes/discovery.ts';
import { healthRoutes } from './routes/health.ts';
import { buildMcpRoutes } from './routes/mcp.ts';

export function buildHttpApp(): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const server = buildServer({
    name: config.MCP_TITLE || serverMetadata.title,
    version: config.MCP_VERSION,
    instructions: config.MCP_INSTRUCTIONS || serverMetadata.instructions,
  });
  const transports = new Map();
  app.use('*', corsMiddleware());
  app.use('*', createAuthHeaderMiddleware());
  app.route('/', healthRoutes());
  app.route('/', discoveryRoutes());
  app.use('/mcp', createMcpSecurityMiddleware());
  app.route('/mcp', buildMcpRoutes({ server, transports }));
  return app;
}
