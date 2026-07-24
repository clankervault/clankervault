import type { Adapter } from './index.js';
import { GENERATED_HEADER, MCP_HINT, renderMarkdownBody } from './index.js';

export const gemini: Adapter = {
  name: 'gemini',
  filename: 'GEMINI.md',
  render: (ctx) => `${GENERATED_HEADER}\n\n${renderMarkdownBody(ctx)}\n${MCP_HINT}\n`,
};
