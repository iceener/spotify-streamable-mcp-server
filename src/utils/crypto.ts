export function toBase64(value: string): string {
  if (typeof btoa === 'function') {
    return btoa(value);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64');
  }
  throw new Error('No base64 encoding available in this environment');
}

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    s += String.fromCharCode(b);
  }
  const b64 = btoa(s);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64urlDecode(data: string): Uint8Array {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function getCryptoKey(): Promise<CryptoKey | undefined> {
  try {
    const g = globalThis as unknown as {
      process?: { env?: Record<string, unknown> };
      ENV?: Record<string, unknown>;
    };
    const secret =
      (g.ENV as { TOKENS_ENC_KEY?: string })?.TOKENS_ENC_KEY ||
      (g.process?.env?.TOKENS_ENC_KEY as string | undefined);
    if (!secret) {
      return undefined;
    }
    const raw = b64urlDecode(String(secret));
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  } catch {
    return undefined;
  }
}

export async function encryptString(plain: string): Promise<string> {
  const key = await getCryptoKey();
  if (!key) {
    return plain; // no-op without configured key
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plain);
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc);
  const ct = b64urlEncode(new Uint8Array(ctBuf));
  const ivb64 = b64urlEncode(iv);
  return JSON.stringify({ alg: 'A256GCM', iv: ivb64, ct });
}

export async function decryptString(stored: string): Promise<string> {
  try {
    const obj = JSON.parse(stored) as {
      alg?: string;
      iv?: string;
      ct?: string;
    };
    if (!obj || obj.alg !== 'A256GCM' || !obj.iv || !obj.ct) {
      return stored;
    }
    const key = await getCryptoKey();
    if (!key) {
      return stored;
    }
    const iv = b64urlDecode(obj.iv);
    const ct = b64urlDecode(obj.ct);
    const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(ptBuf);
  } catch {
    return stored;
  }
}
