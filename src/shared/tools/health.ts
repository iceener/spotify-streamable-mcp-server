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
  outputSchema: {
    status: z.string().describe('Server status'),
    timestamp: z.number().describe('Current timestamp'),
    runtime: z.string().describe('Runtime environment'),
    uptime: z.number().optional().describe('Uptime in seconds (if available)'),
  },
  annotations: {
    title: 'Server Health Check',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args) => {
    const verbose = Boolean(args.verbose);

    // Detect runtime
    const g = globalThis as Record<string, unknown>;
    const isWorkers = typeof g.caches !== 'undefined' && !('process' in g);
    const runtime = isWorkers ? 'cloudflare-workers' : 'node';

    const result: Record<string, unknown> = {
      status: 'ok',
      timestamp: Date.now(),
      runtime,
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
