import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SpotifyControlBatchOutput,
  SpotifyLibraryOutputObject,
  SpotifyPlaylistOutputObject,
  SpotifySearchBatchOutput,
  SpotifyStatusOutputObject,
} from '../schemas/outputs.js';
import { logger } from '../utils/logger.js';
import { spotifyControlTool } from './spotify-control.tool.js';
import { spotifyLibraryTool } from './spotify-library.tool.js';
// Schemas imported above in a single import
import { spotifyPlaylistTool } from './spotify-playlist.tool.js';
import { spotifySearchTool } from './spotify-search.tool.js';
import { spotifyStatusTool } from './spotify-status.tool.js';

export function registerTools(server: McpServer): void {
  // Register each tool individually to avoid TypeScript union type issues

  // Spotify Search Tool
  server.registerTool(
    spotifySearchTool.name,
    {
      description: spotifySearchTool.description,
      inputSchema: spotifySearchTool.inputSchema,
      outputSchema: SpotifySearchBatchOutput.shape,
      annotations: {
        title: spotifySearchTool.title,
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    (args) => spotifySearchTool.handler(args),
  );

  // Spotify Status Tool
  server.registerTool(
    spotifyStatusTool.name,
    {
      description: spotifyStatusTool.description,
      inputSchema: spotifyStatusTool.inputSchema,
      outputSchema: SpotifyStatusOutputObject.shape,
      annotations: {
        title: spotifyStatusTool.title,
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    (args) => spotifyStatusTool.handler(args),
  );

  // Spotify Control Tool
  server.registerTool(
    spotifyControlTool.name,
    {
      description: spotifyControlTool.description,
      inputSchema: spotifyControlTool.inputSchema,
      outputSchema: SpotifyControlBatchOutput.shape,
      annotations: {
        title: spotifyControlTool.title,
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    (args) => spotifyControlTool.handler(args),
  );

  // Playlist Management Tool
  server.registerTool(
    spotifyPlaylistTool.name,
    {
      description: spotifyPlaylistTool.description,
      inputSchema: spotifyPlaylistTool.inputSchema,
      outputSchema: SpotifyPlaylistOutputObject.shape,
      annotations: {
        title: spotifyPlaylistTool.title,
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    (args) => spotifyPlaylistTool.handler(args),
  );

  // Library (Saved Songs) Tool
  server.registerTool(
    spotifyLibraryTool.name,
    {
      description: spotifyLibraryTool.description,
      inputSchema: spotifyLibraryTool.inputSchema,
      outputSchema: SpotifyLibraryOutputObject.shape,
      annotations: {
        title: spotifyLibraryTool.title,
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    (args) => spotifyLibraryTool.handler(args),
  );

  const toolNames = [
    spotifySearchTool.name,
    spotifyStatusTool.name,
    spotifyControlTool.name,
    spotifyPlaylistTool.name,
    spotifyLibraryTool.name,
  ];
  logger.info('tools', {
    message: `Registered ${toolNames.length} tools`,
    toolNames,
  });
}
