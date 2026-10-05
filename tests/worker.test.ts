import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import before from './fixtures/storage-before.json';
import { HOST, PRODUCTION_VARS } from './production-config';

/**
 * The Worker entry as deployed: the production vars (the example's stand-ins), the deployed secret names, and KV
 * holding records the checkpoint code wrote (`fixtures/storage-before.json`). A signed-in user
 * must still be served. If the Worker stopped handing the encryption key to the token store,
 * every stored record would fail to open and every user would be signed out.
 */
mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));
// The Worker entry needs Workers types, which the Bun typecheck leaves out, so it is
// imported through a variable and typed by what this test uses.
const WORKER = '../src/worker';
const { default: worker } = (await import(WORKER)) as {
  default: { fetch(request: Request, env: unknown, context: unknown): Promise<Response> };
};

class FakeKv {
  readonly values = new Map(Object.entries(before.kv as Record<string, string>));
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

const env = {
  ...PRODUCTION_VARS,
  SPOTIFY_CLIENT_ID: 'stand-in-client-id',
  SPOTIFY_CLIENT_SECRET: 'stand-in-client-secret',
  RS_TOKENS_ENC_KEY: before.key,
  // The fallback key differs, so a record opened with the wrong one fails.
  TOKENS_ENC_KEY: Buffer.alloc(32, 7).toString('base64url'),
  TOKENS: new FakeKv(),
  OAUTH_AUTHORITY: {
    getByName: () => {
      throw new Error('An MCP request must not reach the authority');
    },
  },
};

// No provider is called for a current record; any network call fails the test.
const network = spyOn(globalThis, 'fetch').mockImplementation((async () => {
  throw new Error('No network in this test');
}) as unknown as typeof fetch);
afterAll(() => network.mockRestore());

test('the deployed Worker serves a record written before 1.1.0, read from KV with the deployed key', async () => {
  const response = await worker.fetch(
    new Request(`https://${HOST}/mcp`, {
      method: 'POST',
      headers: {
        Host: HOST,
        Authorization: `Bearer ${'legacy-rs-access'}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    env,
    {},
  );

  expect(response.status).toBe(200);
  const { result } = (await response.json()) as { result: { tools: unknown[] } };
  expect(result.tools.length).toBeGreaterThan(0);
  expect(network).not.toHaveBeenCalled();
});
