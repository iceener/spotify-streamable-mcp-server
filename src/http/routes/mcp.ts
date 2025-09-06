import { randomUUID } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { Hono } from "hono";
import { runWithRequestContext } from "../../core/context.ts";
import { ensureSession } from "../../core/session.ts";
import {
  getSpotifyTokensByRsToken,
  validateSpotifyToken,
} from "../../core/auth.ts";
import { logger } from "../../utils/logger.ts";

export function buildMcpRoutes(params: {
  server: McpServer;
  transports: Map<string, StreamableHTTPServerTransport>;
}) {
  const { server, transports } = params;
  const app = new Hono<{ Bindings: HttpBindings }>();

  const MCP_SESSION_HEADER = "Mcp-Session-Id";

  app.post("/", async (c) => {
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
        body && (body as { method?: string }).method === "initialize"
      );

      let transport = sessionIdHeader
        ? transports.get(sessionIdHeader)
        : undefined;
      let didCreate = false;
      if (!transport) {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: isInitialize
            ? () => sessionIdHeader || randomUUID()
            : undefined,
          onsessioninitialized: isInitialize
            ? (sid: string) => {
                transports.set(sid, created);
                res.setHeader(MCP_SESSION_HEADER, sid);
                try {
                  ensureSession(sid);
                } catch {}
                try {
                  const authHeader =
                    (req.headers["authorization"] as string | undefined) ??
                    undefined;
                  const rsToken = authHeader
                    ?.toLowerCase()
                    .startsWith("bearer ")
                    ? authHeader.slice("bearer ".length).trim()
                    : undefined;
                  if (rsToken) {
                    const spotify = getSpotifyTokensByRsToken(rsToken);
                    if (spotify) {
                      // Validate the access token before storing it
                      const isValid = await validateSpotifyToken(
                        spotify.access_token
                      );
                      if (isValid) {
                        const s = ensureSession(sid);
                        s.spotify = {
                          access_token: spotify.access_token,
                          refresh_token: spotify.refresh_token,
                          expires_at: spotify.expires_at,
                          scopes: spotify.scopes,
                        };
                        void logger.info("auth", {
                          message:
                            "Spotify token validated and stored in session",
                          sessionId: sid,
                        });
                      } else {
                        void logger.warning("auth", {
                          message:
                            "Invalid Spotify token provided - rejecting session",
                          sessionId: sid,
                        });
                        // Return an error response for invalid tokens
                        res.statusCode = 401;
                        res.setHeader("Content-Type", "application/json");
                        res.end(
                          JSON.stringify({
                            jsonrpc: "2.0",
                            error: {
                              code: -32001,
                              message:
                                "Invalid or expired Spotify credentials provided",
                            },
                            id: null,
                          })
                        );
                        return;
                      }
                    }
                  }
                } catch (error) {
                  void logger.error("auth", {
                    message: "Error during token validation",
                    sessionId: sid,
                    error: (error as Error).message,
                  });
                  // Return an error response for validation failures
                  res.statusCode = 500;
                  res.setHeader("Content-Type", "application/json");
                  res.end(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      error: {
                        code: -32002,
                        message: "Failed to validate credentials",
                      },
                      id: null,
                    })
                  );
                  return;
                }
                void logger.info("mcp", {
                  message: "Session initialized",
                  sessionId: sid,
                });
              }
            : undefined,
        });
        transport = created;
        didCreate = true;
      }

      transport.onerror = (error) => {
        void logger.error("transport", {
          message: "Transport error",
          error: (error as Error).message,
        });
      };

      if (didCreate) {
        await server.connect(transport);
      }
      const sessionId =
        (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
      await runWithRequestContext({ sessionId }, async () => {
        await transport!.handleRequest(req, res, body);
      });

      res.on("close", () => {});
      return toFetchResponse(res);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("MCP POST /mcp error:", (error as Error).message);
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        },
        500
      );
    }
  });

  app.get("/", async (c) => {
    const { req, res } = toReqRes(c.req.raw);
    const sessionIdHeader = c.req.header(MCP_SESSION_HEADER);
    if (!sessionIdHeader) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed - no session" },
          id: null,
        },
        405
      );
    }
    try {
      const transport = transports.get(sessionIdHeader);
      if (!transport) return c.text("Invalid session", 404);
      await runWithRequestContext({ sessionId: sessionIdHeader }, async () => {
        await transport!.handleRequest(req, res);
      });
      return toFetchResponse(res);
    } catch (error) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        },
        500
      );
    }
  });

  app.delete("/", async (c) => {
    const { req, res } = toReqRes(c.req.raw);
    const sessionIdHeader = c.req.header(MCP_SESSION_HEADER);
    if (!sessionIdHeader) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed - no session" },
          id: null,
        },
        405
      );
    }
    try {
      const transport = transports.get(sessionIdHeader);
      if (!transport) return c.text("Invalid session", 404);
      await runWithRequestContext({ sessionId: sessionIdHeader }, async () => {
        await transport!.handleRequest(req, res);
      });
      transports.delete(sessionIdHeader);
      transport.close();
      return toFetchResponse(res);
    } catch (error) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        },
        500
      );
    }
  });

  return app;
}
