import type {
  GetPromptResult,
  PromptMessage,
} from '@modelcontextprotocol/sdk/types.js';

export const greetingPrompt = {
  name: 'greeting',
  description: 'Generate a simple greeting',

  handler: async (args: unknown): Promise<GetPromptResult> => {
    const data = (args as { name?: string; language?: string }) || {};
    const name = typeof data.name === 'string' && data.name ? data.name : 'friend';
    const language = typeof data.language === 'string' ? data.language : 'en';
    const hello =
      { en: 'Hello', es: 'Hola', fr: 'Bonjour', de: 'Hallo' }[language] || 'Hello';
    const messages: PromptMessage[] = [
      {
        role: 'user',
        content: { type: 'text', text: `${hello}, ${name}!` },
      },
    ];
    return { messages };
  },
} as const;
