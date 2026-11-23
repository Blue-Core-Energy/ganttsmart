import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DayPicker } from 'react-day-picker';
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
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ top: number; left: number } | null>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const t = trigger.getBoundingClientRect();
    const p = popover.getBoundingClientRect();
    const clientWidth = document.documentElement.clientWidth || window.innerWidth;
    const clientHeight = document.documentElement.clientHeight || window.innerHeight;

    let top = t.bottom + POPOVER_GAP;
    if (top + p.height > clientHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, t.top - POPOVER_GAP - p.height);
    }
    const maxLeft = Math.max(VIEWPORT_MARGIN, clientWidth - p.width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(VIEWPORT_MARGIN, t.left), maxLeft);
    anchorRef.current = { top: t.top, left: t.left };
    setPos((prev) => (prev?.top === top && prev?.left === left ? prev : { top, left }));
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    reposition();
    window.addEventListener('resize', reposition);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reposition);
    if (popoverRef.current) observer?.observe(popoverRef.current);
    return () => {
      window.removeEventListener('resize', reposition);
      observer?.disconnect();
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      // Close once the trigger has scrolled away from where the popover was anchored (sticky columns stay put)
      const t = triggerRef.current?.getBoundingClientRect();
      const a = anchorRef.current;
      if (!t || !a || Math.abs(t.top - a.top) > 1 || Math.abs(t.left - a.left) > 1) close(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    // Capture phase so interactive chart elements that stopPropagation() still dismiss the picker
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  // Move focus into the calendar so it is keyboard-operable
  const placed = pos !== null;
  useEffect(() => {
    if (!open || !placed) return;
    popoverRef.current?.querySelector<HTMLElement>('button[tabindex="0"], button')?.focus();
  }, [open, placed]);

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
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            close(true);
          }
        }}
        className="-mx-1.5 px-1.5 py-0.5 rounded text-[11.5px] font-mono tabular-nums text-text-secondary whitespace-nowrap bg-transparent border-0 cursor-pointer hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        style={color ? { color } : undefined}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={popoverLabel}
            data-popover={popoverKind}
            data-popover-task={taskId}
            className="fixed z-[200] bg-bg-card border border-border-primary rounded-xl shadow-2xl p-3 w-max max-w-[calc(100vw-16px)]"
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') close(true);
            }}
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
          </div>,
          document.body,
        )}
    </>
  );
}
