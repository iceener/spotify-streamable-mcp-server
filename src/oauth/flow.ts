import * as z from 'zod/v4';
import {
  type AuthorizationTransaction,
  type Grant,
  type OAuthAuthority,
  type RegisteredClient,
  routeId,
} from './authority';
import { createEncryptor, opaqueToken, pkceChallenge } from './crypto';
import { oauthError } from './errors';
import type { AuthorizeInput, TokenInput } from './input';
import {
  exchangeAtProvider,
  type OAuthProvider,
  type ProviderCredentials,
  requireCredentials,
} from './provider';
import { permittedRedirect, type RedirectPolicy, registeredRedirect } from './redirect-policy';
import type { ProviderTokens, TokenStore } from './token-store';

/** What every step of the flow works with. Built once by `createOAuthProxy`. */
export interface Flow {
  provider: OAuthProvider;
  credentials: ProviderCredentials;
  authority: OAuthAuthority;
  tokens: TokenStore;
  policy: RedirectPolicy;
  /** The MCP endpoint URL. Every grant is bound to it (RFC 8707). */
  resource: string;
  /** This server's provider callback, registered at the provider. */
  callbackUrl: string;
  /** `RS_TOKENS_ENC_KEY`: encrypts provider tokens inside issued codes. */
  encryptionKey: string | undefined;
  /** Bind issued tokens to their client and resource (`OAuthProxyOptions.bindGrants`). */
  bindGrants: boolean;
  /** For calls to the provider. Injected in tests. */
  fetch: typeof fetch | undefined;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  scope: string;
}

/** A transaction handle or code: routed to its client's authority document. */
const handleFor = (clientId: string) => `${clientId}.${opaqueToken(24)}`;

/** A supplied `resource` must name this server exactly; an omitted one means this server. */
function boundResource(resource: string | undefined, flow: Flow): string {
  if (resource !== undefined && resource !== flow.resource) throw oauthError('invalid_target');
  return flow.resource;
}

/** Fields the provider's extra authorization parameters can never replace. */
const PROTOCOL_FIELDS = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'scope',
  'resource',
  'code_challenge',
  'code_challenge_method',
]);

/**
 * `GET /authorize`: check the registered client, its redirect URI and S256 PKCE, store the
 * transaction, and send the user to the provider. The provider sees this server's callback
 * and an opaque handle as `state`, never the client's redirect URI or state.
 */
export async function authorize(input: AuthorizeInput, flow: Flow): Promise<string> {
  requireCredentials(flow.credentials);
  if (input.responseType !== 'code') throw oauthError('unsupported_response_type');
  if (routeId(input.clientId) !== input.clientId) throw oauthError('invalid_client');
  const client = (await flow.authority.execute(input.clientId, {
    kind: 'client',
  })) as RegisteredClient;
  if (!registeredRedirect(input.redirectUri, client, flow.policy)) {
    throw oauthError('invalid_request', 'redirect_uri is not allowed');
  }
  if (
    input.codeChallengeMethod !== 'S256' ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(input.codeChallenge)
  ) {
    throw oauthError('invalid_request', 'S256 PKCE required');
  }
  const handle = handleFor(client.client_id);
  const txn: AuthorizationTransaction = {
    clientId: client.client_id,
    redirectUri: input.redirectUri,
    state: input.state,
    resource: boundResource(input.resource, flow),
    codeChallenge: input.codeChallenge,
    providerCallbackUri: flow.callbackUrl,
    expiresAt: Date.now() + 600_000,
    scope: input.requestedScope,
  };
  await flow.authority.execute(client.client_id, { kind: 'begin', handle, txn });

  const url = new URL(flow.provider.authorizationUrl);
  for (const [key, value] of Object.entries(flow.provider.authorizationParams)) {
    if (!PROTOCOL_FIELDS.has(key)) url.searchParams.set(key, value);
  }
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: flow.credentials.clientId,
    redirect_uri: txn.providerCallbackUri,
    state: handle,
    scope: flow.provider.scopes.join(' ') || input.requestedScope || '',
  })) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

/**
 * `GET /oauth/callback`: the provider sends the user back. The transaction is claimed before
 * the provider is called, so a replayed or concurrent callback fails, and a failed exchange
 * can't be retried with the same handle. Returns the client's redirect URI with its code.
 */
export async function callback(providerCode: string, handle: string, flow: Flow): Promise<string> {
  requireCredentials(flow.credentials);
  if (!providerCode || providerCode.length > 4096) throw oauthError('invalid_request');
  const clientId = routeId(handle);
  const txn = (await flow.authority.execute(clientId, {
    kind: 'claim',
    handle,
  })) as AuthorizationTransaction;
  const client = (await flow.authority.execute(clientId, { kind: 'client' })) as RegisteredClient;
  // Policy may have changed since /authorize; check again before calling the provider.
  if (!registeredRedirect(txn.redirectUri, client, flow.policy)) {
    throw oauthError('invalid_redirect_uri');
  }
  boundResource(txn.resource, flow);
  if (txn.providerCallbackUri !== flow.callbackUrl) throw oauthError('invalid_callback');

  const tokens = await exchangeAtProvider(
    flow.provider,
    flow.credentials,
    { grant_type: 'authorization_code', code: providerCode, redirect_uri: txn.providerCallbackUri },
    { fallbackScopes: flow.provider.scopes, fetch: flow.fetch },
  );
  const serialized = JSON.stringify(tokens);
  const providerMaterial = flow.encryptionKey
    ? `enc:${await createEncryptor(flow.encryptionKey).encrypt(serialized)}`
    : `json:${serialized}`;
  const code = handleFor(clientId);
  await flow.authority.execute(clientId, { kind: 'issue', handle, code, providerMaterial });

  // The redirect URI is used exactly as registered: no normalization, default ports kept.
  const query = new URLSearchParams({ code });
  if (txn.state !== undefined) query.set('state', txn.state);
  return `${txn.redirectUri}?${query}`;
}

/**
 * `POST /token`. An authorization code is redeemed once, after the client, redirect URI,
 * resource and PKCE verifier all match; it then becomes a new pair of opaque tokens bound to
 * that client and resource (unless `bindGrants` is off). A refresh token returns the same
 * refresh token and, unless the provider rotated its own refresh token, the same access
 * token, refreshing the provider token first when it expires within a minute.
 */
export async function token(input: TokenInput, flow: Flow): Promise<TokenResponse> {
  boundResource(input.resource, flow);
  if (input.grant === 'refresh_token') return refresh(input, flow);

  if (
    !input.clientId ||
    !input.redirectUri ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)
  ) {
    throw oauthError('invalid_grant');
  }
  if (routeId(input.code) !== input.clientId) throw oauthError('invalid_grant');
  const grant = (await flow.authority.execute(input.clientId, {
    kind: 'consume',
    code: input.code,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    resource: boundResource(input.resource, flow),
    challenge: await pkceChallenge(input.codeVerifier),
  })) as Grant;

  let serialized: string;
  if (grant.providerMaterial.startsWith('enc:') && flow.encryptionKey) {
    serialized = await createEncryptor(flow.encryptionKey).decrypt(grant.providerMaterial.slice(4));
  } else if (grant.providerMaterial.startsWith('json:') && !flow.encryptionKey) {
    serialized = grant.providerMaterial.slice(5);
  } else {
    throw oauthError('server_error');
  }
  const provider = JSON.parse(serialized) as ProviderTokens;
  const accessToken = opaqueToken(24);
  const refreshToken = opaqueToken(24);
  await flow.tokens.storeRsMapping(
    accessToken,
    provider,
    refreshToken,
    flow.bindGrants ? { clientId: grant.clientId, resource: grant.resource } : undefined,
  );
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: 3600,
    scope: (provider.scopes ?? []).join(' ') || grant.scope || '',
  };
}

async function refresh(
  input: Extract<TokenInput, { grant: 'refresh_token' }>,
  flow: Flow,
): Promise<TokenResponse> {
  const record = await flow.tokens.getByRsRefresh(input.refreshToken);
  if (!record) throw oauthError('invalid_grant');
  // Records issued before provenance existed carry no binding and stay usable as they are.
  if (
    record.oauth &&
    (record.oauth.clientId !== input.clientId || record.oauth.resource !== flow.resource)
  ) {
    throw oauthError('invalid_grant');
  }
  let provider = record.provider;
  if (Date.now() >= (provider.expires_at ?? 0) - 60_000) {
    if (!provider.refresh_token) throw oauthError('provider_token_expired');
    const refreshed = await exchangeAtProvider(
      flow.provider,
      flow.credentials,
      { grant_type: 'refresh_token', refresh_token: provider.refresh_token },
      { fetch: flow.fetch },
    );
    provider = {
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? provider.refresh_token,
      scopes: refreshed.scopes?.length ? refreshed.scopes : [...(provider.scopes ?? [])],
    };
  }
  const newAccess =
    provider.refresh_token !== record.provider.refresh_token ? opaqueToken(24) : undefined;
  const updated = await flow.tokens.updateByRsRefresh(input.refreshToken, provider, newAccess);
  return {
    access_token: newAccess ?? record.rs_access_token,
    refresh_token: input.refreshToken,
    token_type: 'bearer',
    expires_in: provider.expires_at
      ? Math.max(1, Math.floor((provider.expires_at - Date.now()) / 1000))
      : 3600,
    scope: (updated?.provider.scopes ?? []).join(' '),
  };
}

const ClientMetadata = z.object({
  application_type: z.enum(['native', 'web']).default('web'),
  token_endpoint_auth_method: z.literal('none').default('none'),
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(20),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .min(1)
    .max(2)
    .default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).length(1).default(['code']),
  client_name: z.string().max(200).optional(),
});

/**
 * `POST /register` (RFC 7591): public clients only. Every redirect URI must pass the
 * redirect policy. No registration access token is issued; registrations can't be changed.
 */
export async function register(input: unknown, flow: Flow): Promise<RegisteredClient> {
  const parsed = ClientMetadata.safeParse(input);
  if (!parsed.success || !parsed.data.grant_types.includes('authorization_code')) {
    throw oauthError('invalid_client_metadata');
  }
  const client: RegisteredClient = {
    ...parsed.data,
    client_id: opaqueToken(24),
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
  if (
    new Set(client.grant_types).size !== client.grant_types.length ||
    client.redirect_uris.some((uri) => !permittedRedirect(uri, client, flow.policy))
  ) {
    throw oauthError('invalid_redirect_uri');
  }
  await flow.authority.execute(client.client_id, { kind: 'register', client });
  return client;
}
