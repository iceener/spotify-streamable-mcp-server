import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';
import type { OAuthAuthority, RegisteredClient } from '../../src/oauth/authority';
import before from '../fixtures/storage-before.json';

/**
 * Shared by every OAuth proxy built on `src/oauth/`: the Durable Object authority keeps the
 * storage layout and the addressing the deployed Workers use. A different table or object
 * name would lose every registration, pending sign-in and code. Provider-neutral on purpose;
 * copy it unchanged. The object's SQLite storage is backed by bun:sqlite here.
 */
mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));
// The module needs Workers types, which the Bun typecheck leaves out, so it is imported
// through a variable and typed by what this test uses.
const AUTHORITY_DO = '../../src/oauth/authority-do';
const { NativeOAuthAuthority, durableObjectAuthority } = (await import(AUTHORITY_DO)) as {
  NativeOAuthAuthority: new (state: unknown, env: unknown) => OAuthAuthority;
  durableObjectAuthority: (namespace: unknown) => OAuthAuthority;
};

const document = JSON.parse(before.authorityDocument) as { client: RegisteredClient };
const clientId = document.client.client_id;

function objectState(db: Database) {
  return {
    storage: {
      sql: {
        exec: (query: string, ...bindings: SQLQueryBindings[]) => {
          const rows = db.query(query).all(...bindings);
          return { toArray: () => rows };
        },
      },
      transactionSync: <T>(run: () => T): T => db.transaction(run)(),
      setAlarm: async () => {},
    },
  };
}

test('the object opens the row the deployed Worker wrote, in the same table', async () => {
  const db = new Database(':memory:');
  // The table and row exactly as the deployed code wrote them.
  db.run('CREATE TABLE authority (id INTEGER PRIMARY KEY CHECK(id = 1), document TEXT NOT NULL)');
  db.run('INSERT INTO authority VALUES (1, ?)', [before.authorityDocument]);

  const authority = new NativeOAuthAuthority(objectState(db), {});
  expect(await authority.execute(clientId, { kind: 'client' })).toEqual(document.client);
});

test('each client has its own object, named by its client ID', async () => {
  const names: string[] = [];
  const namespace = {
    getByName: (name: string) => {
      names.push(name);
      return { execute: async () => null };
    },
  };
  await durableObjectAuthority(namespace).execute(clientId, { kind: 'client' });
  expect(names).toEqual([clientId]);
});
