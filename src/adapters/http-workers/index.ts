/**
 * Cloudflare Workers router factory.
 * Creates a complete router with OAuth, discovery, and MCP endpoints.
 */

import { Router } from 'itty-router';
import type { UnifiedConfig } from '../../shared/config/env.js';
import { createEncryptor } from '../../shared/crypto/aes-gcm.js';
import { corsPreflightResponse, withCors } from '../../shared/http/cors.js';
import type { SessionStore, TokenStore } from '../../shared/storage/interface.js';
import { KvSessionStore, KvTokenStore } from '../../shared/storage/kv.js';
import { MemorySessionStore, MemoryTokenStore } from '../../shared/storage/memory.js';
import { initializeStorage } from '../../shared/storage/singleton.js';
import { sharedLogger as logger } from '../../shared/utils/logger.js';
import { handleMcpGet, handleMcpRequest } from './mcp.handler.js';
import { attachDiscoveryRoutes } from './routes.discovery.js';
import { attachOAuthRoutes } from './routes.oauth.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerEnv {
  /** KV namespace for token storage */
  TOKENS?: KVNamespace;
  /** Base64url-encoded 32-byte key for AES-256-GCM encryption */
  TOKENS_ENC_KEY?: string;
  /** All other env vars */
  [key: string]: unknown;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expiration?: number; expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RouterContext {
  tokenStore: TokenStore;
  sessionStore: SessionStore;
  config: UnifiedConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared State (persists across requests within same worker instance)
// ─────────────────────────────────────────────────────────────────────────────

let sharedTokenStore: MemoryTokenStore | null = null;
let sharedSessionStore: MemorySessionStore | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Storage Initialization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize storage for the worker.
 * Uses KV with memory fallback and optional encryption.
 */
export function initializeWorkerStorage(
  env: WorkerEnv,
  config: UnifiedConfig,
): { tokenStore: TokenStore; sessionStore: SessionStore } | null {
  const kvNamespace = env.TOKENS;

  if (!kvNamespace) {
    logger.error('worker_storage', {
      message: 'No KV namespace bound - storage unavailable',
    });
    return null;
  }

  // Initialize shared memory fallback ONCE per worker instance
  if (!sharedTokenStore || !sharedSessionStore) {
    sharedTokenStore = new MemoryTokenStore();
    sharedSessionStore = new MemorySessionStore();
  }

  // Set up encryption
  let encrypt: (s: string) => Promise<string>;
  let decrypt: (s: string) => Promise<string>;

  if (env.TOKENS_ENC_KEY) {
    const encryptor = createEncryptor(env.TOKENS_ENC_KEY);
    encrypt = encryptor.encrypt;
    decrypt = encryptor.decrypt;
    logger.debug('worker_storage', { message: 'KV encryption enabled' });
  } else {
    encrypt = async (s) => s;
    decrypt = async (s) => s;

    if (config.NODE_ENV === 'production') {
      logger.warning('worker_storage', {
        message: 'TOKENS_ENC_KEY not set! KV data is unencrypted.',
      });
    }
  }

  // Create KV stores with memory fallback
  const tokenStore = new KvTokenStore(kvNamespace, {
    encrypt,
    decrypt,
    fallback: sharedTokenStore,
  });

  const sessionStore = new KvSessionStore(kvNamespace, {
    encrypt,
    decrypt,
    fallback: sharedSessionStore,
  });

  // Register with singleton for shared access
  initializeStorage(tokenStore, sessionStore);

  return { tokenStore, sessionStore };
}

// ─────────────────────────────────────────────────────────────────────────────
// Router Factory
// ─────────────────────────────────────────────────────────────────────────────

const MCP_ENDPOINT_PATH = '/mcp';

/**
 * Create a configured router for the worker.
 */
export function createWorkerRouter(ctx: RouterContext): {
  fetch: (request: Request) => Promise<Response>;
} {
  const router = Router();
  const { tokenStore, sessionStore, config } = ctx;

  // CORS preflight
  router.options('*', () => corsPreflightResponse());

  // Discovery routes (/.well-known/*)
  attachDiscoveryRoutes(router, config);

  // OAuth routes (/authorize, /token, /oauth/callback, etc.)
  attachOAuthRoutes(router, tokenStore, config);

  // MCP endpoints
  router.get(MCP_ENDPOINT_PATH, () => handleMcpGet());

  router.post(MCP_ENDPOINT_PATH, (request: Request) =>
    handleMcpRequest(request, { tokenStore, sessionStore, config }),
  );

  // Health check
  router.get('/health', () =>
    withCors(
      new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );

  // Catch-all 404
  router.all('*', () => withCors(new Response('Not Found', { status: 404 })));

  return router;
}

/**
 * Shim process.env for shared modules that expect Node.js environment.
 * Workers don't have process.env natively, so we polyfill it.
 */
export function shimProcessEnv(env: WorkerEnv): void {
  const g = globalThis as unknown as {
    process?: { env?: Record<string, unknown> };
  };
  g.process = g.process || {};
  g.process.env = { ...(g.process.env ?? {}), ...(env as Record<string, unknown>) };
}
