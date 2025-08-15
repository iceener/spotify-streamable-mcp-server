export type TokenBucket = {
  take: (n?: number) => boolean;
  refill: (tokens?: number) => void;
};

export const makeTokenBucket = (
  capacity: number,
  refillPerSec: number,
): TokenBucket => {
  let tokens = capacity;
  let last = Date.now();

  const refillLoop = () => {
    const now = Date.now();
    const delta = (now - last) / 1000;
    last = now;
    tokens = Math.min(capacity, tokens + delta * refillPerSec);
  };

  return {
    take(n = 1) {
      refillLoop();
      if (tokens >= n) {
        tokens -= n;
        return true;
      }
      return false;
    },
    refill(n = capacity) {
      tokens = Math.min(capacity, tokens + n);
    },
  };
};

export const makeConcurrencyGate = (max: number) => {
  let active = 0;
  const queue: (() => void)[] = [];

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }

    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
};
