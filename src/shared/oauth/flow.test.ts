import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryTokenStore } from '../storage/memory.js';
import { handleAuthorize, handleProviderCallback } from './flow.js';
import type { OAuthConfig, ProviderConfig } from './types.js';

const clientCallback = 'http://127.0.0.1:3000/v1/mcp/oauth/callback';
const providerConfig: ProviderConfig = {
  clientId: 'provider-client',
  clientSecret: 'provider-secret',
  accountsUrl: 'https://accounts.spotify.example',
  oauthScopes: 'user-read-playback-state user-modify-playback-state',
};
const oauthConfig: OAuthConfig = {
  redirectUri: 'https://fallback.example/callback',
  redirectAllowlist: [clientCallback],
  redirectAllowAll: false,
};
const options = {
  baseUrl: 'https://spotify-mcp.example',
  isDev: false,
};
const originalFetch = globalThis.fetch;

function replaceFetch(
  implementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): void {
  globalThis.fetch = Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  }) as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OAuth client redirect binding', () => {
  test('rejects an unapproved redirect instead of falling back with a code', async () => {
    const store = new MemoryTokenStore();
    try {
      await expect(
        handleAuthorize(
          {
            redirectUri: 'https://attacker.example/callback',
            codeChallenge: 'challenge',
            codeChallengeMethod: 'S256',
            state: 'client-state',
          },
          store,
          providerConfig,
          oauthConfig,
          options,
        ),
      ).rejects.toThrow('redirect_uri is not allowed');
    } finally {
      store.stopCleanup();
    }
  });

  test.each([
    `${clientCallback}?next=https://attacker.example`,
    `${clientCallback}#attacker`,
    `${clientCallback}/`,
  ])('rejects a non-exact callback variant: %s', async (redirectUri) => {
    const store = new MemoryTokenStore();
    try {
      await expect(
        handleAuthorize(
          {
            redirectUri,
            codeChallenge: 'challenge',
            codeChallengeMethod: 'S256',
            state: 'client-state',
          },
          store,
          providerConfig,
          oauthConfig,
          options,
        ),
      ).rejects.toThrow('redirect_uri is not allowed');
    } finally {
      store.stopCleanup();
    }
  });

  test('keeps client state and callback server-side and returns to the exact callback', async () => {
    const store = new MemoryTokenStore();
    try {
      const authorization = await handleAuthorize(
        {
          redirectUri: clientCallback,
          codeChallenge: 'challenge',
          codeChallengeMethod: 'S256',
          state: 'client-state',
          sid: 'mcp-session',
        },
        store,
        providerConfig,
        oauthConfig,
        options,
      );

      const providerUrl = new URL(authorization.redirectTo);
      expect(providerUrl.origin).toBe('https://accounts.spotify.example');
      expect(providerUrl.searchParams.get('redirect_uri')).toBe(
        'https://spotify-mcp.example/oauth/callback',
      );
      expect(providerUrl.searchParams.get('state')).toBe(authorization.txnId);
      expect(authorization.redirectTo).not.toContain('client-state');
      expect(authorization.redirectTo).not.toContain('mcp-session');
      expect(authorization.redirectTo).not.toContain(
        encodeURIComponent(clientCallback),
      );

      replaceFetch(async (input) => {
        expect(String(input)).toBe('https://accounts.spotify.example/api/token');
        return Response.json({
          access_token: 'provider-access',
          refresh_token: 'provider-refresh',
          expires_in: 3600,
          scope: 'user-read-playback-state user-modify-playback-state',
        });
      });

      const callback = await handleProviderCallback(
        {
          providerCode: 'provider-code',
          compositeState: authorization.txnId,
        },
        store,
        providerConfig,
        oauthConfig,
        options,
      );

      const clientUrl = new URL(callback.redirectTo);
      expect(`${clientUrl.origin}${clientUrl.pathname}`).toBe(clientCallback);
      expect(clientUrl.searchParams.get('state')).toBe('client-state');
      expect(clientUrl.searchParams.get('code')).toBeTruthy();
      expect(clientUrl.searchParams.get('code')).not.toBe('provider-code');
    } finally {
      store.stopCleanup();
    }
  });

  test('revalidates the stored callback before exchanging the provider code', async () => {
    const store = new MemoryTokenStore();
    try {
      const authorization = await handleAuthorize(
        {
          redirectUri: clientCallback,
          codeChallenge: 'challenge',
          codeChallengeMethod: 'S256',
          state: 'client-state',
        },
        store,
        providerConfig,
        oauthConfig,
        options,
      );
      let fetched = false;
      replaceFetch(async () => {
        fetched = true;
        return Response.json({ access_token: 'must-not-be-used' });
      });

      await expect(
        handleProviderCallback(
          {
            providerCode: 'provider-code',
            compositeState: authorization.txnId,
          },
          store,
          providerConfig,
          { ...oauthConfig, redirectAllowlist: [] },
          options,
        ),
      ).rejects.toThrow('invalid_redirect_uri');
      expect(fetched).toBe(false);
    } finally {
      store.stopCleanup();
    }
  });
});
