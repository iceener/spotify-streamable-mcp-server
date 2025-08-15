/*
 Minimal MCP server over Streamable HTTP for Cloudflare Workers
 Parity with linear Worker: 401 challenges, PKCE OAuth, RS mapping, and tools.
*/

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Router } from "itty-router";
import { z, ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  deleteCode,
  deleteTransaction,
  getSpotifyTokensByRsAccessToken,
  getRecordByRsRefreshToken,
  getTransaction,
  getTxnIdByCode,
  saveCode,
  saveTransaction,
  setAuthStoreEnv,
  storeRsTokenMapping,
  updateSpotifyTokensByRsRefreshToken,
} from "./auth/store.ts";
import { serverMetadata } from "./config/metadata.ts";
import { runWithRequestContext } from "./core/context.ts";
import { ensureSession } from "./core/session.ts";
import { registerTools } from "./tools/index.ts";

const MCP_ENDPOINT_PATH = "/mcp";

function getProtocolVersion(): string {
  const v = (
    globalThis as unknown as { process?: { env?: Record<string, unknown> } }
  )?.process?.env?.MCP_PROTOCOL_VERSION as string | undefined;
  return v || "2025-06-18";
}

type ToolRecord = {
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

const tools: Record<string, ToolRecord> = {};

type RegisterSchema = {
  description?: string;
  inputSchema: Record<string, unknown> | ZodTypeAny;
  annotations?: { title?: string };
};

type RegisterHandler = (args: unknown) => Promise<unknown>;

const adapter: {
  registerTool: (
    name: string,
    schema: RegisterSchema,
    handler: RegisterHandler
  ) => void;
} = {
  registerTool(name, schema, handler) {
    function toJsonSchema(input: unknown): Record<string, unknown> {
      try {
        if (
          input &&
          typeof input === "object" &&
          ("$schema" in (input as Record<string, unknown>) ||
            "type" in (input as Record<string, unknown>))
        ) {
          return input as Record<string, unknown>;
        }
        const isZod =
          input &&
          typeof input === "object" &&
          input !== null &&
          "_def" in (input as Record<string, unknown>);
        if (isZod) {
          const json = zodToJsonSchema(input as ZodTypeAny, {
            $refStrategy: "none",
          });
          return json as unknown as Record<string, unknown>;
        }
        if (input && typeof input === "object") {
          const values = Object.values(input as Record<string, unknown>);
          const looksLikeShape =
            values.length > 0 &&
            values.every(
              (v) =>
                v &&
                typeof v === "object" &&
                "_def" in (v as Record<string, unknown>)
            );
          if (looksLikeShape) {
            const obj = z.object(input as Record<string, ZodTypeAny>);
            const json = zodToJsonSchema(obj, { $refStrategy: "none" });
            return json as unknown as Record<string, unknown>;
          }
        }
      } catch {}
      return (input ?? {}) as Record<string, unknown>;
    }

    const wrappedHandler: ToolRecord["handler"] = async (args) => {
      const result = await handler(args);
      return result as {
        content?: Array<unknown>;
        structuredContent?: unknown;
        isError?: boolean;
      };
    };
    tools[name] = {
      name,
      title: schema.annotations?.title,
      description: schema.description,
      inputSchema: toJsonSchema(schema.inputSchema),
      handler: wrappedHandler,
    };
  },
};

registerTools(adapter as unknown as McpServer);

function ok(id: string | number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(
  id: string | number | undefined,
  code: number,
  message: string
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    {
      headers: { "content-type": "application/json; charset=utf-8" },
    }
  );
}

function withCors(resp: Response): Response {
  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id"
  );
  headers.set(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, Mcp-Session-Id"
  );
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(resp.body, { status: resp.status, headers });
}

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const env =
      (globalThis as unknown as { process?: { env?: Record<string, unknown> } })
        ?.process?.env ?? {};
    const allowAll =
      String(env.OAUTH_REDIRECT_ALLOW_ALL || "false").toLowerCase() === "true";
    if (allowAll) return true;
    const allowRaw = String(env.OAUTH_REDIRECT_ALLOWLIST || "");
    const allowed = new Set(
      allowRaw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .concat([String(env.OAUTH_REDIRECT_URI || "alice://oauth/callback")])
    );
    const u = new URL(uri);
    const isDev = String(env.NODE_ENV || "development") === "development";
    if (isDev) {
      const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
      if (loopback.has(u.hostname)) return true;
    }
    return (
      allowed.has(`${u.protocol}//${u.host}${u.pathname}`) ||
      allowed.has(u.toString())
    );
  } catch {
    return false;
  }
}

const router = Router();

router.options(MCP_ENDPOINT_PATH, async () =>
  withCors(new Response(null, { status: 204 }))
);

router.post(MCP_ENDPOINT_PATH, async (request: Request) => {
  const headerRecord: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headerRecord[String(key).toLowerCase()] = String(value);
  });

  const incomingSid = request.headers.get("Mcp-Session-Id");
  const sid =
    incomingSid && incomingSid.trim() ? incomingSid : crypto.randomUUID();
  try {
    ensureSession(sid);
  } catch {}

  const challenge = (origin: string): Response => {
    const resourceMd = `${origin}/.well-known/oauth-protected-resource?sid=${encodeURIComponent(
      sid
    )}`;
    const resp = new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Unauthorized" },
        id: null,
      }),
      { status: 401 }
    );
    resp.headers.set(
      "WWW-Authenticate",
      `Bearer realm="MCP", authorization_uri="${resourceMd}"`
    );
    resp.headers.set("Mcp-Session-Id", sid);
    return withCors(resp);
  };

  const env =
    (globalThis as unknown as { process?: { env?: Record<string, unknown> } })
      ?.process?.env ?? {};
  const authEnabled =
    String(env.AUTH_ENABLED || "false").toLowerCase() === "true";
  const requireRs =
    String(env.AUTH_REQUIRE_RS || "false").toLowerCase() === "true";
  const allowProviderBearer =
    String(
      (env as Record<string, unknown>).AUTH_ALLOW_DIRECT_BEARER ||
        (env as Record<string, unknown>).AUTH_ALLOW_LINEAR_BEARER ||
        "false"
    )
      .toString()
      .toLowerCase() === "true";

  const authHeaderIn = headerRecord.authorization;
  const apiKeyHeader =
    headerRecord["x-api-key"] || headerRecord["x-auth-token"];

  if (authEnabled && !authHeaderIn && !apiKeyHeader) {
    const origin = new URL(request.url).origin;
    return challenge(origin);
  }

  let rsMapped = false;
  let bearer: string | undefined = undefined;
  if (authHeaderIn) {
    const m = authHeaderIn.match(/^\s*Bearer\s+(.+)$/i);
    bearer = m?.[1];
    if (bearer) {
      try {
        const mapped = await getSpotifyTokensByRsAccessToken(bearer);
        if (mapped?.access_token) {
          headerRecord.authorization = `Bearer ${mapped.access_token}`;
          rsMapped = true;
        }
      } catch {}
    }
  }

  if (authEnabled && requireRs && bearer && !rsMapped && !allowProviderBearer) {
    const origin = new URL(request.url).origin;
    return challenge(origin);
  }

  return runWithRequestContext(
    {
      sessionId: sid,
      spotifyAccessToken:
        rsMapped && headerRecord.authorization
          ? headerRecord.authorization.replace(/^\s*Bearer\s+/i, "")
          : undefined,
    },
    async () => {
      const raw = await request.text();
      const payload = (raw ? JSON.parse(raw) : {}) as {
        jsonrpc?: string;
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (payload?.jsonrpc !== "2.0" || typeof payload.method !== "string") {
        return withCors(new Response("Bad Request", { status: 400 }));
      }
      const { id, method, params } = payload;
      if (!("id" in payload) || typeof id === "undefined") {
        return withCors(new Response(null, { status: 202 }));
      }

      if (method === "initialize") {
        return withCors(
          ok(id, {
            protocolVersion: getProtocolVersion(),
            capabilities: { tools: { listChanged: true } },
            serverInfo: {
              name: serverMetadata.title,
              title: serverMetadata.title,
              version: (env.MCP_VERSION as string) || "0.1.0",
            },
            instructions: serverMetadata.instructions,
          })
        );
      }
      if (method === "tools/list") {
        const list = Object.values(tools).map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        return withCors(ok(id, { tools: list }));
      }
      if (method === "resources/list") {
        return withCors(ok(id, { resources: [] }));
      }
      if (method === "prompts/list") {
        return withCors(ok(id, { prompts: [] }));
      }
      if (method === "tools/call") {
        const nameValue = (params as Record<string, unknown> | undefined)?.name;
        const name = typeof nameValue === "string" ? nameValue : undefined;
        const argsValue = (params as Record<string, unknown> | undefined)
          ?.arguments;
        const args =
          typeof argsValue === "object" &&
          argsValue !== null &&
          !Array.isArray(argsValue)
            ? (argsValue as Record<string, unknown>)
            : ({} as Record<string, unknown>);
        if (!name || !tools[name]) {
          return withCors(error(id, -32602, `Unknown tool: ${String(name)}`));
        }
        try {
          const tool = tools[name];
          const result = await tool?.handler(args);
          return withCors(ok(id, result));
        } catch (e) {
          return withCors(
            ok(id, {
              isError: true,
              content: [
                { type: "text", text: `Tool failed: ${(e as Error).message}` },
              ],
            })
          );
        }
      }
      return withCors(error(id, -32601, `Method not found: ${method}`));
    }
  );
});

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
  async (request: Request) => {
    const base = new URL(request.url).origin;
    const env =
      (globalThis as unknown as { process?: { env?: Record<string, unknown> } })
        ?.process?.env ?? {};
    const scopes = String(env.OAUTH_SCOPES || "")
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return withCors(
      new Response(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: scopes.length ? scopes : ["mcp"],
        }),
        { headers: { "content-type": "application/json; charset=utf-8" } }
      )
    );
  }
);

router.get(
  "/.well-known/oauth-protected-resource",
  async (request: Request) => {
    const here = new URL(request.url);
    const base = here.origin;
    const sid = here.searchParams.get("sid") ?? undefined;
    const resourceBase = `${base}${MCP_ENDPOINT_PATH}`;
    const resourceUrl = (() => {
      try {
        if (!sid) return resourceBase;
        const u = new URL(resourceBase);
        u.searchParams.set("sid", sid);
        return u.toString();
      } catch {
        return resourceBase;
      }
    })();
    return withCors(
      new Response(
        JSON.stringify({
          authorization_servers: [
            `${base}/.well-known/oauth-authorization-server`,
          ],
          resource: resourceUrl,
        }),
        { headers: { "content-type": "application/json; charset=utf-8" } }
      )
    );
  }
);

router.get("/authorize", async (request: Request) => {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? undefined;
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const redirectUri = url.searchParams.get("redirect_uri");
  const scope = url.searchParams.get("scope") ?? undefined;
  const sid =
    url.searchParams.get("sid") ||
    request.headers.get("Mcp-Session-Id") ||
    undefined;

  if (!redirectUri) {
    return withCors(
      new Response("invalid_request: redirect_uri", { status: 400 })
    );
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return withCors(new Response("invalid_request: pkce", { status: 400 }));
  }
  const here = new URL(request.url);
  const base = here.origin;
  const txnId = crypto.randomUUID();
  await saveTransaction(txnId, {
    codeChallenge,
    state,
    scope,
    createdAt: Date.now(),
  });

  const env =
    (globalThis as unknown as { process?: { env?: Record<string, unknown> } })
      ?.process?.env ?? {};
  const clientId = (env.SPOTIFY_CLIENT_ID as string) || undefined;
  const accountsBase =
    (env.SPOTIFY_ACCOUNTS_URL as string) || "https://accounts.spotify.com";
  const oauthAuthUrl =
    (env.OAUTH_AUTHORIZATION_URL as string) || `${accountsBase}/authorize`;
  const scopeParam = String(env.OAUTH_SCOPES || scope || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
  if (clientId) {
    const cb = new URL("/spotify/callback", base).toString();
    const composite = btoa(
      JSON.stringify({ tid: txnId, cs: state, cr: redirectUri, sid })
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const authUrl = new URL(oauthAuthUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", cb);
    if (scopeParam) authUrl.searchParams.set("scope", scopeParam);
    if (composite) authUrl.searchParams.set("state", composite);
    return withCors(Response.redirect(authUrl.toString(), 302));
  }
  const code = crypto.randomUUID();
  await saveCode(code, txnId);
  const target = isAllowedRedirectUri(redirectUri)
    ? redirectUri
    : (env.OAUTH_REDIRECT_URI as string) || "alice://oauth/callback";
  const redirect = new URL(target);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  return withCors(Response.redirect(redirect.toString(), 302));
});

router.post("/register", async (request: Request) => {
  const base = new URL(request.url).origin;
  const now = Math.floor(Date.now() / 1000);
  const client_id = crypto.randomUUID();
  const ct = request.headers.get("content-type") || "";
  let body: Record<string, unknown> = {};
  try {
    if (ct.includes("application/json")) {
      body = (await request.json()) as Record<string, unknown>;
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      const form = new URLSearchParams(await request.text());
      body = Object.fromEntries(form.entries());
    }
  } catch {}
  const redirect_urisRaw = (body.redirect_uris as unknown) ?? [];
  const redirect_uris = Array.isArray(redirect_urisRaw)
    ? (redirect_urisRaw as unknown[]).filter((u) => typeof u === "string")
    : typeof redirect_urisRaw === "string"
    ? [redirect_urisRaw]
    : [];
  const token_endpoint_auth_method =
    (body.token_endpoint_auth_method as string) || "none";
  const grant_typesRaw = (body.grant_types as unknown) ?? undefined;
  const grant_types = Array.isArray(grant_typesRaw)
    ? (grant_typesRaw as unknown[]).filter((v) => typeof v === "string")
    : ["authorization_code", "refresh_token"];
  const response_typesRaw = (body.response_types as unknown) ?? undefined;
  const response_types = Array.isArray(response_typesRaw)
    ? (response_typesRaw as unknown[]).filter((v) => typeof v === "string")
    : ["code"];
  const client_name =
    typeof body.client_name === "string"
      ? (body.client_name as string)
      : undefined;

  return withCors(
    new Response(
      JSON.stringify({
        client_id,
        client_id_issued_at: now,
        client_secret_expires_at: 0,
        token_endpoint_auth_method,
        registration_client_uri: `${base}/register/${client_id}`,
        registration_access_token: crypto.randomUUID(),
        redirect_uris,
        grant_types,
        response_types,
        ...(client_name ? { client_name } : {}),
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } }
    )
  );
});

router.get("/spotify/callback", async (request: Request) => {
  try {
    const here = new URL(request.url);
    const code = here.searchParams.get("code");
    const state = here.searchParams.get("state");
    if (!code || !state) {
      return withCors(new Response("invalid_callback", { status: 400 }));
    }
    let decoded: { tid?: string; cs?: string; cr?: string; sid?: string } = {};
    try {
      const padded = state.replace(/-/g, "+").replace(/_/g, "/");
      decoded = JSON.parse(atob(padded)) as typeof decoded;
    } catch {}
    const txnId = decoded.tid || state;
    const txn = await getTransaction(txnId);
    if (!txn) {
      return withCors(new Response("unknown_txn", { status: 400 }));
    }
    const env =
      (globalThis as unknown as { process?: { env?: Record<string, unknown> } })
        ?.process?.env ?? {};
    const clientId = String(env.SPOTIFY_CLIENT_ID || "");
    const clientSecret = String(env.SPOTIFY_CLIENT_SECRET || "");
    const accountsBase = String(
      env.SPOTIFY_ACCOUNTS_URL || "https://accounts.spotify.com"
    );
    const tokenUrl = String(env.OAUTH_TOKEN_URL || `${accountsBase}/api/token`);
    if (!clientId || !clientSecret) {
      return withCors(new Response("missing_client", { status: 500 }));
    }
    const cb = new URL("/spotify/callback", here.origin).toString();
    const basic = btoa(`${clientId}:${clientSecret}`);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cb,
    });
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
      },
      body: form.toString(),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return withCors(
        new Response(`spotify_token_error: ${resp.status} ${t}`.trim(), {
          status: 500,
        })
      );
    }
    const data = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number | string;
      scope?: string;
    };
    const access_token = String(data.access_token || "");
    if (!access_token) {
      return withCors(new Response("spotify_no_token", { status: 500 }));
    }
    const scopes = String(data.scope || "")
      .split(" ")
      .filter(Boolean);
    const refresh_token = data.refresh_token as string | undefined;
    const expires_at = Date.now() + Number(data.expires_in ?? 3600) * 1000;
    const asCode = crypto.randomUUID();
    await saveCode(asCode, txnId);
    await saveTransaction(txnId, {
      ...txn,
      spotify: { access_token, refresh_token, expires_at, scopes },
    });

    const clientRedirect =
      decoded.cr || String(env.OAUTH_REDIRECT_URI || "alice://oauth/callback");
    const safe = isAllowedRedirectUri(clientRedirect)
      ? clientRedirect
      : String(env.OAUTH_REDIRECT_URI || "alice://oauth/callback");
    if (!safe || String(safe).trim() === "") {
      return withCors(new Response("redirect_not_allowed", { status: 400 }));
    }
    const redirect = new URL(safe);
    redirect.searchParams.set("code", asCode);
    if (decoded.cs) redirect.searchParams.set("state", decoded.cs);
    const sid = decoded.sid;
    if (sid) {
      try {
        const s = ensureSession(sid);
        s.spotify = { access_token, refresh_token, expires_at, scopes };
      } catch {}
    }
    return withCors(Response.redirect(redirect.toString(), 302));
  } catch {
    return withCors(new Response("spotify_callback_error", { status: 500 }));
  }
});

router.post("/token", async (request: Request) => {
  const contentType = request.headers.get("content-type") || "";
  const params = contentType.includes("application/x-www-form-urlencoded")
    ? new URLSearchParams(await request.text())
    : new URLSearchParams(
        (await request.json().catch(() => ({}))) as Record<string, string>
      );
  const grant = params.get("grant_type");

  if (grant === "refresh_token") {
    const rsRefresh = params.get("refresh_token") || "";
    const rec = await getRecordByRsRefreshToken(rsRefresh);
    if (!rec) {
      return withCors(
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        })
      );
    }
    const newAccess = crypto.randomUUID();
    const updated = await updateSpotifyTokensByRsRefreshToken(
      rsRefresh,
      rec.spotify,
      newAccess
    );
    return withCors(
      new Response(
        JSON.stringify({
          access_token: newAccess,
          refresh_token: rsRefresh,
          token_type: "bearer",
          expires_in: 3600,
          scope: (updated?.spotify.scopes || []).join(" "),
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
  const txnId = await getTxnIdByCode(code);
  if (!txnId) {
    return withCors(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    );
  }
  const txn = await getTransaction(txnId);
  if (!txn) {
    return withCors(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    );
  }
  // Verify PKCE S256(code_verifier) equals stored codeChallenge
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  if (txn.codeChallenge !== base64) {
    return withCors(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    );
  }
  const rsAccess = crypto.randomUUID();
  const rsRefresh = crypto.randomUUID();
  const spotifyTokens = (
    txn as unknown as {
      spotify?: {
        access_token: string;
        refresh_token?: string;
        expires_at?: number;
        scopes?: string[];
      };
    }
  ).spotify;
  if (spotifyTokens?.access_token) {
    await storeRsTokenMapping(rsAccess, spotifyTokens, rsRefresh);
  }
  await Promise.all([deleteTransaction(txnId), deleteCode(code)]);
  return withCors(
    new Response(
      JSON.stringify({
        access_token: rsAccess,
        refresh_token: rsRefresh,
        token_type: "bearer",
        expires_in: 3600,
        scope:
          (spotifyTokens?.scopes || []).join(" ") ||
          txn.scope ||
          String(
            ((
              globalThis as unknown as {
                process?: { env?: Record<string, unknown> };
              }
            )?.process?.env?.OAUTH_SCOPES as string) || ""
          ).trim(),
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } }
    )
  );
});

router.all("*", () => withCors(new Response("Not Found", { status: 404 })));

export default {
  fetch(
    request: Request,
    env?: Record<string, unknown>
  ): Promise<Response> | Response {
    if (env) {
      const g = globalThis as unknown as {
        process?: { env?: Record<string, unknown> };
      };
      const existingEnv = (g.process?.env ?? {}) as Record<string, unknown>;
      g.process = g.process || {};
      g.process.env = { ...existingEnv, ...(env as Record<string, unknown>) };
      setAuthStoreEnv(env as Record<string, unknown>);
    }
    const url = new URL(request.url);
    // Forward POST / to /mcp for clients using base URL
    if (url.pathname === "/" && request.method.toUpperCase() === "POST") {
      const forwarded = new Request(
        new URL(MCP_ENDPOINT_PATH, url).toString(),
        request
      );
      return router.handle(forwarded);
    }
    // Normalize duplicate slashes
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
            message: "Spotify MCP Worker",
            endpoint: MCP_ENDPOINT_PATH,
            protocolVersion: getProtocolVersion(),
          }),
          { headers: { "content-type": "application/json; charset=utf-8" } }
        )
      );
    }
    return router.handle(request);
  },
};
