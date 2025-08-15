import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { configResource } from './config.resource.ts';
import { docsResource } from './docs.resource.ts';

const resources = [configResource, docsResource];

export function registerResources(server: McpServer): void {
  for (const resource of resources) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      resource.handler,
    );
  }
}
