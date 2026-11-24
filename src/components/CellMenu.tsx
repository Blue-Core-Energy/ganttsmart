import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import AnchoredPopover from '@/components/AnchoredPopover';
import { filterDropdownOptions, getInitialHighlightIndex, getNextHighlightIndex } from '@/utils/dropdown';

export interface CellMenuOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  keywords?: string;
}

interface Props {
  /** Element the menu is positioned against; clicks on it are left to its own handler */
  anchorRef: React.RefObject<HTMLElement | null>;
  options: CellMenuOption[];
  /** Value of the currently active option (shown with a checkmark) */
  value: string;
  onSelect: (value: string) => void;
  onClose: () => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  loading?: boolean;
  error?: string;
  emptyMessage?: string;
  ariaLabel: string;
}

const MENU_WIDTH = 240;
const MENU_MAX_HEIGHT = 300;
const VIEWPORT_MARGIN = 8;

/**
 * Popover menu for editing a table cell. It is rendered through a portal into document.body so the
 * table's overflow and sticky columns never clip it. Every keyboard and mouse event is contained here
 * so the row (drag, shortcuts, arrow navigation) and the app shortcuts never react to it.
 */
export default function CellMenu({
  anchorRef,
  options,
  value,
  onSelect,
  onClose,
  searchable = false,
  searchPlaceholder = 'Search…',
  loading = false,
  error = '',
  emptyMessage = 'No matches found',
  ariaLabel,
}: Props) {
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(() => getInitialHighlightIndex(options, value, false));
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previousFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const listboxId = useId();

  const filtered = useMemo(
    () => (searchable ? filterDropdownOptions(options, query) : options),
    [searchable, options, query],
  );
  const activeIndex = highlightedIndex >= filtered.length ? (filtered.length > 0 ? 0 : -1) : highlightedIndex;

  const close = useCallback(
    (returnFocus?: boolean) => {
      onClose();
      const prev = previousFocusRef.current;
      if (returnFocus && prev && prev.isConnected && prev !== document.body) prev.focus();
    },
    [onClose],
  );

  useEffect(() => {
    if (activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  // Options can arrive after mount (loaded on demand): highlight the active one once they do
  useEffect(() => {
    setHighlightedIndex(getInitialHighlightIndex(options, value, false));
  }, [options, value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(getNextHighlightIndex(activeIndex, filtered.length, e.key === 'ArrowDown' ? 'next' : 'prev'));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setHighlightedIndex(getNextHighlightIndex(activeIndex, filtered.length, e.key === 'Home' ? 'first' : 'last'));
    } else if (e.key === 'Enter') {
      const opt = filtered[activeIndex];
      if (opt) {
        e.preventDefault();
        onSelect(opt.value);
        close(true);
      }
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <AnchoredPopover
      ref={menuRef}
      anchorRef={anchorRef}
      onClose={close}
      restoreFocusOnClose={false}
      gap={4}
      viewportMargin={VIEWPORT_MARGIN}
      minSpaceBelowToAvoidFlip={180}
      onPlaced={() => {
        if (searchable) searchRef.current?.focus();
        else menuRef.current?.focus();
      }}
      data-inline-menu={ariaLabel}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="z-[300] flex flex-col bg-bg-card border border-border-secondary rounded-lg shadow-xl outline-none"
      style={{
        width: MENU_WIDTH,
        maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
        maxHeight: MENU_MAX_HEIGHT,
      }}
    >
      {searchable && (
        <div className="px-2 pt-2 pb-1.5 border-b border-border-primary shrink-0">
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
            aria-label={searchPlaceholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlightedIndex(0);
            }}
            placeholder={searchPlaceholder}
            className="w-full h-7 px-2 bg-bg-primary border border-border-primary rounded-md text-text-primary text-xs outline-none transition-colors hover:border-border-secondary focus:border-accent placeholder:text-text-muted"
          />
        </div>
      )}
      <div id={listboxId} role="listbox" aria-label={ariaLabel} className="overflow-y-auto py-1 flex-1">
        {loading ? (
          <div className="px-3 py-4 text-center text-xs text-text-muted">Loading…</div>
        ) : error ? (
          <div className="px-3 py-4 text-center text-xs text-urgent" role="alert">
            {error}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-text-muted">{emptyMessage}</div>
        ) : (
          filtered.map((opt, idx) => {
            const selected = opt.value === value;
            const highlighted = idx === activeIndex;
            return (
              <button
                key={opt.value}
                ref={(el) => {
                  optionRefs.current[idx] = el;
                }}
                id={`${listboxId}-opt-${idx}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                title={opt.label}
                onMouseEnter={() => setHighlightedIndex(idx)}
                onClick={() => {
                  onSelect(opt.value);
                  close(true);
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-left cursor-pointer transition-colors ${
                  selected
                    ? highlighted
                      ? 'bg-accent/15 text-accent'
                      : 'bg-accent/10 text-accent'
                    : highlighted
                      ? 'bg-bg-hover text-text-primary'
                      : 'text-text-primary hover:bg-bg-hover'
                }`}
              >
                {opt.icon && (
                  <span className="shrink-0 flex items-center" aria-hidden="true">
                    {opt.icon}
                  </span>
                )}
                <span className="truncate flex-1">{opt.label}</span>
                {selected && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })
        )}
      </div>
    </AnchoredPopover>
  );
}
