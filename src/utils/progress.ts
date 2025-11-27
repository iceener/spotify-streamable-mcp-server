import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from './logger.js';

export type ProgressToken = string | number;

export interface ProgressNotification {
  progressToken: ProgressToken;
  progress: number;
  total?: number;
  message?: string;
}

/**
 * Reports progress for long-running operations.
 *
 * Per review finding #12: Progress notifications sent after request completion
 * are silently ignored by the client (no handler exists for completed requests).
 * Always send progress BEFORE returning from the handler.
 */
export class ProgressReporter {
  private completed = false;

  constructor(
    private server: McpServer,
    private progressToken: ProgressToken,
  ) {}

  /**
   * Send a progress notification.
   *
   * @param progress - Current progress value (should increase with each call)
   * @param total - Optional total value (for percentage calculation)
   * @param message - Optional human-readable progress message
   */
  async report(progress: number, total?: number, message?: string): Promise<void> {
    if (this.completed) {
      logger.warning('progress', {
        message:
          'Attempted to send progress after completion - notification will be ignored',
        progressToken: this.progressToken,
      });
      return;
    }

    try {
      // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
      const lowLevel = (this.server as any).server ?? this.server;
      await lowLevel.notification?.({
        method: 'notifications/progress',
        params: {
          progressToken: this.progressToken,
          progress,
          total,
          ...(message ? { message } : {}),
        },
      });
    } catch (error) {
      logger.warning('progress', {
        message: 'Failed to send progress notification',
        error: (error as Error).message,
        progressToken: this.progressToken,
      });
    }
  }

  /**
   * Mark the operation as complete.
   * Sends final 100% progress notification.
   * Further progress reports will be logged as warnings.
   */
  async complete(message?: string): Promise<void> {
    await this.report(1, 1, message ?? 'Complete');
    this.completed = true;
  }
}

/**
 * Create a progress reporter for a request.
 *
 * @param server - The MCP server instance
 * @param progressToken - Token from request._meta.progressToken
 * @returns ProgressReporter instance, or null if no token provided
 *
 * @example
 * ```typescript
 * const reporter = createProgressReporter(server, extra._meta?.progressToken);
 * if (reporter) {
 *   await reporter.report(0, 100, 'Starting...');
 *   // ... do work ...
 *   await reporter.report(50, 100, 'Halfway done');
 *   // ... more work ...
 *   await reporter.complete();
 * }
 * return result; // Progress sent BEFORE return
 * ```
 */
export function createProgressReporter(
  server: McpServer,
  progressToken: ProgressToken | undefined,
): ProgressReporter | null {
  if (!progressToken) {
    return null;
  }
  return new ProgressReporter(server, progressToken);
}
