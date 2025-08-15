import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  sessionId?: string;
  rsToken?: string;
  spotifyAccessToken?: string;
};

const ctxAls = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => Promise<T>
): Promise<T> {
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
  return ctxAls.getStore() ?? {};
}

export function getCurrentSessionId(): string | undefined {
  return getRequestContext().sessionId;
}

export function getCurrentRsToken(): string | undefined {
  return getRequestContext().rsToken;
}

export function getCurrentSpotifyAccessToken(): string | undefined {
  return getRequestContext().spotifyAccessToken;
}
