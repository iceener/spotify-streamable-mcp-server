import type { z } from 'zod';
import { healthTool } from './health.js';
import { playerStatusTool } from './player-status.js';
import { searchCatalogTool } from './search-catalog.js';
import { spotifyControlTool } from './spotify-control.js';
import { spotifyLibraryTool } from './spotify-library.js';
import { spotifyPlaylistTool } from './spotify-playlist.js';
import type { ToolContext, ToolResult } from './types.js';

export type { SharedToolDefinition, ToolContext, ToolResult } from './types.js';
export { defineTool } from './types.js';

export interface RegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

/** The six public Spotify MCP tool contracts, in stable discovery order. */
export const sharedTools: RegisteredTool[] = [
  healthTool,
  playerStatusTool,
  searchCatalogTool,
  spotifyControlTool,
  spotifyPlaylistTool,
  spotifyLibraryTool,
] as RegisteredTool[];

export function getSharedTool(name: string): RegisteredTool | undefined {
  return sharedTools.find((tool) => tool.name === name);
}

export function getSharedToolNames(): string[] {
  return sharedTools.map((tool) => tool.name);
}

export async function executeSharedTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = getSharedTool(name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  if (context.signal.aborted) {
    return {
      content: [{ type: 'text', text: 'Operation was cancelled' }],
      isError: true,
    };
  }

  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
    return {
      content: [{ type: 'text', text: `Invalid input: ${errors}` }],
      isError: true,
    };
  }

  try {
    return await tool.handler(parsed.data as Record<string, unknown>, context);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: context.signal.aborted
            ? 'Operation was cancelled'
            : `Tool error: ${(error as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}
