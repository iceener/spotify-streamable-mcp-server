import { config } from "../config/env.ts";
import { SpotifyTokenResponseCodec } from "../types/spotify.codecs.ts";
import { logger } from "../utils/logger.ts";
import { getCurrentSessionId } from "./context.ts";
import { getSession } from "./session.ts";

export async function getUserBearer(): Promise<string | null> {
  const sessionId = getCurrentSessionId();
  if (!sessionId) return null;
  const session = getSession(sessionId);
  const token = session?.spotify?.access_token ?? null;
  const expiresAt = session?.spotify?.expires_at ?? 0;
  const refreshToken = session?.spotify?.refresh_token;
  if (!token) return null;

  if (refreshToken && Date.now() > expiresAt - 30_000) {
    try {
      if (!config.SPOTIFY_CLIENT_ID || !config.SPOTIFY_CLIENT_SECRET) {
        await logger.warning("auth", {
          message:
            "Missing Spotify client credentials; cannot refresh access token",
        });
        return Date.now() >= expiresAt ? null : token;
      }
      const tokenUrl = new URL(
        "/api/token",
        config.SPOTIFY_ACCOUNTS_URL
      ).toString();
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString();
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
        signal: AbortSignal.timeout(30_000),
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
      } else {
        await logger.warning("auth", {
          message: "Silent refresh HTTP non-OK; using cached token",
          status: resp.status,
          statusText: resp.statusText,
        });
        return Date.now() >= expiresAt ? null : token;
      }
    } catch {
      await logger.warning("auth", {
        message: "Silent refresh failed; using cached token",
      });
      return Date.now() >= expiresAt ? null : token;
    }
  }
  return token ?? null;
}
