// Unified MCP server entry point (Node.js/Hono) using shared modules
// From Spotify MCP

import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { createMcpSecurityMiddleware } from '../adapters/http-hono/middleware.security.js';
import { buildDiscoveryRoutes } from '../adapters/http-hono/routes.discovery.js';
import { config } from '../config/env.js';
import { serverMetadata } from '../config/metadata.js';
import { buildServer } from '../core/mcp.js';
import { parseConfig } from '../shared/config/env.js';
import { createAuthHeaderMiddleware } from './middlewares/auth.js';
import { corsMiddleware } from './middlewares/cors.js';
import { healthRoutes } from './routes/health.js';
import { buildMcpRoutes } from './routes/mcp.js';

export function buildHttpApp(): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();

  // Parse unified config
  const unifiedConfig = parseConfig(process.env as Record<string, unknown>);

  // Build MCP server
  const server = buildServer({
    name: config.MCP_TITLE || serverMetadata.title,
    version: config.MCP_VERSION,
    instructions: config.MCP_INSTRUCTIONS || serverMetadata.instructions,
  });

  const transports = new Map();

  // Global middleware
  app.use('*', corsMiddleware());
  app.use('*', createAuthHeaderMiddleware());

  // Routes
  app.route('/', healthRoutes());
  app.route('/', buildDiscoveryRoutes(unifiedConfig));

  // MCP endpoint with security
  app.use('/mcp', createMcpSecurityMiddleware(unifiedConfig));
  app.route('/mcp', buildMcpRoutes({ server, transports }));

  return app;
}
