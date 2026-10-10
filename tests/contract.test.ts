import { afterEach, describe, expect, test } from 'bun:test';
import before from './fixtures/contract-before.json';
import { cleanup, connect, PUBLIC_URL } from './helpers';

afterEach(cleanup);

/**
 * The MCP contract clients relied on before the template migration, recorded from the deployed
 * code in `fixtures/contract-before.json`. Names, order and input schemas must match exactly.
 * Every other difference is deliberate and listed here (and in CHANGELOG.md).
 */

/** Removed: a template sample that reported server uptime, not part of what the server is for. */
const REMOVED = ['health'];

/** Added: the display titles the first release defined but never sent. */
const TITLES: Record<string, string> = {
  player_status: 'Player Status',
  search_catalog: 'Find Music (Catalog Search)',
  spotify_control: 'Control Spotify Playback',
  spotify_playlist: 'Playlists: Create, Edit, and Browse',
  spotify_library: 'Library: Saved Songs',
};

type Schema = Record<string, unknown>;

/**
 * Zod 4.4 published a nullable field as `anyOf: [{type: X}, {type: 'null'}]`; Zod 4.6 (the
 * template's version) writes `type: [X, 'null']`. Both accept the same values. Rewrite the old
 * spelling into the new one, so everything else in the output schemas must match exactly.
 */
function newNullableSpelling(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(newNullableSpelling);
  if (!schema || typeof schema !== 'object') return schema;
  const node = Object.fromEntries(
    Object.entries(schema as Schema).map(([key, value]) => [key, newNullableSpelling(value)]),
  ) as Schema;
  const options = node.anyOf as Schema[] | undefined;
  if (
    Array.isArray(options) &&
    options.length === 2 &&
    Object.keys(options[0] ?? {}).join() === 'type' &&
    typeof options[0]?.type === 'string' &&
    JSON.stringify(options[1]) === '{"type":"null"}'
  ) {
    const { anyOf: _anyOf, ...rest } = node;
    return { ...rest, type: [options[0].type, 'null'] };
  }
  return node;
}

/** Added in 1.2.0: a thumbnail URL on every track, album, artist and playlist result. */
const IMAGE = {
  description: 'Thumbnail URL, about 300 px wide. For a track, its album cover.',
  type: 'string',
  format: 'uri',
};

/** The recorded output schema with `image` added to the four slim entities, where they appear. */
function withImages(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withImages);
  if (!schema || typeof schema !== 'object') return schema;
  const node = Object.fromEntries(
    Object.entries(schema as Schema).map(([key, value]) => [key, withImages(value)]),
  ) as Schema;
  const properties = node.properties as Record<string, Schema> | undefined;
  const entity = properties?.type?.const;
  if (properties && ['track', 'album', 'artist', 'playlist'].includes(String(entity))) {
    return { ...node, properties: { ...properties, image: IMAGE } };
  }
  return node;
}

for (const era of ['modern', 'legacy'] as const) {
  describe(`${era} contract`, () => {
    const recorded = before[era];
    const recordedTools = (
      recorded['tools/list'].tools as unknown as Array<Record<string, unknown>>
    ).filter((tool) => !REMOVED.includes(String(tool.name)));

    test('the same tools, in the same order, with the same input schemas', async () => {
      const client = await connect({ era });
      const { tools } = await client.listTools();

      expect(
        (recorded['tools/list'].tools as Array<{ name: string }>).map((tool) => tool.name),
      ).toEqual([...REMOVED, ...tools.map((tool) => tool.name)]);
      expect(tools.map((tool) => tool.name)).toEqual(
        recordedTools.map((tool) => String(tool.name)),
      );
      for (const [index, tool] of tools.entries()) {
        const old = recordedTools[index] as Record<string, unknown>;
        expect(tool.inputSchema).toEqual(old.inputSchema as typeof tool.inputSchema);
        expect(tool.annotations).toEqual(old.annotations as typeof tool.annotations);
        expect(tool.description).toBe(old.description as string);
        expect(tool.outputSchema).toEqual(
          newNullableSpelling(withImages(old.outputSchema)) as typeof tool.outputSchema,
        );
        expect(tool.title).toBe(TITLES[tool.name] as string);
        expect(Object.keys(tool).sort()).toEqual([...Object.keys(old), 'title'].sort());
      }
    });

    test('only player_status spells nullable output fields differently', async () => {
      const client = await connect({ era });
      const { tools } = await client.listTools();
      const changed = tools
        .filter(
          (tool, index) =>
            JSON.stringify(tool.outputSchema) !==
            JSON.stringify(
              withImages((recordedTools[index] as Record<string, unknown>).outputSchema),
            ),
        )
        .map((tool) => tool.name);
      expect(changed).toEqual(['player_status']);
    });

    test('image is added to search results and to the tracks of player_status only', async () => {
      const client = await connect({ era });
      const { tools } = await client.listTools();
      const withImage = tools
        .filter((tool) => JSON.stringify(tool.outputSchema).includes('"image"'))
        .map((tool) => tool.name);
      expect(withImage).toEqual(['player_status', 'search_catalog']);
    });

    test('identity and instructions as before; version, icon and capabilities as listed', async () => {
      const client = await connect({ era });
      const { name, title, description } = recorded.serverInfo;

      expect(client.getServerVersion()).toEqual({
        name,
        title,
        description,
        // Changed: the version, and an icon served from the public origin.
        version: '1.2.0',
        icons: [
          { src: new URL('/icon.svg', PUBLIC_URL).href, mimeType: 'image/svg+xml', sizes: ['any'] },
        ],
      });
      // Changed for modern clients: `listChanged` and `subscribe` are false, as legacy clients
      // already saw. The lists change only on deploy, and nothing ever sent a notification.
      expect(Object.keys(recorded.capabilities).sort()).toEqual(['prompts', 'resources', 'tools']);
      expect(client.getServerCapabilities()).toEqual({
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      });
      expect(client.getInstructions()).toBe(recorded.instructions as string);
    });

    test('no resources, resource templates or prompts, as before', async () => {
      const client = await connect({ era });

      expect(recorded['resources/list'].resources).toEqual([]);
      expect(recorded['resources/templates/list'].resourceTemplates).toEqual([]);
      expect(recorded['prompts/list'].prompts).toEqual([]);
      expect((await client.listResources()).resources).toEqual([]);
      expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
      expect((await client.listPrompts()).prompts).toEqual([]);
    });
  });
}

test('the lists are cacheable by every caller: they are the same for everyone', async () => {
  expect(before.modern['tools/list']).toMatchObject({ ttlMs: 60_000, cacheScope: 'private' });
  const client = await connect();
  expect(await client.listTools()).toMatchObject({ ttlMs: 60_000, cacheScope: 'public' });
});
