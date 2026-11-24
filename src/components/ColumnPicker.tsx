import { useCallback, useId, useRef } from 'react';
import AnchoredPopover from '@/components/AnchoredPopover';
import { COLUMN_DEFS, DEFAULT_VISIBLE_COLUMNS, type ColumnKey } from '@/utils/scheduleColumns';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The saved selection, which a narrow screen does not show in full */
  visible: ColumnKey[];
  /** Narrow screens show only ID and Issue, so the selection can't be edited from here */
  narrow?: boolean;
  onChange: (next: ColumnKey[]) => void;
}

function ColumnsIcon() {
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </svg>
  );
}

/**
 * Chooses which schedule columns are shown. Opened by right-clicking any column
 * header, or from the button this renders in the first header cell — right-click
 * alone would be out of reach for keyboard and touch users.
 */
export default function ColumnPicker({ open, onOpenChange, visible, narrow = false, onChange }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const close = useCallback(
    (opts?: { returnFocus?: boolean }) => {
      onOpenChange(false);
      if (opts?.returnFocus) triggerRef.current?.focus();
    },
    [onOpenChange],
  );

  const toggle = (key: ColumnKey) => {
    onChange(visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key]);
  };

  const optionalVisibleCount = COLUMN_DEFS.filter((d) => !d.required && visible.includes(d.key)).length;

  return (
    <span className="inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Choose columns"
        title="Choose columns"
        data-export-hide
        className={`inline-flex items-center justify-center w-5 h-5 rounded transition-colors cursor-pointer print:hidden hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          open ? 'text-accent' : 'text-text-muted/70'
        }`}
      >
        <ColumnsIcon />
      </button>

      {open && (
        <AnchoredPopover
          anchorRef={triggerRef}
          open={open}
          onClose={(returnFocus) => close({ returnFocus })}
          gap={6}
          closeOnScroll={false}
          onPlaced={(el) => {
            const first = el.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)');
            first?.focus();
          }}
          id={menuId}
          role="group"
          aria-label="Columns"
          className="z-50 w-[196px] bg-bg-card border border-border-secondary rounded-lg shadow-xl py-1 normal-case tracking-normal"
        >
          {narrow && (
            <p className="px-3 py-1.5 text-[11px] leading-snug text-text-muted whitespace-normal">
              Only ID and Issue are shown on narrow screens. Your selection returns on a wider screen.
            </p>
          )}
          {COLUMN_DEFS.map((def) => {
            const checked = visible.includes(def.key);
            // The task column alone is unreadable, so the last optional column holds
            // rather than silently snapping the whole set back to the defaults
            const isLastOptional = checked && !def.required && optionalVisibleCount === 1;
            const locked = def.required || isLastOptional || narrow;
            return (
              <label
                key={def.key}
                className={`flex items-center gap-2.5 px-3 py-1.5 text-xs font-medium text-text-primary ${
                  locked ? 'opacity-50' : 'cursor-pointer hover:bg-bg-hover'
                }`}
                title={
                  def.required
                    ? 'The issue column is always shown'
                    : isLastOptional && !narrow
                      ? 'Keep at least one column besides Issue'
                      : undefined
                }
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={locked}
                  onChange={() => toggle(def.key)}
                  className="w-3.5 h-3.5 accent-accent cursor-pointer disabled:cursor-default"
                />
                <span className="truncate">{def.pickerLabel ?? def.label}</span>
              </label>
            );
          })}
          <div className="border-t border-border-primary mt-1 pt-1 px-3 pb-1">
            <button
              type="button"
              onClick={() => onChange([...DEFAULT_VISIBLE_COLUMNS])}
              className="text-[11px] text-text-muted hover:text-text-primary cursor-pointer underline underline-offset-2 decoration-dotted"
            >
              Reset to defaults
            </button>
          </div>
        </AnchoredPopover>
      )}
    </span>
  );
}
