import { config } from '../config/env.js';
import { makeConcurrencyGate, makeTokenBucket } from '../utils/limits.js';
import { logger } from '../utils/logger.js';

// In Bun/TS without DOM lib, define a minimal Request-like union
export type HttpClientInput = string | URL | { url?: string } | Request;
export type HttpClient = (
  input: HttpClientInput,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpClientOptions {
  baseHeaders?: Record<string, string>;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  rateLimit?: {
    rps: number;
    burst: number;
  };
  concurrency?: number;
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const {
    baseHeaders = {},
    timeout = 30000,
    retries = 3,
    retryDelay = 1000,
    rateLimit = { rps: config.RPS_LIMIT, burst: config.RPS_LIMIT * 2 },
    concurrency = config.CONCURRENCY_LIMIT,
  } = options;

  // Rate limiting with token bucket
  const rateLimiter = makeTokenBucket(rateLimit.burst, rateLimit.rps);

  // Concurrency control
  const concurrencyGate = makeConcurrencyGate(concurrency);

  return async (input: HttpClientInput, init?: RequestInit): Promise<Response> => {
    return concurrencyGate(async () => {
      // Rate limiting check
      if (!rateLimiter.take()) {
        logger.warning('http_client', {
          message: 'Rate limit exceeded, request rejected',
        });
        throw new Error('Rate limit exceeded');
      }

      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : ((input as { url?: string })?.url ?? String(input));
      const method = init?.method || 'GET';

      logger.debug('http_client', {
        message: 'HTTP request starting',
        url,
        method,
      });

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeout);

          const response = await fetch(url, {
            ...init,
            headers: {
              ...baseHeaders,
              ...init?.headers,
            },
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (response.ok || attempt === retries) {
            logger.info('http_client', {
              message: 'HTTP request completed',
              url,
              method,
              status: response.status,
              attempt,
            });
            return response;
          }

          logger.warning('http_client', {
            message: 'HTTP request failed, retrying',
            url,
            method,
            status: response.status,
            attempt,
          });

          // Exponential backoff with jitter
          const delay = retryDelay * 2 ** (attempt - 1) + Math.random() * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        } catch (error) {
          if (attempt === retries) {
            logger.error('http_client', {
              message: 'HTTP request failed after all retries',
              url,
              method,
              error: (error as Error).message,
              attempts: retries,
            });
            throw error;
          }

          logger.warning('http_client', {
            message: 'HTTP request error, retrying',
            url,
            method,
            error: (error as Error).message,
            attempt,
          });

          const delay = retryDelay * 2 ** (attempt - 1) + Math.random() * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      throw new Error('Unexpected end of retry loop');
    });
  };
}
