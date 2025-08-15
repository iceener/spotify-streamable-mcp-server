import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "../config/env.ts";
import { ensureSession } from "../core/session.ts";
import {
  generateOpaqueToken as genOpaque,
  getRecordByRsRefreshToken,
  storeRsTokenMapping,
  updateSpotifyTokensByRsRefreshToken,
} from "../core/tokens.ts";
import { logger } from "../utils/logger.ts";

type Txn = {
  id: string;
  client_state: string;
  code_challenge: string;
  code_challenge_method: "S256";
  resource?: string;
  sessionId?: string;
  client_redirect_uri?: string;
  spotify?: {
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
    scopes?: string[];
  };
  as_code?: string;
  createdAt: number;
};

const txns = new Map<string, Txn>();

function b64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlEncodeJson(obj: unknown): string {
  try {
    const json = JSON.stringify(obj);
    return b64url(Buffer.from(json, "utf8"));
  } catch {
    return "";
  }
}

function b64urlDecodeJson<T = unknown>(value: string): T | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(padded, "base64");
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    return null;
  }
}

function generateOpaqueToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

// Periodic cleanup of old transactions
setInterval(() => {
  const now = Date.now();
  for (const [tid, txn] of txns) {
    if (now - txn.createdAt > 10 * 60_000) {
      txns.delete(tid);
    }
  }
}, 60_000).unref?.();

export function buildAuthApp(): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const here = new URL(c.req.url);
    const base = `${here.protocol}//${here.host}`;
    const metadata = {
      issuer: base,
      authorization_endpoint:
        config.OAUTH_AUTHORIZATION_URL || `${base}/authorize`,
      token_endpoint: config.OAUTH_TOKEN_URL || `${base}/token`,
      revocation_endpoint: config.OAUTH_REVOCATION_URL || `${base}/revoke`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "client_credentials",
      ],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
      scopes_supported: (config.OAUTH_SCOPES || "").split(" ").filter(Boolean),
    } as const;
    return c.json(metadata);
  });

  // AS /authorize — starts client OAuth (PKCE) and then redirects to Spotify authorize
  app.get("/authorize", (c) => {
    const incoming = new URL(c.req.url);
    const client_state = incoming.searchParams.get("state") ?? randomUUID();
    const code_challenge = incoming.searchParams.get("code_challenge");
    const code_challenge_method = incoming.searchParams.get(
      "code_challenge_method"
    );
    const resource = incoming.searchParams.get("resource") ?? undefined;
    const redirectUri = incoming.searchParams.get("redirect_uri") ?? "";
    const sessionId = incoming.searchParams.get("sid") ?? undefined;

    if (!code_challenge || code_challenge_method !== "S256") {
      return c.json({ error: "invalid_code_challenge" }, 400);
    }

    if (sessionId) {
      try {
        ensureSession(sessionId);
      } catch {}
    }

    logger.info("auth", {
      message: "AS /authorize",
      sessionId,
      client_state,
      resource,
    });

    const txn: Txn = {
      id: genOpaque(),
      client_state,
      code_challenge,
      code_challenge_method: "S256",
      resource,
      sessionId,
      client_redirect_uri: redirectUri || undefined,
      createdAt: Date.now(),
    };
    txns.set(txn.id, txn);

    const spotifyAuth = new URL("/authorize", config.SPOTIFY_ACCOUNTS_URL);
    const scopes = (config.OAUTH_SCOPES || "")
      .split(" ")
      .filter(Boolean)
      .join(" ");
    spotifyAuth.searchParams.set("client_id", config.SPOTIFY_CLIENT_ID || "");
    spotifyAuth.searchParams.set("response_type", "code");
    {
      const fallbackRedirect = `http://127.0.0.1:${
        Number(config.PORT) + 1
      }/spotify/callback`;
      spotifyAuth.searchParams.set(
        "redirect_uri",
        config.REDIRECT_URI || fallbackRedirect
      );
    }
    if (scopes) spotifyAuth.searchParams.set("scope", scopes);
    const compositeState = b64urlEncodeJson({
      tid: txn.id,
      sid: txn.sessionId,
      cs: txn.client_state,
      cr: txn.client_redirect_uri,
      cc: txn.code_challenge,
      ccm: txn.code_challenge_method,
      res: txn.resource,
    });
    spotifyAuth.searchParams.set("state", compositeState || txn.id);
    logger.info("auth", {
      message: "Redirecting to Spotify authorize",
      url: spotifyAuth.toString(),
      redirect_uri: spotifyAuth.searchParams.get("redirect_uri"),
    });
    return c.redirect(spotifyAuth.toString(), 302);
  });

  // AS /token — exchanges our AS code (not Spotify) for RS tokens and supports refresh
  app.post("/token", async (c) => {
    const contentType = c.req.header("content-type") || "";
    const form = new URLSearchParams(
      contentType.includes("application/x-www-form-urlencoded")
        ? await c.req
            .text()
            .then((t) => Object.fromEntries(new URLSearchParams(t)))
        : ((await c.req.json().catch(() => ({}))) as Record<string, string>)
    );

    const grant = form.get("grant_type");
    if (grant === "refresh_token") {
      const rsRefreshToken = form.get("refresh_token") || "";
      const rec = getRecordByRsRefreshToken(rsRefreshToken);
      if (!rec) return c.json({ error: "invalid_grant" }, 400);

      const needsRefresh =
        !rec.spotify.expires_at || Date.now() > rec.spotify.expires_at - 30_000;
      if (needsRefresh && rec.spotify.refresh_token) {
        try {
          const tokenUrl = new URL(
            "/api/token",
            config.SPOTIFY_ACCOUNTS_URL
          ).toString();
          const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: rec.spotify.refresh_token,
          }).toString();
          const basic = Buffer.from(
            `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`
          ).toString("base64");
          const resp = await fetch(tokenUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: `Basic ${basic}`,
            },
            body,
          });
          if (resp.ok) {
            const data = (await resp.json()) as {
              access_token?: string;
              refresh_token?: string;
              expires_in?: number | string;
              scope?: string;
            };
            const expires_at =
              Date.now() + Number(data.expires_in ?? 3600) * 1000;
            const refreshedSpotify = {
              access_token: String(
                data.access_token || rec.spotify.access_token
              ),
              refresh_token:
                (data.refresh_token as string | undefined) ??
                rec.spotify.refresh_token,
              expires_at,
              scopes: String(data.scope || (rec.spotify.scopes || []).join(" "))
                .split(" ")
                .filter(Boolean),
            } as const;
            updateSpotifyTokensByRsRefreshToken(
              rsRefreshToken,
              refreshedSpotify
            );
          } else {
            return c.json({ error: "invalid_grant" }, 400);
          }
        } catch {
          return c.json({ error: "server_error" }, 500);
        }
      }
      const newAccess = genOpaque();
      const updated = updateSpotifyTokensByRsRefreshToken(
        rsRefreshToken,
        getRecordByRsRefreshToken(rsRefreshToken)?.spotify ?? rec.spotify,
        newAccess
      );
      logger.info("auth", {
        message: "RS refresh_token grant",
        rotated: Boolean(updated),
      });
      return c.json({
        access_token: newAccess,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: rsRefreshToken,
        scope: (updated?.spotify.scopes || []).join(" "),
      });
    }

    if (grant !== "authorization_code")
      return c.json({ error: "unsupported_grant_type" }, 400);

    const code = form.get("code") || "";
    const code_verifier = form.get("code_verifier") || "";
    const txn = Array.from(txns.values()).find((t) => t.as_code === code);
    if (!txn) return c.json({ error: "invalid_grant" }, 400);

    const expected = b64url(
      createHash("sha256").update(code_verifier).digest()
    );
    if (expected !== txn.code_challenge)
      return c.json({ error: "invalid_grant" }, 400);
    if (!txn.spotify?.access_token)
      return c.json({ error: "invalid_grant" }, 400);
    const rsAccess = genOpaque();
    const rec = storeRsTokenMapping(rsAccess, txn.spotify);
    logger.info("auth", { message: "AS /token issued RS tokens" });
    txns.delete(txn.id);
    return c.json({
      access_token: rec.rs_access_token,
      refresh_token: rec.rs_refresh_token,
      token_type: "bearer",
      expires_in: 3600,
      scope: (txn.spotify.scopes || []).join(" "),
    });
  });

  app.post("/revoke", async (c) => {
    const revocationUrl = config.OAUTH_REVOCATION_URL;
    if (!revocationUrl)
      return c.json({ error: "OAuth revocation endpoint not configured" }, 501);
    const bodyRaw = await c.req.text().catch(() => "");
    const resp = await fetch(revocationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: bodyRaw,
    });
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: {
        "content-type": resp.headers.get("content-type") || "application/json",
      },
    });
  });

  app.post("/register", async (c) => {
    const here = new URL(c.req.url);
    const base = `${here.protocol}//${here.host}`;
    const requested = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const now = Math.floor(Date.now() / 1000);
    const client_id = randomUUID();
    return c.json(
      {
        client_id,
        client_id_issued_at: now,
        client_secret_expires_at: 0,
        token_endpoint_auth_method: "none",
        redirect_uris: Array.isArray(requested?.redirect_uris)
          ? requested.redirect_uris
          : [config.OAUTH_REDIRECT_URI],
        registration_client_uri: `${base}/register/${client_id}`,
        registration_access_token: randomUUID(),
      },
      201
    );
  });

  // Spotify callback → exchange code for tokens; issue AS code back to client
  app.get("/spotify/callback", async (c) => {
    try {
      const url = new URL(c.req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return c.text("Invalid callback", 400);

      let txn = txns.get(state);
      if (!txn) {
        const decoded = b64urlDecodeJson<{
          tid?: string;
          sid?: string;
          cs?: string;
          cr?: string;
          cc?: string;
          ccm?: "S256";
          res?: string;
        }>(state);
        if (decoded?.tid) {
          txn = txns.get(decoded.tid);
          if (!txn) {
            txn = {
              id: decoded.tid,
              client_state: decoded.cs || randomUUID(),
              code_challenge: decoded.cc || "",
              code_challenge_method: decoded.ccm || "S256",
              resource: decoded.res,
              sessionId: decoded.sid,
              client_redirect_uri: decoded.cr,
              createdAt: Date.now(),
            };
            txns.set(txn.id, txn);
          }
        }
      }
      if (!txn) return c.text("Unknown transaction", 400);

      const tokenUrl = new URL(
        "/api/token",
        config.SPOTIFY_ACCOUNTS_URL
      ).toString();
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri:
          config.REDIRECT_URI ||
          `http://127.0.0.1:${Number(config.PORT) + 1}/spotify/callback`,
      }).toString();
      const basic = Buffer.from(
        `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`
      ).toString("base64");
      const resp = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body,
      });
      if (!resp.ok) {
        const t = await resp.text();
        return c.text(`Spotify token error: ${t}`, 500);
      }
      const data = (await resp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number | string;
        scope?: string;
      };
      const expires_at = Date.now() + Number(data.expires_in ?? 3600) * 1000;
      const tokenPayload = {
        access_token: data.access_token as string,
        refresh_token:
          (data.refresh_token as string | undefined) ??
          txn.spotify?.refresh_token,
        expires_at,
        scopes: String(data.scope || "")
          .split(" ")
          .filter(Boolean),
      } as const;
      if (txn.sessionId) {
        const s = ensureSession(txn.sessionId);
        s.spotify = { ...tokenPayload };
        logger.info("auth", {
          message: "Stored Spotify tokens for session",
          sessionId: txn.sessionId,
          scopes: s.spotify.scopes,
          expires_at,
        });
      }
      txn.spotify = { ...tokenPayload };
      txns.set(state, txn);

      txn.as_code = genOpaque();
      txns.set(state, txn);
      const redirectTargetCandidate =
        txn.client_redirect_uri || config.OAUTH_REDIRECT_URI;
      const allowListRaw = config.OAUTH_REDIRECT_ALLOWLIST || "";
      const allowed = new Set(
        allowListRaw
          .split(",")
          .map((value: string) => value.trim())
          .filter(Boolean)
          .concat([config.OAUTH_REDIRECT_URI])
      );
      const isAllowedRedirect = (u: string) => {
        try {
          const url = new URL(u);
          if (config.NODE_ENV === "development") {
            const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
            if (loopbackHosts.has(url.hostname)) return true;
          }
          return (
            allowed.has(`${url.protocol}//${url.host}${url.pathname}`) ||
            allowed.has(u)
          );
        } catch {
          return false;
        }
      };
      const redirectTarget = isAllowedRedirect(redirectTargetCandidate)
        ? redirectTargetCandidate
        : config.OAUTH_REDIRECT_URI;
      const redirect = new URL(redirectTarget);
      redirect.searchParams.set("code", txn.as_code);
      redirect.searchParams.set("state", txn.client_state);
      logger.info("auth", {
        message: "Redirecting back to client",
        redirect: redirect.toString(),
        sessionId: txn.sessionId,
        txnId: txn.id,
      });
      return c.redirect(redirect.toString(), 302);
    } catch (e) {
      return c.text(`Callback error: ${(e as Error).message}`, 500);
    }
  });

  return app;
}
