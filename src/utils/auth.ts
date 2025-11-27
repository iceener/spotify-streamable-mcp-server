/**
 * Authentication utilities for tools.
 * Handles RS token → Provider token mapping with expiry checks.
 */

import { getTokenStore } from '../shared/storage/singleton.js';
import { logger } from './logger.js';

export interface AuthResult {
  providerToken: string;
  expiresAt?: number;
  scopes?: string[];
}

export interface AuthError {
  error: 'no_token' | 'invalid_token' | 'token_expired' | 'no_mapping';
  message: string;
}

/**
 * Extract and validate provider token from RS token.
 *
 * @param authHeader - The Authorization header value (e.g., "Bearer xxx")
 * @returns AuthResult if valid, AuthError if invalid
 *
 * @example
 * ```typescript
 * const result = await getProviderToken(context?.authHeaders?.authorization);
 * if ('error' in result) {
 *   return { isError: true, content: [{ type: 'text', text: result.message }] };
 * }
 * // Use result.providerToken for API calls
 * ```
 */
export async function getProviderToken(
  authHeader?: string,
): Promise<AuthResult | AuthError> {
  if (!authHeader) {
    return {
      error: 'no_token',
      message: 'No authorization header provided',
    };
  }

  const match = authHeader.match(/^\s*Bearer\s+(.+)$/i);
  const rsToken = match?.[1];

  if (!rsToken) {
    return {
      error: 'invalid_token',
      message: 'Invalid authorization header format (expected: Bearer <token>)',
    };
  }

  try {
    const store = getTokenStore();
    const record = await store.getByRsAccess(rsToken);

    if (!record) {
      logger.debug('auth', {
        message: 'No RS mapping found for token',
        tokenPrefix: rsToken.substring(0, 8),
      });
      return {
        error: 'no_mapping',
        message: 'Invalid or expired token - please re-authenticate',
      };
    }

    const providerToken = record.provider.access_token;
    const expiresAt = record.provider.expires_at;

    // Check if provider token is expired
    if (expiresAt) {
      const now = Date.now();
      const bufferMs = 60_000; // 1 minute buffer

      if (now >= expiresAt - bufferMs) {
        logger.warning('auth', {
          message: 'Provider token expired or expiring soon',
          expiresAt,
          now,
          tokenPrefix: rsToken.substring(0, 8),
        });
        return {
          error: 'token_expired',
          message: 'Token expired - please refresh or re-authenticate',
        };
      }
    }

    return {
      providerToken,
      expiresAt,
      scopes: record.provider.scopes,
    };
  } catch (error) {
    logger.error('auth', {
      message: 'Failed to lookup RS token',
      error: (error as Error).message,
    });
    return {
      error: 'invalid_token',
      message: 'Token validation failed',
    };
  }
}

/**
 * Check if an auth result is an error.
 */
export function isAuthError(result: AuthResult | AuthError): result is AuthError {
  return 'error' in result;
}
