import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Spotify on loopback, for the smoke tests: the accounts token endpoint (code, refresh and
 * client credentials) and the Web API calls the smoke client makes. It runs under Bun and
 * Node. Requests for Spotify reach it through `toMock`, so nothing leaves the machine.
 */
export const SPOTIFY_HOSTS = ['accounts.spotify.com', 'api.spotify.com'];
export const MOCK_DEVICE = 'smoke-device';
const SCOPES =
  'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read user-library-modify';

export interface MockSpotify {
  origin: string;
  /** Grant types the token endpoint received, in order. */
  grants: string[];
  /** Hold the player's answer this long, to test quiet connections. */
  delayMs: number;
  close(): Promise<void>;
}

export async function startMockSpotify(
  clientId: string,
  clientSecret: string,
): Promise<MockSpotify> {
  const mock: MockSpotify = { origin: '', grants: [], delayMs: 0, close: async () => {} };
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

  const server = createServer(async (request, response) => {
    const send = (status: number, body?: unknown) => {
      response.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const url = new URL(request.url ?? '/', 'http://mock');
    if (request.method === 'POST' && url.pathname === '/api/token') {
      const form = new URLSearchParams(await text(request));
      if (request.headers.authorization !== basic) return send(401, { error: 'invalid_client' });
      const grant = form.get('grant_type') ?? '';
      mock.grants.push(grant);
      return send(200, {
        access_token: grant === 'client_credentials' ? 'spotify-app' : 'spotify-user',
        token_type: 'Bearer',
        expires_in: 3600,
        ...(grant !== 'client_credentials' && { refresh_token: 'spotify-refresh', scope: SCOPES }),
      });
    }
    const user = request.headers.authorization === 'Bearer spotify-user';
    if (request.method === 'GET' && url.pathname === '/v1/me/player' && user) {
      await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
      return send(200, { is_playing: false, device: { id: MOCK_DEVICE } });
    }
    if (request.method === 'GET' && url.pathname === '/v1/me/player/devices' && user) {
      return send(200, {
        devices: [{ id: MOCK_DEVICE, name: 'Smoke', type: 'Computer', is_active: true }],
      });
    }
    if (request.method === 'GET' && url.pathname === '/v1/me/player/currently-playing' && user) {
      return send(204);
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/v1/search' &&
      request.headers.authorization === 'Bearer spotify-app'
    ) {
      return send(200, {
        tracks: { total: 1, items: [{ id: 't1', uri: 'spotify:track:t1', name: 'Smoke Song' }] },
      });
    }
    send(request.headers.authorization ? 404 : 401, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return mock;
}

/** The same request, sent to the mock instead of Spotify. Other hosts are refused. */
export async function toMock(request: Request, mock: MockSpotify): Promise<Request> {
  const url = new URL(request.url);
  if (!SPOTIFY_HOSTS.includes(url.hostname)) {
    throw new Error(`The smoke test blocked a request to ${url.origin}`);
  }
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();
  return new Request(`${mock.origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers: request.headers,
    ...(body !== undefined && { body }),
  });
}

function text(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
