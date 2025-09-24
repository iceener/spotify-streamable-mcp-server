import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type ProgressToken = string;

export class ProgressReporter {
  constructor(
    private readonly server: McpServer,
    private readonly progressToken: ProgressToken,
  ) {}

  async report(progress: number, total?: number, message?: string): Promise<void> {
    try {
      const lowLevel =
        (this.server as unknown as { server?: unknown })?.server ?? this.server;
      await (
        lowLevel as {
          notification?: (payload: {
            method: string;
            params: {
              id: string;
              progress: number;
              total?: number;
              message?: string;
            };
          }) => Promise<void>;
        }
      )?.notification?.({
        method: 'notifications/progress',
        params: {
          id: this.progressToken,
          progress,
          total,
          ...(message ? { message } : {}),
        },
      });
    } catch {}
  }

  async complete(): Promise<void> {
    await this.report(1, 1);
  }
}

export function createProgressReporter(
  server: McpServer,
  progressToken: ProgressToken,
): ProgressReporter {
  return new ProgressReporter(server, progressToken);
}
