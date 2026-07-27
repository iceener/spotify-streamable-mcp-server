import { preloadSchemas } from '@modelcontextprotocol/server';
import { initializeWorkerStorage } from './adapters/http-workers/index.js';
import { buildHttpApp, type HttpRuntime } from './http/app.js';
import { parseConfig } from './shared/config/env.js';

preloadSchemas();

export function createWorkerRuntime(env: Env, request: Request): HttpRuntime {
  const requestUrl = new URL(request.url);
  const values: Record<string, unknown> = { ...env };
  values.MCP_PUBLIC_URL ||= `${requestUrl.origin}/mcp`;
  values.MCP_ALLOWED_HOSTS ||= requestUrl.hostname;
  values.MCP_ALLOWED_ORIGIN_HOSTNAMES ||= requestUrl.hostname;
  values.AUTH_DISCOVERY_URL ||= requestUrl.origin;

  const config = parseConfig(values);
  const storage = initializeWorkerStorage(env, config);
  return buildHttpApp(config, {
    runtimeName: 'cloudflare-workers',
    tokenStore: storage.tokenStore,
    authorizationServerUrl: new URL(config.AUTH_DISCOVERY_URL ?? requestUrl.origin),
    includeOAuthRoutes: true,
  });
}

let runtime: HttpRuntime | undefined;

export default {
  fetch(request, env) {
    runtime ??= createWorkerRuntime(env, request);
    return runtime.fetch(request);
  },
} satisfies ExportedHandler<Env>;
