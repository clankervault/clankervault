import type { Adapter } from './index.js';
import { GENERATED_HEADER, renderMarkdownBody } from './index.js';

export const claude: Adapter = {
  name: 'claude',
  filename: 'CLAUDE.md',
  render: (ctx) => `${GENERATED_HEADER}\n\n${renderMarkdownBody(ctx)}`,
};
