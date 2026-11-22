import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCollapsedParents, saveCollapsedParents } from './collapsedParents';

describe('collapsed parents persistence', () => {
  // Tests run in the node environment, so stand in a minimal in-memory Storage
  function stubStorage(overrides: Partial<Storage> = {}) {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      ...overrides,
    });
    return store;
  }

  beforeEach(() => {
    stubStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts with nothing collapsed so parents are expanded by default', () => {
    expect(loadCollapsedParents().size).toBe(0);
  });

  it('round-trips collapsed parent ids', () => {
    saveCollapsedParents(new Set(['ENG-1', 'ENG-2']));
    expect(localStorage.getItem('gantt_collapsed_parents')).toBe('["ENG-1","ENG-2"]');
    expect([...loadCollapsedParents()]).toEqual(['ENG-1', 'ENG-2']);
  });

  it('falls back to empty for corrupt or non-array values and drops non-string entries', () => {
    localStorage.setItem('gantt_collapsed_parents', '{not json');
    expect(loadCollapsedParents().size).toBe(0);
    localStorage.setItem('gantt_collapsed_parents', '{"a":1}');
    expect(loadCollapsedParents().size).toBe(0);
    localStorage.setItem('gantt_collapsed_parents', '["ENG-1", 4, null]');
    expect([...loadCollapsedParents()]).toEqual(['ENG-1']);
  });

  it('does not throw when storage is unavailable', () => {
    stubStorage({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(loadCollapsedParents().size).toBe(0);
    expect(() => saveCollapsedParents(new Set(['ENG-1']))).not.toThrow();
  });
});
