let cachedEnv: Record<string, unknown> | undefined;

export function setEnv(env: Record<string, unknown>): void {
  cachedEnv = env;
}

export function getEnv(): Record<string, unknown> {
  if (cachedEnv) {
    return cachedEnv;
  }
  const g = globalThis as unknown as {
    process?: { env?: Record<string, unknown> };
    ENV?: Record<string, unknown>;
  };
  return g.ENV ?? g.process?.env ?? {};
}

export function stringFromEnv(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}
