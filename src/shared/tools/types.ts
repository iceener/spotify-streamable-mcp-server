import type { z } from 'zod';

export type AuthStrategy = 'oauth' | 'bearer' | 'api_key' | 'custom' | 'none';

export interface SpotifyToolConfiguration {
  clientId?: string;
  clientSecret?: string;
  apiUrl: string;
  accountsUrl: string;
  includeJsonInContent: boolean;
  fetch?: typeof globalThis.fetch;
}

/** Per-call data exposed to Spotify tools through the public v2 callback API. */
export interface ToolContext {
  requestId: string;
  runtimeName: string;
  signal: AbortSignal;
  meta?: {
    progressToken?: string | number;
  };
  authStrategy: AuthStrategy;
  /** Resolved Spotify credential. Never the inbound MCP bearer token. */
  spotifyAccessToken?: string;
  /** Immutable deployment configuration; contains no user refresh token. */
  spotify: SpotifyToolConfiguration;
}

export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface SharedToolDefinition<TInput extends z.ZodType = z.ZodType> {
  name: string;
  title?: string;
  description: string;
  inputSchema: TInput;
  outputSchema?: z.ZodType;
  handler: (args: z.output<TInput>, context: ToolContext) => Promise<ToolResult>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export function defineTool<TInput extends z.ZodType>(
  definition: SharedToolDefinition<TInput>,
): SharedToolDefinition<TInput> {
  return definition;
}
