import { concatBytes } from './encoding';
import { oauthError } from './errors';

/** OAuth bodies and provider token responses are small; anything larger is refused unread. */
const MAX_BODY_BYTES = 16_384;

export interface AuthorizeInput {
  clientId: string;
  responseType: string;
  resource: string | undefined;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  requestedScope: string | undefined;
  state: string | undefined;
}

export type TokenInput =
  | {
      grant: 'authorization_code';
      code: string;
      codeVerifier: string;
      clientId: string;
      redirectUri: string;
      resource: string | undefined;
    }
  | {
      grant: 'refresh_token';
      refreshToken: string;
      clientId: string | undefined;
      resource: string | undefined;
    };

/** Bounded, and every field at most once: a repeated security field is an attack, not a typo. */
export function uniqueFields(params: URLSearchParams): void {
  const seen = new Set<string>();
  if (params.toString().length > MAX_BODY_BYTES || [...params].length > 32) {
    throw oauthError('invalid_request');
  }
  for (const [key, value] of params) {
    if (seen.has(key) || key.length > 128 || value.length > 4096) {
      throw oauthError('invalid_request');
    }
    seen.add(key);
  }
}

export function parseAuthorizeInput(url: URL): AuthorizeInput {
  uniqueFields(url.searchParams);
  const field = (name: string) => url.searchParams.get(name) ?? undefined;
  return {
    clientId: field('client_id') ?? '',
    responseType: field('response_type') ?? '',
    resource: field('resource'),
    codeChallenge: field('code_challenge') ?? '',
    codeChallengeMethod: field('code_challenge_method') ?? '',
    redirectUri: field('redirect_uri') ?? '',
    requestedScope: field('scope'),
    state: field('state'),
  };
}

export function parseCallbackInput(url: URL): { code: string | null; state: string | null } {
  uniqueFields(url.searchParams);
  if (url.searchParams.has('error')) throw oauthError('invalid_callback');
  return { code: url.searchParams.get('code'), state: url.searchParams.get('state') };
}

/** Read a body of at most 16 KiB as strict UTF-8. */
export async function boundedText(body: Pick<Request, 'body'>): Promise<string> {
  const reader = body.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw oauthError('request_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(concatBytes(chunks));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw oauthError('invalid_request');
  }
}

/**
 * A flat JSON object with unique keys. Keys are tokenized from the raw text first, so a key
 * repeated under an escaped spelling (`"redirect_uris"`) can't hide from the check.
 */
export function parseOAuthJson(text: string): Record<string, unknown> {
  const keys = new Set<string>();
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g)) {
    if (
      !match[0].startsWith('"') ||
      !/^\s*:/.test(text.slice((match.index ?? 0) + match[0].length))
    ) {
      continue;
    }
    const key = parseJson(match[0]) as string;
    if (keys.has(key) || keys.size >= 32) throw oauthError('invalid_request');
    keys.add(key);
  }
  const value = parseJson(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw oauthError('invalid_request');
  }
  return value as Record<string, unknown>;
}

/** A token request body: form-encoded, or a JSON object of strings. */
export async function parseTokenInput(request: Request): Promise<URLSearchParams> {
  const text = await boundedText(request);
  let params: URLSearchParams;
  if ((request.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) {
    params = new URLSearchParams(text);
  } else {
    const json = parseOAuthJson(text);
    if (Object.values(json).some((value) => typeof value !== 'string')) {
      throw oauthError('invalid_request');
    }
    params = new URLSearchParams(json as Record<string, string>);
  }
  uniqueFields(params);
  return params;
}

export function buildTokenInput(form: URLSearchParams): TokenInput | { error: string } {
  uniqueFields(form);
  const field = (name: string) => form.get(name) ?? undefined;
  const grant = form.get('grant_type');
  if (grant === 'refresh_token') {
    const refreshToken = field('refresh_token');
    if (!refreshToken) return { error: 'missing_refresh_token' };
    return { grant, refreshToken, clientId: field('client_id'), resource: field('resource') };
  }
  if (grant === 'authorization_code') {
    const code = field('code');
    const codeVerifier = field('code_verifier');
    const clientId = field('client_id');
    const redirectUri = field('redirect_uri');
    if (!code || !codeVerifier || !clientId || !redirectUri) return { error: 'invalid_request' };
    return { grant, code, codeVerifier, clientId, redirectUri, resource: field('resource') };
  }
  return { error: 'unsupported_grant_type' };
}
