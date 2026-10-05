import { afterEach, expect, spyOn, test } from 'bun:test';
import { MemoryOAuthAuthority } from '../../src/oauth/authority';
import { MemoryTokenStore } from '../../src/oauth/token-store';
import { createDeps, createServer } from '../../src/server';
import { memoryLogger, testApp, testConfig } from '../helpers';
import {
  codeFor,
  HOST,
  loopback,
  ORIGIN,
  PROXY_ENV,
  type ProxyFixture,
  redeem,
  registerNative,
  spotifyTokens,
  type TokenPair,
} from './fixture';

/**
 * The refresh rule as `createDeps` wires it, through a whole sign-in. This server passes
 * `bindGrants: false`, as the deployed server behaved: a refresh needs no `client_id`, and the
 * one it names is not checked. Clients that refresh without `client_id` keep working.
 */
const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

function wiredServer(): Pick<ProxyFixture, 'request'> {
  const config = testConfig({
    ...PROXY_ENV,
    SPOTIFY_CLIENT_ID: 'spotify-client',
    SPOTIFY_CLIENT_SECRET: 'spotify-secret',
  });
  // createDeps calls the provider with the global fetch; the provider's fake answers it.
  const provider = spyOn(globalThis, 'fetch').mockImplementation(spotifyTokens() as typeof fetch);
  restore.push(() => provider.mockRestore());
  const logger = memoryLogger();
  const deps = createDeps(config, logger, {
    tokens: new MemoryTokenStore(),
    authority: new MemoryOAuthAuthority(),
  });
  const app = testApp(config, { deps, server: createServer });
  return {
    request: (path, body, headers = {}) =>
      app.fetch(
        new Request(new URL(path, ORIGIN).href, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Host: HOST, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
          ...(body !== undefined && { body: String(body) }),
        }),
      ),
  };
}

test('createDeps does not bind grants: a refresh needs no client_id, as deployed', async () => {
  const server = wiredServer() as ProxyFixture;
  const redirectUri = loopback();
  const client = await registerNative(
    {
      ...server,
      request: (path, body) =>
        server.request(path, JSON.stringify(body), { 'Content-Type': 'application/json' }),
    },
    redirectUri,
  );
  const { code } = await codeFor(server, client.client_id, redirectUri);
  const issued = (await (
    await redeem(server, client.client_id, redirectUri, code)
  ).json()) as TokenPair;
  const refresh = (fields: Record<string, string>) =>
    server.request(
      '/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: issued.refresh_token,
        ...fields,
      }),
    );

  expect((await refresh({})).status).toBe(200);
  expect((await refresh({ client_id: 'someone-else' })).status).toBe(200);
  expect((await refresh({ client_id: client.client_id })).status).toBe(200);
});
