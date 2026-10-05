import { defineTool } from '../platform/primitives';
import { errorCodeOf, withoutCode } from '../services/spotify';
import { searchCatalog as search } from '../services/spotify-catalog';
import { SpotifySearchInputSchema } from './shared/inputs';
import { SpotifySearchBatchOutput } from './shared/outputs';
import { textContent } from './shared/spotify';

type Batch = SpotifySearchBatchOutput['batches'][number];

/** Items shown per query in the text the model reads; all of them are in the result. */
const PREVIEW_ITEMS = 5;

export const searchCatalog = defineTool(
  'search_catalog',
  {
    title: 'Find Music (Catalog Search)',
    description:
      "Search songs, artists, albums, and playlists. Inputs: queries[], types[album|artist|playlist|track], optional market(2 letters), limit(1-50), offset(0-1000), include_external['audio']. Returns ordered items per query.",
    inputSchema: SpotifySearchInputSchema,
    outputSchema: SpotifySearchBatchOutput,
    annotations: {
      title: 'Find Music (Catalog Search)',
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async (args, _ctx, deps) => {
    try {
      const limit = args.limit ?? 20;
      const offset = args.offset ?? 0;
      // The catalog needs no user: search runs with the server's own Spotify app.
      const client = deps.spotify.app();
      const batches: Batch[] = await Promise.all(
        args.queries.map(async (query, inputIndex) => {
          const result = await search(client, {
            q: query,
            types: args.types,
            market: args.market,
            limit,
            offset,
            include_external: args.include_external,
          });
          return {
            inputIndex,
            query,
            totals: result.totals,
            items: result.items as Batch['items'],
          };
        }),
      );

      const message = summarize(batches);
      const structured: SpotifySearchBatchOutput = {
        _msg: message,
        queries: args.queries,
        types: args.types,
        limit,
        offset,
        batches,
      };
      return { content: textContent(deps, message, structured), structuredContent: structured };
    } catch (error) {
      deps.logger.warning('Spotify request failed', { tool: 'search_catalog', error });
      const raw = (error as Error).message;
      const code = errorCodeOf(raw);
      const message =
        code === 'unauthorized'
          ? 'Authorization failed for app credentials. Check SPOTIFY_CLIENT_ID/SECRET.'
          : code === 'forbidden'
            ? 'Access denied by Spotify API.'
            : code === 'rate_limited'
              ? 'Rate limited. Please wait and retry.'
              : code
                ? withoutCode(raw)
                : raw;
      return {
        isError: true,
        content: [{ type: 'text', text: message }],
        structuredContent: {
          _msg: message,
          queries: [],
          types: [],
          limit: 0,
          offset: 0,
          batches: [],
        },
      };
    }
  },
);

function summarize(batches: Batch[]): string {
  const preview = (batch: Batch) => {
    if (batch.items.length === 0) return `No results for "${batch.query}".`;
    const lines = batch.items
      .slice(0, PREVIEW_ITEMS)
      .map((item) => `- [${item.type}] ${item.name}${item.uri ? ` — ${item.uri}` : ''}`)
      .join('\n');
    const more =
      batch.items.length > PREVIEW_ITEMS
        ? `\n… and ${batch.items.length - PREVIEW_ITEMS} more`
        : '';
    return `Results for "${batch.query}":\n${lines}${more}`;
  };
  if (batches.length === 1) return batches[0] ? preview(batches[0]) : 'No search results.';

  const counts = batches.map((batch) => `${batch.items.length}× "${batch.query}"`);
  const empty = batches.filter((batch) => batch.items.length === 0).map((b) => `"${b.query}"`);
  const head = `Processed ${batches.length} queries — ${counts.join(', ')}.`;
  const previews = batches.map(preview).join('\n\n');
  return empty.length > 0
    ? `${head} No results for ${empty.join(', ')}.\n\n${previews}`
    : `${head}\n\n${previews}`;
}
