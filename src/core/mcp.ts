import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config/env.ts';
import { registerTools } from '../tools/index.ts';
import { registerPrompts } from '../prompts/index.ts';
import { registerResources } from '../resources/index.ts';
import { buildCapabilities } from './capabilities.ts';
import { initializeServerLogging } from './logging.ts';

export function buildServer(params: {
  name: string;
  version: string;
  instructions?: string;
}): McpServer {
  const { name, version, instructions } = params;
  const server = new McpServer(
    { name, version },
    {
      capabilities: buildCapabilities(),
      instructions: instructions ?? config.MCP_INSTRUCTIONS,
    },
  );

  initializeServerLogging(server);
  registerTools(server);
  registerPrompts(server);
  registerResources(server);

  return server;
}
