import { FileOAuthAuthority } from './oauth/authority-file';
import { FileTokenStore } from './oauth/token-store-file';
import { type App, createApp } from './platform/app';
import { type Config, parseConfig } from './platform/config';
import { createLogger } from './platform/logger';
import { tokenEncryptionKey } from './settings';

/**
 * Bun drops a connection that stays quiet for `idleTimeout` seconds (default 10). A tool that
 * reports progress answers with an SSE stream, and it may go quiet for longer than that
 * between updates; the default would cut the call off with no result. 255 is Bun's maximum.
 * `bun run test:smoke` holds such a stream quiet for 15 s to keep this fixed.
 */
const IDLE_TIMEOUT_SECONDS = 255;

/** How long a shutdown waits for in-flight requests before aborting them. */
const DRAIN_TIMEOUT_MS = 10_000;

/** How often expired authorization transactions and codes are removed from disk. */
const AUTHORITY_CLEANUP_MS = 60_000;

export function serve(config: Config, app: App): Bun.Server<undefined> {
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    fetch: (request) => app.fetch(request),
  });
}

if (import.meta.main) {
  const config = parseConfig(Bun.env);
  const logger = createLogger(config.logLevel);
  // The OAuth proxy's state: one token file, and one authority file per registered client.
  const tokens = new FileTokenStore(
    config.settings.RS_TOKENS_FILE,
    tokenEncryptionKey(config.settings),
    logger,
  );
  const authority = new FileOAuthAuthority(`${config.settings.RS_TOKENS_FILE}.oauth-authority`);
  await authority.cleanupExpired();
  const cleanup = setInterval(() => {
    authority.cleanupExpired().catch((error) => {
      logger.error('Could not clean up the OAuth authority files', { error });
    });
  }, AUTHORITY_CLEANUP_MS);
  cleanup.unref();

  const app = createApp(config, { runtime: { tokens, authority } });
  const server = serve(config, app);

  logger.info('MCP server listening', {
    url: config.publicUrl.href,
    listening: server.url.href,
    auth: config.auth.mode,
  });

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down', { signal });

    // Stop accepting connections and let in-flight requests finish, up to a limit.
    await Promise.race([server.stop(), Bun.sleep(DRAIN_TIMEOUT_MS)]);
    await app.close();
    await server.stop(true);
    clearInterval(cleanup);
    tokens.flush();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
