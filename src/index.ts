import { serve } from '@hono/node-server';
import { config } from './config/env.js';
import { buildHttpApp } from './http/app.js';
import { buildAuthApp } from './http/auth-app.js';
import { logger } from './utils/logger.js';

async function main() {
  try {
    // Build the HTTP app(s)
    const app = buildHttpApp();
    const authApp = buildAuthApp();
    // Start the server
    const port = config.PORT;
    const host = config.HOST;

    // Main MCP server on PORT
    serve({
      fetch: app.fetch,
      port,
      hostname: host,
    });
    // Auth proxy server on PORT+1
    const authPort = Number(port) + 1;
    serve({
      fetch: authApp.fetch,
      port: authPort,
      hostname: host,
    });

    logger.info('server', {
      message: `MCP server started on http://${host}:${port} (auth on http://${host}:${authPort})`,
      environment: config.NODE_ENV,
      authEnabled: config.AUTH_ENABLED,
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    logger.error('server', {
      message: 'Server startup failed',
      error: (error as Error).message,
    });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('server', {
    message: 'Received SIGINT, shutting down gracefully',
  });
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('server', {
    message: 'Received SIGTERM, shutting down gracefully',
  });
  process.exit(0);
});

// Start the server
main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
