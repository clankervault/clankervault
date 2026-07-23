import { randomBytes } from 'node:crypto';

/** ascii-safe kebab slug, diacritics stripped, max 60 chars */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/** 4 hex chars, e.g. "a1b2" */
export function shortId(): string {
  return randomBytes(2).toString('hex');
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** rough token estimate: ~4 chars per token */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
