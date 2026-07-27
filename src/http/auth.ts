import {
  type AuthInfo,
  type AuthMetadataOptions,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthTokenVerifier,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import type { UnifiedConfig } from '../shared/config/env.js';

export interface AuthServices {
  gate: (request: Request) => Promise<AuthInfo | Response>;
  metadata: AuthMetadataOptions;
}

function endpoint(baseUrl: URL, path: string): string {
  return new URL(path, `${baseUrl.origin}/`).href;
}

/** Build the OAuth Resource Server gate around the Spotify OAuth proxy. */
export function createAuthServices(
  config: UnifiedConfig,
  verifier: OAuthTokenVerifier,
  authorizationServerUrl: URL,
): AuthServices | undefined {
  if (!config.AUTH_ENABLED) return undefined;

  const scopes = config.SPOTIFY_SCOPES.split(/\s+/).filter(Boolean);
  const metadata: AuthMetadataOptions = {
    oauthMetadata: {
      issuer: authorizationServerUrl.href.replace(/\/$/, ''),
      authorization_endpoint: endpoint(authorizationServerUrl, '/authorize'),
      token_endpoint: endpoint(authorizationServerUrl, '/token'),
      revocation_endpoint: endpoint(authorizationServerUrl, '/revoke'),
      registration_endpoint: endpoint(authorizationServerUrl, '/register'),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: scopes,
    },
    resourceServerUrl: config.MCP_PUBLIC_URL,
    scopesSupported: scopes,
    resourceName: config.MCP_TITLE,
    dangerouslyAllowInsecureIssuerUrl: config.NODE_ENV !== 'production',
  };

  // Validate metadata once at isolate/server construction.
  buildOAuthProtectedResourceMetadata(metadata);

  return {
    metadata,
    gate: requireBearerAuth({
      verifier,
      requiredScopes: config.MCP_REQUIRED_SCOPES,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.MCP_PUBLIC_URL),
    }),
  };
}

export function legacyProtectedResourceMetadata(services: AuthServices): Response {
  return Response.json(buildOAuthProtectedResourceMetadata(services.metadata));
}

export function legacyAuthorizationServerMetadata(services: AuthServices): Response {
  return Response.json(services.metadata.oauthMetadata);
}
