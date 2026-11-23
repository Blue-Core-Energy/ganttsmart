import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Filters } from '@/types';
import { Avatar } from '@/utils/avatar';
import CustomDropdown from './CustomDropdown';
import type { DropdownOption } from './CustomDropdown';
import DateRangePicker from './DateRangePicker';

interface Props {
  assignees: string[];
  statuses: string[];
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
  showBaselines?: boolean;
  onShowBaselinesChange?: (show: boolean) => void;
  externalCount?: number;
  showExternal?: boolean;
  onShowExternalChange?: (show: boolean) => void;
  allowExternalEdits?: boolean;
  onAllowExternalEditsChange?: (allow: boolean) => void;
}

/** Width of the filter panel, in px — also used to keep it inside the bar's right edge */
const PANEL_WIDTH = 224;

// Icons
function SearchIcon() {
  return (
    <svg
      className="absolute left-2.5 text-text-muted pointer-events-none"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-text-muted shrink-0"
    >
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

function StatusIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-text-muted shrink-0"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  );
}

function BaselineIcon() {
  return (
    <svg width="14" height="10" viewBox="0 0 20 12" fill="none" className="shrink-0">
      <rect x="1" y="1" width="18" height="10" rx="3" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2.4" />
    </svg>
  );
}

function CrossProjectIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
    </svg>
  );
}

function LockIcon({ unlocked }: { unlocked?: boolean }) {
  return unlocked ? (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 019.9-1" />
    </svg>
  ) : (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default function FilterBar({
  assignees,
  statuses,
  filters,
  onFiltersChange,
  showBaselines,
  onShowBaselinesChange,
  externalCount = 0,
  showExternal = true,
  onShowExternalChange,
  allowExternalEdits = false,
  onAllowExternalEditsChange,
}: Props) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [panelLeft, setPanelLeft] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const chipRowRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const hasSearch = !!filters.search;
  const hasAssignee = !!filters.assignee;
  const hasStatus = !!filters.status;
  const hasDateRange = !!filters.dateFrom || !!filters.dateTo;
  const hasHiddenCompleted = !filters.showCompleted;
  // Search has its own box in the bar, so it isn't counted on the Filter button
  const activeFilterCount = [hasAssignee, hasStatus, hasDateRange, hasHiddenCompleted].filter(Boolean).length;
  const anyActiveChip = hasSearch || activeFilterCount > 0;

  const clearAll = () => {
    onFiltersChange({
      ...filters,
      search: '',
      assignee: '',
      status: '',
      dateFrom: '',
      dateTo: '',
      showCompleted: true,
    });
  };

  // The trigger, the panel and the active-chip row form one filter surface:
  // working in any of them keeps the panel open.
  const isInsideFilter = useCallback(
    (node: Node | null) =>
      Boolean(
        node &&
        (panelRef.current?.contains(node) || triggerRef.current?.contains(node) || chipRowRef.current?.contains(node)),
      ),
    [],
  );

  const closeFilter = useCallback((opts?: { returnFocus?: boolean }) => {
    setFilterOpen(false);
    if (opts?.returnFocus) triggerRef.current?.focus();
  }, []);

  // Keep the panel aligned under its trigger. It is positioned against the bar
  // as a whole (not the trigger) so the chip row stays usable, and it is clamped
  // so it can't run off the right edge once the bar wraps on narrow screens.
  useLayoutEffect(() => {
    if (!filterOpen) return;
    const update = () => {
      const trigger = triggerRef.current;
      const root = rootRef.current;
      if (!trigger || !root) return;
      const offset = trigger.getBoundingClientRect().left - root.getBoundingClientRect().left;
      const maxLeft = Math.max(8, root.clientWidth - PANEL_WIDTH - 8);
      setPanelLeft(Math.round(Math.min(Math.max(offset, 8), maxLeft)));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [filterOpen]);

  // Dismiss on outside click, on Escape, and when focus leaves the panel. Nested
  // popovers (the dropdowns and the date picker) live inside the panel, so clicks
  // and focus within them never count as "outside", and Escape closes them first.
  useEffect(() => {
    if (!filterOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!isInsideFilter(e.target as Node)) closeFilter();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (panelRef.current?.querySelector('[role="listbox"], [data-popover="date-range"]')) return;
      closeFilter({ returnFocus: true });
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null;
      // Focus landing on <body> means focus was lost (e.g. a chip unmounted),
      // not deliberately moved somewhere else
      if (!target || target === document.body) return;
      if (!isInsideFilter(target)) closeFilter();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [filterOpen, isInsideFilter, closeFilter]);

  // Build dropdown options
  const assigneeOptions: DropdownOption[] = useMemo(
    () => assignees.map((a) => ({ value: a, label: a, icon: <Avatar name={a} size="sm" /> })),
    [assignees],
  );

  const statusOptions: DropdownOption[] = useMemo(
    () => statuses.map((s) => ({ value: s, label: s, icon: <StatusIcon /> })),
    [statuses],
  );

  return (
    <div
      ref={rootRef}
      data-testid="filter-bar"
      className="shrink-0 border-b border-border-primary bg-bg-header print:hidden relative z-20"
    >
      {/* Main filter row */}
      <div className="min-h-12 py-1.5 flex flex-wrap items-center gap-2 px-4">
        {/* Search */}
        <div className="relative flex items-center shrink-0">
          <SearchIcon />
          <input
            type="text"
            value={filters.search}
            onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
            placeholder="Search tasks…"
            className="h-8 pl-8 pr-3 bg-bg-card border border-border-primary rounded-md text-text-primary text-xs outline-none transition-colors w-[155px] xl:w-[200px] hover:border-border-secondary focus:border-accent placeholder:text-text-muted"
          />
        </div>

        <div className="w-px h-5 bg-border-primary shrink-0" />

        {/* Filters — assignee, status, date range and completed visibility.
            The panel itself is rendered after the chip row so it can't cover it. */}
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setFilterOpen((v) => !v)}
          aria-expanded={filterOpen}
          aria-controls={filterOpen ? panelId : undefined}
          title={
            activeFilterCount > 0
              ? `Filter tasks — ${activeFilterCount} active`
              : 'Filter tasks by assignee, status, date range and completion'
          }
          className={`shrink-0 inline-flex items-center gap-1.5 py-[7px] px-3 bg-bg-card border rounded-md text-xs font-medium cursor-pointer outline-none transition-colors hover:border-text-muted ${
            activeFilterCount > 0 || filterOpen
              ? 'border-accent text-accent'
              : 'border-border-secondary text-text-secondary'
          }`}
        >
          <FilterIcon />
          Filter
          {activeFilterCount > 0 && (
            <span
              aria-hidden="true"
              className="ml-0.5 min-w-[16px] h-4 px-1 rounded-full bg-accent text-white text-[10px] font-bold font-mono tabular-nums flex items-center justify-center"
            >
              {activeFilterCount}
            </span>
          )}
        </button>

        {/* Plan vs Actual — toggles the dashed baseline ghost bars */}
        {onShowBaselinesChange && (
          <>
            <div className="w-px h-5 bg-border-primary shrink-0" />
            <button
              onClick={() => onShowBaselinesChange(!showBaselines)}
              aria-pressed={showBaselines}
              title={
                showBaselines ? 'Hide original plan overlay (dashed bars)' : 'Show original plan overlay (dashed bars)'
              }
              className={`h-7 px-2.5 rounded-full text-[11px] font-medium cursor-pointer transition-all border select-none active:scale-95 inline-flex items-center gap-1.5 shrink-0 ${
                showBaselines
                  ? 'border-accent/60 text-accent bg-accent/10'
                  : 'bg-bg-card border-border-primary text-text-muted hover:border-border-secondary hover:text-text-secondary'
              }`}
            >
              <BaselineIcon />
              Plan vs Actual
            </button>
          </>
        )}

        {/* Cross-project dependencies visibility + write mode */}
        {onShowExternalChange && externalCount > 0 && (
          <>
            <div className="w-px h-5 bg-border-primary shrink-0" />
            <button
              type="button"
              onClick={() => onShowExternalChange(!showExternal)}
              aria-pressed={showExternal}
              title={
                showExternal ? 'Hide cross-project dependency ghost rows' : 'Show cross-project dependency ghost rows'
              }
              className={`h-7 px-2.5 rounded-full text-[11px] font-medium cursor-pointer transition-all border select-none active:scale-95 inline-flex items-center gap-1.5 shrink-0 ${
                showExternal
                  ? 'border-accent/60 text-accent bg-accent/10'
                  : 'bg-bg-card border-border-primary text-text-muted hover:border-border-secondary hover:text-text-secondary'
              }`}
            >
              <CrossProjectIcon />
              Cross-project
              <span className="font-mono text-[10px] opacity-80">{externalCount}</span>
            </button>
            {showExternal && onAllowExternalEditsChange && (
              <button
                type="button"
                onClick={() => onAllowExternalEditsChange(!allowExternalEdits)}
                aria-pressed={allowExternalEdits}
                title={
                  allowExternalEdits
                    ? 'External issues are editable — click to lock read-only'
                    : 'External issues are read-only — click to enable inline editing'
                }
                className={`h-7 px-2.5 rounded-full text-[11px] font-medium cursor-pointer transition-all border select-none active:scale-95 inline-flex items-center gap-1.5 shrink-0 ${
                  allowExternalEdits
                    ? 'border-amber-500/60 text-amber-500 bg-amber-500/10'
                    : 'bg-bg-card border-border-primary text-text-muted hover:border-border-secondary hover:text-text-secondary'
                }`}
              >
                <LockIcon unlocked={allowExternalEdits} />
                {allowExternalEdits ? 'Editing external' : 'Edit external'}
              </button>
            )}
          </>
        )}
      </div>

      {/* Active filter chips row */}
      {anyActiveChip && (
        <div
          ref={chipRowRef}
          className="flex items-center gap-1.5 px-4 py-1.5 border-t border-border-primary/50 bg-bg-primary/40 flex-wrap"
        >
          <span className="text-[10.5px] uppercase tracking-wider text-text-muted font-semibold mr-1">Filters</span>
          {hasSearch && (
            <ActiveChip label={`"${filters.search}"`} onClear={() => onFiltersChange({ ...filters, search: '' })} />
          )}
          {hasAssignee && (
            <ActiveChip label={filters.assignee} onClear={() => onFiltersChange({ ...filters, assignee: '' })} />
          )}
          {hasStatus && (
            <ActiveChip label={filters.status} onClear={() => onFiltersChange({ ...filters, status: '' })} />
          )}
          {hasDateRange && (
            <ActiveChip
              label={`${filters.dateFrom || '…'} → ${filters.dateTo || '…'}`}
              onClear={() => onFiltersChange({ ...filters, dateFrom: '', dateTo: '' })}
            />
          )}
          {hasHiddenCompleted && (
            <ActiveChip label="Completed hidden" onClear={() => onFiltersChange({ ...filters, showCompleted: true })} />
          )}
          <button
            onClick={clearAll}
            className="ml-1 text-[11px] text-text-muted hover:text-text-primary cursor-pointer underline underline-offset-2 decoration-dotted"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Filter panel — anchored under its trigger but below the whole bar, so the
          chip row stays visible and clickable while the panel is open. */}
      {filterOpen && (
        <div
          ref={panelRef}
          id={panelId}
          role="group"
          aria-label="Filters"
          className="absolute top-full mt-1 z-50 w-[224px] bg-bg-card border border-border-secondary rounded-lg shadow-xl p-3 flex flex-col gap-3"
          style={{ left: panelLeft }}
        >
          <FilterField label="Assignee">
            <CustomDropdown
              value={filters.assignee}
              options={assigneeOptions}
              placeholder="Any assignee"
              placeholderIcon={<UsersIcon />}
              onChange={(v) => onFiltersChange({ ...filters, assignee: v })}
              className="w-full"
              ariaLabel="Assignee"
            />
          </FilterField>

          <FilterField label="Status">
            <CustomDropdown
              value={filters.status}
              options={statusOptions}
              placeholder="Any status"
              placeholderIcon={<StatusIcon />}
              onChange={(v) => onFiltersChange({ ...filters, status: v })}
              className="w-full"
              ariaLabel="Status"
            />
          </FilterField>

          <FilterField label="Date range">
            <DateRangePicker
              from={filters.dateFrom}
              to={filters.dateTo}
              onChange={(dateFrom, dateTo) => onFiltersChange({ ...filters, dateFrom, dateTo })}
            />
          </FilterField>

          <button
            type="button"
            onClick={() => onFiltersChange({ ...filters, showCompleted: !filters.showCompleted })}
            aria-pressed={filters.showCompleted}
            title={filters.showCompleted ? 'Hide completed tasks' : 'Show completed tasks'}
            className={`h-7 px-2.5 self-start rounded-full text-[11px] font-medium cursor-pointer transition-all border select-none active:scale-95 inline-flex items-center gap-1.5 ${
              filters.showCompleted
                ? 'border-low/60 text-low bg-low/10'
                : 'bg-bg-card border-border-primary text-text-muted hover:border-border-secondary hover:text-text-secondary'
            }`}
          >
            <CheckIcon />
            Completed
          </button>
        </div>
      )}
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10.5px] uppercase tracking-wider text-text-muted font-semibold">{label}</span>
      {children}
    </div>
  );
}

function ActiveChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-accent/10 border border-accent/30 text-[11px] font-medium text-accent">
      <span className="truncate max-w-[180px]">{label}</span>
      <button
        onClick={onClear}
        className="flex items-center justify-center w-4 h-4 rounded-full hover:bg-accent/20 cursor-pointer"
        title="Clear filter"
      >
        <XIcon />
      </button>
    </span>
  );
}
