/**
 * AES-256-GCM encryption/decryption using Web Crypto API.
 * Works in both Cloudflare Workers and Node.js 18+.
 */

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits recommended for GCM
const TAG_LENGTH = 128; // bits

/**
 * Derive a CryptoKey from a base64url-encoded secret.
 */
async function deriveKey(secret: string): Promise<CryptoKey> {
  // Decode base64url to bytes
  const keyBytes = base64UrlDecode(secret);

  // Ensure we have exactly 32 bytes (256 bits) for AES-256
  if (keyBytes.length !== 32) {
    throw new Error(`Invalid key length: expected 32 bytes, got ${keyBytes.length}`);
  }

  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: ALGORITHM, length: KEY_LENGTH },
    false, // not extractable
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt plaintext string using AES-256-GCM.
 *
 * @param plaintext - String to encrypt
 * @param secret - Base64url-encoded 32-byte secret key
 * @returns Base64url-encoded ciphertext (IV prepended)
 */
export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);

  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // Encode plaintext to bytes
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);

  // Encrypt
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    plaintextBytes,
  );

  // Combine IV + ciphertext (GCM tag is appended by Web Crypto)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return base64UrlEncode(combined);
}

/**
 * Decrypt ciphertext string using AES-256-GCM.
 *
 * @param ciphertext - Base64url-encoded ciphertext (IV prepended)
 * @param secret - Base64url-encoded 32-byte secret key
 * @returns Decrypted plaintext string
 */
export async function decrypt(ciphertext: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);

  // Decode ciphertext
  const combined = base64UrlDecode(ciphertext);

  if (combined.length < IV_LENGTH + 16) {
    // Minimum: IV (12) + auth tag (16)
    throw new Error('Invalid ciphertext: too short');
  }

  // Extract IV and encrypted data
  const iv = combined.slice(0, IV_LENGTH);
  const encrypted = combined.slice(IV_LENGTH);

  // Decrypt
  const plaintextBytes = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    encrypted,
  );

  // Decode bytes to string
  const decoder = new TextDecoder();
  return decoder.decode(plaintextBytes);
}

/**
 * Generate a random 32-byte (256-bit) key suitable for AES-256.
 * Returns base64url-encoded string.
 */
export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncode(bytes);
}

// --- Base64URL helpers ---

function base64UrlEncode(bytes: Uint8Array): string {
  // Convert to regular base64
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  // Convert to base64url
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(str: string): Uint8Array {
  // Convert from base64url to base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding if needed
  const padLength = (4 - (base64.length % 4)) % 4;
  base64 += '='.repeat(padLength);

  // Decode
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/**
 * Create encryption/decryption functions bound to a specific key.
 * Useful for initializing KV stores.
 */
export function createEncryptor(secret: string): {
  encrypt: (plaintext: string) => Promise<string>;
  decrypt: (ciphertext: string) => Promise<string>;
} {
  return {
    encrypt: (plaintext: string) => encrypt(plaintext, secret),
    decrypt: (ciphertext: string) => decrypt(ciphertext, secret),
  };
}
