import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

const content = `# MCP Server Template

This template demonstrates an MCP server with:

- Tools with Zod validation
- Optional prompts and resources
- Streamable HTTP transport for Node/Hono and Workers
- CORS and protocol-version validation
- Structured logging
`;

export const docsResource = {
  uri: 'docs://overview',
  name: 'Server Documentation',
  description: 'Overview documentation for this MCP server',
  mimeType: 'text/markdown',

  handler: async (): Promise<ReadResourceResult> => {
    return {
      contents: [
        {
          uri: 'docs://overview',
          name: 'overview.md',
          mimeType: 'text/markdown',
          text: content,
        },
      ],
    };
  },
} as const;
