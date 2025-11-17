// Framework-agnostic OAuth endpoint handlers

import { generateOpaqueToken } from './flow.ts';
import type { RegisterInput, RegisterResult } from './types.ts';

/**
 * Handle dynamic client registration (RFC7591)
 */
export async function handleRegister(
  input: RegisterInput,
  baseUrl: string,
  defaultRedirectUri: string,
): Promise<RegisterResult> {
  const now = Math.floor(Date.now() / 1000);
  const clientId = generateOpaqueToken(12);

  const redirectUris = Array.isArray(input.redirect_uris)
    ? input.redirect_uris
    : [defaultRedirectUri];

  const grantTypes = Array.isArray(input.grant_types)
    ? input.grant_types
    : ['authorization_code', 'refresh_token'];

  const responseTypes = Array.isArray(input.response_types)
    ? input.response_types
    : ['code'];

  return {
    client_id: clientId,
    client_id_issued_at: now,
    client_secret_expires_at: 0,
    token_endpoint_auth_method: 'none',
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    registration_client_uri: `${baseUrl}/register/${clientId}`,
    registration_access_token: generateOpaqueToken(12),
    ...(input.client_name ? { client_name: input.client_name } : {}),
  };
}

/**
 * Handle token revocation (no-op in this implementation)
 */
export async function handleRevoke(): Promise<{ status: string }> {
  return { status: 'ok' };
}
