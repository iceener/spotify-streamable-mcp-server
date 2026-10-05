import { expect, test } from 'bun:test';
import { ConfigError, parseConfig } from '../src/platform/config';
import { Settings } from '../src/settings';
import {
  DEVELOPMENT,
  describePrivate,
  digestOf,
  EXAMPLE,
  PRIVATE,
  PRODUCTION_VARS,
  servedAs,
  shapeOf,
  type WranglerConfig,
} from './production-config';

/** The deployed Worker's secrets (version 37). Renaming one signs every user out or breaks sign-in. */
const DEPLOYED_SECRETS = [
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'RS_TOKENS_ENC_KEY',
  'TOKENS_ENC_KEY',
];
const SECRETS = {
  SPOTIFY_CLIENT_ID: 'id',
  SPOTIFY_CLIENT_SECRET: 'secret',
  RS_TOKENS_ENC_KEY: Buffer.alloc(32).toString('base64url'),
  TOKENS_ENC_KEY: Buffer.alloc(32, 1).toString('base64url'),
};

/** The callbacks of the public clients. Every production allowlist lists them. */
const CLIENT_CALLBACKS = [
  'alice://oauth/callback',
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'http://127.0.0.1:*/oauth/callback',
];

test('the production vars, with the deployed secrets, are a valid configuration', () => {
  const config = parseConfig({ ...PRODUCTION_VARS, ...SECRETS });
  expect(config.environment).toBe('production');
  expect(config.auth.mode).toBe('oauth');
  expect(config.publicUrl.href).toBe('https://spotify-mcp.example.workers.dev/mcp');
});

test('the production Worker: name, workers.dev, KV, Durable Object, migrations', () => {
  expect(EXAMPLE.name).toBe('spotify-mcp');
  expect(EXAMPLE.workers_dev).toBe(true);
  expect(EXAMPLE.kv_namespaces?.map((namespace) => namespace.binding)).toEqual(['TOKENS']);
  expect(EXAMPLE.durable_objects?.bindings).toEqual([
    { name: 'OAUTH_AUTHORITY', class_name: 'NativeOAuthAuthority' },
  ]);
  // Applied in production in this order. Only ever append. Development has the same list.
  expect(EXAMPLE.migrations).toEqual([
    { tag: 'v1-oauth-authority', new_sqlite_classes: ['OAuthAuthorityDurableObject'] },
    { tag: 'v2-remove-oauth-authority', deleted_classes: ['OAuthAuthorityDurableObject'] },
    { tag: 'v3-native-oauth-authority', new_sqlite_classes: ['NativeOAuthAuthority'] },
  ]);
  expect(DEVELOPMENT.migrations).toEqual(EXAMPLE.migrations);
});

test('production runs the same code and runtime as development', () => {
  expect(shapeOf(EXAMPLE).runtime).toEqual(shapeOf(DEVELOPMENT).runtime);
});

test("the redirect allowlist lists the public clients' callbacks", () => {
  expect(PRODUCTION_VARS.PROXY_REDIRECT_ALLOWLIST?.split(',')).toEqual(
    expect.arrayContaining(CLIENT_CALLBACKS),
  );
});

test('every deployed secret is declared in src/settings.ts', () => {
  expect(Object.keys(Settings.shape)).toEqual(expect.arrayContaining(DEPLOYED_SECRETS));
});

test('MCP requests need no particular scope, as before 1.1.0', () => {
  // OAUTH_SCOPES is what every MCP request must carry. The deployed server required none, and
  // requiring the Spotify scopes would only add a way to refuse a valid token.
  expect(PRODUCTION_VARS.OAUTH_SCOPES).toBeUndefined();
});

test('the Spotify client ID and secret are set together', () => {
  expect(() => parseConfig({ SPOTIFY_CLIENT_ID: 'id' })).toThrow(ConfigError);
  expect(() => parseConfig({ SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 's' })).not.toThrow();
});

test('the redirect allowlist is a trimmed, de-duplicated list', () => {
  const config = parseConfig({
    PROXY_REDIRECT_ALLOWLIST: ' alice://oauth/callback, https://a.example/,alice://oauth/callback',
  });
  expect(config.settings.PROXY_REDIRECT_ALLOWLIST).toEqual([
    'alice://oauth/callback',
    'https://a.example/',
  ]);
});

test('SPOTIFY_INCLUDE_JSON_IN_CONTENT accepts the values it always did', () => {
  for (const value of ['1', 'true', 'YES', 'on']) {
    expect(
      parseConfig({ SPOTIFY_INCLUDE_JSON_IN_CONTENT: value }).settings
        .SPOTIFY_INCLUDE_JSON_IN_CONTENT,
    ).toBe(true);
  }
  for (const value of ['0', 'false', 'no', 'off']) {
    expect(
      parseConfig({ SPOTIFY_INCLUDE_JSON_IN_CONTENT: value }).settings
        .SPOTIFY_INCLUDE_JSON_IN_CONTENT,
    ).toBe(false);
  }
  expect(parseConfig({}).settings.SPOTIFY_INCLUDE_JSON_IN_CONTENT).toBe(false);
  expect(() => parseConfig({ SPOTIFY_INCLUDE_JSON_IN_CONTENT: 'maybe' })).toThrow(ConfigError);
});

test('the Spotify client ID and secret are trimmed, as before 1.1.0', () => {
  const { settings } = parseConfig({
    ...PRODUCTION_VARS,
    SPOTIFY_CLIENT_ID: ' client-id\n',
    SPOTIFY_CLIENT_SECRET: 'client-secret\n',
  });
  expect(settings.SPOTIFY_CLIENT_ID).toBe('client-id');
  expect(settings.SPOTIFY_CLIENT_SECRET).toBe('client-secret');
});

describePrivate('wrangler.production.jsonc, the deployed configuration', () => {
  const real = PRIVATE as WranglerConfig;

  test("has the example's shape: the same keys, vars, list lengths, bindings and migrations", () => {
    expect(shapeOf(real)).toEqual(shapeOf(EXAMPLE));
  });

  test("serves what the example serves, and lists the public clients' callbacks", () => {
    expect(servedAs(parseConfig({ ...real.vars, ...SECRETS }))).toEqual(
      servedAs(parseConfig({ ...EXAMPLE.vars, ...SECRETS })),
    );
    expect(real.vars.PROXY_REDIRECT_ALLOWLIST?.split(',')).toEqual(
      expect.arrayContaining(CLIENT_CALLBACKS),
    );
    // Like the deployed server, MCP requests need no particular scope.
    expect(real.vars.OAUTH_SCOPES).toBeUndefined();
  });

  test('is unchanged since the last deliberate production change', () => {
    // Any edit to wrangler.production.jsonc changes this digest. Update it in the same commit
    // as a deliberate production change; the values themselves stay out of the repository.
    expect(digestOf(real)).toBe('eb54430213a5131f1ecd51bd0d6b0aee1e0164a39298bf32a837925fb640766e');
  });
});
