import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_COLOR,
  priorityBadgeStyle,
  priorityClass,
  priorityColorFor,
  priorityColors,
  statusDotColorFor,
  statusDotColors,
} from './colors';

describe('colour tokens', () => {
  it('names a themed custom property instead of a hex literal', () => {
    for (const value of [...Object.values(priorityColors), ...Object.values(statusDotColors), NEUTRAL_COLOR]) {
      expect(value).toMatch(/^var\(--color-[a-z-]+\)$/);
    }
  });

  it('maps every priority class to its own token', () => {
    expect(priorityColors[priorityClass(1)]).toBe('var(--color-urgent)');
    expect(priorityColors[priorityClass(2)]).toBe('var(--color-high)');
    expect(priorityColors[priorityClass(3)]).toBe('var(--color-medium)');
    expect(priorityColors[priorityClass(4)]).toBe('var(--color-low)');
    expect(priorityColors[priorityClass(0)]).toBe('var(--color-none)');
    expect(new Set(Object.values(priorityColors)).size).toBe(5);
  });

  it('looks priorities up case-insensitively and falls back to neutral', () => {
    expect(priorityColorFor('Urgent')).toBe(priorityColors.urgent);
    expect(priorityColorFor(' HIGH ')).toBe(priorityColors.high);
    expect(priorityColorFor('None')).toBe(priorityColors.none);
    expect(priorityColorFor('No priority')).toBe(NEUTRAL_COLOR);
    expect(priorityColorFor('')).toBe(NEUTRAL_COLOR);
  });

  it('builds priority badge styles from the themed token', () => {
    expect(priorityBadgeStyle('High')).toEqual({
      backgroundColor: 'color-mix(in srgb, var(--color-high) 15%, transparent)',
      color: 'var(--color-high)',
      border: '1px solid color-mix(in srgb, var(--color-high) 25%, transparent)',
    });
  });

  it('gives work in flight the accent, normalizes casing, and falls back for unknown state types', () => {
    expect(statusDotColorFor('started')).toBe('var(--color-accent)');
    expect(statusDotColorFor(' STARTED ')).toBe('var(--color-accent)');
    expect(statusDotColorFor('completed')).toBe('var(--color-success)');
    expect(statusDotColorFor('backlog')).toBe(NEUTRAL_COLOR);
    expect(statusDotColorFor('something-new')).toBe(NEUTRAL_COLOR);
  });
});
