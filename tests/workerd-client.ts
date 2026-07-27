import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = new URL(process.argv[2] ?? 'http://127.0.0.1:8787/mcp');
const modernSnapshot = await Bun.file(
  new URL('./tool-contract.snapshot.json', import.meta.url),
).json();
const legacySnapshot = await Bun.file(
  new URL('./tool-contract.legacy.snapshot.json', import.meta.url),
).json();

function normalizeZod4InputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeZod4InputSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => !(key === 'additionalProperties' && entry === false))
      .map(([key, entry]) => [key, normalizeZod4InputSchema(entry)]),
  );
}

function preservedToolContract(tools: Array<Record<string, unknown>>) {
  return tools.map((tool) => ({
    ...tool,
    inputSchema: normalizeZod4InputSchema(tool.inputSchema),
  }));
}

const expectedTools = [
  'health',
  'player_status',
  'search_catalog',
  'spotify_control',
  'spotify_playlist',
  'spotify_library',
];

async function verify(mode: 'modern' | 'legacy') {
  const client = new Client(
    { name: `workerd-${mode}`, version: '1.0.0' },
    mode === 'modern'
      ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      : undefined,
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    const snapshot = mode === 'modern' ? modernSnapshot : legacySnapshot;
    if (
      JSON.stringify(preservedToolContract(tools)) !==
      JSON.stringify(preservedToolContract(snapshot as Array<Record<string, unknown>>))
    ) {
      throw new Error(`Unexpected ${mode} tool contract snapshot`);
    }
    if (JSON.stringify(names) !== JSON.stringify(expectedTools)) {
      throw new Error(`Unexpected ${mode} tools: ${names.join(', ')}`);
    }
    const health = await client.callTool({ name: 'health', arguments: {} });
    const structured = health.structuredContent as Record<string, unknown> | undefined;
    if (health.isError || structured?.status !== 'ok') {
      throw new Error(`${mode} health tool failed`);
    }
    return {
      mode,
      era: client.getProtocolEra(),
      version: client.getNegotiatedProtocolVersion(),
      tools: names,
      runtime: structured.runtime,
    };
  } finally {
    await client.close();
  }
}

const results = [await verify('modern'), await verify('legacy')];
console.log(JSON.stringify(results));
