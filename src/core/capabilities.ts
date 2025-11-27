import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

export function buildCapabilities(): ServerCapabilities {
  return {
    logging: {},
    prompts: {
      listChanged: true,
    },
    resources: {
      listChanged: true,
      subscribe: true,
    },
    tools: {
      listChanged: true,
    },
  };
}
