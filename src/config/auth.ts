import type { Context } from 'hono';
import { z } from 'zod';

export const AuthConfig = z.object({
  AUTH_ENABLED: z.boolean().default(false),
  AUTH_RESOURCE_URI: z.string().url().optional(),
  AUTH_DISCOVERY_URL: z.string().url().optional(),
  OAUTH_SCOPES: z.string().default(''),
});

export type AuthConfig = z.infer<typeof AuthConfig>;

export type ProtectedResourceMetadata = {
  issuer?: string;
  authorization_servers: string[];
  resource: string;
};

export type AuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  jwks_uri?: string;
  scopes_supported?: string[];
};

export const composeWwwAuthenticate = (resourceMetadataUrl: string) =>
  `Bearer realm="mcp", resource_metadata="${resourceMetadataUrl}"`;

export const validateBearer = (headers: Headers): string | null => {
  const auth = headers.get('Authorization') || headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
};

export const requireBearerOr401 = (
  c: Context,
  resourceMetadataUrl: string,
): string | Response => {
  const token = validateBearer(c.req.raw.headers);
  if (!token) {
    c.header('WWW-Authenticate', composeWwwAuthenticate(resourceMetadataUrl));
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unauthorized' },
        id: null,
      },
      401,
    );
  }
  return token;
};

export const validateAudience = async (
  _token: string,
  _resource: string,
): Promise<boolean> => {
  // TODO: Implement JWT introspection/validation per your Authorization Server
  // This should:
  // 1. Decode/introspect the JWT token
  // 2. Verify the audience (aud) claim matches the resource parameter
  // 3. Check token expiration and signature
  // 4. Return true if valid, false otherwise

  console.warn(
    'Token validation not implemented - accepting all tokens in development',
  );
  return true;
};

export const fetchASMetadata = async (
  asUrl: string,
): Promise<AuthorizationServerMetadata> => {
  const res = await fetch(asUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`AS metadata fetch failed: ${res.status}`);
  return (await res.json()) as AuthorizationServerMetadata;
};
