import type { RegisteredClient } from './authority';

/**
 * Where the proxy may send a client back with its code. Two kinds of redirect URI pass:
 *
 *  1. Native loopback: a client registered with `application_type: native` and no secret may
 *     use `http://127.0.0.1:<port>/<path>`, spelled exactly so, with any port at authorize
 *     time but its registered path. `localhost`, IPv6, numeric aliases, userinfo, queries,
 *     fragments and dot segments are refused.
 *  2. Configured: an entry in `PROXY_REDIRECT_ALLOWLIST`, matched exactly, or an HTTPS
 *     origin entry (`https://host/`) that admits any path on that origin. Plain `http`
 *     entries never match; loopback goes through rule 1 only.
 *
 * Either way the URI must also be one the client registered.
 */
export interface RedirectPolicy {
  redirectAllowlist: readonly string[];
}

/** The raw spelling is checked before URL parsing can normalize numeric aliases. */
export function nativeLoopback(uri: string): URL | null {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})(\/[^?#\\\s]*)$/.exec(uri);
  if (!match || Number(match[1]) > 65535) return null;
  try {
    const url = new URL(uri);
    // URL drops a default :80 but keeps the path; a normalized path is a different URI.
    if (url.pathname !== match[2]) return null;
    return url;
  } catch {
    return null;
  }
}

export function configuredRedirect(uri: string, policy: RedirectPolicy): boolean {
  try {
    const url = new URL(uri);
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(uri)?.[1];
    if (url.username || url.password || /[?#\s\\]/.test(uri) || authority?.includes('@')) {
      return false;
    }
    if (url.protocol === 'https:') {
      const rawHost = authority?.replace(/:[0-9]+$/, '');
      if (rawHost?.toLowerCase() !== url.hostname.toLowerCase()) return false;
    }
    // Plain http is only ever the native loopback rule, never a configured web callback.
    if (url.protocol === 'http:' || !/^[a-z][a-z0-9+.-]*:/i.test(uri)) return false;
    return policy.redirectAllowlist.filter(Boolean).some((entry) => {
      if (entry === uri) return true;
      try {
        const allowed = new URL(entry);
        return (
          url.protocol === 'https:' &&
          allowed.protocol === 'https:' &&
          allowed.pathname === '/' &&
          !allowed.search &&
          !allowed.hash &&
          !allowed.username &&
          !allowed.password &&
          allowed.origin === url.origin
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** May a client of this kind register this redirect URI? */
export function permittedRedirect(
  uri: string,
  client: Pick<RegisteredClient, 'application_type' | 'token_endpoint_auth_method'>,
  policy: RedirectPolicy,
): boolean {
  return (
    (client.application_type === 'native' &&
      client.token_endpoint_auth_method === 'none' &&
      !!nativeLoopback(uri)) ||
    configuredRedirect(uri, policy)
  );
}

/** May this client use this redirect URI now? Native clients may change only the port. */
export function registeredRedirect(
  uri: string,
  client: RegisteredClient,
  policy: RedirectPolicy,
): boolean {
  if (!permittedRedirect(uri, client, policy)) return false;
  return client.redirect_uris.some((registered) => {
    if (registered === uri) return true;
    const chosen = nativeLoopback(uri);
    const original = nativeLoopback(registered);
    return (
      client.application_type === 'native' &&
      !!chosen &&
      !!original &&
      chosen.pathname === original.pathname
    );
  });
}
