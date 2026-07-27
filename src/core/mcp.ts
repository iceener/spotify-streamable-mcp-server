import {
  type McpRequestContext,
  McpServer,
  type ServerCapabilities,
} from '@modelcontextprotocol/server';
import { registerPrompts } from '../prompts/index.js';
import { registerResources } from '../resources/index.js';
import type { UnifiedConfig } from '../shared/config/env.js';
import { registerTools } from '../tools/index.js';

export interface McpServerDependencies {
  runtimeName: string;
  spotifyFetch?: typeof globalThis.fetch;
}

function capabilitiesFor(context: McpRequestContext): ServerCapabilities {
  const changeStreams = context.era === 'modern';
  return {
    tools: { listChanged: changeStreams },
    prompts: { listChanged: changeStreams },
    resources: {
      listChanged: changeStreams,
      subscribe: changeStreams,
    },
  };
}

/** Build a fresh MCP server for exactly one HTTP request. */
export function createMcpServer(
  config: UnifiedConfig,
  context: McpRequestContext,
  dependencies: McpServerDependencies,
): McpServer {
  const server = new McpServer(
    {
      name: config.MCP_NAME,
      title: config.MCP_TITLE,
      version: config.MCP_VERSION,
      description: 'Search Spotify and manage playback, playlists, and saved songs.',
    },
    {
      instructions: config.MCP_INSTRUCTIONS,
      capabilities: capabilitiesFor(context),
      cacheHints: {
        'server/discover': { ttlMs: 60_000, cacheScope: 'private' },
        'tools/list': { ttlMs: 60_000, cacheScope: 'private' },
        'prompts/list': { ttlMs: 60_000, cacheScope: 'private' },
        'resources/list': { ttlMs: 60_000, cacheScope: 'private' },
        'resources/templates/list': {
          ttlMs: 60_000,
          cacheScope: 'private',
        },
      },
    },
  );

  registerTools(server, config, {
    runtimeName: dependencies.runtimeName,
    era: context.era,
    ...(dependencies.spotifyFetch ? { spotifyFetch: dependencies.spotifyFetch } : {}),
  });
  registerPrompts(server);
  registerResources(server);

  return server;
}
