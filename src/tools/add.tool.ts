import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolsMetadata } from '../config/metadata.ts';
import { AddInputSchema } from '../schemas/inputs.ts';

type AddArgs = { a: number; b: number };

export const addTool = {
  name: toolsMetadata.add.name,
  title: toolsMetadata.add.title,
  description: toolsMetadata.add.description,
  inputSchema: AddInputSchema.shape,

  handler: async (args: AddArgs): Promise<CallToolResult> => {
    const parsed = AddInputSchema.safeParse(args);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Invalid arguments: a and b must be numbers',
          },
        ],
      };
    }
    const { a: firstValue, b: secondValue } = parsed.data;
    const sum = firstValue + secondValue;
    return {
      content: [
        {
          type: 'text',
          text: `The result is ${String(sum)}`,
        },
      ],
      structuredContent: { sum },
    };
  },
};
