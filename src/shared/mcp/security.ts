// MCP security: origin validation, protocol version, and challenge builder
// From Spotify MCP

export function validateOrigin(headers: Headers, isDev: boolean): void {
  const origin = headers.get('Origin') || headers.get('origin');

  if (!origin) {
    return; // non-browser callers
  }

  if (isDev) {
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
}

export function validateProtocolVersion(headers: Headers, expected: string): void {
  const header =
    headers.get('Mcp-Protocol-Version') || headers.get('MCP-Protocol-Version');

  if (!header) {
    return;
  }

  const versions = header
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  if (!versions.includes(expected)) {
    throw new Error(
      `Unsupported MCP protocol version: ${header}. Expected ${expected}`,
    );
  }
}

function isLocalhostOrigin(origin: string): boolean {
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
}

// Placeholder: wire up proper allowlist for production
function isAllowedOrigin(_origin: string): boolean {
  return true;
}

export type UnauthorizedChallenge = {
  status: 401;
  headers: Record<string, string>;
  body: {
    jsonrpc: '2.0';
    error: {
      code: -32000;
      message: string;
    };
    id: null;
  };
};

/**
 * Build a 401 Unauthorized challenge response for MCP
 */
export function buildUnauthorizedChallenge(args: {
  origin: string;
  sid: string;
  resourcePath?: string;
  message?: string;
}): UnauthorizedChallenge {
  const resourcePath = args.resourcePath || '/.well-known/oauth-protected-resource';
  const resourceMd = `${args.origin}${resourcePath}?sid=${encodeURIComponent(args.sid)}`;

  return {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer realm="MCP", authorization_uri="${resourceMd}"`,
      'Mcp-Session-Id': args.sid,
    },
    body: {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: args.message || 'Unauthorized',
      },
      id: null,
    },
  };
}
