import { describe, it, expect } from 'vitest';
import { slugify, shortId, today, estimateTokens } from '../src/util.js';

describe('slugify', () => {
  it('kebab-cases and strips diacritics', () => {
    expect(slugify('Export shorts verze')).toBe('export-shorts-verze');
    expect(slugify('Řemeslníci: pivot!')).toBe('remeslnici-pivot');
  });
  it('caps length at 60', () => {
    expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe('shortId', () => {
  it('returns 4 hex chars', () => {
    expect(shortId()).toMatch(/^[0-9a-f]{4}$/);
  });
});

describe('today', () => {
  it('returns YYYY-MM-DD', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('estimateTokens', () => {
  it('estimates ~chars/4', () => {
    expect(estimateTokens('a'.repeat(40))).toBe(10);
    expect(estimateTokens('')).toBe(0);
  });
});
