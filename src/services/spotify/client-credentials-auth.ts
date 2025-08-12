import type { HttpClient } from '../../core/http-client.js';
import { mapStatusToCode } from '../../utils/http-result.js';

export type ClientCredentialsAuthDeps = {
  accountsHttp: HttpClient;
  accountsUrl: string;
  clientId?: string;
  clientSecret?: string;
  now?: () => number;
};

type TokenCache = { accessToken: string; expiresAtMs: number } | null;

export function createClientCredentialsAuth(deps: ClientCredentialsAuthDeps) {
  const now = deps.now ?? (() => Date.now());
  let cache: TokenCache = null;

  function ensureCreds(): void {
    if (!deps.clientId || !deps.clientSecret) {
      throw new Error(
        'Spotify client credentials are not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET',
      );
    }
  }

  return {
    async getAppToken(signal?: AbortSignal): Promise<string> {
      if (cache && now() < cache.expiresAtMs - 10_000) {
        return cache.accessToken;
      }

      ensureCreds();
      const tokenUrl = new URL('/api/token', deps.accountsUrl).toString();
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
      }).toString();
      const basic = btoa(`${deps.clientId}:${deps.clientSecret}`);

      const resp = await deps.accountsHttp(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body,
        signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        const code = mapStatusToCode(resp.status);
        throw new Error(
          `Spotify token request failed: ${resp.status} ${resp.statusText}${
            text ? ` - ${text}` : ''
          } [${code}]`,
        );
      }
      const json = (await resp.json()) as {
        access_token: string;
        expires_in: number;
      };
      cache = {
        accessToken: json.access_token,
        expiresAtMs: now() + json.expires_in * 1000,
      };
      return cache.accessToken;
    },
  } as const;
}
