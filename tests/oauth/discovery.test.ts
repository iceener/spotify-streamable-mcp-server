import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup } from '../helpers';
import { ORIGIN, proxyFixture, SCOPE } from './fixture';

afterEach(cleanup);

const CANONICAL = [
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
];
/** Where the server published the same documents before the template migration. */
const ALIASES = [
  '/.well-known/oauth-protected-resource',
  '/mcp/.well-known/oauth-protected-resource',
  '/mcp/.well-known/oauth-authorization-server',
];

function get(path: string, headers: Record<string, string> = {}, method = 'GET') {
  const f = proxyFixture();
  return f.app.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers: { Host: '127.0.0.1:3000', ...headers } }),
  );
}

describe('discovery documents', () => {
  test('this server is the authorization server, with the metadata it published before', async () => {
    const response = await get('/.well-known/oauth-authorization-server');
    // Field for field what production published before the migration
    // (tests/fixtures/routes-before.json), on this test origin.
    expect(await response.json()).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      revocation_endpoint: `${ORIGIN}/revoke`,
      registration_endpoint: `${ORIGIN}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: SCOPE.split(' '),
      client_id_metadata_document_supported: false,
    });
  });

  test('the protected resource names it, with the Spotify scopes', async () => {
    const response = await get('/.well-known/oauth-protected-resource/mcp');
    expect(await response.json()).toEqual({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      scopes_supported: SCOPE.split(' '),
      resource_name: 'Spotify Music',
    });
  });

  for (const path of CANONICAL) {
    test(`${path}: readable from any origin, but only for an allowed Host`, async () => {
      for (const [method, status] of [
        ['GET', 200],
        ['HEAD', 200],
        ['OPTIONS', 204],
        ['POST', 405],
      ] as const) {
        const response = await get(path, { Origin: 'https://untrusted.example' }, method);
        expect(response.status).toBe(status);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      }
      expect((await get(path, { Host: 'evil.example' })).status).toBe(403);
    });
  }

  for (const alias of ALIASES) {
    test(`${alias}: the same document as its canonical location`, async () => {
      const canonical = alias.endsWith('authorization-server') ? CANONICAL[1] : CANONICAL[0];
      const [aliased, original] = await Promise.all([get(alias), get(canonical as string)]);
      expect(aliased.status).toBe(200);
      expect(aliased.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(await aliased.json()).toEqual(await original.json());
      expect((await get(alias, {}, 'POST')).status).toBe(405);
      expect((await get(alias, { Host: 'evil.example' })).status).toBe(403);
      // Changed in the migration: aliases are routes, so the Origin check runs first.
      expect((await get(alias, { Origin: 'https://untrusted.example' })).status).toBe(403);
      expect((await get(alias, { Origin: 'http://client.example' })).status).toBe(200);
    });
  }
});

describe('the Origin check', () => {
  test('covers MCP and every OAuth endpoint; an allowed origin can read the answers', async () => {
    const f = proxyFixture();
    for (const path of [
      '/mcp',
      '/register',
      '/authorize',
      '/token',
      '/oauth/callback',
      '/unknown',
    ]) {
      const response = await f.request(path, undefined, { Origin: 'https://untrusted.example' });
      expect(response.status).toBe(403);
    }

    const options = await f.app.fetch(
      new Request(`${ORIGIN}/token`, {
        method: 'OPTIONS',
        headers: {
          Host: '127.0.0.1:3000',
          Origin: 'http://client.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      }),
    );
    expect(options.status).toBe(204);
    expect(options.headers.get('Access-Control-Allow-Origin')).toBe('http://client.example');
    expect(options.headers.get('Access-Control-Allow-Methods')).toContain('POST');

    const token = await f.request('/token', new URLSearchParams({ grant_type: 'password' }), {
      Origin: 'http://client.example',
    });
    expect(token.status).toBe(400);
    expect(token.headers.get('Access-Control-Allow-Origin')).toBe('http://client.example');
    expect(token.headers.get('Cache-Control')).toBe('no-store');
  });

  test('MCP without a token is challenged toward the protected-resource document', async () => {
    const f = proxyFixture();
    const response = await f.request('/mcp', {});
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});
