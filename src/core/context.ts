import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from '../types/context.js';
import type { CancellationToken } from '../utils/cancellation.js';
import { createCancellationToken } from '../utils/cancellation.js';

/**
 * AsyncLocalStorage for passing auth context through async call chains.
 * This allows tool handlers to access auth context without relying on
 * the MCP SDK to pass request IDs.
 */
export const authContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current auth context from AsyncLocalStorage.
 */
export function getCurrentAuthContext(): RequestContext | undefined {
  return authContextStorage.getStore();
}

/**
 * Global registry for request contexts.
 * Maps request IDs to their contexts (including cancellation tokens).
 *
 * This allows tool handlers to access the cancellation token for the current request.
 */
class ContextRegistry {
  private contexts = new Map<string | number, RequestContext>();

  /**
   * Create and register a new request context.
   */
  create(
    requestId: string | number,
    sessionId?: string,
    authData?: {
      authStrategy?: RequestContext['authStrategy'];
      authHeaders?: RequestContext['authHeaders'];
      resolvedHeaders?: RequestContext['resolvedHeaders'];
      rsToken?: string;
      providerToken?: string;
      provider?: RequestContext['provider'];
      /** @deprecated Use providerToken instead */
      serviceToken?: string;
    },
  ): RequestContext {
    const context: RequestContext = {
      sessionId,
      cancellationToken: createCancellationToken(),
      requestId,
      timestamp: Date.now(),
      authStrategy: authData?.authStrategy,
      authHeaders: authData?.authHeaders,
      resolvedHeaders: authData?.resolvedHeaders,
      rsToken: authData?.rsToken,
      providerToken: authData?.providerToken,
      provider: authData?.provider,
      // Legacy support
      serviceToken: authData?.serviceToken ?? authData?.providerToken,
    };

    this.contexts.set(requestId, context);
    return context;
  }

  /**
   * Get the context for a request ID.
   */
  get(requestId: string | number): RequestContext | undefined {
    return this.contexts.get(requestId);
  }

  /**
   * Get the cancellation token for a request ID.
   */
  getCancellationToken(requestId: string | number): CancellationToken | undefined {
    return this.contexts.get(requestId)?.cancellationToken;
  }

  /**
   * Cancel a request by its ID.
   */
  cancel(requestId: string | number, _reason?: string): boolean {
    const context = this.contexts.get(requestId);
    if (!context) return false;

    context.cancellationToken.cancel();
    return true;
  }

  /**
   * Delete a request context (cleanup after request completes).
   */
  delete(requestId: string | number): void {
    this.contexts.delete(requestId);
  }

  /**
   * Clean up expired contexts (older than 10 minutes).
   */
  cleanupExpired(): void {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutes

    for (const [requestId, context] of this.contexts.entries()) {
      if (now - context.timestamp > maxAge) {
        this.contexts.delete(requestId);
      }
    }
  }
}

/**
 * Global context registry instance.
 */
export const contextRegistry = new ContextRegistry();

/**
 * Interval handle for cleanup - stored for proper shutdown
 */
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Start the cleanup interval for expired contexts.
 * Called automatically on module load.
 */
export function startContextCleanup(): void {
  if (cleanupIntervalId) return;
  cleanupIntervalId = setInterval(() => {
    contextRegistry.cleanupExpired();
  }, 60_000);
}

/**
 * Stop the cleanup interval.
 * Call this during graceful shutdown to prevent memory leaks.
 */
export function stopContextCleanup(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}

// Start cleanup on module load
startContextCleanup();
