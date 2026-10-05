import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTokenStore } from '../../src/oauth/token-store-file';
import { memoryLogger } from '../helpers';

/**
 * Shared by every OAuth proxy built on `src/oauth/`: the Bun token file. Provider-neutral on
 * purpose; copy it unchanged.
 */
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const directories: string[] = [];

function tokenFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'oauth-file-store-'));
  directories.push(directory);
  return join(directory, 'rs-tokens.json');
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('FileTokenStore', () => {
  test('a record survives a restart after its provider token expired, so it can be refreshed', async () => {
    const path = tokenFile();
    const writer = new FileTokenStore(path, KEY, memoryLogger());
    await writer.storeRsMapping(
      'access-token',
      {
        access_token: 'provider-old',
        refresh_token: 'provider-refresh',
        expires_at: Date.now() - 60_000,
      },
      'refresh-token',
    );
    writer.flush();

    const restarted = new FileTokenStore(path, KEY, memoryLogger());
    expect((await restarted.getByRsAccess('access-token'))?.provider).toMatchObject({
      access_token: 'provider-old',
      refresh_token: 'provider-refresh',
    });
    expect(await restarted.getByRsRefresh('refresh-token')).not.toBeNull();
  });
});
