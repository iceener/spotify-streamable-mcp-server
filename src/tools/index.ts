import type {
  CallToolResult,
  McpServer,
  ProtocolEra,
  ToolCallback,
} from '@modelcontextprotocol/server';
import { SPOTIFY_ACCESS_TOKEN_EXTRA_KEY } from '../shared/auth/opaque-token-verifier.js';
import type { UnifiedConfig } from '../shared/config/env.js';
import { sharedTools } from '../shared/tools/registry.js';
import type { ToolContext } from '../shared/tools/types.js';
import { sharedLogger as logger } from '../shared/utils/logger.js';

export interface ToolRegistrationOptions {
  runtimeName: string;
  era: ProtocolEra;
  spotifyFetch?: typeof globalThis.fetch;
}

function resolvedSpotifyAccessToken(
  config: UnifiedConfig,
  authInfo: { extra?: Record<string, unknown> } | undefined,
): string | undefined {
  const resolved = authInfo?.extra?.[SPOTIFY_ACCESS_TOKEN_EXTRA_KEY];
  if (typeof resolved === 'string' && resolved.length > 0) return resolved;

  // Static deployment credentials remain distinct from an inbound MCP bearer.
  if (config.AUTH_STRATEGY === 'bearer') return config.BEARER_TOKEN;
  if (config.AUTH_STRATEGY === 'api_key') return config.API_KEY;
  return undefined;
}

/** Register the six stable Spotify tool contracts through public v2 APIs. */
export function registerTools(
  server: McpServer,
  config: UnifiedConfig,
  options: ToolRegistrationOptions,
): void {
  for (const tool of sharedTools) {
    const callback: ToolCallback<typeof tool.inputSchema> = async (args, ctx) => {
      const toolContext: ToolContext = {
        requestId: String(ctx.mcpReq.id),
        runtimeName: options.runtimeName,
        signal: ctx.mcpReq.signal,
        authStrategy: config.AUTH_STRATEGY,
        spotifyAccessToken: resolvedSpotifyAccessToken(config, ctx.http?.authInfo),
        spotify: {
          clientId: config.SPOTIFY_CLIENT_ID,
          clientSecret: config.SPOTIFY_CLIENT_SECRET,
          apiUrl: config.SPOTIFY_API_URL,
          accountsUrl: config.SPOTIFY_ACCOUNTS_URL,
          includeJsonInContent: config.SPOTIFY_INCLUDE_JSON_IN_CONTENT,
          ...(options.spotifyFetch ? { fetch: options.spotifyFetch } : {}),
        },
      };
      return (await tool.handler(
        args as Record<string, unknown>,
        toolContext,
      )) as CallToolResult;
    };

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      callback,
    );
  }

  logger.info('tools', {
    message: `Registered ${sharedTools.length} Spotify tools`,
    toolNames: sharedTools.map((tool) => tool.name),
    protocolEra: options.era,
  });
}
