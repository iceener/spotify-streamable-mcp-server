/**
 * Sampling utilities for servers to request LLM completions from clients.
 *
 * ⚠️ NODE.JS ONLY - These utilities require SDK bidirectional support
 * (server.request()) which is not available in the Cloudflare Workers runtime.
 * The Workers dispatcher does not support server→client requests.
 *
 * Per MCP spec:
 * - Sampling is a CLIENT capability
 * - Servers send sampling/createMessage requests TO clients
 * - Clients handle the actual LLM interaction
 * - This enables agentic behaviors in server tools
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from './logger.js';

/**
 * Message content types for sampling requests.
 */
export type SamplingContent =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      data: string;
      mimeType: string;
    }
  | {
      type: 'audio';
      data: string;
      mimeType: string;
    };

/**
 * Sampling message with role and content.
 */
export interface SamplingMessage {
  role: 'user' | 'assistant';
  content: SamplingContent;
}

/**
 * Model preferences for sampling requests.
 */
export interface ModelPreferences {
  /** Model name hints (evaluated in order) */
  hints?: Array<{ name: string }>;
  /** Cost priority (0-1, higher = prefer cheaper models) */
  costPriority?: number;
  /** Speed priority (0-1, higher = prefer faster models) */
  speedPriority?: number;
  /** Intelligence priority (0-1, higher = prefer more capable models) */
  intelligencePriority?: number;
}

/**
 * Tool choice mode for sampling requests.
 */
export interface ToolChoice {
  /** 'auto' | 'required' | 'none' */
  mode: 'auto' | 'required' | 'none';
}

/**
 * Tool definition for sampling requests.
 */
export interface SamplingTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Sampling request parameters.
 */
export interface CreateMessageRequest {
  messages: SamplingMessage[];
  /** REQUIRED: Maximum tokens to generate (prevents runaway completions) */
  maxTokens: number;
  modelPreferences?: ModelPreferences;
  systemPrompt?: string;
  temperature?: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
  /** Tools available for the LLM to use. Requires client sampling.tools capability. */
  tools?: SamplingTool[];
  /** Control tool usage. Can be specified without tools array to control built-in tools. */
  toolChoice?: ToolChoice;
}

/**
 * Sampling response from client.
 */
export interface CreateMessageResponse {
  role: 'assistant';
  content: SamplingContent;
  model: string;
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens';
}

/**
 * Request LLM sampling from the client.
 *
 * This allows servers to implement agentic behaviors by asking the client
 * to call an LLM on their behalf.
 *
 * @param server - The MCP server instance
 * @param request - Sampling request parameters
 * @returns The LLM response from the client
 *
 * @example
 * ```typescript
 * const response = await requestSampling(server, {
 *   messages: [
 *     {
 *       role: 'user',
 *       content: { type: 'text', text: 'What is the capital of France?' }
 *     }
 *   ],
 *   modelPreferences: {
 *     hints: [{ name: 'claude-3-sonnet' }],
 *     intelligencePriority: 0.8,
 *     speedPriority: 0.5
 *   },
 *   maxTokens: 100
 * });
 *
 * console.log(response.content.text); // "The capital of France is Paris."
 * ```
 */
export async function requestSampling(
  server: McpServer,
  request: CreateMessageRequest,
): Promise<CreateMessageResponse> {
  logger.debug('sampling', {
    message: 'Requesting LLM sampling from client',
    messageCount: request.messages.length,
    modelHints: request.modelPreferences?.hints?.map((h) => h.name),
    hasTools: !!request.tools,
    hasToolChoice: !!request.toolChoice,
  });

  try {
    // Access the underlying server to send client requests
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const lowLevel = (server as any).server ?? server;

    if (!lowLevel.request) {
      throw new Error(
        'Sampling not supported: Server does not support client requests',
      );
    }

    // Check for tools capability if tools or toolChoice are specified
    // Per review finding #6: toolChoice CAN be specified without tools array
    if (request.tools || request.toolChoice) {
      const clientCapabilities = lowLevel.getClientCapabilities?.() ?? {};
      if (!clientCapabilities.sampling?.tools) {
        throw new Error(
          'Client does not support sampling tools capability. ' +
            'Client must declare "sampling.tools" to use tools or toolChoice.',
        );
      }
    }

    // Send sampling/createMessage request to client
    const response = (await lowLevel.request(
      {
        method: 'sampling/createMessage',
        params: {
          messages: request.messages,
          maxTokens: request.maxTokens,
          modelPreferences: request.modelPreferences,
          systemPrompt: request.systemPrompt,
          temperature: request.temperature,
          stopSequences: request.stopSequences,
          metadata: request.metadata,
          tools: request.tools,
          toolChoice: request.toolChoice,
        },
      },
      // Schema for validation (SDK requires a Zod schema or compatible object)
      { parse: (r: unknown) => r as CreateMessageResponse },
    )) as CreateMessageResponse;

    logger.info('sampling', {
      message: 'Received LLM response from client',
      model: response.model,
      stopReason: response.stopReason,
    });

    return response;
  } catch (error) {
    logger.error('sampling', {
      message: 'Sampling request failed',
      error: (error as Error).message,
    });

    // Check if client doesn't support sampling
    // biome-ignore lint/suspicious/noExplicitAny: checking JSON-RPC error code
    if ((error as any).code === -32601) {
      throw new Error(
        'Sampling not supported by client. Client must declare "sampling" capability.',
      );
    }

    throw error;
  }
}

/**
 * Check if the client supports sampling.
 *
 * @param server - The MCP server instance
 * @returns true if client declared sampling capability
 */
export function clientSupportsSampling(server: McpServer): boolean {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const lowLevel = (server as any).server ?? server;
    const clientCapabilities = lowLevel.getClientCapabilities?.() ?? {};
    return Boolean(clientCapabilities.sampling);
  } catch {
    return false;
  }
}

/**
 * Check if the client supports sampling with tools.
 *
 * @param server - The MCP server instance
 * @returns true if client declared sampling.tools capability
 */
export function clientSupportsSamplingTools(server: McpServer): boolean {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const lowLevel = (server as any).server ?? server;
    const clientCapabilities = lowLevel.getClientCapabilities?.() ?? {};
    return Boolean(clientCapabilities.sampling?.tools);
  } catch {
    return false;
  }
}

/**
 * Simple helper for text-only sampling requests.
 *
 * @param server - The MCP server instance
 * @param prompt - User prompt text
 * @param maxTokens - Maximum tokens to generate (REQUIRED per spec)
 * @param options - Optional additional sampling parameters
 * @returns The text response from the LLM
 *
 * @example
 * ```typescript
 * const answer = await requestTextCompletion(server, 'What is 2+2?', 50, {
 *   modelPreferences: { hints: [{ name: 'claude' }] }
 * });
 * console.log(answer); // "2+2 equals 4."
 * ```
 */
export async function requestTextCompletion(
  server: McpServer,
  prompt: string,
  maxTokens: number,
  options?: Omit<CreateMessageRequest, 'messages' | 'maxTokens'>,
): Promise<string> {
  const response = await requestSampling(server, {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: prompt,
        },
      },
    ],
    maxTokens,
    ...options,
  });

  if (response.content.type !== 'text') {
    throw new Error(`Expected text response but got ${response.content.type}`);
  }

  return response.content.text;
}
