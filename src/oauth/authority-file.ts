import {
  chmod,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type AuthorityCommand,
  type AuthorityDocument,
  type AuthorityResult,
  emptyDocument,
  type OAuthAuthority,
  routeId,
  transition,
} from './authority';
import { oauthError } from './errors';

// Shared by every instance in one Bun process. Several processes must not share a directory.
const queues = new Map<string, Promise<unknown>>();

/**
 * The authority on Bun: one JSON file per client in an owner-only directory. Commands for a
 * client run one at a time; each write is fsynced and renamed into place. Wait for `ready`,
 * then call `cleanupExpired()` at startup and every minute.
 */
export class FileOAuthAuthority implements OAuthAuthority {
  readonly ready: Promise<void>;
  private directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
    this.ready = mkdir(this.directory, { recursive: true, mode: 0o700 }).then(async () => {
      this.directory = await realpath(this.directory);
      await chmod(this.directory, 0o700);
    });
  }

  /** Drop expired transactions and codes, and temporary files older than 10 minutes. */
  async cleanupExpired(): Promise<void> {
    await this.ready;
    for await (const entry of await opendir(this.directory)) {
      if (/^[A-Za-z0-9_-]{32}\.json$/.test(entry.name)) {
        await this.execute(entry.name.slice(0, -5), { kind: 'cleanup' });
      } else if (/^[A-Za-z0-9_-]{32}\.json\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
        const path = `${this.directory}/${entry.name}`;
        try {
          if ((await stat(path)).mtimeMs < Date.now() - 600_000) await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  }

  async execute(clientId: string, command: AuthorityCommand): Promise<AuthorityResult> {
    if (routeId(clientId) !== clientId) throw oauthError('invalid_client');
    await this.ready;
    const path = `${this.directory}/${clientId}.json`;
    const operation = (queues.get(path) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        let doc: AuthorityDocument;
        try {
          doc = JSON.parse(await readFile(path, 'utf8')) as AuthorityDocument;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          doc = emptyDocument();
        }
        const result = transition(doc, clientId, command);
        const temp = `${path}.${crypto.randomUUID()}.tmp`;
        try {
          const file = await open(temp, 'wx', 0o600);
          try {
            await file.writeFile(JSON.stringify(doc));
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temp, path);
          const directory = await open(this.directory, 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } finally {
          await unlink(temp).catch(() => {});
        }
        return result;
      });
    queues.set(path, operation);
    try {
      return await operation;
    } finally {
      if (queues.get(path) === operation) queues.delete(path);
    }
  }
}
