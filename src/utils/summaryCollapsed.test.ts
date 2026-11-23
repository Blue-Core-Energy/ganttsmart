import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSummaryCollapsed, saveSummaryCollapsed } from './summaryCollapsed';

describe('summary row collapsed persistence', () => {
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

  it('is expanded by default', () => {
    expect(loadSummaryCollapsed()).toBe(false);
  });

  it('round-trips the collapsed choice', () => {
    saveSummaryCollapsed(true);
    expect(localStorage.getItem('gantt_summary_collapsed')).toBe('1');
    expect(loadSummaryCollapsed()).toBe(true);
    saveSummaryCollapsed(false);
    expect(localStorage.getItem('gantt_summary_collapsed')).toBe('0');
    expect(loadSummaryCollapsed()).toBe(false);
  });

  it('treats unrecognised values as expanded', () => {
    localStorage.setItem('gantt_summary_collapsed', 'garbage');
    expect(loadSummaryCollapsed()).toBe(false);
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
    expect(loadSummaryCollapsed()).toBe(false);
    expect(() => saveSummaryCollapsed(true)).not.toThrow();
  });
});
