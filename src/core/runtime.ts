import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { UnifiedConfig } from '../shared/config/env.js';
import { sharedLogger as logger } from '../shared/utils/logger.js';
import { createMcpServer, type McpServerDependencies } from './mcp.js';

export type McpRuntime = McpHttpHandler;

/**
 * Create one deployment/isolate-scoped fetch handler. Its factory builds a
 * fresh McpServer for every modern or stateless-legacy HTTP request.
 */
export function createMcpRuntime(
  config: UnifiedConfig,
  dependencies: McpServerDependencies,
): McpRuntime {
  return createMcpHandler((context) => createMcpServer(config, context, dependencies), {
    legacy: config.MCP_LEGACY_MODE,
    responseMode: 'auto',
    onerror(error) {
      logger.error('mcp', {
        message: 'MCP request failed',
        error: error.message,
      });
    },
  });
}
