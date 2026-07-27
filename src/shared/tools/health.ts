import { z } from 'zod';
import { defineTool } from './types.js';

/**
 * Input schema for health tool.
 */
export const healthInputSchema = z.object({
  verbose: z.boolean().optional().describe('Include additional runtime details'),
});

/**
 * Health check tool - works in both Node and Workers.
 */
export const healthTool = defineTool({
  name: 'health',
  title: 'Health Check',
  description: 'Check server health, uptime, and runtime information',
  inputSchema: healthInputSchema,
  outputSchema: z.object({
    status: z.string().describe('Server status'),
    timestamp: z.number().describe('Current timestamp'),
    runtime: z.string().describe('Runtime environment'),
    uptime: z.number().optional().describe('Uptime in seconds (if available)'),
  }),
  annotations: {
    title: 'Server Health Check',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, context) => {
    const verbose = Boolean(args.verbose);
    const isWorkers = context.runtimeName === 'cloudflare-workers';

    const result: Record<string, unknown> = {
      status: 'ok',
      timestamp: Date.now(),
      runtime: context.runtimeName,
    };

    if (verbose) {
      if (!isWorkers && typeof process !== 'undefined') {
        result.uptime = Math.floor(process.uptime());
        result.nodeVersion = process.version;
        result.memoryUsage = process.memoryUsage().heapUsed;
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
});
