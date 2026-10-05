import * as z from 'zod/v4';

/**
 * Settings your own code needs: API keys, feature flags, upstream URLs. They are read from
 * the environment and validated at startup together with the platform's configuration, so
 * one misconfigured deploy reports every problem at once. Code reads them as
 * `deps.config.settings`.
 *
 * On Workers, store secrets with `wrangler secret put NAME --config wrangler.production.jsonc`, not in `vars`.
 * docs/oauth.md describes how the OAuth proxy uses each of these. The secret names are the
 * deployed ones: renaming one breaks sign-in or signs every user out.
 */
export const Settings = z
  .object({
    SPOTIFY_CLIENT_ID: z
      .string()
      .optional()
      .describe("Secret. The server's Spotify app: client ID."),
    SPOTIFY_CLIENT_SECRET: z
      .string()
      .optional()
      .describe("Secret. The server's Spotify app: client secret."),
    RS_TOKENS_ENC_KEY: z
      .string()
      .optional()
      .describe(
        'Secret. 32 random bytes, base64url: encrypts stored tokens. Changing it signs every user out.',
      ),
    TOKENS_ENC_KEY: z
      .string()
      .optional()
      .describe(
        'Secret. The older name of the token key, used only when RS_TOKENS_ENC_KEY is unset.',
      ),
    PROXY_REDIRECT_ALLOWLIST: z
      .string()
      .optional()
      .transform((value) => [
        ...new Set(
          (value ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      ])
      .describe(
        'Comma-separated client redirect URIs the OAuth proxy accepts, besides native loopback.',
      ),
    RS_TOKENS_FILE: z
      .string()
      .default('.data/rs-tokens.json')
      .describe('Bun only: the token file. The authority keeps its files next to it.'),
    SPOTIFY_INCLUDE_JSON_IN_CONTENT: z
      .string()
      .optional()
      .transform((value, ctx) => {
        const flag = value?.trim().toLowerCase();
        if (!flag || ['0', 'false', 'no', 'off'].includes(flag)) return false;
        if (['1', 'true', 'yes', 'on'].includes(flag)) return true;
        ctx.addIssue({ code: 'custom', message: 'must be true or false' });
        return z.NEVER;
      })
      .describe(
        'Also put each tool result as JSON text in its content, for clients that ignore structured content.',
      ),
  })
  .refine((settings) => !settings.SPOTIFY_CLIENT_ID === !settings.SPOTIFY_CLIENT_SECRET, {
    message: 'SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set together',
  });

export type Settings = z.infer<typeof Settings>;

/**
 * The key that encrypts stored tokens and authorization grants. Both secret names are
 * deployed; `RS_TOKENS_ENC_KEY` has been the one in use since November 2025, and
 * `TOKENS_ENC_KEY` takes over only when it is unset, as before.
 */
export function tokenEncryptionKey(settings: Settings): string | undefined {
  return settings.RS_TOKENS_ENC_KEY ?? settings.TOKENS_ENC_KEY;
}
