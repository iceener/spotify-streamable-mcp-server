// Storage singleton for backward compatibility with existing code
// This allows gradual migration from core/tokens.ts to storage interfaces

import { FileTokenStore } from './file.ts';
import type { SessionStore, TokenStore } from './interface.ts';

let tokenStoreInstance: TokenStore | null = null;

export function initializeStorage(
  tokenStore: TokenStore,
  _sessionStore: SessionStore,
): void {
  tokenStoreInstance = tokenStore;
}

export function getTokenStore(): TokenStore {
  if (!tokenStoreInstance) {
    // Default to file-based storage for Node.js
    const persistPath =
      (process.env.RS_TOKENS_FILE as string | undefined) || '.data/spotify-tokens.json';
    tokenStoreInstance = new FileTokenStore(persistPath);
  }
  return tokenStoreInstance;
}









