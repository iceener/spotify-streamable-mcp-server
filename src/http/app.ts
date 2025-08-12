import type { HttpBindings } from '@hono/node-server';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Hono } from 'hono';
import { config } from '../config/env.js';
import { serverMetadata } from '../config/metadata.js';
import { buildServer } from '../core/mcp.js';
import { corsMiddleware } from './middlewares/cors.js';
import { createMcpSecurityMiddleware } from './middlewares/mcp-security.js';
import { discoveryRoutes } from './routes/discovery.js';
import { healthRoutes } from './routes/health.js';
import { buildMcpRoutes } from './routes/mcp.js';
import { oauthProxyRoutes } from './routes/oauthProxy.js';

export function buildHttpApp(): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  // Single MCP server instance for all transports
  const server = buildServer({
    name: config.MCP_TITLE || serverMetadata.title,
    instructions: config.MCP_INSTRUCTIONS || serverMetadata.instructions,
    version: config.MCP_VERSION,
  });
  // Session transport store
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // Global CORS
  app.use('*', corsMiddleware());
  // Health
  app.route('/', healthRoutes());
  // OAuth proxy
  app.route('/', oauthProxyRoutes());
  // Discovery
  app.route('/', discoveryRoutes());
  // MCP security middleware
  app.use('/mcp', createMcpSecurityMiddleware());
  // MCP REST-like endpoints
  app.route('/mcp', buildMcpRoutes({ server, transports }));

  return app;
}
