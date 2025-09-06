import { config } from "../config/env.ts";
import { SpotifyTokenResponseCodec } from "../types/spotify.codecs.ts";
import { logger } from "../utils/logger.ts";
import {
  getCurrentSessionId,
  getCurrentSpotifyAccessToken,
} from "./context.ts";
import { getSession } from "./session.ts";
import { createHttpClient } from "../services/http-client.ts";
import { apiBase } from "../utils/spotify.ts";

const http = createHttpClient({
  baseHeaders: {
    "Content-Type": "application/json",
    "User-Agent": `mcp-spotify/${config.MCP_VERSION}`,
  },
  rateLimit: { rps: 5, burst: 10 },
  timeout: 10000, // Shorter timeout for validation
  retries: 0, // No retries for validation
});

/**
 * Validates a Spotify access token by making a lightweight API call
 * @param accessToken The access token to validate
 * @returns true if token is valid, false if expired/invalid
 */
export async function validateSpotifyToken(
  accessToken: string
): Promise<boolean> {
  try {
    const base = apiBase(config.SPOTIFY_API_URL);
    const response = await http(new URL("me", base).toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000), // Quick validation
    });

    // 200 OK means token is valid
    return response.status === 200;
  } catch (error) {
    await logger.warning("auth", {
      message: "Token validation failed",
      error: (error as Error).message,
    });
    return false;
  }
}

export async function getUserBearer(): Promise<string | null> {
  // Linear-style: prefer per-request token passed via context from the Worker
  const fromContext = getCurrentSpotifyAccessToken();
  if (fromContext && fromContext.trim()) {
    return fromContext;
  }
  const sessionId = getCurrentSessionId();
  if (!sessionId) return null;
  const session = getSession(sessionId);
  const token = session?.spotify?.access_token ?? null;
  const expiresAt = session?.spotify?.expires_at ?? 0;
  const refreshToken = session?.spotify?.refresh_token;
  if (!token) return null;

  if (refreshToken && Date.now() > expiresAt - 30_000) {
    const tokenUrl = new URL(
      "/api/token",
      config.SPOTIFY_ACCOUNTS_URL
    ).toString();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString();

    // Minimal, bounded retry with jittered backoff
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!config.SPOTIFY_CLIENT_ID || !config.SPOTIFY_CLIENT_SECRET) {
          await logger.warning("auth", {
            message:
              "Missing Spotify client credentials; cannot refresh access token",
          });
          // If still valid, prefer returning the current token; otherwise fail
          return Date.now() <= expiresAt ? token : null;
        }
        const basic = Buffer.from(
          `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`
        ).toString("base64");

        const resp = await fetch(tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            Authorization: `Basic ${basic}`,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });

        if (resp.ok) {
          const parsed = SpotifyTokenResponseCodec.safeParse(await resp.json());
          if (!parsed.success) {
            await logger.warning("auth", {
              message:
                "Silent refresh returned invalid payload; using cached token",
              issues: parsed.error.issues.map((i) => ({
                path: i.path,
                code: i.code,
              })),
            });
            return token;
          }
          const data = parsed.data;
          const newAccess = data.access_token || token;
          const newRt = data.refresh_token ?? refreshToken;
          const newExp = Date.now() + Number(data.expires_in ?? 3600) * 1000;
          const scopes = String(data.scope || "")
            .split(" ")
            .filter(Boolean);
          if (session?.spotify) {
            session.spotify.access_token = newAccess;
            session.spotify.refresh_token = newRt;
            session.spotify.expires_at = newExp;
            session.spotify.scopes = scopes.length
              ? scopes
              : session.spotify.scopes;
          }
          return newAccess;
        }

        // Non-OK: retry only on transient statuses
        const status = resp.status;
        const shouldRetry = status >= 500 || status === 429;
        await logger.warning("auth", {
          message: "Silent refresh HTTP non-OK",
          status,
          statusText: resp.statusText,
          attempt,
        });
        if (!shouldRetry || attempt === maxAttempts) {
          return Date.now() <= expiresAt ? token : null;
        }

        const backoffMs = 300 * attempt + Math.floor(Math.random() * 200);
        await new Promise((r) => setTimeout(r, backoffMs));
      } catch (error) {
        await logger.warning("auth", {
          message: "Silent refresh attempt failed",
          error: (error as Error)?.message,
          attempt,
        });
        if (attempt === maxAttempts) {
          return Date.now() <= expiresAt ? token : null;
        }
        const backoffMs = 300 * attempt + Math.floor(Math.random() * 200);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  return token ?? null;
}
