// OAuth discovery endpoints (.well-known)

export type AuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  registration_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
};

export type ProtectedResourceMetadata = {
  authorization_servers: string[];
  resource: string;
};

export function buildAuthorizationServerMetadata(
  baseUrl: string,
  scopes: string[],
  overrides?: {
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    revocationEndpoint?: string;
  },
): AuthorizationServerMetadata {
  return {
    issuer: baseUrl,
    authorization_endpoint: overrides?.authorizationEndpoint || `${baseUrl}/authorize`,
    token_endpoint: overrides?.tokenEndpoint || `${baseUrl}/token`,
    revocation_endpoint: overrides?.revocationEndpoint || `${baseUrl}/revoke`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: scopes,
  };
}

export function buildProtectedResourceMetadata(
  resourceUrl: string,
  authorizationServerUrl: string,
  sid?: string,
): ProtectedResourceMetadata {
  const resource = (() => {
    if (!sid) {
      return resourceUrl;
    }
    try {
      const u = new URL(resourceUrl);
      u.searchParams.set('sid', sid);
      return u.toString();
    } catch {
      return resourceUrl;
    }
  })();

  return {
    authorization_servers: [authorizationServerUrl],
    resource,
  };
}
