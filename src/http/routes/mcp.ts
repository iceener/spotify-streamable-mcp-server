import { randomUUID } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { toFetchResponse, toReqRes } from 'fetch-to-node';
import { Hono } from 'hono';
import { runWithRequestContext } from '../../core/context.js';
import { ensureSession } from '../../core/session.js';
import { getSpotifyTokensByRsToken } from '../../core/tokens.js';
import { logger } from '../../utils/logger.js';

export function buildMcpRoutes(params: {
  server: McpServer;
  transports: Map<string, StreamableHTTPServerTransport>;
}) {
  const { server, transports } = params;
  const app = new Hono<{ Bindings: HttpBindings }>();

  const MCP_SESSION_HEADER = 'Mcp-Session-Id';

  function extractBearerToken(authorizationHeader?: string): string | undefined {
    if (!authorizationHeader) {
      return undefined;
    }
    const [scheme, token] = authorizationHeader.split(' ', 2);
    if (!scheme || scheme.toLowerCase() !== 'bearer') {
      return undefined;
    }
    return token?.trim() || undefined;
  }

  function attachSpotifyTokensToSessionIfPresent(
    sessionId: string,
    authorizationHeader?: string,
  ): void {
    try {
      const rsToken = extractBearerToken(authorizationHeader);
      if (!rsToken) {
        return;
      }
      const spotify = getSpotifyTokensByRsToken(rsToken);
      if (!spotify) {
        return;
      }
      const s = ensureSession(sessionId);
      s.spotify = {
        access_token: spotify.access_token,
        refresh_token: spotify.refresh_token,
        expires_at: spotify.expires_at,
        scopes: spotify.scopes,
      };
      // Best-effort log; ignore failures
      void logger.info('auth', {
        message: 'Attached Spotify tokens to session',
        sessionId,
      });
    } catch {
      // ignore token attachment errors
    }
  }

  async function getOrCreateTransport(args: {
    server: McpServer;
    transports: Map<string, StreamableHTTPServerTransport>;
    sessionIdHeader?: string;
    body: unknown;
    req: { headers: Record<string, unknown> };
    res: { setHeader: (name: string, value: string) => void };
  }): Promise<StreamableHTTPServerTransport> {
    const { server, transports, sessionIdHeader, body, req, res } = args;

    const existing = sessionIdHeader ? transports.get(sessionIdHeader) : undefined;
    if (existing) {
      return existing;
    }

    const initializing = isInitializeRequest(body as unknown);

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: initializing
        ? () => sessionIdHeader || randomUUID()
        : undefined,
      onsessioninitialized: initializing
        ? (sid: string) => {
            transports.set(sid, transport);
            res.setHeader(MCP_SESSION_HEADER, sid);
            // Ensure per-session storage exists and optionally attach Spotify tokens
            try {
              ensureSession(sid);
            } catch {
              // ignore ensureSession errors to avoid breaking initialization
            }
            attachSpotifyTokensToSessionIfPresent(
              sid,
              (req.headers.authorization as string | undefined) ?? undefined,
            );
            void logger.info('mcp', {
              message: 'Session initialized',
              sessionId: sid,
            });
          }
        : undefined,
    });

    transport.onerror = (error) => {
      void logger.error('transport', {
        message: 'Transport error',
        error: (error as Error).message,
      });
    };

    await server.connect(transport);
    return transport;
  }

  // POST endpoint for MCP requests
  app.post('/', async (c) => {
    void logger.info('mcp', { message: 'Received POST request to /mcp' });

    const { req, res } = toReqRes(c.req.raw);

    try {
      const sessionIdHeader = c.req.header(MCP_SESSION_HEADER) ?? undefined;

      // Read the body once and reuse; tolerate empty/non-JSON
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        body = undefined;
      }

      const transport = await getOrCreateTransport({
        server,
        transports,
        sessionIdHeader,
        body,
        req,
        res,
      });

      const sessionId =
        (req.headers['mcp-session-id'] as string | undefined) ?? undefined;

      await runWithRequestContext({ sessionId }, async () => {
        await transport.handleRequest(req, res, body);
      });

      res.on('close', () => {
        // keep transport alive for sessions; stateless will close automatically
      });

      return toFetchResponse(res);
    } catch (error) {
      void logger.error('mcp', {
        message: 'Error handling POST request',
        error: (error as Error).message,
      });
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        },
        500,
      );
    }
  });

  // GET endpoint - allow SSE only when session is present; else 405
  app.get('/', async (c) => {
    const { req, res } = toReqRes(c.req.raw);
    const sessionIdHeader = c.req.header(MCP_SESSION_HEADER);
    if (!sessionIdHeader) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed - no session' },
          id: null,
        },
        405,
      );
    }
    try {
      const transport = transports.get(sessionIdHeader);
      if (!transport) {
        return c.text('Invalid session', 404);
      }
      await runWithRequestContext({ sessionId: sessionIdHeader }, async () => {
        await transport.handleRequest(req, res);
      });
      return toFetchResponse(res);
    } catch (error) {
      void logger.error('mcp', {
        message: 'Error handling GET request',
        error: (error as Error).message,
      });
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        },
        500,
      );
    }
  });

  // DELETE endpoint - end session if present, else 405
  app.delete('/', async (c) => {
    const { req, res } = toReqRes(c.req.raw);
    const sessionIdHeader = c.req.header(MCP_SESSION_HEADER);
    if (!sessionIdHeader) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed - no session' },
          id: null,
        },
        405,
      );
    }
    try {
      const transport = transports.get(sessionIdHeader);
      if (!transport) {
        return c.text('Invalid session', 404);
      }

      await runWithRequestContext({ sessionId: sessionIdHeader }, async () => {
        await transport.handleRequest(req, res);
      });

      transports.delete(sessionIdHeader);
      transport.close();

      return toFetchResponse(res);
    } catch (error) {
      void logger.error('mcp', {
        message: 'Error handling DELETE request',
        error: (error as Error).message,
      });

      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        },
        500,
      );
    }
  });

  return app;
}
