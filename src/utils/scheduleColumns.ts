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
  { key: 'task', label: 'Task', defaultWidth: 300, minWidth: 220, required: true },
  { key: 'assignee', label: 'Assignee', defaultWidth: 128, minWidth: 90 },
  { key: 'status', label: 'Status', defaultWidth: 128, minWidth: 90 },
  { key: 'start', label: 'Start', pickerLabel: 'Start date', defaultWidth: 86, minWidth: 70 },
  { key: 'due', label: 'Due', pickerLabel: 'Due date', defaultWidth: 86, minWidth: 70 },
  { key: 'priority', label: 'Priority', defaultWidth: 96, minWidth: 80 },
  { key: 'project', label: 'Project', defaultWidth: 140, minWidth: 100 },
  { key: 'progress', label: 'Sub-issues', pickerLabel: 'Sub-issue progress', defaultWidth: 96, minWidth: 70 },
  { key: 'id', label: 'ID', pickerLabel: 'Issue ID', defaultWidth: 96, minWidth: 70 },
];

export const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ['task', 'assignee', 'status', 'due'];

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
    const raw = localStorage.getItem(VISIBLE_KEY);
    if (!raw) return [...DEFAULT_VISIBLE_COLUMNS];
    return normalizeVisibleColumns(JSON.parse(raw));
  } catch {
    return [...DEFAULT_VISIBLE_COLUMNS];
  }
}

export function saveVisibleColumns(keys: ColumnKey[]): void {
  try {
    localStorage.setItem(VISIBLE_KEY, JSON.stringify(normalizeVisibleColumns(keys)));
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
