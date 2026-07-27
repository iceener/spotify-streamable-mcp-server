import { parseConfig } from './config/env.js';
import { buildHttpApp } from './http/app.js';
import { buildAuthApp } from './http/auth-app.js';
import { FileTokenStore } from './shared/storage/file.js';
import { MemorySessionStore } from './shared/storage/memory.js';
import { sharedLogger as logger } from './shared/utils/logger.js';

const config = parseConfig(process.env as Record<string, unknown>);
const tokenStore = new FileTokenStore(config.RS_TOKENS_FILE, config.RS_TOKENS_ENC_KEY);
// Retained for OAuth/storage rollback compatibility. MCP transport is stateless.
const sessionStore = new MemorySessionStore();

function defaultAuthorizationServerUrl(): URL {
  if (config.AUTH_DISCOVERY_URL) return new URL(config.AUTH_DISCOVERY_URL);
  const url = new URL(config.MCP_PUBLIC_URL.origin);
  url.port = String(config.PORT + 1);
  return url;
}

const authorizationServerUrl = defaultAuthorizationServerUrl();
const runtime = buildHttpApp(config, {
  runtimeName: 'bun',
  tokenStore,
  authorizationServerUrl,
});
const mcpServer = Bun.serve({
  hostname: config.HOST,
  port: config.PORT,
  fetch: (request) => runtime.fetch(request),
});

const authServer = config.AUTH_ENABLED
  ? Bun.serve({
      hostname: config.HOST,
      port: config.PORT + 1,
      fetch: buildAuthApp(config, tokenStore, authorizationServerUrl).fetch,
    })
  : undefined;

logger.info('server', {
  message: 'Spotify MCP servers started',
  mcpUrl: config.MCP_PUBLIC_URL.href,
  oauthUrl: authServer ? authorizationServerUrl.href : undefined,
  protocol: '2026-07-28',
  legacyMode: config.MCP_LEGACY_MODE,
  authEnabled: config.AUTH_ENABLED,
  tokenEncryption: Boolean(config.RS_TOKENS_ENC_KEY),
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('server', { message: 'Shutting down', signal });
  const stopping = [mcpServer.stop(false)];
  if (authServer) stopping.push(authServer.stop(false));
  await runtime.close();
  tokenStore.flush();
  tokenStore.stopCleanup();
  sessionStore.stopCleanup();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    Promise.all(stopping).then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), 5_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!stopped) {
    await mcpServer.stop(true);
    if (authServer) await authServer.stop(true);
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
