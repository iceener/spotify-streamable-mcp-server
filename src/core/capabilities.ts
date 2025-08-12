import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

export function buildCapabilities(): ServerCapabilities {
  return {
    logging: {},
    tools: {
      listChanged: true,
    },
  };
}
