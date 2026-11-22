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
  visibleColumnsForViewport,
  columnWidthsForViewport,
  NARROW_COLUMNS,
  NARROW_COLUMN_WIDTHS,
  MAX_FROZEN_WIDTH_RATIO,
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

  it('defaults to ID, task, assignee, status and due date', () => {
    expect(DEFAULT_VISIBLE_COLUMNS).toEqual(['id', 'task', 'assignee', 'status', 'due']);
  });

  it('places the ID column before the task column', () => {
    const keys = COLUMN_DEFS.map((c) => c.key);
    expect(keys[0]).toBe('id');
    expect(keys.indexOf('id')).toBeLessThan(keys.indexOf('task'));
  });

  it('offers start date, priority, project and sub-issue progress as extras', () => {
    const optional = COLUMN_DEFS.filter((c) => !DEFAULT_VISIBLE_COLUMNS.includes(c.key)).map((c) => c.key);
    expect(optional).toEqual(['start', 'priority', 'project', 'progress']);
  });
});

describe('normalizeVisibleColumns', () => {
  it('keeps the canonical order regardless of the order chosen', () => {
    expect(normalizeVisibleColumns(['id', 'due', 'task', 'assignee'])).toEqual(['id', 'task', 'assignee', 'due']);
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
    expect(localStorage.getItem('gantt_columns')).toBe('["id","task"]');
  });

  describe('adding the ID column to saved selections', () => {
    it('adds ID once, in canonical position, to a selection saved before it was a default', () => {
      localStorage.setItem('gantt_columns', JSON.stringify(['task', 'assignee', 'status', 'due']));
      expect(loadVisibleColumns()).toEqual(['id', 'task', 'assignee', 'status', 'due']);
      expect(localStorage.getItem('gantt_columns')).toBe('["id","task","assignee","status","due"]');
    });

    it('adds ID to older selections that already had it last, without duplicating it', () => {
      localStorage.setItem('gantt_columns', JSON.stringify(['task', 'due', 'id']));
      expect(loadVisibleColumns()).toEqual(['id', 'task', 'due']);
    });

    it('keeps ID hidden across reloads once the user has hidden it', () => {
      localStorage.setItem('gantt_columns', JSON.stringify(['task', 'due']));
      expect(loadVisibleColumns()).toContain('id');
      saveVisibleColumns(['task', 'due']);
      expect(loadVisibleColumns()).toEqual(['task', 'due']);
      expect(loadVisibleColumns()).toEqual(['task', 'due']);
    });

    it('keeps ID hidden when it was hidden right after a fresh install', () => {
      expect(loadVisibleColumns()).toEqual(DEFAULT_VISIBLE_COLUMNS);
      saveVisibleColumns(['task', 'due']);
      expect(loadVisibleColumns()).toEqual(['task', 'due']);
    });

    it('leaves a fresh install on the defaults and marks the migration done', () => {
      expect(loadVisibleColumns()).toEqual(DEFAULT_VISIBLE_COLUMNS);
      expect(localStorage.getItem('gantt_columns')).toBeNull();
      expect(localStorage.getItem('gantt_columns_id_added')).toBe('1');
    });

    it('does not touch a selection saved after the migration ran', () => {
      localStorage.setItem('gantt_columns_id_added', '1');
      localStorage.setItem('gantt_columns', JSON.stringify(['task', 'priority']));
      expect(loadVisibleColumns()).toEqual(['task', 'priority']);
    });
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

describe('narrow screens', () => {
  const selected: ColumnKey[] = ['id', 'task', 'assignee', 'status', 'start', 'due', 'priority'];

  // Tests run in the node environment, so stand in a minimal in-memory Storage
  function stubStore(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    return store;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('shows only ID and Issue below the mobile breakpoint', () => {
    expect(visibleColumnsForViewport(selected, { viewportWidth: MOBILE_BREAKPOINT - 1 })).toEqual(['id', 'task']);
    expect(visibleColumnsForViewport(selected, { viewportWidth: 375 })).toEqual(NARROW_COLUMNS);
    expect(visibleColumnsForViewport(selected, { isNarrow: true })).toEqual(['id', 'task']);
  });

  it('keeps ID on screen even when it was hidden from the saved selection', () => {
    expect(visibleColumnsForViewport(['task', 'due'], { viewportWidth: 375 })).toEqual(['id', 'task']);
  });

  it('shows the full saved selection at and above the mobile breakpoint', () => {
    expect(visibleColumnsForViewport(selected, { viewportWidth: MOBILE_BREAKPOINT })).toEqual(selected);
    expect(visibleColumnsForViewport(selected, { viewportWidth: 1920 })).toEqual(selected);
    expect(visibleColumnsForViewport(selected)).toEqual(selected);
  });

  it('is a display rule only: widening restores everything and storage is never written', () => {
    stubStore();
    saveVisibleColumns(selected);
    saveColumnWidths({ ...DEFAULT_COLUMN_WIDTHS, task: 350 });
    const stored = loadVisibleColumns();
    const storedWidths = loadColumnWidths();
    const writes = vi.spyOn(localStorage, 'setItem');

    expect(visibleColumnsForViewport(stored, { viewportWidth: 375 })).toEqual(['id', 'task']);
    expect(columnWidthsForViewport(storedWidths, { viewportWidth: 375 }).task).toBe(NARROW_COLUMN_WIDTHS.task);
    expect(visibleColumnsForViewport(stored, { viewportWidth: 1280 })).toEqual(selected);
    expect(columnWidthsForViewport(storedWidths, { viewportWidth: 1280 }).task).toBe(350);

    expect(writes).not.toHaveBeenCalled();
    expect(stored).toEqual(selected);
    expect(storedWidths.task).toBe(350);
    expect(loadVisibleColumns()).toEqual(selected);
    expect(loadColumnWidths().task).toBe(350);
  });

  it('does not interact with the migration: a narrow first load still adds ID to storage', () => {
    const store = stubStore({ gantt_columns: JSON.stringify(['task', 'due']) });
    const stored = loadVisibleColumns();
    expect(visibleColumnsForViewport(stored, { viewportWidth: 375 })).toEqual(['id', 'task']);
    expect(stored).toEqual(['id', 'task', 'due']);
    expect(store.get('gantt_columns')).toBe('["id","task","due"]');
    // ...and a later hide of ID is respected on a wide screen
    saveVisibleColumns(['task', 'due']);
    expect(visibleColumnsForViewport(loadVisibleColumns(), { viewportWidth: 1280 })).toEqual(['task', 'due']);
  });

  it('uses slimmer widths that leave room for the timeline on a phone', () => {
    const widths = columnWidthsForViewport({ ...DEFAULT_COLUMN_WIDTHS, task: 450 }, { viewportWidth: 375 });
    expect(widths.id).toBe(80);
    expect(widths.task).toBe(200);
    expect(widths.assignee).toBe(DEFAULT_COLUMN_WIDTHS.assignee);
    expect(totalColumnWidth(NARROW_COLUMNS, widths)).toBe(280);
    expect(375 - totalColumnWidth(NARROW_COLUMNS, widths)).toBeGreaterThanOrEqual(90);
  });

  it('pins ID and Issue side by side at 375px, past the 65% ratio', () => {
    const widths = columnWidthsForViewport(DEFAULT_COLUMN_WIDTHS, { viewportWidth: 375 });
    const result = computeStickyColumnOffsets(NARROW_COLUMNS, widths, { viewportWidth: 375 });
    // 280px is 75% of 375px, so a ratio rule would have left ID scrolling under Issue
    expect(280 / 375).toBeGreaterThan(MAX_FROZEN_WIDTH_RATIO);
    expect(result.offsets).toEqual({ id: 0, task: 80 });
    expect(result.lastFrozenKey).toBe('task');
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

  describe('with the ID column before the task column', () => {
    const withId: ColumnKey[] = ['id', 'task', 'assignee', 'status', 'due'];
    const idWidths = { ...widths, id: 96 };

    it('offsets every column cumulatively on desktop', () => {
      const result = computeStickyColumnOffsets(withId, idWidths, { viewportWidth: 1920 });
      expect(result.onlyTaskFrozen).toBe(false);
      expect(result.offsets.id).toBe(0);
      expect(result.offsets.task).toBe(96);
      expect(result.offsets.assignee).toBe(396);
      expect(result.lastFrozenKey).toBe('due');
    });

    it('narrow fallback pins ID and task together when they fit', () => {
      // 738 / 800 crowds the timeline, but the 396px pair is within 65% of it
      const result = computeStickyColumnOffsets(withId, idWidths, { viewportWidth: 800 });
      expect(result.onlyTaskFrozen).toBe(true);
      expect(result.offsets).toEqual({ id: 0, task: 96 });
      expect(result.lastFrozenKey).toBe('task');
    });

    it('narrow fallback pins task alone at left: 0 when ID and task would crowd the timeline', () => {
      // A resized Issue column makes the pair 546px, over 65% of 800
      const result = computeStickyColumnOffsets(withId, { ...idWidths, task: 450 }, { viewportWidth: 800 });
      expect(result.onlyTaskFrozen).toBe(true);
      expect(result.offsets).toEqual({ task: 0 });
      expect(result.lastFrozenKey).toBe('task');
    });

    it('still pins ID and task together when the pair sits exactly on the 65% limit', () => {
      // 396 is exactly 65% of 396 / 0.65 (= 609.23...), so the pair is allowed
      const result = computeStickyColumnOffsets(withId, idWidths, {
        isNarrow: false,
        viewportWidth: 396 / MAX_FROZEN_WIDTH_RATIO,
      });
      expect(result.onlyTaskFrozen).toBe(true);
      expect(result.offsets).toEqual({ id: 0, task: 96 });
    });

    it('falls back to task alone when a wider Issue column tips the pair over the limit', () => {
      const viewportWidth = 396 / MAX_FROZEN_WIDTH_RATIO;
      const result = computeStickyColumnOffsets(withId, { ...idWidths, task: 301 }, { isNarrow: false, viewportWidth });
      expect(result.offsets).toEqual({ task: 0 });
      expect(result.lastFrozenKey).toBe('task');
    });

    it('fallback pins just task at left: 0 when ID is hidden', () => {
      const result = computeStickyColumnOffsets(visible, idWidths, { viewportWidth: 800 });
      expect(result.onlyTaskFrozen).toBe(true);
      expect(result.offsets).toEqual({ task: 0 });
    });
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
