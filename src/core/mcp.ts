import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../tools/index.js';
import { logger } from '../utils/logger.js';
import { buildCapabilities } from './capabilities.js';

export function buildServer({
  name,
  instructions,
  version,
}: {
  name: string;
  instructions: string;
  version: string;
}): McpServer {
  const server = new McpServer(
    { name, version },
    {
      capabilities: buildCapabilities(),
      instructions,
    },
  );

  // Set up logging
  logger.setServer(server);
  // Register handlers
  registerTools(server);
  // Set up logging level handler if the method exists (SDK interop)
  try {
    type LowLevelServer = {
      setRequestHandler?: (
        method: string,
        handler: (request: { params?: { level?: unknown } }) => Promise<unknown>,
      ) => void;
    };
    const maybeLowLevel = (server as unknown as { server?: LowLevelServer }).server;
    const lowLevel: LowLevelServer | undefined =
      maybeLowLevel ?? (server as unknown as LowLevelServer);
    lowLevel?.setRequestHandler?.('logging/setLevel', async (request) => {
      const level =
        typeof request?.params?.level === 'string'
          ? (request.params.level as string)
          : undefined;
      if (level) {
        logger.setLevel(level);
        await logger.info('logging', { message: `Log level set to ${level}` });
      }
      return {} as const;
    });
  } catch (error) {
    void logger.warning('server', {
      message: 'Could not set up logging/setLevel handler',
      error: (error as Error).message,
    });
  }

  return server;
}
