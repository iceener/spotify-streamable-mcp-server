import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';

export const makeSessionId = (): string => randomUUID();
export const makeEventId = (): string => randomUUID();

// Accept any protocol version value (or none). No validation enforced.
export const validateProtocolVersion = (headers: Headers): void => {
  // Enforce exact match when present; allow absence for compatibility
  const header =
    headers.get('Mcp-Protocol-Version') || headers.get('MCP-Protocol-Version');
  if (!header) return;
  if (header !== config.MCP_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported MCP protocol version: ${header}. Expected ${config.MCP_PROTOCOL_VERSION}`,
    );
  }
};

export const validateOrigin = (headers: Headers): void => {
  const origin = headers.get('Origin') || headers.get('origin');

  // In development, allow localhost origins
  if (config.NODE_ENV === 'development') {
    if (origin && !isLocalhostOrigin(origin)) {
      throw new Error(
        `Invalid origin: ${origin}. Only localhost allowed in development`,
      );
    }
    return;
  }

  // In production, implement your origin validation logic
  if (origin && !isAllowedOrigin(origin)) {
    throw new Error(`Invalid origin: ${origin}`);
  }
};

const isLocalhostOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.endsWith('.local')
    );
  } catch {
    return false;
  }
};

const isAllowedOrigin = (_origin: string): boolean => {
  // TODO: Implement your origin allowlist logic
  // This might check against environment variables, database, etc.
  console.warn('Origin validation not implemented for production');
  return true;
};

export const redactSensitiveData = (
  obj: Record<string, unknown>,
): Record<string, unknown> => {
  const sensitiveKeys = [
    'password',
    'token',
    'secret',
    'key',
    'authorization',
    'apikey',
    'api_key',
    'access_token',
    'refresh_token',
  ];

  const redacted = { ...obj };

  for (const [key, value] of Object.entries(redacted)) {
    if (sensitiveKeys.some((sensitive) => key.toLowerCase().includes(sensitive))) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveData(value as Record<string, unknown>);
    }
  }

  return redacted;
};
