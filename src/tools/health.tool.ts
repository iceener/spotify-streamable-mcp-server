import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HealthOutput as HealthOutputType } from '../schemas/outputs.js';
import type { RequestContext } from '../types/context.js';
import { logger } from '../utils/logger.js';

const startTime = Date.now();

export const healthInputSchema = z.object({}).strict();

export const healthTool = {
  name: 'health',
  title: 'Health Check Tool',
  description: 'Check the health status of the MCP server',
  inputSchema: healthInputSchema.shape,

  handler: async (args: unknown, context?: RequestContext): Promise<CallToolResult> => {
    // Validate input (even if empty, reject unknown keys)
    const parsed = healthInputSchema.safeParse(args);
    if (!parsed.success) {
      void logger.warning('health', {
        message: 'Invalid input parameters',
        errors: parsed.error.errors,
        requestId: context?.requestId,
      });

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Health check expects no parameters. Unknown parameters were provided.',
          },
        ],
      };
    }

    try {
      void logger.debug('health', {
        message: 'Health check requested',
        requestId: context?.requestId,
      });

      const uptime = Date.now() - startTime;
      const result: HealthOutputType = {
        status: 'ok',
        timestamp: Date.now(),
        uptime,
      };

      void logger.info('health', {
        message: 'Health check completed',
        uptime,
        requestId: context?.requestId,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      void logger.error('health', {
        message: 'Health check failed',
        error: (error as Error).message,
        requestId: context?.requestId,
      });

      return {
        isError: true,
        content: [
          { type: 'text', text: `Health check failed: ${(error as Error).message}` },
        ],
      };
    }
  },
};
