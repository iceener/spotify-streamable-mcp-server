import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { unstable_startWorker } from 'wrangler';
// Node runs this file directly, so the imports name the .ts files.
import { TEST_SETTINGS } from '../tests/settings.ts';
import { startMockSpotify, toMock } from './mock-spotify.ts';

/**
 * Run the real Worker in local workerd, with the KV namespace and the `NativeOAuthAuthority`
 * Durable Object from wrangler.jsonc: once in OAuth mode, signing in through Spotify mocked on
 * loopback and driven by the shared smoke client; once misconfigured, to check it fails
 * safely. Every request the Worker makes goes to the mock or is refused. Wrangler's API
 * needs Node, so this file runs under Node; the client runs under Bun.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const plain = (value: string) => ({ type: 'plain_text' as const, value });

process.env.WRANGLER_SEND_METRICS = 'false';
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';

const spotify = await startMockSpotify('smoke-client', 'smoke-secret');

function startWorker(
  vars: Record<string, string>,
  port: number,
  logLevel: 'warn' | 'none' = 'warn',
) {
  return unstable_startWorker({
    config: `${root}wrangler.jsonc`,
    bindings: Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, plain(value)])),
    dev: {
      server: { hostname: '127.0.0.1', port },
      inspector: false,
      watch: false,
      logLevel,
      persist: false,
      outboundService: async (request: Request) => fetch(await toMock(request, spotify)),
    },
  });
}

/** A port the OS just assigned: the proxy needs its own origin before it starts. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

try {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const worker = await startWorker(
    {
      ...TEST_SETTINGS,
      NODE_ENV: 'test',
      MCP_PUBLIC_URL: `${origin}/mcp`,
      MCP_MAX_REQUEST_BYTES: '1024',
      AUTH_MODE: 'oauth',
      OAUTH_ISSUER_URL: origin,
      OAUTH_AUTHORIZATION_URL: `${origin}/authorize`,
      OAUTH_TOKEN_URL: `${origin}/token`,
      OAUTH_REGISTRATION_URL: `${origin}/register`,
      SPOTIFY_CLIENT_ID: 'smoke-client',
      SPOTIFY_CLIENT_SECRET: 'smoke-secret',
      RS_TOKENS_ENC_KEY: Buffer.alloc(32, 4).toString('base64url'),
    },
    port,
  );
  try {
    const endpoint = new URL('/mcp', await worker.url).href;
    assert.equal(new URL(endpoint).origin, origin);
    const { stdout, stderr } = await promisify(execFile)(
      'bun',
      [`${root}scripts/smoke-client.ts`, endpoint, 'workers', '--sign-in'],
      { cwd: root, timeout: 60_000 },
    );
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    assert.deepEqual(spotify.grants, ['authorization_code', 'client_credentials']);
  } finally {
    await worker.dispose();
  }

  // Production settings with the auth decision missing: every request gets a generic 500.
  // Its configuration error is the point here, so keep it out of the output.
  const misconfigured = await startWorker(
    { NODE_ENV: 'production', MCP_PUBLIC_URL: 'https://mcp.example.com/mcp', AUTH_MODE: '' },
    await freePort(),
    'none',
  );
  try {
    const response = await fetch(new URL('/health', await misconfigured.url));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'server_misconfigured' });
    console.info('workers: invalid configuration answers a generic 500');
  } finally {
    await misconfigured.dispose();
  }
} finally {
  await spotify.close();
}
