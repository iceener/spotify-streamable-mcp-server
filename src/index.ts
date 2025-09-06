import { serve } from '@hono/node-server';
import { config } from './config/env.ts';
import { buildHttpApp } from './http/app.ts';
import { buildAuthApp } from './http/auth-app.ts';
import { logger } from './utils/logger.ts';

async function main(): Promise<void> {
  try {
    const app = buildHttpApp();
    serve({ fetch: app.fetch, port: config.PORT, hostname: '127.0.0.1' });
    // Minimal local Authorization Server for testing (runs on PORT+1)
    const authApp = buildAuthApp();
    serve({
      fetch: authApp.fetch,
      port: Number(config.PORT) + 1,
      hostname: '127.0.0.1',
    });
    await logger.info('server', {
      message: `MCP server started on http://127.0.0.1:${config.PORT}`,
      environment: config.NODE_ENV,
      authEnabled: config.AUTH_ENABLED,
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    await logger.error('server', {
      message: 'Server startup failed',
      error: (error as Error).message,
    });
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  void logger.info('server', { message: 'Received SIGINT, shutting down' });
  process.exit(0);
});

process.on('SIGTERM', () => {
  void logger.info('server', { message: 'Received SIGTERM, shutting down' });
  process.exit(0);
});

void main();
