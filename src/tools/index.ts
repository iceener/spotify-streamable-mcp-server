/**
 * Tool registration for Spotify MCP (Node.js runtime).
 * Combines shared tools (cross-runtime) with any Node-specific tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { contextRegistry } from '../core/context.js';
import { sharedTools, type ToolContext } from '../shared/tools/registry.js';
import type { RequestContext } from '../types/context.js';
import { createCancellationToken } from '../utils/cancellation.js';
import { logger } from '../utils/logger.js';

/**
 * Register all tools with the MCP server.
 * Combines shared tools (cross-runtime) with Node-specific tools.
 */
export function registerTools(server: McpServer): void {
  const registeredNames: string[] = [];

  // Register shared tools (work in both Node and Workers)
  for (const tool of sharedTools) {
    try {
      const wrappedHandler = createWrappedHandler(server, tool.handler);

      // Shared tools use Zod schemas - pass .shape for SDK compatibility
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema.shape,
          ...(tool.outputSchema && { outputSchema: tool.outputSchema }),
          ...(tool.annotations && { annotations: tool.annotations }),
        },
        wrappedHandler as Parameters<typeof server.registerTool>[2],
      );

      registeredNames.push(tool.name);
      logger.debug('tools', { message: 'Registered shared tool', toolName: tool.name });
    } catch (error) {
      logger.error('tools', {
        message: 'Failed to register shared tool',
        toolName: tool.name,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  logger.info('tools', {
    message: `Registered ${registeredNames.length} tools`,
    toolNames: registeredNames,
    sharedCount: sharedTools.length,
  });
}

/**
 * Create a wrapped handler for shared tools.
 * Adapts the shared ToolContext to the SDK's RequestHandlerExtra.
 */
function createWrappedHandler(
  _server: McpServer,
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
) {
  return async (
    args: Record<string, unknown>,
    extra?: {
      requestId?: string | number;
      _meta?: { progressToken?: string | number };
      signal?: AbortSignal;
    },
  ) => {
    const requestId = extra?.requestId;

    // Look up auth context from registry (stored by MCP routes with auth info)
    const existingContext = requestId ? contextRegistry.get(requestId) : undefined;

    // Build shared ToolContext
    const context: ToolContext = {
      sessionId: String(requestId || crypto.randomUUID()),
      signal: extra?.signal,
      meta: {
        progressToken: extra?._meta?.progressToken,
        requestId: requestId ? String(requestId) : undefined,
      },
      // Auth from context registry
      authStrategy: existingContext?.authStrategy,
      providerToken: existingContext?.providerToken,
      provider: existingContext?.provider
        ? {
            accessToken: existingContext.provider.access_token,
            refreshToken: existingContext.provider.refresh_token,
            expiresAt: existingContext.provider.expires_at,
            scopes: existingContext.provider.scopes,
          }
        : undefined,
      resolvedHeaders: existingContext?.resolvedHeaders,
      authHeaders: existingContext?.authHeaders as Record<string, string> | undefined,
    };

    try {
      const result = await handler(args, context);
      return result;
    } finally {
      if (requestId) {
        contextRegistry.delete(requestId);
      }
    }
  };
}

/**
 * Create a wrapped handler for legacy Node-specific tools.
 * @deprecated Kept for potential future use with Node-specific tools
 */
function _createLegacyWrappedHandler(
  server: McpServer,
  handler: (args: unknown, context?: RequestContext) => Promise<unknown>,
) {
  return async (
    args: unknown,
    extra?: { requestId?: string | number; signal?: AbortSignal },
  ) => {
    const requestId = extra?.requestId;

    let context: RequestContext & { _server?: McpServer };
    if (requestId) {
      const existingContext = contextRegistry.get(requestId);
      if (existingContext) {
        context = { ...existingContext, _server: server };
      } else {
        context = { ...contextRegistry.create(requestId), _server: server };
      }
    } else {
      context = {
        cancellationToken: createCancellationToken(),
        timestamp: Date.now(),
        _server: server,
      };
    }

    try {
      const result = await handler(args, context);
      return result;
    } finally {
      if (requestId) {
        contextRegistry.delete(requestId);
      }
    }
  };
}
