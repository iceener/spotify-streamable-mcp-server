import { durableObjectAuthority } from './oauth/authority-do';
import { createEncryptor } from './oauth/crypto';
import { KvTokenStore } from './oauth/token-store-kv';
import { type App, createApp } from './platform/app';
import { type Config, ConfigError, parseConfig } from './platform/config';
import { createLogger } from './platform/logger';
import type { Runtime } from './server';
import { tokenEncryptionKey } from './settings';

export { NativeOAuthAuthority } from './oauth/authority-do';

/**
 * Workers receive `env` with each request, so the app is built on the first request and
 * reused for the isolate's lifetime. If that fails (bad configuration, or a registration
 * mistake such as a duplicate tool name), it is logged once and every request gets a generic
 * 500 until the next deploy; the details stay in Workers Logs, not in responses.
 *
 * Bindings (KV, D1, Durable Objects) reach your code through `runtime`, typed in
 * `src/server.ts`. Export any Durable Object classes from this module, as Workers require.
 */
let app: App | undefined;
let misconfigured = false;

export default {
  async fetch(request, env) {
    if (!app && !misconfigured) {
      try {
        const config = parseConfig({ ...env });
        app = createApp(config, { runtime: workerRuntime(env, config) });
      } catch (error) {
        misconfigured = true;
        const message =
          error instanceof ConfigError ? 'Invalid configuration' : 'The server failed to start';
        createLogger('error').error(`${message}; fix it and redeploy`, { error });
      }
    }
    return app
      ? app.fetch(request)
      : Response.json({ error: 'server_misconfigured' }, { status: 500 });
  },
} satisfies ExportedHandler<Env>;

/** Tokens in KV (`TOKENS`), authorization state in the `OAUTH_AUTHORITY` Durable Object. */
function workerRuntime(env: Env, config: Config): Runtime {
  const missing = (['TOKENS', 'OAUTH_AUTHORITY'] as const).filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new ConfigError(missing.map((name) => `The ${name} binding is missing`));
  }
  const key = tokenEncryptionKey(config.settings);
  return {
    tokens: new KvTokenStore(env.TOKENS, {
      encryptor: key ? createEncryptor(key) : undefined,
      logger: createLogger(config.logLevel),
    }),
    authority: durableObjectAuthority(env.OAUTH_AUTHORITY),
  };
}
