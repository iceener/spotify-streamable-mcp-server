import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config/env.ts';
import { toolsMetadata } from '../config/metadata.ts';
import {
  type SpotifySearchInput,
  SpotifySearchInputSchema,
} from '../schemas/inputs.ts';
import { SpotifySearchBatchOutput } from '../schemas/outputs.ts';
import { createHttpClient } from '../services/http-client.ts';
import { searchCatalog } from '../services/spotify/catalog.ts';
import { createClientCredentialsAuth } from '../services/spotify/client-credentials-auth.ts';
import { logger } from '../utils/logger.ts';
import { validateDev } from '../utils/validate.ts';

const accountsHttp = createHttpClient({
  baseHeaders: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': `mcp-spotify/${config.MCP_VERSION}`,
  },
  rateLimit: { rps: 2, burst: 4 },
  timeout: 15000,
  retries: 1,
});

const apiHttp = createHttpClient({
  baseHeaders: {
    'Content-Type': 'application/json',
    'User-Agent': `mcp-spotify/${config.MCP_VERSION}`,
  },
  rateLimit: { rps: 5, burst: 10 },
  timeout: 20000,
  retries: 2,
});

const appAuth = createClientCredentialsAuth({
  accountsHttp,
  accountsUrl: config.SPOTIFY_ACCOUNTS_URL,
  clientId: config.SPOTIFY_CLIENT_ID,
  clientSecret: config.SPOTIFY_CLIENT_SECRET,
});

export const spotifySearchTool = {
  name: 'search_catalog',
  title: toolsMetadata.search_catalog.title,
  description: toolsMetadata.search_catalog.description,
  inputSchema: SpotifySearchInputSchema.shape,

  handler: async (
    args: SpotifySearchInput,
    signal?: AbortSignal,
  ): Promise<CallToolResult> => {
    try {
      const parsed = SpotifySearchInputSchema.parse(args);
      const limit = parsed.limit ?? 20;
      const offset = parsed.offset ?? 0;

      const batches: Array<{
        inputIndex: number;
        query: string;
        totals: Record<string, number>;
        items: SpotifySearchBatchOutput['batches'][number]['items'];
      }> = await Promise.all(
        parsed.queries.map(async (query, inputIndex) => {
          const result = await searchCatalog(
            apiHttp,
            config.SPOTIFY_API_URL,
            appAuth.getAppToken,
            {
              q: query,
              types: parsed.types,
              market: parsed.market,
              limit,
              offset,
              include_external: parsed.include_external,
            },
            signal,
          );
          return {
            inputIndex,
            query,
            totals: result.totals,
            items: result.items as SpotifySearchBatchOutput['batches'][number]['items'],
          };
        }),
      );

      const itemPreviewLimit = 5;
      const multiQueryMsg = (() => {
        const buildPreview = (b: (typeof batches)[number]) => {
          if (b.items.length === 0) {
            return `No results for "${b.query}".`;
          }
          const lines = b.items
            .slice(0, itemPreviewLimit)
            .map((it) => {
              const safe = it as Record<string, unknown>;
              const type = String((safe?.type as string | undefined) ?? 'item');
              const name = String((safe?.name as string | undefined) ?? '');
              const uri = String((safe?.uri as string | undefined) ?? '');
              return `- [${type}] ${name}${uri ? ` — ${uri}` : ''}`;
            })
            .join('\n');
          const more =
            b.items.length > itemPreviewLimit
              ? `\n… and ${b.items.length - itemPreviewLimit} more`
              : '';
          return `Results for "${b.query}":\n${lines}${more}`;
        };
        if (batches.length === 1) {
          const firstBatch = batches[0];
          if (!firstBatch) {
            return 'No search results.';
          }
          return buildPreview(firstBatch);
        }
        const counts = batches.map((b) => `${b.items.length}× "${b.query}"`);
        const empties = batches
          .filter((b) => b.items.length === 0)
          .map((b) => `"${b.query}"`);
        const head = `Processed ${batches.length} queries — ${counts.join(', ')}.`;
        const previews = batches.map(buildPreview).join('\n\n');
        if (empties.length > 0) {
          return `${head} No results for ${empties.join(', ')}.\n\n${previews}`;
        }
        return `${head}\n\n${previews}`;
      })();

      const structured: SpotifySearchBatchOutput = {
        _msg: multiQueryMsg,
        queries: parsed.queries,
        types: parsed.types,
        limit,
        offset,
        batches,
      };

      const contentParts: Array<{ type: 'text'; text: string }> = [
        { type: 'text', text: multiQueryMsg },
      ];
      if (config.SPOTIFY_MCP_INCLUDE_JSON_IN_CONTENT) {
        contentParts.push({ type: 'text', text: JSON.stringify(structured) });
      }

      return {
        content: contentParts,
        structuredContent: validateDev(SpotifySearchBatchOutput, structured),
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error('spotify_search', { error: message });
      const codeMatch = message.match(
        /\[(unauthorized|forbidden|rate_limited|bad_response)\]$/,
      );
      const code = codeMatch?.[1];
      const friendly = code
        ? code === 'unauthorized'
          ? 'Authorization failed for app credentials. Check SPOTIFY_CLIENT_ID/SECRET.'
          : code === 'forbidden'
            ? 'Access denied by Spotify API.'
            : code === 'rate_limited'
              ? 'Rate limited. Please wait and retry.'
              : message.replace(/\s*\[[^\]]+\]$/, '')
        : message;
      const structured = {
        _msg: friendly,
        queries: [],
        types: [],
        limit: 0,
        offset: 0,
        batches: [],
      } as const;
      return {
        isError: true,
        content: [{ type: 'text', text: friendly }],
        structuredContent: validateDev(SpotifySearchBatchOutput, structured),
      };
    }
  },
};
