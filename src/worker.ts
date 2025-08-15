/*
 Minimal MCP server over Streamable HTTP for Cloudflare Workers
 - Implements initialize, notifications/initialized (ack), tools/list, tools/call
 - Stateless by default; returns JSON for requests; GET /mcp returns 405
*/

import { Router } from "itty-router";
import { serverMetadata } from "./config/metadata.ts";

type JsonRpcId = string | number;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

let SUPPORTED_PROTOCOL_VERSION = "2025-06-18";
const MCP_ENDPOINT_PATH = "/mcp";
let AUTH_ENABLED_FLAG = false; // set from env in fetch
const SERVER_NAME = "spotify-mcp-worker";
const SERVER_VERSION = "0.1.0";

// Minimal in-memory Authorization Server state (dev-only)
type Txn = {
  codeChallenge: string; // PKCE: base64url(SHA-256(code_verifier))
  state?: string;
  scope?: string;
  createdAt: number;
};
const txns = new Map<string, Txn>();
const codes = new Map<string, string>(); // code -> txnId

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256B64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return b64urlEncode(new Uint8Array(digest));
}

type Tool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content?: Array<unknown>;
    structuredContent?: unknown;
    isError?: boolean;
  }>;
};

const tools: Record<string, Tool> = {
  health: {
    name: "health",
    title: "Health",
    description: "Server health",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  },
};

function ok(id: JsonRpcId, result: unknown): Response {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
  data?: unknown
): Response {
  const body: JsonRpcResponse = {
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function negotiateProtocol(req: Request): { ok: boolean; version: string } {
  const raw = req.headers.get("MCP-Protocol-Version");
  if (!raw) {
    return { ok: true, version: SUPPORTED_PROTOCOL_VERSION };
  }
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const match = values.find((v) => v === SUPPORTED_PROTOCOL_VERSION);
  return match ? { ok: true, version: match } : { ok: false, version: raw };
}

async function handleRpc(req: Request): Promise<Response> {
  const { ok: versionOk } = negotiateProtocol(req);
  if (!versionOk) {
    return new Response("Bad Request: unsupported MCP-Protocol-Version", {
      status: 400,
    });
  }

  let payload: JsonRpcRequest;
  let raw = "";
  try {
    raw = await req.text();
  } catch {}
  try {
    payload = JSON.parse(raw || "{}") as JsonRpcRequest;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (payload?.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    return new Response("Bad Request", { status: 400 });
  }

  const { id, method, params } = payload;
  if (!("id" in payload) || typeof id === "undefined") {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case "initialize": {
      const result = {
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: {
          name: serverMetadata.title,
          title: serverMetadata.title,
          version: SERVER_VERSION,
        },
        instructions: serverMetadata.instructions,
      } as const;
      return ok(id, result);
    }
    case "tools/list": {
      const items = Object.values(tools).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return ok(id, { tools: items });
    }
    case "tools/call": {
      const name = (params as Record<string, unknown>)?.name;
      const args = (params as Record<string, unknown>)?.arguments as
        | Record<string, unknown>
        | undefined;
      if (typeof name !== "string") {
        return error(id, -32602, "Invalid params: name");
      }
      const tool = tools[name];
      if (!tool) {
        return error(id, -32602, `Unknown tool: ${name}`);
      }
      const result = await tool.handler(args ?? {});
      return ok(id, result);
    }
    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}

const router = Router();

function withCors(resp: Response): Response {
  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id"
  );
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(resp.body, { status: resp.status, headers });
}

router.options(MCP_ENDPOINT_PATH, async () =>
  withCors(new Response(null, { status: 204 }))
);
router.post(MCP_ENDPOINT_PATH, async (request: Request) =>
  (async () => {
    if (AUTH_ENABLED_FLAG) {
      const auth = request.headers.get("authorization");
      if (!auth) {
        const origin = new URL(request.url).origin;
        const resourceMd = `${origin}/.well-known/oauth-protected-resource`;
        const unauthorized = new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Unauthorized" },
            id: null,
          }),
          { status: 401 }
        );
        unauthorized.headers.set(
          "WWW-Authenticate",
          `Bearer realm="MCP", authorization_uri="${resourceMd}"`
        );
        return withCors(unauthorized);
      }
    }
    return withCors(await handleRpc(request));
  })()
);
router.get(MCP_ENDPOINT_PATH, async () =>
  withCors(new Response("Method Not Allowed", { status: 405 }))
);
router.get("/health", async () =>
  withCors(
    new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  )
);
router.get(
  "/.well-known/oauth-authorization-server",
  async (request: Request) =>
    withCors(
      new Response(
        JSON.stringify({
          issuer: new URL(request.url).origin,
          authorization_endpoint: `${new URL(request.url).origin}/authorize`,
          token_endpoint: `${new URL(request.url).origin}/token`,
          registration_endpoint: `${new URL(request.url).origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["mcp"],
        }),
        {
          headers: { "content-type": "application/json; charset=utf-8" },
        }
      )
    )
);

router.get("/.well-known/oauth-protected-resource", async (request: Request) =>
  withCors(
    new Response(
      JSON.stringify({
        authorization_servers: [
          `${
            new URL(request.url).origin
          }/.well-known/oauth-authorization-server`,
        ],
        resource: `${new URL(request.url).origin}${MCP_ENDPOINT_PATH}`,
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } }
    )
  )
);

router.get("/authorize", async (request: Request) => {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? undefined;
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const redirectUri = url.searchParams.get("redirect_uri");
  const scope = url.searchParams.get("scope") ?? undefined;
  if (!redirectUri) {
    return withCors(
      new Response("invalid_request: redirect_uri", { status: 400 })
    );
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return withCors(new Response("invalid_request: pkce", { status: 400 }));
  }
  const txnId = crypto.randomUUID();
  txns.set(txnId, { codeChallenge, state, scope, createdAt: Date.now() });
  const code = crypto.randomUUID();
  codes.set(code, txnId);
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) {
    redirect.searchParams.set("state", state);
  }
  return withCors(Response.redirect(redirect.toString(), 302));
});

router.post("/token", async (request: Request) => {
  const contentType = request.headers.get("content-type") || "";
  const params = contentType.includes("application/x-www-form-urlencoded")
    ? new URLSearchParams(await request.text())
    : new URLSearchParams((await request.json().catch(() => ({}))) as any);
  const grant = params.get("grant_type");
  if (grant === "refresh_token") {
    const refresh = params.get("refresh_token") || crypto.randomUUID();
    return withCors(
      new Response(
        JSON.stringify({
          access_token: crypto.randomUUID(),
          refresh_token: refresh,
          token_type: "bearer",
          expires_in: 3600,
        }),
        { headers: { "content-type": "application/json; charset=utf-8" } }
      )
    );
  }
  if (grant !== "authorization_code") {
    return withCors(
      new Response(JSON.stringify({ error: "unsupported_grant_type" }), {
        status: 400,
      })
    );
  }
  const code = params.get("code") || "";
  const codeVerifier = params.get("code_verifier") || "";
  const txnId = codes.get(code);
  if (!txnId) {
    return withCors(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    );
  }
  const txn = txns.get(txnId);
  if (!txn) {
    return withCors(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    );
  }
  const expected = txn.codeChallenge;
  const actual = await sha256B64Url(codeVerifier);
  if (expected !== actual) {
    return withCors(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    );
  }
  // success
  txns.delete(txnId);
  codes.delete(code);
  return withCors(
    new Response(
      JSON.stringify({
        access_token: crypto.randomUUID(),
        refresh_token: crypto.randomUUID(),
        token_type: "bearer",
        expires_in: 3600,
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } }
    )
  );
});

// Minimal Dynamic Client Registration stub
router.post("/register", async (request: Request) => {
  const base = new URL(request.url).origin;
  const now = Math.floor(Date.now() / 1000);
  const client_id = crypto.randomUUID();
  return withCors(
    new Response(
      JSON.stringify({
        client_id,
        client_id_issued_at: now,
        client_secret_expires_at: 0,
        token_endpoint_auth_method: "none",
        registration_client_uri: `${base}/register/${client_id}`,
        registration_access_token: crypto.randomUUID(),
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } }
    )
  );
});

router.all("*", (_request: Request) =>
  withCors(new Response("Not Found", { status: 404 }))
);

export default {
  fetch(
    request: Request,
    env?: Record<string, string>
  ): Promise<Response> | Response {
    if (env && typeof env.AUTH_ENABLED === "string") {
      AUTH_ENABLED_FLAG = env.AUTH_ENABLED.toLowerCase() === "true";
    }
    if (env && typeof env.MCP_PROTOCOL_VERSION === "string") {
      SUPPORTED_PROTOCOL_VERSION = env.MCP_PROTOCOL_VERSION;
    }
    const url = new URL(request.url);
    // Normalize duplicate slashes in pathname (e.g., //authorize → /authorize)
    const normalizedPath = url.pathname.replace(/\/{2,}/g, "/");
    if (normalizedPath !== url.pathname) {
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedPath;
      const normalizedRequest = new Request(normalizedUrl.toString(), request);
      return router.handle(normalizedRequest);
    }
    if (url.pathname === "/") {
      return withCors(
        new Response(
          JSON.stringify({
            message: "MCP server alive",
            endpoint: MCP_ENDPOINT_PATH,
            protocolVersion: SUPPORTED_PROTOCOL_VERSION,
          }),
          { headers: { "content-type": "application/json; charset=utf-8" } }
        )
      );
    }
    return router.handle(request);
  },
};
