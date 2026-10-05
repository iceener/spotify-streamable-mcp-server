import { describe, expect, test } from 'bun:test';
import { OAuthError } from '@modelcontextprotocol/server';
import { createEncryptor } from '../../src/oauth/crypto';
import { readStandardTokenResponse } from '../../src/oauth/provider';
import { type KvLike, KvTokenStore } from '../../src/oauth/token-store-kv';
import { createProxyVerifier } from '../../src/oauth/verifier';
import { type LogEntry, memoryLogger } from '../helpers';

/**
 * Shared by every OAuth proxy built on `src/oauth/`: what the verifier answers when the token
 * store fails. Provider-neutral on purpose; copy it unchanged.
 */
const RESOURCE = new URL('https://mcp.example.com/mcp');
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

const provider = {
  name: 'Example',
  authorizationUrl: 'https://provider.example/authorize',
  tokenUrl: 'https://provider.example/token',
  scopes: ['read'],
  authorizationParams: {},
  readTokens: readStandardTokenResponse,
};

function verifierFor(kv: KvLike, logs: LogEntry[] = []) {
  const logger = memoryLogger(logs);
  return createProxyVerifier({
    tokens: new KvTokenStore(kv, { encryptor: createEncryptor(KEY), logger }),
    provider,
    credentials: { clientId: 'id', clientSecret: 'secret' },
    resource: RESOURCE,
    logger,
  });
}

const unreachable: KvLike = {
  get: async () => {
    throw new Error('KV unavailable for rs:access:secret-token');
  },
  put: async () => {},
  delete: async () => {},
};

describe('token store failures', () => {
  test('an unreachable store is a server error: the client keeps its token', async () => {
    const logs: LogEntry[] = [];
    const failure = await verifierFor(unreachable, logs)
      .verifyAccessToken('secret-token')
      .catch((error: unknown) => error);

    // Anything but an OAuthError becomes 500 server_error in the SDK's bearer gate.
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(OAuthError);
    expect(logs.map(({ level, message }) => [level, message])).toEqual([
      ['error', 'Could not check an access token'],
    ]);
    // The KV key holds the token; neither it nor KV's own message reaches the log.
    expect(JSON.stringify(logs)).not.toContain('secret-token');
  });

  test('a record that will not decrypt is an invalid token: the client signs in again', async () => {
    const garbled: KvLike = {
      get: async () => 'not-a-ciphertext',
      put: async () => {},
      delete: async () => {},
    };
    const failure = await verifierFor(garbled)
      .verifyAccessToken('some-token')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OAuthError);
    expect((failure as OAuthError).code).toBe('invalid_token');
  });

  test('a token that is not stored is an invalid token', async () => {
    const empty: KvLike = { get: async () => null, put: async () => {}, delete: async () => {} };
    const failure = await verifierFor(empty)
      .verifyAccessToken('unknown-token')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OAuthError);
    expect((failure as OAuthError).code).toBe('invalid_token');
  });
});
