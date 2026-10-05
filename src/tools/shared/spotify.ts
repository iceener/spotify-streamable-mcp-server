import type { ServerContext } from '@modelcontextprotocol/server';
import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { providerToken } from '../../oauth/verifier';
import type { Deps } from '../../server';
import { errorCodeOf, type SpotifyErrorCode, withoutCode } from '../../services/spotify';

/**
 * A Spotify client acting as the signed-in user, with the token the OAuth proxy resolved for
 * this request. `undefined` without one, for example when authentication is off.
 */
export function spotifyFor(ctx: ServerContext, deps: Deps): SpotifyApi | undefined {
  const token = providerToken(ctx.http?.authInfo);
  return token ? deps.spotify.user(token) : undefined;
}

/** A failed Spotify call, as the model reads it, and the code it carried. */
export function describeFailure(error: unknown): { message: string; code: SpotifyErrorCode } {
  const raw = error instanceof Error ? error.message : String(error);
  const code = errorCodeOf(raw) ?? 'bad_response';
  switch (code) {
    case 'unauthorized':
      return { code, message: 'Not authenticated. Please sign in to Spotify.' };
    case 'forbidden':
      return {
        code,
        message: 'Access denied. You may need additional permissions or Spotify Premium.',
      };
    case 'rate_limited':
      return { code, message: 'Too many requests. Please wait a moment and try again.' };
    default:
      return { code, message: withoutCode(raw) };
  }
}

/** The text blocks of a result: the summary, and the structured result too when configured. */
export function textContent(
  deps: Deps,
  summary: string,
  structured: unknown,
): Array<{ type: 'text'; text: string }> {
  return deps.config.settings.SPOTIFY_INCLUDE_JSON_IN_CONTENT
    ? [
        { type: 'text', text: summary },
        { type: 'text', text: JSON.stringify(structured) },
      ]
    : [{ type: 'text', text: summary }];
}

/** `path?query`, or `path` alone without parameters. */
export function endpoint(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
