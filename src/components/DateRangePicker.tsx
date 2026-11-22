import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import type { DateRange } from 'react-day-picker';
import { format } from 'date-fns';

interface Props {
  from: string; // YYYY-MM-DD or ''
  to: string;
  onChange: (from: string, to: string) => void;
}

function formatYMD(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function formatDisplay(d: Date): string {
  return format(d, 'MMM d');
}

/** Shared height for the caption row and the nav pinned over it */
const NAV_ROW_HEIGHT = 'h-7';

/** Minimum gap kept between the popover and the viewport edge, in px */
const VIEWPORT_MARGIN = 8;

export default function DateRangePicker({ from, to, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverLeft, setPopoverLeft] = useState(0);

  // Two months need ~620px; show one on narrow screens so the popover fits
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

  // The popover is anchored to its field, which can sit anywhere along the filter bar, so
  // shift it left when it would otherwise run off the right edge of the viewport
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const popover = popoverRef.current;
      const host = ref.current;
      if (!popover || !host) return;
      const hostLeft = host.getBoundingClientRect().left;
      const maxLeft = document.documentElement.clientWidth - popover.offsetWidth - VIEWPORT_MARGIN;
      setPopoverLeft(Math.round(Math.max(VIEWPORT_MARGIN, Math.min(hostLeft, maxLeft)) - hostLeft));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, wideEnough]);

  // Draft state — only committed on Apply
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);

  // Sync draft from props when opening
  useEffect(() => {
    if (open) {
      setDraft(
        from || to
          ? { from: from ? new Date(from + 'T00:00:00') : undefined, to: to ? new Date(to + 'T00:00:00') : undefined }
          : undefined,
      );
    }
  }, [open, from, to]);

  const handleApply = () => {
    const f = draft?.from ? formatYMD(draft.from) : '';
    const t = draft?.to ? formatYMD(draft.to) : '';
    onChange(f, t);
    setOpen(false);
  };

  const handleCancel = () => {
    setDraft(undefined);
    setOpen(false);
  };

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const hasRange = from && to;
  const draftComplete = draft?.from && draft?.to;
  const label = hasRange
    ? `${formatDisplay(new Date(from + 'T00:00:00'))} – ${formatDisplay(new Date(to + 'T00:00:00'))}`
    : 'Date range';

  // Draft display in the footer
  const draftLabel = draft?.from
    ? draft.to
      ? `${formatDisplay(draft.from)} – ${formatDisplay(draft.to)}`
      : `${formatDisplay(draft.from)} – select end date`
    : 'Select start date';

  return (
    <div ref={ref} className="relative flex items-center gap-1.5">
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1.5 py-[7px] px-3 bg-bg-card border rounded-md text-xs font-medium cursor-pointer outline-none transition-colors hover:border-text-muted ${
          hasRange ? 'border-accent text-accent' : 'border-border-secondary text-text-secondary'
        }`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        {label}
      </button>

      {hasRange && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onChange('', '');
          }}
          className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors cursor-pointer"
          title="Clear date range"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}

      {open && (
        <div
          ref={popoverRef}
          data-popover="date-range"
          style={{ left: popoverLeft }}
          className="absolute top-full left-0 mt-1.5 z-[100] bg-bg-card border border-border-primary rounded-xl shadow-2xl p-3 w-max max-w-[calc(100vw-4rem)]"
        >
          <DayPicker
            mode="range"
            selected={draft}
            onSelect={setDraft}
            numberOfMonths={wideEnough ? 2 : 1}
            showOutsideDays
            // react-day-picker's own stylesheet isn't imported, so every bit of
            // layout comes from here — including taking the nav out of flow and
            // pinning it to the caption row, which its default CSS would do.
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
                'w-full h-full rounded-md hover:bg-accent/10 hover:text-accent transition-colors cursor-pointer',
              selected: 'bg-accent text-white rounded-md font-semibold',
              range_start: 'bg-accent text-white rounded-l-md font-semibold',
              range_end: 'bg-accent text-white rounded-r-md font-semibold',
              range_middle: 'bg-accent/15 text-accent',
              today: 'font-bold text-accent',
              outside: 'text-text-muted/40',
              disabled: 'text-text-muted/30',
            }}
          />

          {/* Footer with selection summary and actions */}
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-border-primary">
            <span className="text-[11px] text-text-muted">{draftLabel}</span>
            <div className="flex gap-2">
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 text-[11px] font-medium text-text-secondary hover:text-text-primary rounded-md hover:bg-bg-hover transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleApply}
                disabled={!draftComplete}
                className="px-3 py-1.5 text-[11px] font-semibold text-white bg-accent rounded-md hover:bg-accent/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
