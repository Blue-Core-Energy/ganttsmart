import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DayPicker } from 'react-day-picker';
import { formatIsoDate } from '@/utils/date';

interface Props {
  taskId: string;
  /** Current due date, YYYY-MM-DD */
  value: string;
  title: string;
  color: string;
  onChange: (isoDate: string) => void;
  children: ReactNode;
}

const POPOVER_GAP = 6;
const VIEWPORT_MARGIN = 8;

/**
 * Due date cell trigger with a single-date calendar popover. The popover is portalled to
 * <body> and fixed-positioned so the table's overflow and sticky columns never clip it.
 */
export default function DueDatePicker({ taskId, value, title, color, onChange, children }: Props) {
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
    let top = t.bottom + POPOVER_GAP;
    if (top + p.height > window.innerHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, t.top - POPOVER_GAP - p.height);
    }
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, t.left),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - p.width - VIEWPORT_MARGIN),
    );
    anchorRef.current = { top: t.top, left: t.left };
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open) reposition();
    else setPos(null);
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
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close, reposition]);

  // Move focus into the calendar so it is keyboard-operable
  const placed = pos !== null;
  useEffect(() => {
    if (!open || !placed) return;
    popoverRef.current?.querySelector<HTMLElement>('button[tabindex="0"]')?.focus();
  }, [open, placed]);

  const selected = new Date(value + 'T00:00:00');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-due-cell={taskId}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Edit due date for ${taskId}`}
        title={`${title} — click to change`}
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
        className="-mx-1.5 px-1.5 py-0.5 rounded text-[11.5px] font-mono tabular-nums whitespace-nowrap bg-transparent border-0 cursor-pointer hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        style={{ color }}
      >
        {children}
      </button>
      {open &&
        createPortal(
          // React bubbles portal events through the React tree to the row, so swallow them here
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={`Due date for ${taskId}`}
            data-popover="due-date"
            data-popover-task={taskId}
            className="fixed z-[200] bg-bg-card border border-border-primary rounded-xl shadow-2xl p-3 w-max"
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
              defaultMonth={selected}
              onSelect={(d) => {
                if (!d) return;
                onChange(formatIsoDate(d));
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
                  'w-full h-full rounded-md hover:bg-accent/10 hover:text-accent transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                selected: 'bg-accent text-white rounded-md font-semibold',
                today: 'font-bold text-accent',
                outside: 'text-text-muted/40',
                disabled: 'text-text-muted/30',
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
