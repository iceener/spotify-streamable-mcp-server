import type { CancellationToken } from '../utils/cancellation.js';

/**
 * Auth strategy types.
 */
export type AuthStrategy = 'oauth' | 'bearer' | 'api_key' | 'custom' | 'none';

/**
 * Auth headers extracted by middleware.
 */
export interface AuthHeaders {
  authorization?: string;
  'x-api-key'?: string;
  'x-auth-token'?: string;
  [key: string]: string | undefined;
}

/**
 * Provider token information from OAuth flow.
 */
export interface ProviderInfo {
  /** Provider access token */
  access_token: string;
  /** Refresh token (if available) */
  refresh_token?: string;
  /** Token expiry timestamp (ms since epoch) */
  expires_at?: number;
  /** Granted scopes */
  scopes?: string[];
}

/**
 * Request context passed to tool handlers.
 * Contains metadata and utilities for the current request.
 */
export interface RequestContext {
  /**
   * Session ID from the MCP transport (if available).
   * This is managed by the SDK's StreamableHTTPServerTransport.
   */
  sessionId?: string;

  /**
   * Cancellation token for the current request.
   * Tools should check this periodically and throw CancellationError if cancelled.
   */
  cancellationToken: CancellationToken;

  /**
   * Request ID from JSON-RPC message.
   */
  requestId?: string | number;

  /**
   * Timestamp when the request was received.
   */
  timestamp: number;

  // ─────────────────────────────────────────────────────────────────────────
  // Auth Strategy
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
   * Raw auth headers from the request (before resolution).
   * @deprecated Use resolvedHeaders for API calls
   */
  authHeaders?: AuthHeaders;

  /**
   * Resolved headers ready for API calls.
   * This includes the appropriate auth header based on strategy:
   * - OAuth: Authorization header with provider token
   * - Bearer: Authorization header from config
   * - API Key: Custom header (e.g., x-api-key) from config
   * - Custom: All custom headers from config
   */
  resolvedHeaders?: Record<string, string>;

  /**
   * Original RS token (if OAuth was used).
   */
  rsToken?: string;

  // ─────────────────────────────────────────────────────────────────────────
  // Provider Token
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Provider access token (e.g., Google, Spotify, GitHub token).
   * This is the token to use when calling external APIs.
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
   * Full provider token information (OAuth only).
   * Use this to check expiry or access scopes.
   */
  provider?: ProviderInfo;

  // Legacy fields (deprecated)
  /** @deprecated Use providerToken instead */
  serviceToken?: string;
}
