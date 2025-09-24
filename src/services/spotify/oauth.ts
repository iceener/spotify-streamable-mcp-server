import { config } from '../../config/env.ts';
import {
  SpotifyTokenResponseCodec,
  type SpotifyTokenResponseCodecType,
} from '../../types/spotify.codecs.ts';

export class SpotifyOAuthError extends Error {
  status?: number;

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SpotifyOAuthError';
    this.status = status;
  }
}

type RefreshOptions = {
  refreshToken: string;
  signal?: AbortSignal;
};

export async function refreshSpotifyTokens(
  options: RefreshOptions,
): Promise<SpotifyTokenResponseCodecType> {
  const { refreshToken, signal } = options;

  if (!refreshToken.trim()) {
    throw new SpotifyOAuthError('Missing Spotify refresh token');
  }

  if (!config.SPOTIFY_CLIENT_ID || !config.SPOTIFY_CLIENT_SECRET) {
    throw new SpotifyOAuthError('Spotify client credentials are not configured');
  }

  const tokenUrl = new URL('/api/token', config.SPOTIFY_ACCOUNTS_URL).toString();
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }).toString();

  const basic = Buffer.from(
    `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`,
  ).toString('base64');

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
    signal,
  });

  const payloadText = await response.text();

  if (!response.ok) {
    throw new SpotifyOAuthError('Spotify refresh request failed', response.status, {
      cause: payloadText,
    });
  }

  const payloadJson = payloadText ? JSON.parse(payloadText) : {};
  const parsed = SpotifyTokenResponseCodec.safeParse(payloadJson);
  if (!parsed.success) {
    throw new SpotifyOAuthError('Spotify refresh payload invalid', response.status, {
      cause: parsed.error,
    });
  }

  return parsed.data;
}
