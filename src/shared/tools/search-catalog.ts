/**
 * Search Catalog Tool - Search Spotify for tracks, albums, artists, and playlists.
 */

import { config } from '../../config/env.js';
import { toolsMetadata } from '../../config/metadata.js';
import { SpotifySearchInputSchema } from '../../schemas/inputs.js';
import { SpotifySearchBatchOutput } from '../../schemas/outputs.js';
import { searchCatalog } from '../../services/spotify/catalog.js';
import { sharedLogger as logger } from '../utils/logger.js';
import { defineTool, type ToolContext, type ToolResult } from './types.js';

type ErrorCode = 'unauthorized' | 'forbidden' | 'rate_limited' | 'bad_response';

export const searchCatalogTool = defineTool({
  name: toolsMetadata.search_catalog.name,
  title: toolsMetadata.search_catalog.title,
  description: toolsMetadata.search_catalog.description,
  inputSchema: SpotifySearchInputSchema,
  outputSchema: SpotifySearchBatchOutput.shape,
  annotations: {
    title: toolsMetadata.search_catalog.title,
    readOnlyHint: true,
    openWorldHint: true,
  },

  handler: async (args, context: ToolContext): Promise<ToolResult> => {
    try {
      const limit = args.limit ?? 20;
      const offset = args.offset ?? 0;

      const batches: Array<{
        inputIndex: number;
        query: string;
        totals: Record<string, number>;
        items: SpotifySearchBatchOutput['batches'][number]['items'];
      }> = await Promise.all(
        args.queries.map(async (query, inputIndex) => {
          const result = await searchCatalog(
            {
              q: query,
              types: args.types,
              market: args.market,
              limit,
              offset,
              include_external: args.include_external,
            },
            context.signal,
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
        queries: args.queries,
        types: args.types,
        limit,
        offset,
        batches,
      };

      const contentParts: Array<{ type: 'text'; text: string }> = [
        { type: 'text', text: multiQueryMsg },
      ];
      if (config.SPOTIFY_INCLUDE_JSON_IN_CONTENT) {
        contentParts.push({ type: 'text', text: JSON.stringify(structured) });
      }

      return {
        content: contentParts,
        structuredContent: structured,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error('search_catalog', { message: 'Search error', error: message });
      const codeMatch = message.match(
        /\[(unauthorized|forbidden|rate_limited|bad_response)\]$/,
      );
      const code = codeMatch?.[1] as ErrorCode | undefined;
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
        structuredContent: structured,
      };
    }
  },
});
