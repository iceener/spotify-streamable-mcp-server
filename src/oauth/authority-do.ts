import { DurableObject } from 'cloudflare:workers';
import {
  type AuthorityCommand,
  type AuthorityDocument,
  type AuthorityResult,
  cleanupDocument,
  emptyDocument,
  type OAuthAuthority,
  routeId,
  transition,
} from './authority';
import { oauthError } from './errors';

/**
 * The authority on Workers: one SQLite-backed object per registered client, reached only
 * through internal RPC. Each command reads, checks and writes the client's document in one
 * `transactionSync`, so concurrent callbacks and token requests can't both win.
 *
 * Deployed as class `NativeOAuthAuthority`, binding `OAUTH_AUTHORITY`, migration tag
 * `v1-native-oauth-authority`. Renaming the class or the table loses every registration.
 */
export class NativeOAuthAuthority extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS authority (id INTEGER PRIMARY KEY CHECK(id = 1), document TEXT NOT NULL)',
    );
  }

  async execute(clientId: string, command: AuthorityCommand): Promise<AuthorityResult> {
    if (routeId(clientId) !== clientId) throw oauthError('invalid_client');
    // Arm the cleanup alarm before the write, so even a crash after it leaves one set.
    await this.ctx.storage.setAlarm(Date.now() + 600_001);
    return this.ctx.storage.transactionSync(() => {
      const doc = this.read() ?? emptyDocument();
      const result = transition(doc, clientId, command);
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO authority VALUES (1, ?)',
        JSON.stringify(doc),
      );
      return result;
    });
  }

  override async alarm(): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const doc = this.read();
      if (!doc) return;
      cleanupDocument(doc, Date.now());
      this.ctx.storage.sql.exec(
        'UPDATE authority SET document = ? WHERE id = 1',
        JSON.stringify(doc),
      );
    });
  }

  private read(): AuthorityDocument | undefined {
    const row = this.ctx.storage.sql
      .exec<{ document: string }>('SELECT document FROM authority WHERE id = 1')
      .toArray()[0];
    return row ? (JSON.parse(row.document) as AuthorityDocument) : undefined;
  }
}

/** The authority as the proxy uses it, backed by the `OAUTH_AUTHORITY` namespace. */
export function durableObjectAuthority(
  namespace: DurableObjectNamespace<NativeOAuthAuthority>,
): OAuthAuthority {
  return {
    execute: (clientId, command) => namespace.getByName(clientId).execute(clientId, command),
  };
}
