import { oauthError } from './errors';

/** A client registered through `/register` (RFC 7591). Also the stored shape. */
export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  application_type: 'native' | 'web';
  token_endpoint_auth_method: 'none';
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  client_name?: string | undefined;
}

/** One `/authorize` request, from the redirect to the provider until the client redeems its code. */
export interface AuthorizationTransaction {
  clientId: string;
  redirectUri: string;
  state?: string | undefined;
  resource: string;
  codeChallenge: string;
  providerCallbackUri: string;
  expiresAt: number;
  scope?: string | undefined;
}

/** An issued authorization code: the transaction plus the provider's tokens, encrypted. */
export type Grant = AuthorizationTransaction & { providerMaterial: string };
type Pending = AuthorizationTransaction & { phase: 'pending' | 'processing' };

/**
 * Everything the authority keeps for one client, stored as one JSON document per client
 * (`client_id`). Existing Durable Objects hold documents in this exact shape.
 */
export interface AuthorityDocument {
  client?: RegisteredClient;
  transactions: Record<string, Pending>;
  codes: Record<string, Grant>;
}

export type AuthorityCommand =
  | { kind: 'register'; client: RegisteredClient }
  | { kind: 'client' }
  | { kind: 'begin'; handle: string; txn: AuthorizationTransaction }
  | { kind: 'claim'; handle: string }
  | { kind: 'issue'; handle: string; code: string; providerMaterial: string }
  | {
      kind: 'consume';
      code: string;
      clientId: string;
      redirectUri: string;
      resource: string;
      challenge: string;
    }
  | { kind: 'cleanup' };

export type AuthorityResult = RegisteredClient | AuthorizationTransaction | Grant | null;

/**
 * Atomic, per-client state for registrations, transactions and codes: a Durable Object on
 * Workers (`authority-do.ts`), files on Bun (`authority-file.ts`), memory in tests.
 */
export interface OAuthAuthority {
  execute(clientId: string, command: AuthorityCommand): Promise<AuthorityResult>;
}

export const emptyDocument = (): AuthorityDocument => ({ transactions: {}, codes: {} });

/**
 * Client IDs are 32 base64url characters. Transaction handles and codes are
 * `<client_id>.<32 more>`, so every request routes to its client's document.
 */
export function routeId(handle: string): string {
  if (!/^[A-Za-z0-9_-]{32}(?:\.[A-Za-z0-9_-]{32})?$/.test(handle))
    throw oauthError('invalid_grant');
  return handle.split('.')[0] as string;
}

export function cleanupDocument(doc: AuthorityDocument, now: number): void {
  for (const [id, txn] of Object.entries(doc.transactions)) {
    if (txn.expiresAt <= now) delete doc.transactions[id];
  }
  for (const [id, code] of Object.entries(doc.codes)) {
    if (code.expiresAt <= now) delete doc.codes[id];
  }
}

/**
 * The state machine, applied inside each backend's atomic read-modify-write. It never awaits
 * external I/O.
 *
 *  - `begin` stores a pending transaction (at most 10 minutes; at most 100 open per client).
 *  - `claim` moves it to processing before the provider is called, so a callback runs once.
 *  - `issue` turns the claimed transaction into a code (at most 2 minutes).
 *  - `consume` redeems the code once, only with the same client, redirect, resource and PKCE.
 */
export function transition(
  doc: AuthorityDocument,
  clientId: string,
  command: AuthorityCommand,
  now = Date.now(),
): AuthorityResult {
  routeId(clientId);
  cleanupDocument(doc, now);
  if (command.kind === 'cleanup') return null;
  if (command.kind === 'register') {
    if (doc.client || command.client.client_id !== clientId) throw oauthError('invalid_client');
    doc.client = command.client;
    return doc.client;
  }
  if (!doc.client || doc.client.client_id !== clientId) throw oauthError('invalid_client');
  if (command.kind === 'client') return doc.client;
  if (command.kind === 'begin') {
    if (
      command.txn.clientId !== clientId ||
      routeId(command.handle) !== clientId ||
      command.txn.expiresAt <= now ||
      command.txn.expiresAt > now + 600_000 ||
      doc.transactions[command.handle] ||
      Object.keys(doc.transactions).length + Object.keys(doc.codes).length >= 100
    ) {
      throw oauthError('invalid_request');
    }
    doc.transactions[command.handle] = { ...command.txn, phase: 'pending' };
    return null;
  }
  if (command.kind === 'claim' || command.kind === 'issue') {
    const txn = doc.transactions[command.handle];
    if (!txn || txn.phase !== (command.kind === 'claim' ? 'pending' : 'processing')) {
      throw oauthError('invalid_grant');
    }
    if (command.kind === 'claim') {
      txn.phase = 'processing';
      return txn;
    }
    if (routeId(command.code) !== clientId || doc.codes[command.code]) {
      throw oauthError('invalid_grant');
    }
    doc.codes[command.code] = {
      ...txn,
      expiresAt: Math.min(txn.expiresAt, now + 120_000),
      providerMaterial: command.providerMaterial,
    };
    delete doc.transactions[command.handle];
    return null;
  }
  const grant = doc.codes[command.code];
  if (
    !grant ||
    grant.clientId !== command.clientId ||
    grant.redirectUri !== command.redirectUri ||
    grant.resource !== command.resource ||
    grant.codeChallenge !== command.challenge
  ) {
    throw oauthError('invalid_grant');
  }
  delete doc.codes[command.code];
  return grant;
}

/** For tests: one process, no persistence. */
export class MemoryOAuthAuthority implements OAuthAuthority {
  private documents = new Map<string, AuthorityDocument>();

  async execute(clientId: string, command: AuthorityCommand): Promise<AuthorityResult> {
    const doc = structuredClone(this.documents.get(clientId) ?? emptyDocument());
    const result = transition(doc, clientId, command);
    this.documents.set(clientId, doc);
    return structuredClone(result);
  }
}
