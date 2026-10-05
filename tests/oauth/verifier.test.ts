import { describe, expect, test } from 'bun:test';
import { MemoryTokenStore } from '../../src/oauth/token-store';
import { createProxyVerifier } from '../../src/oauth/verifier';
import { spotifyOAuth } from '../../src/services/spotify-oauth';
import { type LogEntry, memoryLogger, PUBLIC_URL, SPOTIFY_CLIENT } from '../helpers';
import { SCOPE, spotifyTokens } from './fixture';

function verifierWith(
  tokens: MemoryTokenStore,
  accounts = spotifyTokens(),
  logs: LogEntry[] = [],
  credentials = SPOTIFY_CLIENT,
) {
  return createProxyVerifier({
    tokens,
    provider: spotifyOAuth,
    credentials,
    resource: new URL(PUBLIC_URL),
    logger: memoryLogger(logs),
    fetch: accounts,
  });
}

async function storeGrant(
  tokens: MemoryTokenStore,
  expiresAt: number,
  options: { refresh?: string; scopes?: string[]; bound?: boolean } = {},
) {
  await tokens.storeRsMapping(
    'mcp-token',
    {
      access_token: 'spotify-old',
      ...(options.refresh !== undefined && { refresh_token: options.refresh }),
      expires_at: expiresAt,
      ...(options.scopes && { scopes: options.scopes }),
    },
    'mcp-refresh',
    options.bound === false ? undefined : { clientId: 'client-1', resource: PUBLIC_URL },
  );
}

describe('the proxy verifier', () => {
  test('gives tools the Spotify token, and nothing that could refresh it', async () => {
    const tokens = new MemoryTokenStore();
    await storeGrant(tokens, Date.now() + 3_600_000, { refresh: 'spotify-refresh', scopes: ['a'] });
    const caller = await verifierWith(tokens).verifyAccessToken('mcp-token');

    expect(caller).toMatchObject({
      token: 'mcp-token',
      clientId: 'client-1',
      scopes: ['a'],
      resource: new URL(PUBLIC_URL),
      expiresAt: expect.any(Number),
    });
    expect(caller.extra).toEqual({ providerAccessToken: 'spotify-old' });
    expect(JSON.stringify(caller)).not.toContain('spotify-refresh');
  });

  test('refreshes a Spotify token that expires within a minute, once per cooldown', async () => {
    const tokens = new MemoryTokenStore();
    const accounts = spotifyTokens();
    await storeGrant(tokens, Date.now() + 30_000, { refresh: 'spotify-refresh', scopes: ['a'] });
    const verifier = verifierWith(tokens, accounts);

    const [first, second] = await Promise.all([
      verifier.verifyAccessToken('mcp-token'),
      verifier.verifyAccessToken('mcp-token'),
    ]);
    expect([first.extra, second.extra]).toContainEqual({ providerAccessToken: 'spotify-fresh' });
    const stored = await tokens.getByRsAccess('mcp-token');
    expect(stored?.provider).toMatchObject({
      access_token: 'spotify-fresh',
      scopes: [SCOPE.split(' ')].flat(),
    });
    // The access token never changes here; only /token rotates it.
    expect(stored?.rs_access_token).toBe('mcp-token');

    // Expiring again within the cooldown: no second refresh.
    await tokens.updateByRsRefresh('mcp-refresh', {
      ...(stored?.provider ?? { access_token: '' }),
      expires_at: Date.now() + 30_000,
    });
    const calls = accounts.forms.length;
    await verifier.verifyAccessToken('mcp-token');
    expect(accounts.forms.length).toBe(calls);
  });

  test('a refresh Spotify refuses keeps the current token while it is valid', async () => {
    const tokens = new MemoryTokenStore();
    const logs: LogEntry[] = [];
    const accounts = spotifyTokens(
      () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    );
    await storeGrant(tokens, Date.now() + 30_000, { refresh: 'spotify-refresh' });
    const caller = await verifierWith(tokens, accounts, logs).verifyAccessToken('mcp-token');

    expect(caller.extra).toEqual({ providerAccessToken: 'spotify-old' });
    expect(logs.map((entry) => entry.message)).toContain(
      'Spotify token refresh failed; using the current token',
    );
    expect(JSON.stringify(logs)).not.toContain('invalid_grant');
  });

  test('an expired Spotify token that cannot be refreshed is an invalid token', async () => {
    const tokens = new MemoryTokenStore();
    await storeGrant(tokens, Date.now() - 1_000);
    await expect(verifierWith(tokens).verifyAccessToken('mcp-token')).rejects.toMatchObject({
      code: 'invalid_token',
    });

    const withoutClient = new MemoryTokenStore();
    await storeGrant(withoutClient, Date.now() - 1_000, { refresh: 'spotify-refresh' });
    const accounts = spotifyTokens();
    await expect(
      verifierWith(withoutClient, accounts, [], {
        clientId: '',
        clientSecret: '',
      }).verifyAccessToken('mcp-token'),
    ).rejects.toMatchObject({ code: 'invalid_token' });
    expect(accounts.forms).toHaveLength(0);
  });

  test('records from before provenance get the configured scopes and a stable caller ID', async () => {
    const tokens = new MemoryTokenStore();
    await storeGrant(tokens, Date.now() + 3_600_000, { scopes: [], bound: false });
    const verifier = verifierWith(tokens);
    const caller = await verifier.verifyAccessToken('mcp-token');

    expect(caller.scopes).toEqual(SCOPE.split(' '));
    expect(caller.clientId).toMatch(/^rs:[0-9a-f]{64}$/);
    expect((await verifier.verifyAccessToken('mcp-token')).clientId).toBe(caller.clientId);
    expect(caller.clientId).not.toContain('mcp-token');
    expect(caller.resource?.href).toBe(PUBLIC_URL);
  });
});
