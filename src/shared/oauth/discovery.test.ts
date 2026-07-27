import { describe, expect, test } from 'bun:test';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from './discovery.js';

describe('OAuth discovery metadata', () => {
  test('uses a stable protected resource identifier without session query state', () => {
    const metadata = buildProtectedResourceMetadata(
      'https://spotify-mcp.example/mcp',
      'https://spotify-mcp.example',
    );

    expect(metadata).toEqual({
      authorization_servers: ['https://spotify-mcp.example'],
      resource: 'https://spotify-mcp.example/mcp',
    });
    expect(metadata.resource).not.toContain('sid');
  });

  test('advertises authorization code, refresh, PKCE S256, public clients, and DCR', () => {
    const metadata = buildAuthorizationServerMetadata('https://spotify-mcp.example', [
      'user-read-playback-state',
    ]);

    expect(metadata.grant_types_supported).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    expect(metadata.response_types_supported).toContain('code');
    expect(metadata.code_challenge_methods_supported).toContain('S256');
    expect(metadata.token_endpoint_auth_methods_supported).toContain('none');
    expect(metadata.registration_endpoint).toBe('https://spotify-mcp.example/register');
  });
});
