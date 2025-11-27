/**
 * Shared tool types for cross-runtime compatibility.
 * These definitions work in both Node.js (Hono) and Cloudflare Workers.
 *
 * Uses Zod for schema validation (works in both runtimes).
 */

import type { ZodObject, ZodRawShape, z } from 'zod';

/**
 * Auth strategy types.
 */
export type AuthStrategy = 'oauth' | 'bearer' | 'api_key' | 'custom' | 'none';

/**
 * Context passed to every tool handler.
 * Provides access to auth, session, and cancellation.
 */
export interface ToolContext {
  /** Current MCP session ID */
  sessionId: string;
  /** Abort signal for cancellation support */
  signal?: AbortSignal;
  /** Request metadata from MCP */
  meta?: {
    progressToken?: string | number;
    requestId?: string;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Authentication
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Active auth strategy.
   * - 'oauth': Full OAuth flow with RS token mapping
   * - 'bearer': Static bearer token from BEARER_TOKEN env
   * - 'api_key': Static API key from API_KEY env
   * - 'custom': Custom headers from CUSTOM_HEADERS env
   * - 'none': No authentication
   */
  authStrategy?: AuthStrategy;

  /**
   * Provider access token (e.g., Google, Spotify, GitHub token).
   * Use this to call external APIs on behalf of the user.
   *
   * For OAuth: the mapped provider token
   * For Bearer: the BEARER_TOKEN value
   * For API Key: the API_KEY value
   *
   * @example
   * ```typescript
   * const response = await fetch('https://api.example.com/data', {
   *   headers: { Authorization: `Bearer ${context.providerToken}` }
   * });
   * ```
   */
  providerToken?: string;

  /**
   * Provider information (OAuth only).
   */
  provider?: {
    /** Access token (same as providerToken) */
    accessToken: string;
    /** Refresh token (if available) */
    refreshToken?: string;
    /** Token expiry timestamp (ms) */
    expiresAt?: number;
    /** Granted scopes */
    scopes?: string[];
  };

  /**
   * Resolved headers ready for API calls.
   * This includes the appropriate auth header based on strategy:
   * - OAuth: Authorization header with provider token
   * - Bearer: Authorization header from config
   * - API Key: Custom header (e.g., x-api-key) from config
   * - Custom: All custom headers from config
   *
   * Use these headers directly in fetch calls:
   * @example
   * ```typescript
   * const response = await fetch('https://api.example.com/data', {
   *   headers: context.resolvedHeaders
   * });
   * ```
   */
  resolvedHeaders?: Record<string, string>;

  /**
   * Raw authorization headers from the request (before resolution).
   * Usually you should use `resolvedHeaders` instead.
   * @deprecated Use `resolvedHeaders` for API calls
   */
  authHeaders?: Record<string, string>;
}

/**
 * Content block in tool results.
 */
export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string };

/**
 * Result returned from tool handlers.
 */
export interface ToolResult {
  content: ToolContentBlock[];
  /** If true, indicates the tool encountered an error */
  isError?: boolean;
  /** Structured output matching outputSchema (if defined) */
  structuredContent?: Record<string, unknown>;
}

/**
 * Framework-agnostic tool definition using Zod schemas.
 * Can be registered with McpServer (Node) or custom dispatcher (Workers).
 */
export interface SharedToolDefinition<TShape extends ZodRawShape = ZodRawShape> {
  /** Unique tool name (lowercase, underscores allowed) */
  name: string;
  /** Human-readable title */
  title?: string;
  /** Tool description for LLM */
  description: string;
  /** Zod schema for input validation */
  inputSchema: ZodObject<TShape>;
  /** Optional Zod schema for structured output */
  outputSchema?: ZodRawShape;
  /** Tool handler function */
  handler: (
    args: z.infer<ZodObject<TShape>>,
    context: ToolContext,
  ) => Promise<ToolResult>;
  /**
   * Tool annotations per MCP specification.
   * These are hints for clients about tool behavior (not enforced by SDK).
   */
  annotations?: {
    /** Human-readable display title */
    title?: string;
    /** Tool does NOT modify environment (default: false) */
    readOnlyHint?: boolean;
    /** Tool may delete/overwrite data (default: true) */
    destructiveHint?: boolean;
    /** Repeated calls have no additional effect (default: false) */
    idempotentHint?: boolean;
    /** Tool interacts with external entities (default: true) */
    openWorldHint?: boolean;
  };
}

/**
 * Helper to create a type-safe tool definition.
 */
export function defineTool<TShape extends ZodRawShape>(
  def: SharedToolDefinition<TShape>,
): SharedToolDefinition<TShape> {
  return def;
}
