import { config } from '../config/env.ts';
import { makeConcurrencyGate, makeTokenBucket } from '../utils/limits.ts';
import { logger } from '../utils/logger.ts';

export type HttpClientInput = string | URL | Request;
export type HttpClient = (
  input: HttpClientInput,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpClientOptions {
  baseHeaders?: Record<string, string>;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  rateLimit?: { rps: number; burst: number };
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

  const rateLimiter = makeTokenBucket(rateLimit.burst, rateLimit.rps);
  const gate = makeConcurrencyGate(concurrency);

  return async (input: HttpClientInput, init?: RequestInit): Promise<Response> => {
    return gate(async () => {
      if (!rateLimiter.take()) {
        await logger.warning('http_client', { message: 'Rate limit exceeded' });
        throw new Error('Rate limit exceeded');
      }

      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const method = init?.method || 'GET';

      await logger.debug('http_client', {
        message: 'HTTP request start',
        url,
        method,
      });

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeout);

          const response = await fetch(url, {
            ...init,
            headers: { ...baseHeaders, ...init?.headers },
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (response.ok || attempt === retries) {
            await logger.info('http_client', {
              message: 'HTTP request completed',
              url,
              method,
              status: response.status,
              attempt,
            });
            return response;
          }

          await logger.warning('http_client', {
            message: 'HTTP request failed, retrying',
            url,
            method,
            status: response.status,
            attempt,
          });

          const delay = retryDelay * 2 ** (attempt - 1) + Math.random() * 1000;
          await new Promise((r) => setTimeout(r, delay));
        } catch (error) {
          if (attempt === retries) {
            await logger.error('http_client', {
              message: 'HTTP request failed after retries',
              url,
              method,
              error: (error as Error).message,
              attempts: retries,
            });
            throw error;
          }
          await logger.warning('http_client', {
            message: 'HTTP error, retrying',
            url,
            method,
            error: (error as Error).message,
            attempt,
          });
          const delay = retryDelay * 2 ** (attempt - 1) + Math.random() * 1000;
          await new Promise((r) => setTimeout(r, delay));
        }
      }

      throw new Error('Unexpected end of retry loop');
    });
  };
}
