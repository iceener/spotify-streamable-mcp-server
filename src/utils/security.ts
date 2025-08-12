import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";

export const makeSessionId = (): string => randomUUID();
export const makeEventId = (): string => randomUUID();

// Accept any protocol version value (or none). No validation enforced.
export const validateProtocolVersion = (_headers: Headers): void => {
  return; // NO VALIDATION BECAUSE CLIENTS RARELY SEND THIS HEADER
  // const header = headers.get("Mcp-Protocol-Version") || headers.get("MCP-Protocol-Version");

  // // If the client did not send a header, allow it (backwards compatibility)
  // if (!header) return;

  // // Enforce exact match when present
  // if (header !== config.MCP_PROTOCOL_VERSION) {
  //   throw new Error(
  //     `Unsupported MCP protocol version: ${header}. Expected ${config.MCP_PROTOCOL_VERSION}`,
  //   );
  // }
};

export const validateOrigin = (headers: Headers): void => {
  const origin = headers.get("Origin") || headers.get("origin");

  // In development, allow localhost origins
  if (config.NODE_ENV === "development") {
    // if (origin && !isLocalhostOrigin(origin)) {
    //   throw new Error(
    //     `Invalid origin: ${origin}. Only localhost allowed in development`,
    //   );
    // }
    return;
  }

  // In production, implement your origin validation logic
  if (origin && !isAllowedOrigin(origin)) {
    throw new Error(`Invalid origin: ${origin}`);
  }
};

const _isLocalhostOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.") ||
      hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
};

const isAllowedOrigin = (origin: string): boolean => {
  // Env-based allowlist from config; comma-separated list of origins (exact match)
  const allowlist = (config.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowlist.length === 0) {
    return false;
  }
  try {
    const o = new URL(origin);
    const normalized = `${o.protocol}//${o.host}`;
    return allowlist.includes(normalized) || allowlist.includes(origin);
  } catch {
    return false;
  }
};

export const redactSensitiveData = (
  obj: Record<string, unknown>
): Record<string, unknown> => {
  const sensitiveKeys = [
    "password",
    "token",
    "secret",
    "key",
    "authorization",
    "apikey",
    "api_key",
    "access_token",
    "refresh_token",
  ];

  const redacted = { ...obj };

  for (const [key, value] of Object.entries(redacted)) {
    if (
      sensitiveKeys.some((sensitive) => key.toLowerCase().includes(sensitive))
    ) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      redacted[key] = redactSensitiveData(value as Record<string, unknown>);
    }
  }

  return redacted;
};
