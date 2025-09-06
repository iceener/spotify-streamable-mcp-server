import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SpotifyControlBatchOutput,
  SpotifyLibraryOutputObject,
  SpotifyPlaylistOutputObject,
  SpotifySearchBatchOutput,
  SpotifyStatusOutputObject,
} from '../schemas/outputs.ts';
import { spotifyControlTool } from './spotify-control.tool.ts';
import { spotifyLibraryTool } from './spotify-library.tool.ts';
import { spotifyPlaylistTool } from './spotify-playlist.tool.ts';
import { spotifySearchTool } from './spotify-search.tool.ts';
import { spotifyStatusTool } from './spotify-status.tool.ts';

export function registerTools(server: McpServer): void {
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
}
