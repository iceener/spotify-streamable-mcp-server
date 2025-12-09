/**
 * Shared MCP JSON-RPC dispatcher.
 * Used by both Node.js (via SDK wrapper) and Cloudflare Workers (directly).
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import { serverMetadata } from '../../config/metadata.js';
import { buildCapabilities } from '../../core/capabilities.js';
import { executeSharedTool, sharedTools } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import { sharedLogger as logger } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export const LATEST_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07', // Added for backwards compatibility per MCP spec
];

/** JSON-RPC error codes */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** MCP server configuration */
export interface McpServerConfig {
  title: string;
  version: string;
  instructions?: string;
}

/** Session state for MCP connections */
export interface McpSessionState {
  initialized: boolean;
  clientInfo?: { name: string; version: string };
  protocolVersion?: string;
}

/** Cancellation controller registry for in-flight requests */
export type CancellationRegistry = Map<string | number, AbortController>;

/** Context for MCP request handling */
export interface McpDispatchContext {
  sessionId: string;
  auth: ToolContext;
  config: McpServerConfig;
  getSessionState: () => McpSessionState | undefined;
  setSessionState: (state: McpSessionState) => void;
  /** Registry for tracking in-flight requests that can be cancelled */
  cancellationRegistry?: CancellationRegistry;
}

/** JSON-RPC response */
export interface JsonRpcResult {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─────────────────────────────────────────────────────────────────────────────
// Method Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleInitialize(
  params: Record<string, unknown> | undefined,
  ctx: McpDispatchContext,
): Promise<JsonRpcResult> {
  const clientInfo = params?.clientInfo as
    | { name: string; version: string }
    | undefined;
  const requestedVersion = String(params?.protocolVersion || LATEST_PROTOCOL_VERSION);

  // Negotiate protocol version
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
    ? requestedVersion
    : LATEST_PROTOCOL_VERSION;

  // Store session state
  ctx.setSessionState({
    initialized: false,
    clientInfo,
    protocolVersion,
  });

  logger.info('mcp_dispatch', {
    message: 'Initialize request',
    sessionId: ctx.sessionId,
    clientInfo,
    requestedVersion,
    negotiatedVersion: protocolVersion,
  });

  return {
    result: {
      protocolVersion,
      capabilities: buildCapabilities(),
      serverInfo: {
        name: ctx.config.title || serverMetadata.title,
        version: ctx.config.version || '1.0.0',
      },
      instructions: ctx.config.instructions || serverMetadata.instructions,
    },
  };
}

async function handleToolsList(): Promise<JsonRpcResult> {
  const tools = sharedTools.map((tool) => {
    // Convert outputSchema (ZodRawShape) to proper JSON Schema with type: "object"
    let outputSchema: Record<string, unknown> | undefined;
    if (tool.outputSchema) {
      // The outputSchema is a ZodRawShape (just properties), wrap it in an object schema
      const properties: Record<string, unknown> = {};
      for (const [key, zodType] of Object.entries(tool.outputSchema)) {
        properties[key] = zodToJsonSchema(zodType as Parameters<typeof zodToJsonSchema>[0]);
      }
      outputSchema = {
        type: 'object',
        properties,
      };
    }

    return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
      ...(outputSchema && { outputSchema }),
    ...(tool.annotations && { annotations: tool.annotations }),
    };
  });

  return { result: { tools } };
}

async function handleToolsCall(
  params: Record<string, unknown> | undefined,
  ctx: McpDispatchContext,
  requestId?: string | number,
): Promise<JsonRpcResult> {
  const toolName = String(params?.name || '');
  const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
  const meta = params?._meta as { progressToken?: string | number } | undefined;

  // Create abort controller for this request (enables cancellation)
  const abortController = new AbortController();
  if (requestId !== undefined && ctx.cancellationRegistry) {
    ctx.cancellationRegistry.set(requestId, abortController);
  }

  // Build tool context with abort signal
  const toolContext: ToolContext = {
    ...ctx.auth,
    sessionId: ctx.sessionId,
    signal: abortController.signal,
    meta: {
      progressToken: meta?.progressToken,
      requestId: requestId !== undefined ? String(requestId) : undefined,
    },
  };

  logger.debug('mcp_dispatch', {
    message: 'Calling tool',
    tool: toolName,
    sessionId: ctx.sessionId,
    requestId,
    hasProviderToken: Boolean(ctx.auth.providerToken),
  });

  try {
    const result = await executeSharedTool(toolName, toolArgs, toolContext);
    return { result };
  } catch (error) {
    // Check if this was a cancellation
    if (abortController.signal.aborted) {
      logger.info('mcp_dispatch', {
        message: 'Tool execution cancelled',
        tool: toolName,
        requestId,
      });
      return {
        error: {
          code: JsonRpcErrorCode.InternalError,
          message: 'Request was cancelled',
        },
      };
    }

    logger.error('mcp_dispatch', {
      message: 'Tool execution failed',
      tool: toolName,
      error: (error as Error).message,
    });
    return {
      error: {
        code: JsonRpcErrorCode.InternalError,
        message: `Tool execution failed: ${(error as Error).message}`,
      },
    };
  } finally {
    // Clean up cancellation registry
    if (requestId !== undefined && ctx.cancellationRegistry) {
      ctx.cancellationRegistry.delete(requestId);
    }
  }
}

async function handleResourcesList(): Promise<JsonRpcResult> {
  // Resources are registered via SDK in Node.js
  // Workers template doesn't have resources yet
  return { result: { resources: [] } };
}

async function handleResourcesTemplatesList(): Promise<JsonRpcResult> {
  return { result: { resourceTemplates: [] } };
}

async function handlePromptsList(): Promise<JsonRpcResult> {
  // Prompts are registered via SDK in Node.js
  // Workers template doesn't have prompts yet
  return { result: { prompts: [] } };
}

async function handlePing(): Promise<JsonRpcResult> {
  return { result: {} };
}

/** Current log level (can be changed via logging/setLevel) */
let currentLogLevel:
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency' = 'info';

async function handleLoggingSetLevel(
  params: Record<string, unknown> | undefined,
): Promise<JsonRpcResult> {
  const level = params?.level as string | undefined;

  const validLevels = [
    'debug',
    'info',
    'notice',
    'warning',
    'error',
    'critical',
    'alert',
    'emergency',
  ];

  if (!level || !validLevels.includes(level)) {
    return {
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        message: `Invalid log level. Must be one of: ${validLevels.join(', ')}`,
      },
    };
  }

  currentLogLevel = level as typeof currentLogLevel;

  logger.info('mcp_dispatch', {
    message: 'Log level changed',
    level: currentLogLevel,
  });

  return { result: {} };
}

/**
 * Get the current log level set by the client.
 */
export function getLogLevel(): string {
  return currentLogLevel;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch an MCP JSON-RPC method.
 *
 * @param method - The JSON-RPC method name
 * @param params - The method parameters
 * @param ctx - Dispatch context with session and auth info
 * @param requestId - Optional request ID for cancellation tracking
 * @returns JSON-RPC result or error
 */
export async function dispatchMcpMethod(
  method: string | undefined,
  params: Record<string, unknown> | undefined,
  ctx: McpDispatchContext,
  requestId?: string | number,
): Promise<JsonRpcResult> {
  if (!method) {
    return {
      error: { code: JsonRpcErrorCode.InvalidRequest, message: 'Missing method' },
    };
  }

  switch (method) {
    case 'initialize':
      return handleInitialize(params, ctx);

    case 'tools/list':
      return handleToolsList();

    case 'tools/call':
      return handleToolsCall(params, ctx, requestId);

    case 'resources/list':
      return handleResourcesList();

    case 'resources/templates/list':
      return handleResourcesTemplatesList();

    case 'prompts/list':
      return handlePromptsList();

    case 'ping':
      return handlePing();

    case 'logging/setLevel':
      return handleLoggingSetLevel(params);

    default:
      logger.debug('mcp_dispatch', { message: 'Unknown method', method });
      return {
        error: {
          code: JsonRpcErrorCode.MethodNotFound,
          message: `Method not found: ${method}`,
        },
      };
  }
}

/** Parameters for notifications/cancelled */
export interface CancelledNotificationParams {
  requestId: string | number;
  reason?: string;
}

/**
 * Handle MCP notification (no response expected).
 *
 * @param method - The notification method name
 * @param params - Notification parameters
 * @param ctx - Dispatch context
 * @returns true if handled, false if unknown
 */
export function handleMcpNotification(
  method: string,
  params: Record<string, unknown> | undefined,
  ctx: McpDispatchContext,
): boolean {
  if (method === 'notifications/initialized') {
    const session = ctx.getSessionState();
    if (session) {
      ctx.setSessionState({ ...session, initialized: true });
    }
    logger.info('mcp_dispatch', {
      message: 'Client initialized',
      sessionId: ctx.sessionId,
    });
    return true;
  }

  if (method === 'notifications/cancelled') {
    const cancelParams = params as CancelledNotificationParams | undefined;
    const requestId = cancelParams?.requestId;

    if (requestId !== undefined && ctx.cancellationRegistry) {
      const controller = ctx.cancellationRegistry.get(requestId);
      if (controller) {
        logger.info('mcp_dispatch', {
          message: 'Cancelling request',
          requestId,
          reason: cancelParams?.reason,
          sessionId: ctx.sessionId,
        });
        controller.abort(cancelParams?.reason ?? 'Client requested cancellation');
        return true;
      }
      logger.debug('mcp_dispatch', {
        message: 'Cancellation request for unknown requestId',
        requestId,
        sessionId: ctx.sessionId,
      });
    }
    return true; // Always acknowledge cancellation notifications
  }

  logger.debug('mcp_dispatch', {
    message: 'Unhandled notification',
    method,
    sessionId: ctx.sessionId,
  });
  return false;
}
