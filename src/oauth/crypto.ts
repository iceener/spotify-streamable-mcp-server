import { concatBytes, fromBase64Url, toBase64Url } from './encoding';

/** An unguessable identifier: `bytes` random bytes, base64url without padding. */
export function opaqueToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The RFC 7636 S256 challenge for a code verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export interface Encryptor {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM with Web Crypto, as stored in KV and in authority grants:
 * `base64url(iv[12] || ciphertext || tag[16])`. The key is 32 bytes, base64url-encoded
 * (`RS_TOKENS_ENC_KEY`). Changing this format makes every stored token unreadable.
 */
export function createEncryptor(secret: string): Encryptor {
  let key: Promise<CryptoKey> | undefined;
  const importKey = () => {
    key ??= (async () => {
      const bytes = fromBase64Url(secret);
      if (bytes.length !== 32) {
        throw new Error(`Invalid key length: expected 32 bytes, got ${bytes.length}`);
      }
      return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
    })();
    return key;
  };

  return {
    async encrypt(plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, tagLength: TAG_BYTES * 8 },
        await importKey(),
        new TextEncoder().encode(plaintext),
      );
      return toBase64Url(concatBytes([iv, new Uint8Array(sealed)]));
    },
    async decrypt(ciphertext) {
      const combined = fromBase64Url(ciphertext);
      if (combined.length < IV_BYTES + TAG_BYTES) throw new Error('Invalid ciphertext: too short');
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: combined.subarray(0, IV_BYTES), tagLength: TAG_BYTES * 8 },
        await importKey(),
        combined.subarray(IV_BYTES),
      );
      return new TextDecoder().decode(plain);
    },
  };
}
