export type ProtectedResourceMetadata = {
  issuer?: string;
  authorization_servers: string[];
  resource: string;
};

export const composeWwwAuthenticate = (resourceMetadataUrl: string) =>
  `Bearer realm="mcp", resource_metadata="${resourceMetadataUrl}"`;

export const validateBearer = (headers: Headers): string | null => {
  const auth = headers.get('Authorization') || headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  return auth.slice('Bearer '.length).trim();
};

export const validateAudience = async (
  _token: string,
  _resource: string,
): Promise<boolean> => {
  console.warn(
    'Token validation not implemented - accepting all tokens in development: ',
  );
  return true;
};
