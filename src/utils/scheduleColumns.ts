export type ColumnKey = 'task' | 'assignee' | 'status' | 'start' | 'due' | 'priority' | 'project' | 'progress' | 'id';

export interface ColumnDef {
  key: ColumnKey;
  /** Header label */
  label: string;
  /** Longer name for the column picker, where there is room */
  pickerLabel?: string;
  defaultWidth: number;
  minWidth: number;
  /** The task column identifies the row, so it can't be hidden */
  required?: boolean;
}

/** Canonical left-to-right order. Showing or hiding a column never reorders the rest. */
export const COLUMN_DEFS: ColumnDef[] = [
  { key: 'id', label: 'ID', pickerLabel: 'Issue ID', defaultWidth: 96, minWidth: 70 },
  { key: 'task', label: 'Issue', defaultWidth: 300, minWidth: 220, required: true },
  { key: 'assignee', label: 'Assignee', defaultWidth: 128, minWidth: 90 },
  { key: 'status', label: 'Status', defaultWidth: 128, minWidth: 90 },
  { key: 'start', label: 'Start', pickerLabel: 'Start date', defaultWidth: 86, minWidth: 70 },
  { key: 'due', label: 'Due', pickerLabel: 'Due date', defaultWidth: 86, minWidth: 70 },
  { key: 'priority', label: 'Priority', defaultWidth: 96, minWidth: 80 },
  { key: 'project', label: 'Project', defaultWidth: 140, minWidth: 100 },
  { key: 'progress', label: 'Sub-issues', pickerLabel: 'Sub-issue progress', defaultWidth: 96, minWidth: 70 },
];

export const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ['id', 'task', 'assignee', 'status', 'due'];

export type ColumnWidths = Record<ColumnKey, number>;

/** Upper bound for a single column, so a stale or hand-edited value can't bury the timeline */
export const MAX_COLUMN_WIDTH = 600;

export const DEFAULT_COLUMN_WIDTHS: ColumnWidths = Object.fromEntries(
  COLUMN_DEFS.map((c) => [c.key, c.defaultWidth]),
) as ColumnWidths;

// Per-person display preference, shared by the app and the public shared view.
// Last write wins across tabs, which is fine for a preference of this kind.
const VISIBLE_KEY = 'gantt_columns';
const WIDTHS_KEY = 'gantt_column_widths';
// One-shot flag: the ID column became a default column, so saved selections from before
// that get it added once. Never re-added afterwards, so hiding it sticks.
const ID_MIGRATED_KEY = 'gantt_columns_id_added';

const defByKey = new Map(COLUMN_DEFS.map((c) => [c.key, c]));

export function getColumnDef(key: ColumnKey): ColumnDef {
  return defByKey.get(key)!;
}

/** Keep a selection valid: known keys only, canonical order, task always present. */
export function normalizeVisibleColumns(keys: unknown): ColumnKey[] {
  if (!Array.isArray(keys)) return [...DEFAULT_VISIBLE_COLUMNS];
  const chosen = new Set(keys.filter((k): k is ColumnKey => typeof k === 'string' && defByKey.has(k as ColumnKey)));
  for (const def of COLUMN_DEFS) if (def.required) chosen.add(def.key);
  const ordered = COLUMN_DEFS.filter((c) => chosen.has(c.key)).map((c) => c.key);
  // An empty or unusable stored value falls back to the defaults rather than
  // leaving someone with just the task column
  return ordered.length > 1 ? ordered : [...DEFAULT_VISIBLE_COLUMNS];
}

export function loadVisibleColumns(): ColumnKey[] {
  try {
    const migrated = localStorage.getItem(ID_MIGRATED_KEY) === '1';
    // Set before anything else, so a fresh install never counts as needing the migration
    if (!migrated) localStorage.setItem(ID_MIGRATED_KEY, '1');
    const raw = localStorage.getItem(VISIBLE_KEY);
    if (!raw) return [...DEFAULT_VISIBLE_COLUMNS];
    const stored = normalizeVisibleColumns(JSON.parse(raw));
    if (migrated) return stored;
    const withId = normalizeVisibleColumns([...stored, 'id']);
    saveVisibleColumns(withId);
    return withId;
  } catch {
    return [...DEFAULT_VISIBLE_COLUMNS];
  }
}

export function saveVisibleColumns(keys: ColumnKey[]): void {
  try {
    localStorage.setItem(VISIBLE_KEY, JSON.stringify(normalizeVisibleColumns(keys)));
    // A selection saved on purpose is already past the migration
    localStorage.setItem(ID_MIGRATED_KEY, '1');
  } catch {
    // Storage unavailable (private mode, quota) — the session still works
  }
}

/** Merge stored widths over the defaults, dropping unknown keys and sub-minimum values. */
export function normalizeColumnWidths(widths: unknown): ColumnWidths {
  const merged = { ...DEFAULT_COLUMN_WIDTHS };
  if (widths && typeof widths === 'object') {
    for (const [key, value] of Object.entries(widths as Record<string, unknown>)) {
      const def = defByKey.get(key as ColumnKey);
      if (!def || typeof value !== 'number' || !Number.isFinite(value)) continue;
      merged[def.key] = Math.min(Math.max(value, def.minWidth), MAX_COLUMN_WIDTH);
    }
  }
  return merged;
}

export function loadColumnWidths(): ColumnWidths {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY);
    if (!raw) return { ...DEFAULT_COLUMN_WIDTHS };
    return normalizeColumnWidths(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_COLUMN_WIDTHS };
  }
}

export function saveColumnWidths(widths: ColumnWidths): void {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(normalizeColumnWidths(widths)));
  } catch {
    // Storage unavailable — widths just won't persist
  }
}

/** Total width of the pinned columns to the left of the timeline */
export function totalColumnWidth(visible: ColumnKey[], widths: ColumnWidths): number {
  return visible.reduce((sum, key) => sum + widths[key], 0);
}

export const MOBILE_BREAKPOINT = 768;

/**
 * The only columns shown below MOBILE_BREAKPOINT, in table order. ID rides along with Issue
 * so the identifier stays visible on a phone, and the rest wait for a wider screen.
 */
export const NARROW_COLUMNS: ColumnKey[] = ['id', 'task'];

/**
 * Widths used instead of the saved ones below MOBILE_BREAKPOINT, so the pinned pair is 280px:
 * on a 375px phone that leaves about 95px of timeline beside it (40px on a 320px one).
 * ID's 80px still holds a nine-character identifier such as ENG-1234 in its 56px of content,
 * and 200px leaves the Issue title roughly 120px next to the tree gutter.
 */
export const NARROW_COLUMN_WIDTHS: Partial<ColumnWidths> = { id: 80, task: 200 };

export interface ViewportOptions {
  isNarrow?: boolean;
  viewportWidth?: number;
}

export function resolveIsNarrow(options?: ViewportOptions): boolean {
  return (
    options?.isNarrow ?? (options?.viewportWidth !== undefined ? options.viewportWidth < MOBILE_BREAKPOINT : false)
  );
}

/**
 * The columns to render. This is a display rule only: the saved selection is left alone,
 * so widening the window brings the full selection straight back.
 */
export function visibleColumnsForViewport(selected: ColumnKey[], options?: ViewportOptions): ColumnKey[] {
  return resolveIsNarrow(options) ? [...NARROW_COLUMNS] : selected;
}

/** The widths to render, with the narrow-screen widths applied. Saved widths are never changed. */
export function columnWidthsForViewport(widths: ColumnWidths, options?: ViewportOptions): ColumnWidths {
  return resolveIsNarrow(options) ? { ...widths, ...NARROW_COLUMN_WIDTHS } : widths;
}

/**
 * Maximum fraction of viewport/container width that frozen columns may consume before
 * falling back to freezing only up to the primary task column.
 */
export const MAX_FROZEN_WIDTH_RATIO = 0.65;

export interface StickyColumnOffsets {
  /** Sticky left offset in pixels, or undefined if the column is not sticky */
  offsets: Partial<Record<ColumnKey, number>>;
  /** The rightmost column that is frozen */
  lastFrozenKey: ColumnKey;
  /** Whether the freeze is limited to the primary task column (plus any columns before it) */
  onlyTaskFrozen: boolean;
}

/**
 * Computes sticky `left` offsets for schedule columns.
 * When the viewport is >= 768px and the columns don't crowd the timeline, all visible
 * columns are pinned with cumulative left offsets.
 *
 * Otherwise only the columns up to and including 'task' are pinned, so the timeline stays
 * reachable. Below 768px those are always ID and Issue (see NARROW_COLUMNS): they are the
 * only columns shown, so nothing else needs to scroll but the timeline, and pinning the pair
 * regardless of the 65% ratio is what keeps ID from being stranded under Issue. Between 768px
 * and the full freeze, ID and Issue are pinned together only while the pair fits within
 * MAX_FROZEN_WIDTH_RATIO of the viewport. If resized widths push it past that, Issue pins
 * alone at left: 0 and ID scrolls away underneath it, rather than being left stranded in
 * front of it. Issue also pins alone when nothing precedes it (ID hidden).
 */
export function computeStickyColumnOffsets(
  visibleColumns: ColumnKey[],
  colWidths: ColumnWidths,
  options?: ViewportOptions,
): StickyColumnOffsets {
  const isNarrow = resolveIsNarrow(options);

  const totalWidth = totalColumnWidth(visibleColumns, colWidths);
  const onlyTaskFrozen =
    isNarrow ||
    (options?.viewportWidth !== undefined &&
      options.viewportWidth > 0 &&
      totalWidth > options.viewportWidth * MAX_FROZEN_WIDTH_RATIO);

  const offsets: Partial<Record<ColumnKey, number>> = {};

  if (onlyTaskFrozen) {
    const taskIndex = visibleColumns.indexOf('task');
    if (taskIndex >= 0) {
      const leading = visibleColumns.slice(0, taskIndex + 1);
      const leadingWidth = totalColumnWidth(leading, colWidths);
      const leadingFits =
        isNarrow || !options?.viewportWidth || leadingWidth <= options.viewportWidth * MAX_FROZEN_WIDTH_RATIO;
      if (taskIndex === 0 || !leadingFits) {
        offsets.task = 0;
      } else {
        let left = 0;
        for (const key of leading) {
          offsets[key] = left;
          left += colWidths[key];
        }
      }
    }
    return {
      offsets,
      lastFrozenKey: 'task',
      onlyTaskFrozen: true,
    };
  }

  let currentLeft = 0;
  let lastFrozenKey: ColumnKey = visibleColumns[0] ?? 'task';

  for (const key of visibleColumns) {
    offsets[key] = currentLeft;
    lastFrozenKey = key;
    currentLeft += colWidths[key] ?? getColumnDef(key).defaultWidth;
  }

  return {
    offsets,
    lastFrozenKey,
    onlyTaskFrozen: false,
  };
}
