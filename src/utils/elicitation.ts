/**
 * Elicitation utilities for servers to request user input from clients.
 *
 * ⚠️ NODE.JS ONLY - These utilities require SDK bidirectional support
 * (server.request()) which is not available in the Cloudflare Workers runtime.
 * The Workers dispatcher does not support server→client requests.
 *
 * Two modes:
 * - Form: Structured input via a schema (text fields, checkboxes, dropdowns)
 * - URL: Redirect user to external URL for out-of-band interaction
 *
 * Per MCP spec:
 * - Elicitation is a CLIENT capability
 * - Servers send elicitation/create requests TO clients
 * - Clients display the form/URL and return user response
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from './logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Schema Types
// ─────────────────────────────────────────────────────────────────────────────

/** Boolean field schema */
export interface BooleanFieldSchema {
  type: 'boolean';
  title?: string;
  description?: string;
  default?: boolean;
}

/** String field schema */
export interface StringFieldSchema {
  type: 'string';
  title?: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
  default?: string;
}

/** Number field schema */
export interface NumberFieldSchema {
  type: 'number' | 'integer';
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  default?: number;
}

/** Single-select enum with titles (preferred) */
export interface TitledEnumFieldSchema {
  type: 'string';
  title?: string;
  description?: string;
  oneOf: Array<{ const: string; title: string }>;
  default?: string;
}

/** Single-select enum without titles */
export interface UntitledEnumFieldSchema {
  type: 'string';
  title?: string;
  description?: string;
  enum: string[];
  default?: string;
}

/** Multi-select enum */
export interface MultiSelectFieldSchema {
  type: 'array';
  title?: string;
  description?: string;
  minItems?: number;
  maxItems?: number;
  items:
    | {
        type: 'string';
        enum: string[];
      }
    | {
        anyOf: Array<{ const: string; title: string }>;
      };
  default?: string[];
}

/** All supported field schema types */
export type FieldSchema =
  | BooleanFieldSchema
  | StringFieldSchema
  | NumberFieldSchema
  | TitledEnumFieldSchema
  | UntitledEnumFieldSchema
  | MultiSelectFieldSchema;

/** Schema for form elicitation (flat object with primitive fields only) */
export interface ElicitationSchema {
  type: 'object';
  properties: Record<string, FieldSchema>;
  required?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Types
// ─────────────────────────────────────────────────────────────────────────────

/** Form elicitation request */
export interface FormElicitationRequest {
  mode?: 'form';
  message: string;
  requestedSchema: ElicitationSchema;
}

/** URL elicitation request */
export interface UrlElicitationRequest {
  mode: 'url';
  message: string;
  elicitationId: string;
  url: string;
}

export type ElicitationRequest = FormElicitationRequest | UrlElicitationRequest;

// ─────────────────────────────────────────────────────────────────────────────
// Response Types
// ─────────────────────────────────────────────────────────────────────────────

/** User's response to elicitation */
export interface ElicitResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schemas for validation
// ─────────────────────────────────────────────────────────────────────────────

export const ElicitResultSchema = z.object({
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
    .optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate that elicitation schema is flat (no nested objects/arrays of objects).
 * Per MCP spec: requestedSchema must have type: 'object' at root with only
 * primitive properties (no nesting).
 *
 * @throws Error if schema contains nested objects or invalid structure
 */
export function validateElicitationSchema(schema: ElicitationSchema): void {
  if (schema.type !== 'object') {
    throw new Error('Elicitation schema must have type: "object" at root');
  }

  if (!schema.properties || typeof schema.properties !== 'object') {
    throw new Error('Elicitation schema must have a "properties" object');
  }

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
    // Check for nested objects
    if ('properties' in fieldSchema) {
      throw new Error(
        `Nested objects not allowed in elicitation schema (field: "${fieldName}"). ` +
          'Only primitive types (string, number, integer, boolean) and enums are supported.',
      );
    }

    // Check for arrays with object items (only string enums allowed)
    if (fieldSchema.type === 'array' && 'items' in fieldSchema) {
      const items = fieldSchema.items as Record<string, unknown>;
      if (items.type === 'object' || 'properties' in items) {
        throw new Error(
          `Array of objects not allowed in elicitation schema (field: "${fieldName}"). ` +
            'Only arrays with string enum items are supported for multi-select.',
        );
      }
    }

    // Validate allowed types
    const allowedTypes = ['boolean', 'string', 'number', 'integer', 'array'];
    if (!allowedTypes.includes(fieldSchema.type)) {
      throw new Error(
        `Invalid field type "${fieldSchema.type}" in elicitation schema (field: "${fieldName}"). ` +
          `Allowed types: ${allowedTypes.join(', ')}`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability Checking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if client supports form elicitation.
 */
export function clientSupportsFormElicitation(server: McpServer): boolean {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const lowLevel = (server as any).server ?? server;
    const clientCapabilities = lowLevel.getClientCapabilities?.() ?? {};
    // Empty elicitation object is treated as { form: {} }
    return Boolean(clientCapabilities.elicitation);
  } catch {
    return false;
  }
}

/**
 * Check if client supports URL elicitation.
 */
export function clientSupportsUrlElicitation(server: McpServer): boolean {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const lowLevel = (server as any).server ?? server;
    const clientCapabilities = lowLevel.getClientCapabilities?.() ?? {};
    return Boolean(clientCapabilities.elicitation?.url);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Elicitation Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request user input via form elicitation.
 *
 * @example
 * ```typescript
 * const result = await elicitForm(server, {
 *   message: 'Configure your preferences:',
 *   requestedSchema: {
 *     type: 'object',
 *     properties: {
 *       apiKey: { type: 'string', title: 'API Key' },
 *       enabled: { type: 'boolean', title: 'Enable feature', default: true },
 *       theme: {
 *         type: 'string',
 *         title: 'Theme',
 *         oneOf: [
 *           { const: 'light', title: 'Light' },
 *           { const: 'dark', title: 'Dark' }
 *         ]
 *       }
 *     },
 *     required: ['apiKey']
 *   }
 * });
 *
 * if (result.action === 'accept') {
 *   console.log('API Key:', result.content?.apiKey);
 * }
 * ```
 */
export async function elicitForm(
  server: McpServer,
  request: FormElicitationRequest,
): Promise<ElicitResult> {
  if (!clientSupportsFormElicitation(server)) {
    logger.warning('elicitation', {
      message: 'Client does not support form elicitation',
    });
    throw new Error('Client does not support form elicitation');
  }

  // Validate schema is flat (no nested objects) per MCP spec
  validateElicitationSchema(request.requestedSchema);

  logger.debug('elicitation', {
    message: 'Requesting form elicitation',
    fieldCount: Object.keys(request.requestedSchema.properties).length,
  });

  try {
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const lowLevel = (server as any).server ?? server;

    if (!lowLevel.request) {
      throw new Error('Server does not support client requests');
    }

    const response = await lowLevel.request(
      {
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: request.message,
          requestedSchema: request.requestedSchema,
        },
      },
      ElicitResultSchema,
    );

    logger.info('elicitation', {
      message: 'Form elicitation completed',
      action: response.action,
    });

    return response;
  } catch (error) {
    logger.error('elicitation', {
      message: 'Form elicitation failed',
      error: (error as Error).message,
    });
    throw error;
  }
}

/**
 * Request user interaction via URL elicitation.
 *
 * @example
 * ```typescript
 * const elicitationId = crypto.randomUUID();
 *
 * const result = await elicitUrl(server, {
 *   message: 'Please complete authentication:',
 *   elicitationId,
 *   url: 'https://auth.example.com/oauth/authorize?state=xyz'
 * });
 *
 * // After external callback completes:
 * await notifyElicitationComplete(server, elicitationId);
 * ```
 */
export async function elicitUrl(
  server: McpServer,
  request: Omit<UrlElicitationRequest, 'mode'>,
): Promise<ElicitResult> {
  if (!clientSupportsUrlElicitation(server)) {
    logger.warning('elicitation', {
      message: 'Client does not support URL elicitation',
    });
    throw new Error('Client does not support URL elicitation');
  }

  logger.debug('elicitation', {
    message: 'Requesting URL elicitation',
    elicitationId: request.elicitationId,
    url: request.url,
  });

  try {
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const lowLevel = (server as any).server ?? server;

    if (!lowLevel.request) {
      throw new Error('Server does not support client requests');
    }

    const response = await lowLevel.request(
      {
        method: 'elicitation/create',
        params: {
          mode: 'url',
          message: request.message,
          elicitationId: request.elicitationId,
          url: request.url,
        },
      },
      ElicitResultSchema,
    );

    logger.info('elicitation', {
      message: 'URL elicitation completed',
      action: response.action,
      elicitationId: request.elicitationId,
    });

    return response;
  } catch (error) {
    logger.error('elicitation', {
      message: 'URL elicitation failed',
      error: (error as Error).message,
      elicitationId: request.elicitationId,
    });
    throw error;
  }
}

/**
 * Notify client that URL elicitation has completed (external flow finished).
 */
export async function notifyElicitationComplete(
  server: McpServer,
  elicitationId: string,
): Promise<void> {
  if (!clientSupportsUrlElicitation(server)) {
    throw new Error('Client does not support URL elicitation notifications');
  }

  logger.debug('elicitation', {
    message: 'Sending elicitation complete notification',
    elicitationId,
  });

  try {
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const lowLevel = (server as any).server ?? server;

    await lowLevel.notification?.({
      method: 'notifications/elicitation/complete',
      params: { elicitationId },
    });

    logger.info('elicitation', {
      message: 'Elicitation complete notification sent',
      elicitationId,
    });
  } catch (error) {
    logger.error('elicitation', {
      message: 'Failed to send elicitation complete notification',
      error: (error as Error).message,
      elicitationId,
    });
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request a simple confirmation from the user.
 *
 * @example
 * ```typescript
 * const confirmed = await confirm(server, 'Delete all items?');
 * if (confirmed) {
 *   // proceed with deletion
 * }
 * ```
 */
export async function confirm(
  server: McpServer,
  message: string,
  options?: { confirmLabel?: string; declineLabel?: string },
): Promise<boolean> {
  const result = await elicitForm(server, {
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        confirmed: {
          type: 'boolean',
          title: options?.confirmLabel ?? 'Confirm',
          default: false,
        },
      },
    },
  });

  return result.action === 'accept' && result.content?.confirmed === true;
}

/**
 * Request a single text input from the user.
 *
 * @example
 * ```typescript
 * const apiKey = await promptText(server, 'Enter your API key:', {
 *   title: 'API Key',
 *   required: true
 * });
 *
 * if (apiKey) {
 *   // use the API key
 * }
 * ```
 */
export async function promptText(
  server: McpServer,
  message: string,
  options?: {
    title?: string;
    description?: string;
    defaultValue?: string;
    required?: boolean;
    minLength?: number;
    maxLength?: number;
  },
): Promise<string | undefined> {
  const result = await elicitForm(server, {
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        value: {
          type: 'string',
          title: options?.title ?? 'Value',
          description: options?.description,
          default: options?.defaultValue,
          minLength: options?.minLength,
          maxLength: options?.maxLength,
        },
      },
      ...(options?.required && { required: ['value'] }),
    },
  });

  if (result.action === 'accept') {
    return result.content?.value as string | undefined;
  }

  return undefined;
}

/**
 * Request a selection from a list of options.
 *
 * @example
 * ```typescript
 * const choice = await promptSelect(server, 'Choose a model:', [
 *   { value: 'gpt-4', label: 'GPT-4 (Best quality)' },
 *   { value: 'gpt-3.5', label: 'GPT-3.5 (Faster)' },
 *   { value: 'claude', label: 'Claude (Alternative)' }
 * ]);
 *
 * if (choice) {
 *   console.log('Selected:', choice);
 * }
 * ```
 */
export async function promptSelect(
  server: McpServer,
  message: string,
  options: Array<{ value: string; label: string }>,
  config?: { title?: string; defaultValue?: string; required?: boolean },
): Promise<string | undefined> {
  const result = await elicitForm(server, {
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        selection: {
          type: 'string',
          title: config?.title ?? 'Selection',
          oneOf: options.map((opt) => ({ const: opt.value, title: opt.label })),
          default: config?.defaultValue,
        },
      },
      ...(config?.required && { required: ['selection'] }),
    },
  });

  if (result.action === 'accept') {
    return result.content?.selection as string | undefined;
  }

  return undefined;
}
