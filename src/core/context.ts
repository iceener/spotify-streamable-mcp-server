import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../utils/logger.ts';

export type RequestContext = {
  sessionId?: string;
  rsToken?: string;
  spotifyAccessToken?: string;
};

const ctxAls = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  void logger.info('context', {
    message: 'Setting up request context',
    sessionId: context.sessionId,
    hasRsToken: !!context.rsToken,
    hasSpotifyToken: !!context.spotifyAccessToken,
    rsTokenLength: context.rsToken?.length || 0,
    spotifyTokenLength: context.spotifyAccessToken?.length || 0,
  });

  return new Promise<T>((resolve, reject) => {
    ctxAls.run(context, async () => {
      try {
        const result = await fn();
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function getRequestContext(): RequestContext {
  const context = ctxAls.getStore() ?? {};
  void logger.info('context', {
    message: 'Retrieving request context',
    hasContext: !!ctxAls.getStore(),
    sessionId: context.sessionId,
    hasRsToken: !!context.rsToken,
    hasSpotifyToken: !!context.spotifyAccessToken,
  });
  return context;
}

export function getCurrentSessionId(): string | undefined {
  const sessionId = getRequestContext().sessionId;
  void logger.info('context', {
    message: 'getCurrentSessionId called',
    sessionId,
  });
  return sessionId;
}

export function getCurrentRsToken(): string | undefined {
  const rsToken = getRequestContext().rsToken;
  void logger.info('context', {
    message: 'getCurrentRsToken called',
    hasRsToken: !!rsToken,
    rsTokenLength: rsToken?.length || 0,
  });
  return rsToken;
}

export function getCurrentSpotifyAccessToken(): string | undefined {
  const spotifyToken = getRequestContext().spotifyAccessToken;
  void logger.info('context', {
    message: 'getCurrentSpotifyAccessToken called',
    hasSpotifyToken: !!spotifyToken,
    spotifyTokenLength: spotifyToken?.length || 0,
  });
  return spotifyToken;
}
