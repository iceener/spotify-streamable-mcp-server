import type { UnifiedConfig } from '../../shared/config/env.js';
import { createEncryptor } from '../../shared/crypto/aes-gcm.js';
import { KvSessionStore, KvTokenStore } from '../../shared/storage/kv.js';
import { MemorySessionStore, MemoryTokenStore } from '../../shared/storage/memory.js';
import { sharedLogger as logger } from '../../shared/utils/logger.js';

export interface WorkerStorage {
  tokenStore: KvTokenStore;
  /** Retained for OAuth/storage rollback compatibility; MCP does not use it. */
  sessionStore: KvSessionStore;
}

/** Build storage once per Worker isolate without creating MCP sessions. */
export function initializeWorkerStorage(
  env: Env,
  config: UnifiedConfig,
): WorkerStorage {
  const memoryTokens = new MemoryTokenStore();
  const memorySessions = new MemorySessionStore();

  const envValues: Record<string, unknown> = { ...env };
  const configuredEncryptionKey =
    envValues.RS_TOKENS_ENC_KEY ?? envValues.TOKENS_ENC_KEY;
  const encryptionKey =
    typeof configuredEncryptionKey === 'string' ? configuredEncryptionKey : undefined;
  let encrypt: (value: string) => Promise<string>;
  let decrypt: (value: string) => Promise<string>;
  if (encryptionKey) {
    const encryptor = createEncryptor(encryptionKey);
    encrypt = encryptor.encrypt;
    decrypt = encryptor.decrypt;
  } else {
    encrypt = async (value) => value;
    decrypt = async (value) => value;
    if (config.NODE_ENV === 'production') {
      logger.warning('worker_storage', {
        message: 'RS_TOKENS_ENC_KEY is unset; token KV records are plaintext',
      });
    }
  }

  const tokenStore = new KvTokenStore(env.TOKENS, {
    encrypt,
    decrypt,
    fallback: memoryTokens,
  });
  const sessionStore = new KvSessionStore(env.TOKENS, {
    encrypt,
    decrypt,
    fallback: memorySessions,
  });
  return { tokenStore, sessionStore };
}
