import { config } from '../config/env.ts';

export const validateProtocolVersion = (headers: Headers): void => {
  const header =
    headers.get('Mcp-Protocol-Version') || headers.get('MCP-Protocol-Version');
  if (!header) return;
  const versions = header
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!versions.includes(config.MCP_PROTOCOL_VERSION)) {
    throw new Error(
      `Unsupported MCP protocol version: ${header}. Expected ${config.MCP_PROTOCOL_VERSION}`,
    );
  }
};

export const validateOrigin = (headers: Headers): void => {
  const origin = headers.get('Origin') || headers.get('origin');

  if (!origin) return; // non-browser callers

  if (config.NODE_ENV === 'development') {
    if (!isLocalhostOrigin(origin)) {
      throw new Error(
        `Invalid origin: ${origin}. Only localhost allowed in development`,
      );
    }
    return;
  }

  if (!isAllowedOrigin(origin)) {
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

// Placeholder: wire up a proper allowlist for production
const isAllowedOrigin = (_origin: string): boolean => {
  return true;
};
