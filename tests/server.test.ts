import { afterEach, describe, expect, test } from 'bun:test';
import { prompts } from '../src/prompts';
import { resources } from '../src/resources';
import { serverInfo } from '../src/server';
import { tools } from '../src/tools';
import { cleanup, connect, PUBLIC_URL } from './helpers';

afterEach(cleanup);

/** `src/server.ts`: identity, capabilities, and that every listed definition is served. */
describe('server', () => {
  for (const era of ['modern', 'legacy'] as const) {
    test(`${era}: identifies itself with an icon served from the public origin`, async () => {
      const client = await connect({ era });

      expect(client.getServerVersion()).toMatchObject({
        ...serverInfo,
        icons: [{ src: new URL('/icon.svg', PUBLIC_URL).href, mimeType: 'image/svg+xml' }],
      });
      expect(client.getInstructions()).toBeString();
    });

    test(`${era}: advertises tools, prompts and resources, with no change stream`, async () => {
      const client = await connect({ era });

      // Prompts and resources are advertised with empty lists, as they always were.
      expect(client.getServerCapabilities()).toEqual({
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      });
    });
  }

  test('serves every tool, resource and prompt in the index lists, in order', async () => {
    const client = await connect();

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      tools.map((tool) => tool.name),
    );
    const listed = [
      ...(await client.listResources()).resources.map((resource) => resource.name),
      ...(await client.listResourceTemplates()).resourceTemplates.map((template) => template.name),
    ];
    for (const resource of resources) expect(listed).toContain(resource.name);
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(
      prompts.map((prompt) => prompt.name),
    );
  });

  test('lists are cacheable by every caller for a minute', async () => {
    const client = await connect();
    const result = await client.listTools();

    expect(result).toMatchObject({ ttlMs: 60_000, cacheScope: 'public' });
  });
});

test('oversized tool arguments are refused before any schema runs', async () => {
  const client = await connect();
  const result = await client.callTool({
    name: 'spotify_playlist',
    arguments: {
      action: 'add_items',
      playlist_id: 'p',
      uris: Array.from({ length: 2_000 }, (_, index) => `spotify:track:${index}`),
    },
  });

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain('1000');
});
