import type { Adapter } from './index.js';
import { GENERATED_HEADER, renderMarkdownBody } from './index.js';

export const agents: Adapter = {
  name: 'agents',
  filename: 'AGENTS.md',
  render: (ctx) => `${GENERATED_HEADER}\n\n${renderMarkdownBody(ctx)}`,
};
