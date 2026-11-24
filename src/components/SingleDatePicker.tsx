import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { DayPicker } from 'react-day-picker';
import AnchoredPopover from '@/components/AnchoredPopover';
import { formatIsoDate } from '@/utils/date';

interface Props {
  taskId: string;
  kind: 'due' | 'start';
  /** Current date, YYYY-MM-DD or null */
  value: string | null;
  title: string;
  color?: string;
  /** Disables dates strictly after this YYYY-MM-DD */
  maxDate?: string | null;
  /** Disables dates strictly before this YYYY-MM-DD */
  minDate?: string | null;
  onChange: (isoDate: string) => void;
  onClear?: () => void;
  children: ReactNode;
}

const POPOVER_GAP = 6;
const VIEWPORT_MARGIN = 8;

/**
 * Single-date cell trigger with a calendar popover (used for both Due and Start dates).
 * The popover is portalled to <body> and fixed-positioned with viewport clamping and
 * ResizeObserver observing so narrow viewports (e.g. 375px) never clip or overflow.
 */
export default function SingleDatePicker({
  taskId,
  kind,
  value,
  title,
  color,
  maxDate,
  minDate,
  onChange,
  onClear,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((restoreFocus?: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const selected = value ? new Date(value + 'T00:00:00') : undefined;
  const defaultMonth = selected ?? (maxDate ? new Date(maxDate + 'T00:00:00') : new Date());

  const disabledMatchers = useMemo(() => {
    const matchers: Array<{ after: Date } | { before: Date }> = [];
    if (maxDate) matchers.push({ after: new Date(maxDate + 'T00:00:00') });
    if (minDate) matchers.push({ before: new Date(minDate + 'T00:00:00') });
    return matchers.length > 0 ? matchers : undefined;
  }, [maxDate, minDate]);

  const isDue = kind === 'due';
  const triggerLabel = isDue ? `Edit due date for ${taskId}` : `Edit start date for ${taskId}`;
  const popoverLabel = isDue ? `Due date for ${taskId}` : `Start date for ${taskId}`;
  const popoverKind = isDue ? 'due-date' : 'start-date';
  const triggerTitle = title.includes('click to')
    ? title
    : value
      ? `${title} — click to change`
      : `${title} — click to set`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-due-cell={isDue ? taskId : undefined}
        data-start-cell={!isDue ? taskId : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerTitle}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        }}
        className="-mx-1.5 px-1.5 py-0.5 rounded text-[11.5px] font-mono tabular-nums text-text-secondary whitespace-nowrap bg-transparent border-0 cursor-pointer hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        style={color ? { color } : undefined}
      >
        {children}
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={triggerRef}
          open={open}
          onClose={close}
          gap={POPOVER_GAP}
          viewportMargin={VIEWPORT_MARGIN}
          onPlaced={(el) => {
            el.querySelector<HTMLElement>('button[tabindex="0"], button')?.focus();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          role="dialog"
          aria-label={popoverLabel}
          data-popover={popoverKind}
          data-popover-task={taskId}
          className="z-[200] bg-bg-card border border-border-primary rounded-xl shadow-2xl p-3 w-max max-w-[calc(100vw-16px)]"
        >
          <DayPicker
            mode="single"
            required
            selected={selected}
            defaultMonth={defaultMonth}
            disabled={disabledMatchers}
            onSelect={(d) => {
              if (!d) return;
              const iso = formatIsoDate(d);
              if (maxDate && iso > maxDate) return;
              if (minDate && iso < minDate) return;
              onChange(iso);
              close(true);
            }}
            showOutsideDays
            classNames={{
              root: 'text-text-primary text-xs',
              months: 'relative flex gap-4',
              month_caption: 'flex items-center justify-center h-7 mb-2 text-sm font-semibold text-text-primary',
              nav: 'absolute inset-x-0 top-0 z-10 flex items-center justify-between h-7',
              button_previous:
                'p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors cursor-pointer',
              button_next:
                'p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors cursor-pointer',
              weekdays: 'flex',
              weekday: 'w-9 text-center text-[10px] font-medium text-text-muted py-1',
              week: 'flex',
              day: 'w-9 h-8 text-center text-xs',
              day_button:
                'w-full h-full rounded-md hover:bg-accent/10 hover:text-accent transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-inherit',
              selected: 'bg-accent text-white rounded-md font-semibold',
              today: 'font-bold text-accent',
              outside: 'text-text-muted/40',
              disabled: 'text-text-muted/30',
            }}
          />
          {onClear && (
            <div className="flex items-center justify-end mt-2 pt-2 border-t border-border-primary">
              <button
                type="button"
                data-clear-date
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                  close(true);
                }}
                className="px-2.5 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary rounded hover:bg-bg-hover transition-colors cursor-pointer"
              >
                Clear
              </button>
            </div>
          )}
        </AnchoredPopover>
      )}
    </>
  );
}
