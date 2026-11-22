import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLUMN_DEFS,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_VISIBLE_COLUMNS,
  loadColumnWidths,
  loadVisibleColumns,
  MAX_COLUMN_WIDTH,
  normalizeColumnWidths,
  normalizeVisibleColumns,
  saveColumnWidths,
  saveVisibleColumns,
  totalColumnWidth,
  computeStickyColumnOffsets,
  MOBILE_BREAKPOINT,
  type ColumnKey,
} from './scheduleColumns';

describe('column definitions', () => {
  it('gives every column a minimum no larger than its default', () => {
    for (const def of COLUMN_DEFS) {
      expect(def.minWidth).toBeLessThanOrEqual(def.defaultWidth);
      expect(def.minWidth).toBeGreaterThan(0);
    }
  });

  it('labels the required task column as Issue', () => {
    const taskCol = COLUMN_DEFS.find((c) => c.key === 'task');
    expect(taskCol?.label).toBe('Issue');
  });

  it('defaults to task, assignee, status and due date', () => {
    expect(DEFAULT_VISIBLE_COLUMNS).toEqual(['task', 'assignee', 'status', 'due']);
  });

  it('offers start date, priority, project, sub-issue progress and issue ID as extras', () => {
    const optional = COLUMN_DEFS.filter((c) => !DEFAULT_VISIBLE_COLUMNS.includes(c.key)).map((c) => c.key);
    expect(optional).toEqual(['start', 'priority', 'project', 'progress', 'id']);
  });
});

describe('normalizeVisibleColumns', () => {
  it('keeps the canonical order regardless of the order chosen', () => {
    expect(normalizeVisibleColumns(['id', 'due', 'task', 'assignee'])).toEqual(['task', 'assignee', 'due', 'id']);
  });

  it('always keeps the task column', () => {
    expect(normalizeVisibleColumns(['due', 'id'])).toContain('task');
  });

  it('drops unknown keys', () => {
    expect(normalizeVisibleColumns(['task', 'due', 'nonsense', 42])).toEqual(['task', 'due']);
  });

  it('falls back to the defaults for unusable values', () => {
    expect(normalizeVisibleColumns(null)).toEqual(DEFAULT_VISIBLE_COLUMNS);
    expect(normalizeVisibleColumns('due')).toEqual(DEFAULT_VISIBLE_COLUMNS);
    expect(normalizeVisibleColumns([])).toEqual(DEFAULT_VISIBLE_COLUMNS);
    // Hiding everything but the task column would leave nothing to read
    expect(normalizeVisibleColumns(['task'])).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });
});

describe('normalizeColumnWidths', () => {
  it('fills in defaults for columns with no stored width', () => {
    expect(normalizeColumnWidths({ task: 400 })).toEqual({ ...DEFAULT_COLUMN_WIDTHS, task: 400 });
  });

  it('clamps widths to each column minimum', () => {
    expect(normalizeColumnWidths({ task: 10 }).task).toBe(220);
    expect(normalizeColumnWidths({ due: 0 }).due).toBe(70);
  });

  it('caps a column at the maximum width', () => {
    expect(normalizeColumnWidths({ task: 1e9 }).task).toBe(MAX_COLUMN_WIDTH);
  });

  it('keeps widths for columns that are currently hidden', () => {
    const stored = normalizeColumnWidths({ priority: 150 });
    expect(stored.priority).toBe(150);
  });

  it('ignores unknown keys and non-numeric values', () => {
    expect(normalizeColumnWidths({ nonsense: 100, task: '300', due: Number.NaN })).toEqual(DEFAULT_COLUMN_WIDTHS);
  });

  it('survives a non-object', () => {
    expect(normalizeColumnWidths(null)).toEqual(DEFAULT_COLUMN_WIDTHS);
  });
});

describe('persistence', () => {
  // Tests run in the node environment, so stand in a minimal in-memory Storage
  function stubStorage(overrides: Partial<Storage> = {}) {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
      ...overrides,
    });
    return store;
  }

  beforeEach(() => stubStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips a column selection', () => {
    saveVisibleColumns(['task', 'due', 'priority']);
    expect(loadVisibleColumns()).toEqual(['task', 'due', 'priority']);
  });

  it('round-trips column widths', () => {
    saveColumnWidths({ ...DEFAULT_COLUMN_WIDTHS, task: 350 });
    expect(loadColumnWidths().task).toBe(350);
  });

  it('returns defaults when nothing is stored', () => {
    expect(loadVisibleColumns()).toEqual(DEFAULT_VISIBLE_COLUMNS);
    expect(loadColumnWidths()).toEqual(DEFAULT_COLUMN_WIDTHS);
  });

  it('returns defaults when the stored value is malformed', () => {
    localStorage.setItem('gantt_columns', '{not json');
    localStorage.setItem('gantt_column_widths', '{not json');
    expect(loadVisibleColumns()).toEqual(DEFAULT_VISIBLE_COLUMNS);
    expect(loadColumnWidths()).toEqual(DEFAULT_COLUMN_WIDTHS);
  });

  it('normalizes what it stores, so a bad selection can never be read back', () => {
    saveVisibleColumns(['id', 'task', 'nonsense' as ColumnKey]);
    expect(localStorage.getItem('gantt_columns')).toBe('["task","id"]');
  });

  it('keeps working when storage is unavailable', () => {
    stubStorage({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(loadVisibleColumns()).toEqual(DEFAULT_VISIBLE_COLUMNS);
    expect(loadColumnWidths()).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(() => saveVisibleColumns(['task', 'due'])).not.toThrow();
    expect(() => saveColumnWidths(DEFAULT_COLUMN_WIDTHS)).not.toThrow();
  });
});

describe('totalColumnWidth', () => {
  it('adds up only the visible columns', () => {
    const visible: ColumnKey[] = ['task', 'due'];
    expect(totalColumnWidth(visible, DEFAULT_COLUMN_WIDTHS)).toBe(
      DEFAULT_COLUMN_WIDTHS.task + DEFAULT_COLUMN_WIDTHS.due,
    );
  });
});

describe('computeStickyColumnOffsets', () => {
  const visible: ColumnKey[] = ['task', 'assignee', 'status', 'due'];
  const widths = { ...DEFAULT_COLUMN_WIDTHS, task: 300, assignee: 128, status: 128, due: 86 };

  it('computes cumulative offsets for all visible columns on desktop', () => {
    const result = computeStickyColumnOffsets(visible, widths, { viewportWidth: 1280 });
    expect(result.onlyTaskFrozen).toBe(false);
    expect(result.lastFrozenKey).toBe('due');
    expect(result.offsets.task).toBe(0);
    expect(result.offsets.assignee).toBe(300);
    expect(result.offsets.status).toBe(428);
    expect(result.offsets.due).toBe(556);
  });

  it('updates offsets dynamically when a column is resized', () => {
    const resizedWidths = { ...widths, task: 350 };
    const result = computeStickyColumnOffsets(visible, resizedWidths, { viewportWidth: 1280 });
    expect(result.offsets.task).toBe(0);
    expect(result.offsets.assignee).toBe(350);
    expect(result.offsets.status).toBe(350 + 128);
    expect(result.offsets.due).toBe(350 + 128 + 128);
    expect(result.lastFrozenKey).toBe('due');
  });

  it('freezes ONLY the task column on narrow/mobile viewports (< 768px)', () => {
    const result = computeStickyColumnOffsets(visible, widths, { viewportWidth: 640 });
    expect(result.onlyTaskFrozen).toBe(true);
    expect(result.lastFrozenKey).toBe('task');
    expect(result.offsets.task).toBe(0);
    expect(result.offsets.assignee).toBeUndefined();
    expect(result.offsets.status).toBeUndefined();
    expect(result.offsets.due).toBeUndefined();
  });

  it('freezes ONLY the task column when isNarrow is explicitly set', () => {
    const result = computeStickyColumnOffsets(visible, widths, { isNarrow: true, viewportWidth: 1280 });
    expect(result.onlyTaskFrozen).toBe(true);
    expect(result.lastFrozenKey).toBe('task');
    expect(result.offsets.task).toBe(0);
    expect(result.offsets.assignee).toBeUndefined();
  });

  it('falls back to freezing only the task column when frozen columns would consume > 65% of viewport', () => {
    // Total width is 642. At viewport 800, 642 / 800 = 80.25% > 65%
    const result = computeStickyColumnOffsets(visible, widths, { viewportWidth: 800 });
    expect(result.onlyTaskFrozen).toBe(true);
    expect(result.lastFrozenKey).toBe('task');
    expect(result.offsets.task).toBe(0);
    expect(result.offsets.assignee).toBeUndefined();
  });

  it('correctly sets lastFrozenKey for customized visible column lists', () => {
    const customVisible: ColumnKey[] = ['task', 'priority'];
    const result = computeStickyColumnOffsets(customVisible, widths, { viewportWidth: 1440 });
    expect(result.lastFrozenKey).toBe('priority');
    expect(result.offsets.task).toBe(0);
    expect(result.offsets.priority).toBe(widths.task);
  });

  it('respects MOBILE_BREAKPOINT constant at 768', () => {
    expect(MOBILE_BREAKPOINT).toBe(768);
  });
});
