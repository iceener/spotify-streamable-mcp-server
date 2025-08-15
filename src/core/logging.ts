import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../utils/logger.ts';

export function initializeServerLogging(server: McpServer): void {
  logger.setServer(server);
  try {
    const lowLevel = (server as unknown as { server?: unknown })?.server ?? server;
    (lowLevel as { setRequestHandler?: Function })?.setRequestHandler?.(
      'logging/setLevel',
      async (request: { params?: { level?: unknown } }) => {
        const level =
          typeof request?.params?.level === 'string'
            ? (request.params.level as string)
            : undefined;
        if (level) {
          logger.setLevel(level);
          await logger.info('logging', {
            message: `Log level set to ${level}`,
          });
        }
        return {} as const;
      },
    );
  } catch {}
}
