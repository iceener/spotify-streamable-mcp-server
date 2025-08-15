import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config/env.ts';

function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitive = [
    'password',
    'token',
    'secret',
    'key',
    'authorization',
    'apikey',
    'api_key',
    'access_token',
    'refresh_token',
  ];
  const copy: Record<string, unknown> = { ...obj };
  for (const [k, v] of Object.entries(copy)) {
    if (sensitive.some((s) => k.toLowerCase().includes(s))) {
      copy[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      copy[k] = redactSensitive(v as Record<string, unknown>);
    }
  }
  return copy;
}

export const configResource = {
  uri: 'config://server',
  name: 'Server Configuration',
  description: 'Current server configuration (sensitive data redacted)',
  mimeType: 'application/json',

  handler: async (): Promise<ReadResourceResult> => {
    const safe = redactSensitive(config as unknown as Record<string, unknown>);
    return {
      contents: [
        {
          uri: 'config://server',
          name: 'server-config.json',
          mimeType: 'application/json',
          text: JSON.stringify(safe, null, 2),
        },
      ],
    };
  },
} as const;
