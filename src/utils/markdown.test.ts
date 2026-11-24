import { describe, expect, it } from 'vitest';
import { stripMarkdown } from './markdown';

describe('stripMarkdown', () => {
  it('strips bold, italic, headings, links, and list markers', () => {
    const input = `
# Project Overview
Here is **bold text** and *italic text*.
Check [our roadmap](https://linear.app/project) for updates.
- Item 1
* Item 2



End of notes.
`;
    const result = stripMarkdown(input);
    expect(result).toBe(
      'Project Overview\nHere is bold text and italic text.\nCheck our roadmap for updates.\n• Item 1\n• Item 2\n\nEnd of notes.',
    );
  });

  it('handles empty and whitespace strings', () => {
    expect(stripMarkdown('')).toBe('');
    expect(stripMarkdown('   \n\n  ')).toBe('');
  });

  it('runs in linear O(n) time on pathological unclosed bracket inputs', () => {
    const pathologicalBrackets = '['.repeat(50_000);
    const start = performance.now();
    const result = stripMarkdown(pathologicalBrackets);
    const durationMs = performance.now() - start;

    expect(result).toBe(pathologicalBrackets);
    // 50,000 chars should take well under 50ms; previously took ~2000ms+
    expect(durationMs).toBeLessThan(100);
  });

  it('runs in linear O(n) time on pathological unclosed paren inputs', () => {
    const pathologicalParens = '[label]('.repeat(10_000);
    const start = performance.now();
    const result = stripMarkdown(pathologicalParens);
    const durationMs = performance.now() - start;

    expect(result).toBe(pathologicalParens);
    expect(durationMs).toBeLessThan(100);
  });

  it('runs in linear O(n) time on pathological star inputs', () => {
    const pathologicalStars = '*'.repeat(50_000);
    const start = performance.now();
    const result = stripMarkdown(pathologicalStars);
    const durationMs = performance.now() - start;

    expect(result).toBe(pathologicalStars);
    expect(durationMs).toBeLessThan(100);
  });
});
