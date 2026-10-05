import {
  type AccessToken,
  type IAuthStrategy,
  type IValidateResponses,
  SpotifyApi,
} from '@spotify/web-api-ts-sdk';
import { SPOTIFY_ACCOUNTS_URL } from './spotify-oauth';

/**
 * Spotify Web API clients (https://developer.spotify.com/documentation/web-api), built on
 * `@spotify/web-api-ts-sdk`. A user client acts with the Spotify access token the OAuth proxy
 * resolved for this request, never with the client's own MCP token, and can't refresh it. The
 * app client uses the server's own client credentials, for catalog search.
 *
 * A failed call throws `Error('Spotify request failed: <status> <text> - <body> [<code>]')`,
 * with `status` set. Tools read the code to tell the model what to do next.
 */
export type SpotifyErrorCode = 'unauthorized' | 'forbidden' | 'rate_limited' | 'bad_response';

export function errorCodeFor(status: number): SpotifyErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  return 'bad_response';
}

/** The `[code]` a failed call's message ends with, if any. */
export function errorCodeOf(error: unknown): SpotifyErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return /\[(unauthorized|forbidden|rate_limited|bad_response)\]$/.exec(message)?.[1] as
    | SpotifyErrorCode
    | undefined;
}

/** The message of a failed call without its `[code]`. */
export function withoutCode(message: string): string {
  return message.replace(/\s*\[[^\]]+\]$/, '');
}

/**
 * Run one SDK call. An HTTP failure keeps its status and gets the `[code]` suffix; any other
 * error passes through unchanged.
 */
export async function spotifyCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (typeof status !== 'number') throw error instanceof Error ? error : new Error(String(error));
    const decorated = new Error(
      `${withoutCode((error as Error).message)} [${errorCodeFor(status)}]`,
    );
    (decorated as { status?: number }).status = status;
    throw decorated;
  }
}

/** Every non-2xx answer becomes an error that carries Spotify's status and body. */
const responseValidator: IValidateResponses = {
  async validateResponse(response) {
    if (response.status === 204 || response.ok) return;
    const body = await response.text().catch(() => '');
    const error = new Error(
      `Spotify request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
    );
    (error as { status?: number }).status = response.status;
    throw error;
  },
};

/** Empty and non-JSON bodies (204 from player commands) read as `null`. */
const deserializer = {
  async deserialize<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (text.length === 0) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null as T;
    }
  },
};

export interface SpotifyClients {
  /** A client acting as the signed-in user, with the token the OAuth proxy resolved. */
  user(accessToken: string): SpotifyApi;
  /** The server's own client (client credentials), for catalog search. Throws without them. */
  app(): SpotifyApi;
  /** Waits between playback-state reads. Tests replace it so they don't sleep. */
  wait(ms: number): Promise<void>;
}

/** `fetch` as the SDK calls it. */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SpotifyClientOptions {
  /** `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`. */
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** Injected in tests and smoke runs. Defaults to the runtime's `fetch`. */
  fetch?: Fetch;
  wait?: (ms: number) => Promise<void>;
}

export function createSpotifyClients(options: SpotifyClientOptions): SpotifyClients {
  // Wrapped: the SDK calls `fetch` as a method of its options, and Workers refuse a `fetch`
  // called with another `this`.
  const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const sdkOptions = { responseValidator, deserializer, fetch: fetchImpl };
  let app: SpotifyApi | undefined;

  return {
    user: (accessToken) => new SpotifyApi(new ResolvedTokenStrategy(accessToken), sdkOptions),
    app() {
      if (!options.clientId || !options.clientSecret) {
        throw new Error('Spotify client credentials are not configured');
      }
      // One app client per deployment: its token is cached until it expires.
      app ??= new SpotifyApi(
        new ClientCredentials(options.clientId, options.clientSecret, fetchImpl),
        sdkOptions,
      );
      return app;
    },
    wait: options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/**
 * The user's Spotify token, as the OAuth verifier resolved and refreshed it before the tool
 * ran. This strategy never sees a refresh token and never refreshes.
 */
class ResolvedTokenStrategy implements IAuthStrategy {
  private readonly token: AccessToken;

  constructor(accessToken: string) {
    this.token = {
      access_token: accessToken,
      refresh_token: '',
      token_type: 'Bearer',
      expires_in: 3_600,
      expires: Date.now() + 3_600_000,
    };
  }

  setConfiguration(): void {}

  async getOrCreateAccessToken(): Promise<AccessToken> {
    return this.token;
  }

  async getAccessToken(): Promise<AccessToken> {
    return this.token;
  }

  removeAccessToken(): void {}
}

/**
 * The client credentials flow, as the SDK's `ClientCredentialsStrategy` does it, but with an
 * injectable `fetch`: the SDK's strategy always calls the global one.
 */
class ClientCredentials implements IAuthStrategy {
  private token: AccessToken | undefined;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: Fetch,
  ) {}

  setConfiguration(): void {}

  async getOrCreateAccessToken(): Promise<AccessToken> {
    if (this.token && Date.now() < (this.token.expires ?? 0) - 60_000) return this.token;
    const response = await this.fetchImpl(`${SPOTIFY_ACCOUNTS_URL}/api/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
      },
      body: 'grant_type=client_credentials&scope=',
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('Failed to get access token.');
    }
    const token = (await response.json()) as AccessToken;
    this.token = { ...token, expires: Date.now() + Number(token.expires_in) * 1000 };
    return this.token;
  }

  async getAccessToken(): Promise<AccessToken | null> {
    return this.token ?? null;
  }

  removeAccessToken(): void {
    this.token = undefined;
  }
}
