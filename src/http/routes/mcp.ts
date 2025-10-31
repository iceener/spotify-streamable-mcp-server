import { randomUUID } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toFetchResponse, toReqRes } from 'fetch-to-node';
import { Hono } from 'hono';
import { validateSpotifyToken } from '../../core/auth.ts';
import { runWithRequestContext } from '../../core/context.ts';
import { ensureSession } from '../../core/session.ts';
import {
  getSpotifyTokensByRsToken,
  refreshSpotifyTokensForRsAccessToken,
} from '../../core/tokens.ts';
import { logger } from '../../utils/logger.ts';

export function buildMcpRoutes(params: {
  server: McpServer;
  transports: Map<string, StreamableHTTPServerTransport>;
}) {
  const { server, transports } = params;
  const app = new Hono<{ Bindings: HttpBindings }>();

  const MCP_SESSION_HEADER = 'Mcp-Session-Id';

  app.post('/', async (c) => {
    const { req, res } = toReqRes(c.req.raw);

    try {
      const sessionIdHeader = c.req.header(MCP_SESSION_HEADER) ?? undefined;
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        body = undefined;
      }

      const isInitialize = Boolean(
        body && (body as { method?: string }).method === 'initialize',
      );

      // Pre-compute/plumb the session id to avoid writing inside the session callback
      const plannedSid = isInitialize ? sessionIdHeader || randomUUID() : undefined;

      // Log session context for debugging
      void logger.info('mcp_request', {
        message: 'Processing MCP request',
        sessionId: plannedSid || sessionIdHeader,
        isInitialize,
        hasSessionIdHeader: !!sessionIdHeader,
        hasAuthorizationHeader: !!(req.headers.authorization as string),
        requestMethod: req.method,
        bodyMethod: (body as { method?: string })?.method,
      });

      // Early auth validation for initialize requests, before transport handles the request
      if (isInitialize) {
        try {
          const authHeader =
            (req.headers.authorization as string | undefined) ?? undefined;
          const rsToken = authHeader?.toLowerCase().startsWith('bearer ')
            ? authHeader.slice('bearer '.length).trim()
            : undefined;

          if (rsToken) {
            void logger.info('auth', {
              message: 'Attempting to retrieve Spotify tokens from RS token',
              sessionId: plannedSid,
              rsTokenLength: rsToken.length,
            });

            const spotifyRecord = getSpotifyTokensByRsToken(rsToken);
            if (spotifyRecord) {
              void logger.info('auth', {
                message: 'Found Spotify tokens for RS token, validating access token',
                sessionId: plannedSid,
                hasAccessToken: !!spotifyRecord.access_token,
                hasRefreshToken: !!spotifyRecord.refresh_token,
                expiresAt: spotifyRecord.expires_at
                  ? new Date(spotifyRecord.expires_at).toISOString()
                  : null,
                scopes: spotifyRecord.scopes,
              });
              const initialValid = await validateSpotifyToken(
                spotifyRecord.access_token,
              );
              let spotify = spotifyRecord;
              if (!initialValid) {
                void logger.warning('auth', {
                  message:
                    'Spotify access token invalid, attempting refresh via RS flow',
                  sessionId: plannedSid,
                  tokenExpired: Date.now() > (spotifyRecord.expires_at || 0),
                });
                const refreshed = await refreshSpotifyTokensForRsAccessToken(rsToken, {
                  signal: AbortSignal.timeout(10_000),
                });
                if (!refreshed) {
                  void logger.warning('auth', {
                    message: 'RS-linked refresh failed, rejecting session',
                    sessionId: plannedSid,
                  });
                  return c.json(
                    {
                      jsonrpc: '2.0',
                      error: {
                        code: -32001,
                        message: 'Invalid or expired Spotify credentials provided',
                      },
                      id: null,
                    },
                    401,
                  );
                }
                spotify = refreshed.spotify;
              }

              if (!(await validateSpotifyToken(spotify.access_token))) {
                void logger.warning('auth', {
                  message:
                    'Spotify token still invalid after refresh - rejecting session',
                  sessionId: plannedSid,
                  tokenExpired: Date.now() > (spotify.expires_at || 0),
                });
                return c.json(
                  {
                    jsonrpc: '2.0',
                    error: {
                      code: -32001,
                      message: 'Invalid or expired Spotify credentials provided',
                    },
                    id: null,
                  },
                  401,
                );
              }

              if (plannedSid) {
                const s = ensureSession(plannedSid);
                s.spotify = {
                  access_token: spotify.access_token,
                  refresh_token: spotify.refresh_token,
                  expires_at: spotify.expires_at,
                  scopes: spotify.scopes,
                };
                res.setHeader(MCP_SESSION_HEADER, plannedSid);
                void logger.info('auth', {
                  message: 'Spotify token validated and stored in session',
                  sessionId: plannedSid,
                  sessionHasSpotify: !!s.spotify,
                  tokenExpiresAt: s.spotify?.expires_at
                    ? new Date(s.spotify.expires_at).toISOString()
                    : null,
                });
              }
            } else {
              void logger.warning('auth', {
                message: 'No Spotify tokens found for RS token',
                sessionId: plannedSid,
              });
            }
          } else {
            void logger.info('auth', {
              message: 'No RS token provided in Authorization header',
              sessionId: plannedSid,
            });
          }
        } catch (error) {
          void logger.error('auth', {
            message: 'Error during token validation',
            sessionId: plannedSid,
            error: (error as Error).message,
          });
          return c.json(
            {
              jsonrpc: '2.0',
              error: {
                code: -32002,
                message: 'Failed to validate credentials',
              },
              id: null,
            },
            500,
          );
        }
      }

      let transport = sessionIdHeader ? transports.get(sessionIdHeader) : undefined;
      let didCreate = false;
      if (!transport) {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: isInitialize ? () => plannedSid as string : undefined,
          onsessioninitialized: isInitialize
            ? (sid: string) => {
                transports.set(sid, created);
                try {
                  ensureSession(sid);
                } catch {}
                void logger.info('mcp', {
                  message: 'Session initialized',
                  sessionId: sid,
                });
              }
            : undefined,
        });
        transport = created;
        didCreate = true;
      }

      transport.onerror = (error) => {
        void logger.error('transport', {
          message: 'Transport error',
          error: (error as Error).message,
        });
      };

      if (didCreate) {
        await server.connect(transport);
      }
      const sessionId =
        (req.headers['mcp-session-id'] as string | undefined) ?? undefined;
      if (!transport) {
        return c.text('Transport unavailable', 500);
      }
      const bearerHeader =
        (req.headers.authorization as string | undefined) ?? undefined;
      const bearerMatch = bearerHeader?.match(/\s*Bearer\s+(.+)$/i);
      const rsToken = bearerMatch?.[1];
      await runWithRequestContext(
        rsToken ? { sessionId, rsToken } : { sessionId },
        async () => {
          await transport.handleRequest(req, res, body);
        },
      );

      res.on('close', () => {});
      return toFetchResponse(res);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('MCP POST /mcp error:', (error as Error).message);
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

  app.get('/', async (c) => {
    const { req, res } = toReqRes(c.req.raw);
    const sessionIdHeader = c.req.header(MCP_SESSION_HEADER);

    void logger.info('mcp_request', {
      message: 'Processing GET MCP request',
      sessionId: sessionIdHeader,
      hasSessionIdHeader: !!sessionIdHeader,
      requestMethod: req.method,
    });

    if (!sessionIdHeader) {
      void logger.warning('mcp_request', {
        message: 'GET request rejected - no session header',
      });
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
      void logger.info('mcp_request', {
        message: 'GET request transport lookup',
        sessionId: sessionIdHeader,
        transportExists: !!transport,
      });

      if (!transport) {
        void logger.warning('mcp_request', {
          message: 'GET request rejected - invalid session',
          sessionId: sessionIdHeader,
        });
        return c.text('Invalid session', 404);
      }
      const bearerHeader =
        (req.headers.authorization as string | undefined) ?? undefined;
      const bearerMatch = bearerHeader?.match(/\s*Bearer\s+(.+)$/i);
      const rsToken = bearerMatch?.[1];
      await runWithRequestContext(
        rsToken
          ? { sessionId: sessionIdHeader, rsToken }
          : { sessionId: sessionIdHeader },
        async () => {
          await transport.handleRequest(req, res);
        },
      );
      return toFetchResponse(res);
    } catch (_error) {
      void logger.error('mcp_request', {
        message: 'GET request error',
        sessionId: sessionIdHeader,
        error: (_error as Error).message,
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

  app.delete('/', async (c) => {
    const { req, res } = toReqRes(c.req.raw);
    const sessionIdHeader = c.req.header(MCP_SESSION_HEADER);

    void logger.info('mcp_request', {
      message: 'Processing DELETE MCP request',
      sessionId: sessionIdHeader,
      hasSessionIdHeader: !!sessionIdHeader,
      requestMethod: req.method,
    });

    if (!sessionIdHeader) {
      void logger.warning('mcp_request', {
        message: 'DELETE request rejected - no session header',
      });
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
      void logger.info('mcp_request', {
        message: 'DELETE request transport lookup',
        sessionId: sessionIdHeader,
        transportExists: !!transport,
      });

      if (!transport) {
        void logger.warning('mcp_request', {
          message: 'DELETE request rejected - invalid session',
          sessionId: sessionIdHeader,
        });
        return c.text('Invalid session', 404);
      }
      const bearerHeader =
        (req.headers.authorization as string | undefined) ?? undefined;
      const bearerMatch = bearerHeader?.match(/\s*Bearer\s+(.+)$/i);
      const rsToken = bearerMatch?.[1];
      await runWithRequestContext(
        rsToken
          ? { sessionId: sessionIdHeader, rsToken }
          : { sessionId: sessionIdHeader },
        async () => {
          await transport.handleRequest(req, res);
        },
      );
      transports.delete(sessionIdHeader);
      transport.close();

      void logger.info('mcp_request', {
        message: 'DELETE request completed - session cleaned up',
        sessionId: sessionIdHeader,
        remainingTransports: transports.size,
      });

      return toFetchResponse(res);
    } catch (_error) {
      void logger.error('mcp_request', {
        message: 'DELETE request error',
        sessionId: sessionIdHeader,
        error: (_error as Error).message,
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
