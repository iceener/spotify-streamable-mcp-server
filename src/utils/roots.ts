/**
 * Roots utilities for server→client requests.
 *
 * ⚠️ NODE.JS ONLY - These utilities require SDK bidirectional support
 * (server.request()) which is not available in the Cloudflare Workers runtime.
 * The Workers dispatcher does not support server→client requests.
 *
 * Per MCP spec (review finding #2):
 * - Roots is a CLIENT capability
 * - Servers send roots/list requests TO clients
 * - Clients respond with filesystem locations they have access to
 * - This enables file-based tools to know allowed paths
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from './logger.js';

/**
 * A root directory or file that the client has access to.
 * Per spec: URI MUST start with "file://"
 */
export interface Root {
  /** The URI identifying the root. MUST start with "file://" */
  uri: string;
  /** Optional display name for the root */
  name?: string;
  /** Extension metadata */
  _meta?: Record<string, unknown>;
}

/**
 * Result from roots/list request.
 */
export interface ListRootsResult {
  roots: Root[];
}

/**
 * Request the list of roots from the client.
 *
 * @param server - The MCP server instance
 * @returns Array of Root objects representing accessible filesystem locations
 * @throws Error if client doesn't support roots capability
 *
 * @example
 * ```typescript
 * const roots = await requestRoots(server);
 * for (const root of roots) {
 *   console.log(`Root: ${root.name ?? root.uri}`);
 * }
 * ```
 */
export async function requestRoots(server: McpServer): Promise<Root[]> {
  logger.debug('roots', {
    message: 'Requesting roots from client',
  });

  try {
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const lowLevel = (server as any).server ?? server;

    if (!lowLevel.request) {
      throw new Error('Roots not supported: Server does not support client requests');
    }

    // Check client capability before requesting
    const clientCapabilities = lowLevel.getClientCapabilities?.() ?? {};
    if (!clientCapabilities.roots) {
      throw new Error(
        'Client does not support roots capability. ' +
          'Client must declare "roots" capability to list filesystem roots.',
      );
    }

    const response = await lowLevel.request(
      { method: 'roots/list' },
      // Schema for validation (simplified)
      { parse: (r: unknown) => r as ListRootsResult },
    );

    logger.info('roots', {
      message: 'Received roots from client',
      rootCount: response.roots.length,
    });

    return response.roots;
  } catch (error) {
    logger.error('roots', {
      message: 'Roots request failed',
      error: (error as Error).message,
    });

    // Check if client doesn't support roots
    // biome-ignore lint/suspicious/noExplicitAny: checking JSON-RPC error code
    if ((error as any).code === -32601) {
      throw new Error(
        'Roots not supported by client. Client must declare "roots" capability.',
      );
    }

    throw error;
  }
}

/**
 * Check if the client supports roots.
 *
 * @param server - The MCP server instance
 * @returns true if client declared roots capability
 */
export function clientSupportsRoots(server: McpServer): boolean {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const lowLevel = (server as any).server ?? server;
    const clientCapabilities = lowLevel.getClientCapabilities?.() ?? {};
    return Boolean(clientCapabilities.roots);
  } catch {
    return false;
  }
}

/**
 * Check if the client supports roots list change notifications.
 *
 * @param server - The MCP server instance
 * @returns true if client declared roots.listChanged capability
 */
export function clientSupportsRootsListChanged(server: McpServer): boolean {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const lowLevel = (server as any).server ?? server;
    const clientCapabilities = lowLevel.getClientCapabilities?.() ?? {};
    return Boolean(clientCapabilities.roots?.listChanged);
  } catch {
    return false;
  }
}
