// Shared HTTP response builders for both Node.js and Cloudflare Workers

import { type CorsOptions, withCors } from './cors.js';

/**
 * Create a JSON response with proper headers.
 */
export function jsonResponse(
  data: unknown,
  options: {
    status?: number;
    headers?: Record<string, string>;
    cors?: boolean | CorsOptions;
  } = {},
): Response {
  const { status = 200, headers = {}, cors = true } = options;

  const response = new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });

  if (cors) {
    return withCors(response, typeof cors === 'object' ? cors : undefined);
  }

  return response;
}

/**
 * Create a JSON-RPC error response.
 */
export function jsonRpcError(
  code: number,
  message: string,
  id: string | number | null = null,
  options: { status?: number; cors?: boolean | CorsOptions } = {},
): Response {
  return jsonResponse(
    {
      jsonrpc: '2.0',
      error: { code, message },
      id,
    },
    { status: options.status ?? 200, cors: options.cors },
  );
}

/**
 * Create a JSON-RPC success response.
 */
export function jsonRpcSuccess(
  result: unknown,
  id: string | number | null,
  options: { headers?: Record<string, string>; cors?: boolean | CorsOptions } = {},
): Response {
  return jsonResponse(
    {
      jsonrpc: '2.0',
      result,
      id,
    },
    { status: 200, headers: options.headers, cors: options.cors },
  );
}

/**
 * Create a text error response.
 */
export function textError(
  message: string,
  options: { status?: number; cors?: boolean | CorsOptions } = {},
): Response {
  const { status = 400, cors = true } = options;

  const response = new Response(message, { status });

  if (cors) {
    return withCors(response, typeof cors === 'object' ? cors : undefined);
  }

  return response;
}

/**
 * Create an OAuth error response.
 */
export function oauthError(
  error: string,
  description?: string,
  options: { status?: number; cors?: boolean | CorsOptions } = {},
): Response {
  const body: Record<string, string> = { error };
  if (description) {
    body.error_description = description;
  }

  return jsonResponse(body, { status: options.status ?? 400, cors: options.cors });
}

/**
 * Create a redirect response.
 */
export function redirectResponse(
  url: string,
  status: 301 | 302 | 303 | 307 | 308 = 302,
): Response {
  return Response.redirect(url, status);
}

/**
 * Standard JSON-RPC error codes
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerError: -32000, // Base for server errors
} as const;
