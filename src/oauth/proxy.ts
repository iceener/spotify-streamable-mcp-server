import {
  type AuthMetadataOptions,
  type OAuthMetadata,
  type OAuthTokenVerifier,
  oauthMetadataResponse,
} from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import { type Config, ConfigError, type OAuthConfig } from '../platform/config';
import type { Logger } from '../platform/logger';
import type { OAuthAuthority } from './authority';
import type { Flow } from './flow';
import type { OAuthProvider, ProviderCredentials } from './provider';
import { mountOAuthEndpoints, OAUTH_ROUTES } from './routes';
import type { TokenStore } from './token-store';
import { createProxyVerifier } from './verifier';

/**
 * This server as the OAuth authorization server MCP clients use, in front of a provider's own
 * OAuth (docs/oauth.md). It plugs into three hooks in `src/server.ts`: `createVerifier`,
 * `oauthMetadata` and `routes`.
 */
export interface OAuthProxy {
  /** Checks the opaque tokens this server issued, and resolves the provider token. */
  verifier: OAuthTokenVerifier;
  /** RFC 8414 metadata for this server. Throws `ConfigError` when `OAUTH_*` don't name its routes. */
  metadata(oauth: OAuthConfig): OAuthMetadata;
  /** Mount the endpoints, the provider callback, and the older discovery locations. */
  mount(app: Hono, oauth: OAuthConfig, resourceName: string): void;
}

export interface OAuthProxyOptions {
  config: Config;
  logger: Logger;
  provider: OAuthProvider;
  credentials: ProviderCredentials;
  /** `PROXY_REDIRECT_ALLOWLIST`: client redirect URIs allowed besides native loopback. */
  redirectAllowlist: readonly string[];
  /** `RS_TOKENS_ENC_KEY`. Without it, tokens are stored as plain JSON. */
  encryptionKey: string | undefined;
  tokens: TokenStore;
  authority: OAuthAuthority;
  /**
   * Bind each issued token pair to its client and this server (the record's `oauth` field), so
   * a refresh needs the same `client_id`. Default `true`. With `false`, records are written
   * without a binding, for a server whose clients relied on refresh without `client_id`.
   */
  bindGrants?: boolean;
  /**
   * Also serve the discovery documents at the locations used before the template (see
   * `mountDiscoveryAliases`). Default `true`. Turn off for a server that never served them.
   */
  discoveryAliases?: boolean;
  /** For calls to the provider. Injected in tests and smoke runs. */
  fetch?: typeof fetch;
}

export function createOAuthProxy(options: OAuthProxyOptions): OAuthProxy {
  const { config, provider, logger } = options;
  const origin = config.publicUrl.origin;
  const own = (path: string) => new URL(path, origin).href;

  const flow: Flow = {
    provider,
    credentials: options.credentials,
    authority: options.authority,
    tokens: options.tokens,
    policy: { redirectAllowlist: options.redirectAllowlist },
    resource: config.publicUrl.href,
    callbackUrl: own(OAUTH_ROUTES.callback),
    encryptionKey: options.encryptionKey,
    bindGrants: options.bindGrants ?? true,
    fetch: options.fetch,
  };

  function metadata(oauth: OAuthConfig): OAuthMetadata {
    checkEndpoints(oauth, origin);
    return {
      issuer: oauth.issuer,
      authorization_endpoint: oauth.authorizationUrl.href,
      token_endpoint: oauth.tokenUrl.href,
      revocation_endpoint: own(OAUTH_ROUTES.revoke),
      registration_endpoint: own(OAUTH_ROUTES.register),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...provider.scopes],
      // Clients register through /register; client ID metadata documents are not supported.
      client_id_metadata_document_supported: false,
    };
  }

  return {
    verifier: createProxyVerifier({
      tokens: options.tokens,
      provider,
      credentials: options.credentials,
      resource: config.publicUrl,
      logger,
      fetch: options.fetch,
    }),
    metadata,
    mount(app, oauth, resourceName) {
      mountOAuthEndpoints(app, flow, logger);
      if (options.discoveryAliases === false) return;
      mountDiscoveryAliases(app, config, {
        oauthMetadata: metadata(oauth),
        resourceServerUrl: config.publicUrl,
        resourceName,
        ...(oauth.scopes.length > 0 && { scopesSupported: oauth.scopes }),
        dangerouslyAllowInsecureIssuerUrl: config.environment !== 'production',
      });
    },
  };
}

/**
 * The proxy serves its endpoints on this origin, so `OAUTH_*` must name them exactly:
 * the published metadata and the mounted routes can't disagree.
 */
function checkEndpoints(oauth: OAuthConfig, origin: string): void {
  const expected: Array<[string, string | undefined, string]> = [
    ['OAUTH_ISSUER_URL', oauth.issuer, origin],
    ['OAUTH_AUTHORIZATION_URL', oauth.authorizationUrl.href, `${origin}${OAUTH_ROUTES.authorize}`],
    ['OAUTH_TOKEN_URL', oauth.tokenUrl.href, `${origin}${OAUTH_ROUTES.token}`],
    ['OAUTH_REGISTRATION_URL', oauth.registrationUrl?.href, `${origin}${OAUTH_ROUTES.register}`],
  ];
  const problems = expected
    .filter(([, actual, wanted]) => actual !== wanted)
    .map(
      ([name, , wanted]) =>
        `${name} must be "${wanted}": this server is its own authorization server`,
    );
  if (oauth.jwksUrl) {
    problems.push('OAUTH_JWKS_URL must be unset: the proxy looks its tokens up instead');
  }
  if (problems.length > 0) throw new ConfigError(problems);
}

/**
 * Discovery documents at the locations the server published before it moved to the template:
 * the root protected-resource document, which 2025-era clients fall back to, and both
 * documents under the MCP path. Each answers exactly as its canonical location does; unlike
 * the canonical ones, they sit behind the Origin check.
 */
function mountDiscoveryAliases(app: Hono, config: Config, metadata: AuthMetadataOptions): void {
  const mcpPath = config.publicUrl.pathname;
  const protectedResource = new URL(
    `/.well-known/oauth-protected-resource${mcpPath}`,
    config.publicUrl,
  );
  const authorizationServer = new URL('/.well-known/oauth-authorization-server', config.publicUrl);
  const aliases: Array<[string, URL]> = [
    ['/.well-known/oauth-protected-resource', protectedResource],
    [`${mcpPath}/.well-known/oauth-protected-resource`, protectedResource],
    [`${mcpPath}/.well-known/oauth-authorization-server`, authorizationServer],
  ];
  for (const [alias, canonical] of aliases) {
    app.all(alias, (c) => {
      const request = new Request(canonical.href, {
        method: c.req.method,
        headers: c.req.raw.headers,
      });
      const response = oauthMetadataResponse(request, metadata);
      return response ?? c.notFound();
    });
  }
}
