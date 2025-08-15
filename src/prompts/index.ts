import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { greetingPrompt } from './greeting.prompt.ts';

const prompts = [greetingPrompt];

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    greetingPrompt.name,
    {
      title: 'Greeting Prompt',
      description: greetingPrompt.description,
      argsSchema: {
        name: z.string().optional().describe('Name to greet'),
        language: z.enum(['en', 'es', 'fr', 'de']).optional().describe('Language code'),
      },
    },
    greetingPrompt.handler,
  );
}
