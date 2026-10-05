/**
 * Proxy errors travel as `Error` messages that start with an OAuth error code, optionally
 * followed by `: detail`. A plain message is the only thing that survives the Durable Object
 * RPC boundary intact (custom error classes arrive as plain `Error`), so the authority, the
 * flow and the routes all use this one convention.
 */
export function oauthError(code: string, detail?: string): Error {
  return new Error(detail ? `${code}: ${detail}` : code);
}

/** The OAuth error code an `oauthError` carries, or the whole message for other errors. */
export function errorCode(error: unknown): string {
  return error instanceof Error ? (error.message.split(':')[0] ?? '') : '';
}

/**
 * Codes a client may see, with 400 (413 for `request_too_large`). Anything else is answered
 * as `503 server_error`, so storage failures, provider responses and bugs never reach the
 * client.
 */
export const CLIENT_ERRORS = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_client_metadata',
  'invalid_redirect_uri',
  'invalid_callback',
  'invalid_grant',
  'invalid_target',
  'unsupported_response_type',
  'request_too_large',
]);
