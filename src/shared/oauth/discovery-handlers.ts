// OAuth discovery handlers with strategy pattern for Node + Workers
// From Spotify MCP

import type { UnifiedConfig } from '../config/env.js';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from './discovery.js';

type DiscoveryStrategy = {
  resolveAuthBaseUrl(requestUrl: URL, config: UnifiedConfig): string;
  resolveAuthorizationServerUrl(requestUrl: URL, config: UnifiedConfig): string;
  resolveResourceBaseUrl(requestUrl: URL, config: UnifiedConfig): string;
};

export function createDiscoveryHandlers(
  config: UnifiedConfig,
  strategy: DiscoveryStrategy,
): {
  authorizationMetadata: (
    requestUrl: URL,
  ) => ReturnType<typeof buildAuthorizationServerMetadata>;
  protectedResourceMetadata: (
    requestUrl: URL,
    sid?: string,
  ) => ReturnType<typeof buildProtectedResourceMetadata>;
} {
  const scopes = config.OAUTH_SCOPES.split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  return {
    authorizationMetadata: (requestUrl: URL) => {
      const baseUrl = strategy.resolveAuthBaseUrl(requestUrl, config);
      // IMPORTANT: Advertise OUR proxy endpoints, not the provider's directly!
      // Our /authorize and /token endpoints will proxy to the provider.
      return buildAuthorizationServerMetadata(baseUrl, scopes, {
        // Use our endpoints (default behavior when not overriding)
        authorizationEndpoint: `${baseUrl}/authorize`,
        tokenEndpoint: `${baseUrl}/token`,
        revocationEndpoint: `${baseUrl}/revoke`,
      });
    },
    protectedResourceMetadata: (requestUrl: URL, sid?: string) => {
      const resourceBase = strategy.resolveResourceBaseUrl(requestUrl, config);
      const authorizationServerUrl =
        config.AUTH_DISCOVERY_URL ||
        strategy.resolveAuthorizationServerUrl(requestUrl, config);
      return buildProtectedResourceMetadata(resourceBase, authorizationServerUrl, sid);
    },
  };
}

export const workerDiscoveryStrategy: DiscoveryStrategy = {
  resolveAuthBaseUrl: (requestUrl) => requestUrl.origin,
  resolveAuthorizationServerUrl: (requestUrl) =>
    `${requestUrl.origin}/.well-known/oauth-authorization-server`,
  resolveResourceBaseUrl: (requestUrl) => `${requestUrl.origin}/mcp`,
};

export const nodeDiscoveryStrategy: DiscoveryStrategy = {
  resolveAuthBaseUrl: (requestUrl, config) => {
    const authPort = Number(config.PORT) + 1;
    return `${requestUrl.protocol}//${requestUrl.hostname}:${authPort}`;
  },
  resolveAuthorizationServerUrl: (requestUrl, config) => {
    const authPort = Number(config.PORT) + 1;
    return `${requestUrl.protocol}//${requestUrl.hostname}:${authPort}/.well-known/oauth-authorization-server`;
  },
  resolveResourceBaseUrl: (requestUrl) =>
    `${requestUrl.protocol}//${requestUrl.host}/mcp`,
};
