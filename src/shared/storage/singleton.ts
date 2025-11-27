// Storage singleton for backward compatibility with existing code
// Provider-agnostic version from Spotify MCP

import { FileTokenStore } from './file.js';
import type { SessionStore, TokenStore } from './interface.js';
import { MemorySessionStore } from './memory.js';

let tokenStoreInstance: TokenStore | null = null;
let sessionStoreInstance: SessionStore | null = null;

export function initializeStorage(
  tokenStore: TokenStore,
  sessionStore: SessionStore,
): void {
  tokenStoreInstance = tokenStore;
  sessionStoreInstance = sessionStore;
}

export function getTokenStore(): TokenStore {
  if (!tokenStoreInstance) {
    // Default to file-based storage for Node.js
    const persistPath =
      (process.env.RS_TOKENS_FILE as string | undefined) ||
      '.data/provider-tokens.json';
    tokenStoreInstance = new FileTokenStore(persistPath);
  }
  return tokenStoreInstance;
}

export function getSessionStore(): SessionStore {
  if (!sessionStoreInstance) {
    sessionStoreInstance = new MemorySessionStore();
  }
  return sessionStoreInstance;
}
