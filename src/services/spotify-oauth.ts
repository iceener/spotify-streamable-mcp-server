import { type OAuthProvider, readStandardTokenResponse } from '../oauth/provider';

/**
 * What the server may do in the user's Spotify account. Users grant all of them at sign-in;
 * Spotify has no partial consent. The list has not changed since the first release, so every
 * stored grant carries it.
 */
export const SPOTIFY_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-library-read',
  'user-library-modify',
] as const;

/** Spotify's accounts service: sign-in, token exchange and refresh. */
export const SPOTIFY_ACCOUNTS_URL = 'https://accounts.spotify.com';

/**
 * Spotify as the proxy's provider. The client ID and secret are the server's own Spotify app
 * (secrets `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`), whose redirect URI is
 * `<server origin>/oauth/callback`.
 */
export const spotifyOAuth: OAuthProvider = {
  name: 'Spotify',
  authorizationUrl: `${SPOTIFY_ACCOUNTS_URL}/authorize`,
  tokenUrl: `${SPOTIFY_ACCOUNTS_URL}/api/token`,
  scopes: SPOTIFY_SCOPES,
  // Spotify needs no extra parameters: it issues a refresh token on every code exchange.
  authorizationParams: {},
  // Spotify answers RFC 6749 token responses with space-separated `scope`. A refresh response
  // may omit `refresh_token`, and the proxy keeps the one it has.
  readTokens: readStandardTokenResponse,
};
