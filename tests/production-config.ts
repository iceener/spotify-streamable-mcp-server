import { describe } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Config } from '../src/platform/config';

/**
 * The three Wrangler configs, for tests. The production one, `wrangler.production.jsonc`, is
 * gitignored: it names the deployed Worker, its account, its storage IDs and the allowlists.
 * The committed `wrangler.production.example.jsonc` has the same shape with stand-in values,
 * and tests serve it in process as "production". Checks of the real file run only where it
 * exists. Shared by every server built on the template; copy it unchanged.
 */
export interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  account_id?: string;
  workers_dev?: boolean;
  vars: Record<string, string>;
  secrets?: { required: string[] };
  kv_namespaces?: Array<{ binding: string; id: string }>;
  durable_objects?: { bindings: Array<{ name: string; class_name: string }> };
  migrations?: Array<Record<string, unknown>>;
}

const ROOT = `${import.meta.dir}/..`;
const PRIVATE_PATH = `${ROOT}/wrangler.production.jsonc`;

async function read(file: string): Promise<WranglerConfig> {
  return Bun.JSONC.parse(await Bun.file(file).text()) as WranglerConfig;
}

export const DEVELOPMENT = await read(`${ROOT}/wrangler.jsonc`);
export const EXAMPLE = await read(`${ROOT}/wrangler.production.example.jsonc`);
/** The real production config, or `undefined` outside the operator's checkout. */
export const PRIVATE = existsSync(PRIVATE_PATH) ? await read(PRIVATE_PATH) : undefined;

/** A `describe` that runs only where the real production config exists. */
export const describePrivate = PRIVATE ? describe : describe.skip;

/** The stand-in production vars, from the example. */
export const PRODUCTION_VARS: Readonly<Record<string, string>> = EXAMPLE.vars;
export const ORIGIN = new URL(EXAMPLE.vars.MCP_PUBLIC_URL as string).origin;
export const HOST = new URL(ORIGIN).host;

/** Every key and name in a config, without the values, to compare the two production files. */
export function shapeOf(config: WranglerConfig) {
  return {
    keys: Object.keys(config)
      .filter((key) => key !== '$schema')
      .sort(),
    vars: Object.keys(config.vars).sort(),
    // How many entries each comma-separated var has, such as origins and redirect URIs.
    listLengths: Object.fromEntries(
      Object.entries(config.vars).map(([name, value]) => [name, value.split(',').length]),
    ),
    secrets: config.secrets?.required ?? [],
    kv: (config.kv_namespaces ?? []).map((namespace) => namespace.binding),
    durableObjects: config.durable_objects?.bindings ?? [],
    migrations: config.migrations ?? [],
    runtime: [config.main, config.compatibility_date, config.compatibility_flags ?? []],
  };
}

/** What a parsed config serves, without its host names: compare the real file with the example. */
export function servedAs(config: Config) {
  return {
    environment: config.environment,
    authMode: config.auth.mode,
    publicPath: config.publicUrl.pathname,
    publicHostAllowed: config.allowedHosts.includes(config.publicUrl.host),
    publicHostIsAnOrigin: config.allowedOrigins.includes(config.publicUrl.hostname),
    claudeIsAnOrigin: ['claude.ai', 'claude.com'].every((host) =>
      config.allowedOrigins.includes(host),
    ),
    origins: config.allowedOrigins.length,
    legacy: config.legacy,
    maxRequestBytes: config.maxRequestBytes,
  };
}

/** SHA-256 of a config's content, keys sorted, without `$schema`. */
export function digestOf(config: WranglerConfig): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .filter((key) => key !== '$schema')
              .sort()
              .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(sorted(config)))
    .digest('hex');
}
