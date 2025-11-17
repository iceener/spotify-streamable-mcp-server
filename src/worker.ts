/*
 * Unified MCP server for Cloudflare Workers using shared modules
 * Parity with Node.js: same OAuth flow, discovery, security, and tools
 */

import { Router } from 'itty-router';
import { type ZodTypeAny, z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { attachDiscoveryRoutes } from './adapters/http-workers/routes.discovery.ts';
import { attachOAuthRoutes } from './adapters/http-workers/routes.oauth.ts';
import { checkAuthAndChallenge } from './adapters/http-workers/security.ts';
import { serverMetadata } from './config/metadata.ts';
import { runWithRequestContext } from './core/context.ts';
import { parseConfig } from './shared/config/env.ts';
import type { SessionStore, TokenStore } from './shared/storage/interface.ts';
import { KvSessionStore, KvTokenStore } from './shared/storage/kv.ts';
import { initializeStorage } from './shared/storage/singleton.ts';
import { registerTools } from './tools/index.ts';
import { decryptString, encryptString } from './utils/crypto.ts';

const MCP_ENDPOINT_PATH = '/mcp';

function withCors(response: Response): Response {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', '*');
  return response;
}

// Shared memory storage (persists across requests within same worker instance)
// This is CRITICAL - without this, each request gets a new store and transactions are lost
let sharedTokenStore: TokenStore | null = null;
let sharedSessionStore: SessionStore | null = null;

type Env = {
  TOKENS?: {
    get(key: string): Promise<string | null>;
    put(
      key: string,
      value: string,
      options?: { expiration?: number; expirationTtl?: number },
    ): Promise<void>;
    delete(key: string): Promise<void>;
  };
  [key: string]: unknown;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CRITICAL FIX: Copy Workers env to globalThis.process.env
    // Our shared crypto/flow modules may access process.env in some paths
    if (env) {
      const g = globalThis as unknown as {
        process?: { env?: Record<string, unknown> };
      };
      g.process = g.process || {};
      g.process.env = { ...(g.process.env ?? {}), ...(env as Record<string, unknown>) };
    }

    // Parse config
    const config = parseConfig(env as Record<string, unknown>);

    // Initialize storage - MUST use KV for Workers (memory doesn't work across instances)
    const kvNamespace = env.TOKENS;

    if (!kvNamespace) {
      console.error('[WORKER] CRITICAL: No KV namespace bound! OAuth will not work.');
      return new Response(
        'Server misconfigured: Storage unavailable. Contact administrator.',
        { status: 503 },
      );
    }

    // Initialize shared memory fallback ONCE per Worker instance
    if (!sharedTokenStore || !sharedSessionStore) {
      const { MemoryTokenStore, MemorySessionStore } = await import(
        './shared/storage/memory.ts'
      );
      sharedTokenStore = new MemoryTokenStore();
      sharedSessionStore = new MemorySessionStore();
    }

    // Create KV stores that use shared memory as fallback
    // This ensures data persists across requests within same Worker instance
    const tokenStore = new KvTokenStore(kvNamespace, {
      encrypt: encryptString,
      decrypt: decryptString,
      fallback: sharedTokenStore,
    });
    const sessionStore = new KvSessionStore(kvNamespace, {
      encrypt: encryptString,
      decrypt: decryptString,
      fallback: sharedSessionStore,
    });

    // Register stores with singleton so compat layer sees same instance
    initializeStorage(tokenStore, sessionStore);

    // Create router for this request
    const router = Router();

    // OPTIONS preflight
    router.options(MCP_ENDPOINT_PATH, async () => {
      return withCors(new Response(null, { status: 204 }));
    });

    // GET /mcp - Required by Streamable HTTP spec to return 405
    router.get(MCP_ENDPOINT_PATH, async () => {
      return withCors(new Response('Method Not Allowed', { status: 405 }));
    });

    // MCP endpoint
    router.post(MCP_ENDPOINT_PATH, async (req: Request) => {
      const incomingSid = req.headers.get('Mcp-Session-Id');
      const sid = incomingSid?.trim() ? incomingSid : crypto.randomUUID();

      try {
        await sessionStore.ensure(sid);
      } catch {}

      // Check auth and get challenge if needed
      const challengeResp = await checkAuthAndChallenge(req, tokenStore, config, sid);
      if (challengeResp) {
        return challengeResp;
      }

      // Extract auth headers
      const headerRecord: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headerRecord[String(key).toLowerCase()] = String(value);
      });

      // Map RS token to Spotify token
      let _rsMapped = false;
      let bearer: string | undefined;
      let rsTokenForContext: string | undefined;
      let spotifyTokenForContext: string | undefined;

      const authHeaderIn = headerRecord.authorization;
      if (authHeaderIn) {
        const m = authHeaderIn.match(/^\s*Bearer\s+(.+)$/i);
        bearer = m?.[1];

        if (bearer) {
          try {
            const record = await tokenStore.getByRsAccess(bearer);
            const mapped = record?.spotify?.access_token;

              if (mapped) {
                headerRecord.authorization = `Bearer ${mapped}`;
                _rsMapped = true;
              rsTokenForContext = bearer;
              spotifyTokenForContext = mapped;
            }
          } catch {}
        }
      }

      // Dispatch to MCP JSON-RPC handler
      return runWithRequestContext(
        {
          sessionId: sid,
          rsToken: rsTokenForContext,
          spotifyToken: spotifyTokenForContext,
          headers: headerRecord,
        },
        async () => {
          const body = (await req.json().catch(() => ({}))) as {
            jsonrpc?: string;
            method?: string;
            params?: unknown;
            id?: string | number | null;
          };

          const { method, params, id } = body;

          // Handle notifications (no id field) - return 202 Accepted
          if (!('id' in body) || id === null || id === undefined) {
            console.log('[MCP] Received notification:', method);
            return withCors(new Response(null, { status: 202 }));
          }

          // Initialize tools (lazy)
          type ToolRecord = {
            name: string;
            title?: string;
            description?: string;
            inputSchema: Record<string, unknown>;
            handler: (args: Record<string, unknown>) => Promise<unknown>;
          };

          const tools: Record<string, ToolRecord> = {};

          const adapter = {
            registerTool: (
              name: string,
              schema: unknown,
              handler: (args: unknown, signal?: AbortSignal) => Promise<unknown>,
            ) => {
              function toJsonSchema(input: unknown): Record<string, unknown> {
                try {
                  // Already JSON schema-ish
                  if (
                    input &&
                    typeof input === 'object' &&
                    ('$schema' in (input as Record<string, unknown>) ||
                      'type' in (input as Record<string, unknown>))
                  ) {
                    return input as Record<string, unknown>;
                  }
                  // Zod object or any Zod type
                  const isZodType =
                    typeof input === 'object' &&
                    input !== null &&
                    '_def' in (input as Record<string, unknown>);
                  if (isZodType) {
                    const json = zodToJsonSchema(input as ZodTypeAny, {
                      $refStrategy: 'none',
                    });
                    return json as unknown as Record<string, unknown>;
                  }
                  // Zod shape (Record<string, ZodTypeAny>)
                  if (input && typeof input === 'object') {
                    const values = Object.values(input as Record<string, unknown>);
                    const looksLikeShape =
                      values.length > 0 &&
                      values.every((v) => {
                        return (
                          v && typeof v === 'object' && '_def' in (v as Record<string, unknown>)
                        );
                      });
                    if (looksLikeShape) {
                      const obj = z.object(input as Record<string, ZodTypeAny>);
                      const json = zodToJsonSchema(obj, { $refStrategy: 'none' });
                      return json as unknown as Record<string, unknown>;
                    }
                  }
                } catch {}
                // Fallback: return as-is
                return (input ?? {}) as Record<string, unknown>;
              }

              const schemaObj = schema as {
                description?: string;
                inputSchema?: unknown;
                annotations?: { title?: string };
              };

              tools[name] = {
                name,
                title: schemaObj.annotations?.title,
                description: schemaObj.description,
                inputSchema: toJsonSchema(schemaObj.inputSchema),
                handler: async (args) => {
                  const result = await handler(args);
                  return result as {
                    content?: Array<unknown>;
                    structuredContent?: unknown;
                    isError?: boolean;
                  };
                },
              };
            },
          };
          registerTools(adapter);

          // Handle initialize
          if (method === 'initialize') {
            const initResponse = {
              protocolVersion: config.MCP_PROTOCOL_VERSION,
              capabilities: {
                tools: { listChanged: true },
                resources: {},
                prompts: {},
              },
              serverInfo: {
                name: serverMetadata.title,
                title: serverMetadata.title,
                version: config.MCP_VERSION,
              },
              instructions: serverMetadata.instructions,
            };

            console.log('[INITIALIZE] Responding with:', JSON.stringify(initResponse));

            return withCors(
              new Response(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id,
                  result: initResponse,
                }),
                { headers: { 'content-type': 'application/json' } },
              ),
            );
          }

          // Handle tools/list
          if (method === 'tools/list') {
            const list = Object.values(tools).map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.inputSchema,
            }));

            console.log('[TOOLS/LIST] Returning', list.length, 'tools');

            return withCors(
              new Response(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id,
                  result: { tools: list },
                }),
                { headers: { 'content-type': 'application/json' } },
              ),
            );
          }

          // Handle tools/call
          if (method === 'tools/call' && params) {
            const { name, arguments: args } = params as {
              name: string;
              arguments: unknown;
            };
            const tool = tools[name] as
              | { handler: (args: unknown, signal?: AbortSignal) => Promise<unknown> }
              | undefined;

            if (!tool) {
              return withCors(
                new Response(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32601, message: `Tool not found: ${name}` },
                  }),
                  { status: 404, headers: { 'content-type': 'application/json' } },
                ),
              );
            }

            try {
              const result = await tool.handler(args);
              return withCors(
                new Response(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    result,
                  }),
                  { headers: { 'content-type': 'application/json' } },
                ),
              );
            } catch (e) {
              return withCors(
                new Response(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32603, message: (e as Error).message },
                  }),
                  { status: 500, headers: { 'content-type': 'application/json' } },
                ),
              );
            }
          }

          return withCors(
            new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: `Method not found: ${method}` },
              }),
              { status: 404, headers: { 'content-type': 'application/json' } },
            ),
          );
        },
      );
    });

    // Health check
    router.get('/health', async () => {
      return withCors(
        new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );
    });

    // Attach OAuth routes
    attachOAuthRoutes(router, tokenStore, config);

    // Attach discovery routes
    attachDiscoveryRoutes(router, config);

    // 404 fallback
    router.all('*', () => {
      return withCors(
        new Response('Not Found', {
          status: 404,
        }),
      );
    });

    return router.handle(request);
  },
};
