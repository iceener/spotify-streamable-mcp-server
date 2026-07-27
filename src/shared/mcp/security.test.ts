import { describe, expect, test } from 'bun:test';
import { buildUnauthorizedChallenge } from './security.js';

describe('MCP unauthorized challenge', () => {
  test('advertises RFC 9728 resource metadata without session state in the URL', () => {
    const challenge = buildUnauthorizedChallenge({
      origin: 'https://spotify-mcp.example',
      sid: 'session-secret',
    });

    expect(challenge.status).toBe(401);
    expect(challenge.headers['WWW-Authenticate']).toBe(
      'Bearer realm="MCP", resource_metadata="https://spotify-mcp.example/.well-known/oauth-protected-resource"',
    );
    expect(challenge.headers['WWW-Authenticate']).not.toContain('authorization_uri');
    expect(challenge.headers['WWW-Authenticate']).not.toContain('session-secret');
    expect(challenge.headers['Mcp-Session-Id']).toBe('session-secret');
  });

  test('resolves an explicit metadata path against the exact resource origin', () => {
    const challenge = buildUnauthorizedChallenge({
      origin: 'https://spotify-mcp.example',
      sid: 'session-id',
      resourcePath: '/mcp/.well-known/oauth-protected-resource',
    });

    expect(challenge.headers['WWW-Authenticate']).toContain(
      'resource_metadata="https://spotify-mcp.example/mcp/.well-known/oauth-protected-resource"',
    );
  });

  test.each([
    'https://attacker.example/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource?sid=secret',
    '/.well-known/oauth-protected-resource#fragment',
  ])('rejects an unsafe metadata path: %s', (resourcePath) => {
    expect(() =>
      buildUnauthorizedChallenge({
        origin: 'https://spotify-mcp.example',
        sid: 'session-id',
        resourcePath,
      }),
    ).toThrow('Invalid protected resource metadata URL');
  });
});
