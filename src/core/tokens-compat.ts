// Compatibility layer for legacy code that imports from core/tokens.ts
// Delegates to the new shared storage interfaces

import type { SpotifyTokens } from '../shared/storage/interface.ts';
import { getTokenStore } from '../shared/storage/singleton.ts';

/**
 * @deprecated Use getTokenStore().getByRsAccess() instead
 */
export function getSpotifyTokensByRsToken(rsToken?: string): SpotifyTokens | null {
  if (!rsToken) {
    return null;
  }
  const store = getTokenStore();
  // Convert async to sync by blocking (only for Node.js compatibility)
  // This works because FileTokenStore operations are actually sync under the hood
  let result: SpotifyTokens | null = null;
  void store.getByRsAccess(rsToken).then((rec) => {
    result = rec?.spotify ?? null;
  });
  return result;
}

/**
 * @deprecated Use getTokenStore().updateByRsRefresh() instead
 */
export function updateSpotifyTokensByRsRefreshToken(
  rsRefreshToken: string,
  newSpotify: SpotifyTokens,
  maybeNewRsAccessToken?: string,
): { spotify: SpotifyTokens } | null {
  const store = getTokenStore();
  let result: { spotify: SpotifyTokens } | null = null;
  void store
    .updateByRsRefresh(rsRefreshToken, newSpotify, maybeNewRsAccessToken)
    .then((rec) => {
      result = rec ? { spotify: rec.spotify } : null;
    });
  return result;
}

/**
 * @deprecated Use getTokenStore().getByRsRefresh() instead
 */
export function getRecordByRsRefreshToken(rsRefreshToken?: string): {
  rs_access_token: string;
  rs_refresh_token: string;
  spotify: SpotifyTokens;
} | null {
  if (!rsRefreshToken) {
    return null;
  }
  const store = getTokenStore();
  let result: {
    rs_access_token: string;
    rs_refresh_token: string;
    spotify: SpotifyTokens;
  } | null = null;
  void store.getByRsRefresh(rsRefreshToken).then((rec) => {
    result = rec ? { ...rec } : null;
  });
  return result;
}

/**
 * @deprecated Use getTokenStore().storeRsMapping() instead
 */
export function storeRsTokenMapping(
  rsAccessToken: string,
  spotifyTokens: SpotifyTokens,
  rsRefreshToken?: string,
): void {
  const store = getTokenStore();
  void store.storeRsMapping(rsAccessToken, spotifyTokens, rsRefreshToken);
}









