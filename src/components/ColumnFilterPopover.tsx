import { useEffect, useId, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { DayPicker, type DateRange } from 'react-day-picker';
import AnchoredPopover from '@/components/AnchoredPopover';
import StatusIcon from '@/components/StatusIcon';
import type { Filters } from '@/types';
import { Avatar } from '@/utils/avatar';
import { statusDotColorFor } from '@/utils/colors';
import type { ColumnKey } from '@/utils/scheduleColumns';

interface Props {
  columnKey: ColumnKey;
  anchorRef: React.RefObject<Element | null>;
  onClose: (restoreFocus?: boolean) => void;
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  assignees: string[];
  statuses: string[];
  statusTypeByStatus?: Map<string, string> | Record<string, string>;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  anchorKey?: unknown;
}

function formatYMD(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function formatDisplay(d: Date): string {
  return format(d, 'MMM d');
}

const NAV_ROW_HEIGHT = 'h-7';
const VIEWPORT_MARGIN = 8;

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <polyline points="20 6 9 17 4 12" />
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
      strokeWidth="1.5"
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

function SearchIcon() {
  return (
    <svg
      className="text-text-muted shrink-0"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export default function ColumnFilterPopover({
  columnKey,
  anchorRef,
  onClose,
  filters,
  onFiltersChange,
  assignees,
  statuses,
  statusTypeByStatus,
  returnFocusRef,
  anchorKey,
}: Props) {
  const isDateColumn = columnKey === 'start' || columnKey === 'due';
  const isAssigneeColumn = columnKey === 'assignee';
  const isStatusColumn = columnKey === 'status';

  if (!isDateColumn && !isAssigneeColumn && !isStatusColumn) {
    return null;
  }

  if (isDateColumn) {
    return (
      <DateRangeFilterPopover
        anchorRef={anchorRef}
        anchorKey={`${anchorKey ?? columnKey}:${filters.dateFrom}:${filters.dateTo}`}
        returnFocusRef={returnFocusRef}
        onClose={onClose}
        dateFrom={filters.dateFrom}
        dateTo={filters.dateTo}
        onApply={(dateFrom, dateTo) => onFiltersChange({ ...filters, dateFrom, dateTo })}
        onClear={() => onFiltersChange({ ...filters, dateFrom: '', dateTo: '' })}
      />
    );
  }

  if (isAssigneeColumn) {
    return (
      <AssigneeFilterPopover
        anchorRef={anchorRef}
        anchorKey={`${anchorKey ?? columnKey}:${filters.assignee}`}
        returnFocusRef={returnFocusRef}
        onClose={onClose}
        assignees={assignees}
        selected={filters.assignee}
        onSelect={(assignee) => onFiltersChange({ ...filters, assignee })}
        onClear={() => onFiltersChange({ ...filters, assignee: '' })}
      />
    );
  }

  return (
    <StatusFilterPopover
      anchorRef={anchorRef}
      anchorKey={`${anchorKey ?? columnKey}:${filters.status}:${filters.showCompleted}`}
      returnFocusRef={returnFocusRef}
      onClose={onClose}
      statuses={statuses}
      statusTypeByStatus={statusTypeByStatus}
      selectedStatus={filters.status}
      showCompleted={filters.showCompleted}
      onSelectStatus={(status) => onFiltersChange({ ...filters, status })}
      onToggleCompleted={() => onFiltersChange({ ...filters, showCompleted: !filters.showCompleted })}
      onReset={() => onFiltersChange({ ...filters, status: '', showCompleted: true })}
    />
  );
}

interface AssigneePopoverProps {
  anchorRef: React.RefObject<Element | null>;
  anchorKey?: unknown;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  onClose: (restoreFocus?: boolean) => void;
  assignees: string[];
  selected: string;
  onSelect: (assignee: string) => void;
  onClear: () => void;
}

function AssigneeFilterPopover({
  anchorRef,
  anchorKey,
  returnFocusRef,
  onClose,
  assignees,
  selected,
  onSelect,
  onClear,
}: AssigneePopoverProps) {
  const [search, setSearch] = useState('');
  const dialogId = useId();

  const filtered = useMemo(() => {
    if (!search.trim()) return assignees;
    const q = search.toLowerCase();
    return assignees.filter((a) => a.toLowerCase().includes(q));
  }, [assignees, search]);

  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      anchorKey={anchorKey}
      returnFocusRef={returnFocusRef}
      open={true}
      onClose={onClose}
      gap={6}
      viewportMargin={VIEWPORT_MARGIN}
      onPlaced={(el) => {
        el.querySelector<HTMLElement>('input, button[role="option"], button')?.focus();
      }}
      id={dialogId}
      role="dialog"
      aria-label="Filter by assignee"
      data-popover="filter-assignee"
      className="z-[100] w-[220px] max-w-[calc(100vw-16px)] bg-bg-card border border-border-secondary rounded-lg shadow-xl p-2.5 flex flex-col gap-2 normal-case tracking-normal text-left"
    >
      <div className="flex items-center justify-between pb-1 border-b border-border-primary/60">
        <span className="text-xs font-semibold text-text-primary">Assignee</span>
        {Boolean(selected) && (
          <button
            type="button"
            onClick={() => {
              onClear();
              onClose(true);
            }}
            className="text-[11px] text-text-muted hover:text-text-primary cursor-pointer underline underline-offset-2 decoration-dotted"
          >
            Clear
          </button>
        )}
      </div>

      {assignees.length > 5 && (
        <div className="relative flex items-center">
          <span className="absolute left-2 pointer-events-none">
            <SearchIcon />
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search assignees…"
            className="h-7 w-full pl-6 pr-2 bg-bg-hover/60 border border-border-primary rounded text-xs text-text-primary outline-none focus:border-accent placeholder:text-text-muted"
          />
        </div>
      )}

      <div role="listbox" aria-label="Assignees" className="max-h-[220px] overflow-y-auto flex flex-col gap-0.5">
        <button
          type="button"
          role="option"
          aria-selected={!selected}
          onClick={() => {
            onClear();
            onClose(true);
          }}
          className={`flex items-center justify-between w-full px-2 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors text-left hover:bg-bg-hover ${
            !selected ? 'text-accent bg-accent/10' : 'text-text-primary'
          }`}
        >
          <span className="inline-flex items-center gap-2 truncate">
            <UsersIcon />
            <span className="truncate">All assignees</span>
          </span>
          {!selected && <CheckIcon />}
        </button>

        {filtered.map((a) => {
          const isSelected = selected === a;
          return (
            <button
              key={a}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => {
                onSelect(a);
                onClose(true);
              }}
              className={`flex items-center justify-between w-full px-2 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors text-left hover:bg-bg-hover ${
                isSelected ? 'text-accent bg-accent/10' : 'text-text-primary'
              }`}
            >
              <span className="inline-flex items-center gap-2 truncate">
                <Avatar name={a} size="sm" />
                <span className="truncate">{a}</span>
              </span>
              {isSelected && <CheckIcon />}
            </button>
          );
        })}

        {filtered.length === 0 && (
          <div className="py-2 px-3 text-xs text-text-muted text-center">No assignees found</div>
        )}
      </div>
    </AnchoredPopover>
  );
}

interface StatusPopoverProps {
  anchorRef: React.RefObject<Element | null>;
  anchorKey?: unknown;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  onClose: (restoreFocus?: boolean) => void;
  statuses: string[];
  statusTypeByStatus?: Map<string, string> | Record<string, string>;
  selectedStatus: string;
  showCompleted: boolean;
  onSelectStatus: (status: string) => void;
  onToggleCompleted: () => void;
  onReset: () => void;
}

function StatusFilterPopover({
  anchorRef,
  anchorKey,
  returnFocusRef,
  onClose,
  statuses,
  statusTypeByStatus,
  selectedStatus,
  showCompleted,
  onSelectStatus,
  onToggleCompleted,
  onReset,
}: StatusPopoverProps) {
  const dialogId = useId();
  const isFiltering = Boolean(selectedStatus) || !showCompleted;

  const resolveStatusType = (name: string): string => {
    if (statusTypeByStatus instanceof Map) {
      return statusTypeByStatus.get(name) ?? name;
    }
    if (statusTypeByStatus) {
      return statusTypeByStatus[name] ?? name;
    }
    return name;
  };

  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      anchorKey={anchorKey}
      returnFocusRef={returnFocusRef}
      open={true}
      onClose={onClose}
      gap={6}
      viewportMargin={VIEWPORT_MARGIN}
      onPlaced={(el) => {
        el.querySelector<HTMLElement>('button[role="option"], button')?.focus();
      }}
      id={dialogId}
      role="dialog"
      aria-label="Filter by status"
      data-popover="filter-status"
      className="z-[100] w-[220px] max-w-[calc(100vw-16px)] bg-bg-card border border-border-secondary rounded-lg shadow-xl p-2.5 flex flex-col gap-2 normal-case tracking-normal text-left"
    >
      <div className="flex items-center justify-between pb-1 border-b border-border-primary/60">
        <span className="text-xs font-semibold text-text-primary">Status</span>
        {isFiltering && (
          <button
            type="button"
            onClick={() => {
              onReset();
              onClose(true);
            }}
            className="text-[11px] text-text-muted hover:text-text-primary cursor-pointer underline underline-offset-2 decoration-dotted"
          >
            Reset
          </button>
        )}
      </div>

      <div role="listbox" aria-label="Statuses" className="max-h-[220px] overflow-y-auto flex flex-col gap-0.5">
        <button
          type="button"
          role="option"
          aria-selected={!selectedStatus}
          onClick={() => {
            onSelectStatus('');
            onClose(true);
          }}
          className={`flex items-center justify-between w-full px-2 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors text-left hover:bg-bg-hover ${
            !selectedStatus ? 'text-accent bg-accent/10' : 'text-text-primary'
          }`}
        >
          <span className="inline-flex items-center gap-2 truncate">
            <StatusIcon type="unstarted" color={statusDotColorFor('unstarted')} size={13} />
            <span className="truncate">All statuses</span>
          </span>
          {!selectedStatus && <CheckIcon />}
        </button>

        {statuses.map((s) => {
          const isSelected = selectedStatus === s;
          const sType = resolveStatusType(s);
          return (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => {
                onSelectStatus(s);
                onClose(true);
              }}
              className={`flex items-center justify-between w-full px-2 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors text-left hover:bg-bg-hover ${
                isSelected ? 'text-accent bg-accent/10' : 'text-text-primary'
              }`}
            >
              <span className="inline-flex items-center gap-2 truncate">
                <StatusIcon type={sType} color={statusDotColorFor(sType)} size={13} />
                <span className="truncate">{s}</span>
              </span>
              {isSelected && <CheckIcon />}
            </button>
          );
        })}
      </div>

      <div className="border-t border-border-primary/60 pt-1.5">
        <button
          type="button"
          onClick={onToggleCompleted}
          aria-pressed={showCompleted}
          title={showCompleted ? 'Hide completed tasks' : 'Show completed tasks'}
          className="flex items-center justify-between w-full px-2 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors text-left hover:bg-bg-hover text-text-primary"
        >
          <span className="inline-flex items-center gap-2">
            <span
              className={`w-3.5 h-3.5 rounded flex items-center justify-center border transition-colors ${
                showCompleted ? 'bg-low/20 border-low/60 text-low' : 'border-border-secondary text-transparent'
              }`}
            >
              <CheckIcon />
            </span>
            Completed tasks
          </span>
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
              showCompleted ? 'text-low bg-low/10' : 'text-text-muted bg-bg-hover'
            }`}
          >
            {showCompleted ? 'Shown' : 'Hidden'}
          </span>
        </button>
      </div>
    </AnchoredPopover>
  );
}

interface DatePopoverProps {
  anchorRef: React.RefObject<Element | null>;
  anchorKey?: unknown;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  onClose: (restoreFocus?: boolean) => void;
  dateFrom: string;
  dateTo: string;
  onApply: (from: string, to: string) => void;
  onClear: () => void;
}

function DateRangeFilterPopover({
  anchorRef,
  anchorKey,
  returnFocusRef,
  onClose,
  dateFrom,
  dateTo,
  onApply,
  onClear,
}: DatePopoverProps) {
  const dialogId = useId();
  const [wideEnough, setWideEnough] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 1024px)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const update = () => setWideEnough(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const [draft, setDraft] = useState<DateRange | undefined>(() =>
    dateFrom || dateTo
      ? {
          from: dateFrom ? new Date(dateFrom + 'T00:00:00') : undefined,
          to: dateTo ? new Date(dateTo + 'T00:00:00') : undefined,
        }
      : undefined,
  );

  const handleApply = () => {
    const f = draft?.from ? formatYMD(draft.from) : '';
    const t = draft?.to ? formatYMD(draft.to) : '';
    onApply(f, t);
    onClose(true);
  };

  const handleClear = () => {
    onClear();
    onClose(true);
  };

  const hasRange = Boolean(dateFrom || dateTo);
  const draftComplete = Boolean(draft?.from && draft?.to);
  const draftLabel = draft?.from
    ? draft.to
      ? `${formatDisplay(draft.from)} – ${formatDisplay(draft.to)}`
      : `${formatDisplay(draft.from)} – select end date`
    : 'Select start date';

  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      anchorKey={anchorKey}
      returnFocusRef={returnFocusRef}
      open={true}
      onClose={onClose}
      gap={6}
      viewportMargin={VIEWPORT_MARGIN}
      onPlaced={(el) => {
        el.querySelector<HTMLElement>('button[tabindex="0"], button')?.focus();
      }}
      id={dialogId}
      role="dialog"
      aria-label="Filter by date range"
      data-popover="date-range"
      className="z-[100] bg-bg-card border border-border-secondary rounded-lg shadow-xl p-3 w-max max-w-[calc(100vw-16px)] normal-case tracking-normal"
    >
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-border-primary/60">
        <span className="text-xs font-semibold text-text-primary">Date range</span>
        {hasRange && (
          <button
            type="button"
            onClick={handleClear}
            className="text-[11px] text-text-muted hover:text-text-primary cursor-pointer underline underline-offset-2 decoration-dotted"
          >
            Clear
          </button>
        )}
      </div>

      <DayPicker
        mode="range"
        selected={draft}
        onSelect={setDraft}
        numberOfMonths={wideEnough ? 2 : 1}
        showOutsideDays
        classNames={{
          root: 'text-text-primary text-xs',
          months: 'relative flex gap-4',
          month_caption: `flex items-center justify-center ${NAV_ROW_HEIGHT} mb-2 text-sm font-semibold text-text-primary`,
          nav: `absolute inset-x-0 top-0 z-10 flex items-center justify-between ${NAV_ROW_HEIGHT}`,
          button_previous:
            'p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors cursor-pointer',
          button_next:
            'p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors cursor-pointer',
          weekdays: 'flex',
          weekday: 'w-9 text-center text-[10px] font-medium text-text-muted py-1',
          week: 'flex',
          day: 'w-9 h-8 text-center text-xs',
          day_button:
            'w-full h-full rounded-[4px] hover:bg-accent/10 hover:text-accent transition-colors cursor-pointer',
          selected: 'bg-accent text-white rounded-[4px] font-medium',
          range_start: 'bg-accent text-white rounded-l-[4px] font-medium',
          range_end: 'bg-accent text-white rounded-r-[4px] font-medium',
          range_middle: 'bg-accent/15 text-accent',
          today: 'font-bold text-accent',
          outside: 'text-text-muted/40',
          disabled: 'text-text-muted/30',
        }}
      />

      <div className="flex items-center justify-between pt-2.5 mt-2 border-t border-border-primary/60 text-xs">
        <span className="text-text-muted text-[11px] font-mono">{draftLabel}</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onClose(true)}
            className="px-2.5 py-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover text-xs cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!draftComplete}
            className={`px-3 py-1 rounded-md text-white text-xs font-medium transition-colors shadow-sm ${
              draftComplete
                ? 'bg-accent cursor-pointer hover:bg-accent/90'
                : 'bg-accent/50 cursor-not-allowed opacity-60'
            }`}
          >
            Apply
          </button>
        </div>
      </div>
    </AnchoredPopover>
  );
}
