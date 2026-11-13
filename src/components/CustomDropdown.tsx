import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { filterDropdownOptions, getInitialHighlightIndex, getNextHighlightIndex } from '@/utils/dropdown';

export interface DropdownOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  keywords?: string;
}

interface Props {
  value: string;
  options: DropdownOption[];
  placeholder: string;
  placeholderIcon?: React.ReactNode;
  onChange: (value: string) => void;
  className?: string;
  /** When true, hides the "All" clear option — the dropdown always requires a selection */
  required?: boolean;
  /** When true, renders a search input inside the dropdown popover to filter options by typing */
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  ariaLabel?: string;
}

const selectBgImage = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%238b949e' d='M1 1l4 4 4-4'/%3E%3C/svg%3E")`;

export default function CustomDropdown({
  value,
  options,
  placeholder,
  placeholderIcon,
  onChange,
  className = '',
  required = false,
  searchable = false,
  searchPlaceholder = 'Search…',
  emptyMessage = 'No matches found',
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();

  const filteredOptions = useMemo(
    () => (searchable ? filterDropdownOptions(options, query) : options),
    [searchable, options, query],
  );

  const showClearOption = !required && (!searchable || query.trim() === '');
  const optionOffset = showClearOption ? 1 : 0;
  const totalItems = optionOffset + filteredOptions.length;
  const activeHighlightIndex = highlightedIndex >= totalItems ? (totalItems > 0 ? 0 : -1) : highlightedIndex;

  const openDropdown = useCallback(() => {
    setQuery('');
    setHighlightedIndex(getInitialHighlightIndex(options, value, !required));
    setOpen(true);
  }, [options, value, required]);

  const closeDropdown = useCallback((opts?: { returnFocus?: boolean }) => {
    setOpen(false);
    setQuery('');
    setHighlightedIndex(-1);
    if (opts?.returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      const nextFiltered = filterDropdownOptions(options, nextQuery);
      const nextShowClear = !required && nextQuery.trim() === '';
      setHighlightedIndex(getInitialHighlightIndex(nextFiltered, value, nextShowClear));
    },
    [options, required, value],
  );

  const selectValue = useCallback(
    (nextValue: string, opts?: { returnFocus?: boolean }) => {
      onChange(nextValue);
      closeDropdown(opts);
    },
    [onChange, closeDropdown],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        closeDropdown();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, closeDropdown]);

  useEffect(() => {
    if (open && searchable) {
      searchInputRef.current?.focus();
    }
  }, [open, searchable]);

  useEffect(() => {
    if (!open || activeHighlightIndex < 0) return;
    optionRefs.current[activeHighlightIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeHighlightIndex]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openDropdown();
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeDropdown({ returnFocus: true });
      return;
    }

    if (e.key === 'Tab') {
      closeDropdown();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(getNextHighlightIndex(activeHighlightIndex, totalItems, 'next'));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(getNextHighlightIndex(activeHighlightIndex, totalItems, 'prev'));
      return;
    }

    if (e.key === 'Enter' && (e.target === searchInputRef.current || e.target === triggerRef.current)) {
      if (activeHighlightIndex >= 0 && activeHighlightIndex < totalItems) {
        e.preventDefault();
        if (showClearOption && activeHighlightIndex === 0) {
          selectValue('', { returnFocus: true });
        } else {
          const opt = filteredOptions[activeHighlightIndex - optionOffset];
          if (opt) selectValue(opt.value, { returnFocus: true });
        }
      }
    }
  };

  const selected = options.find((o) => o.value === value);
  const activeOptionId = activeHighlightIndex >= 0 ? `${listboxId}-opt-${activeHighlightIndex}` : undefined;

  return (
    <div className={`relative ${className}`} ref={ref} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closeDropdown() : openDropdown())}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 py-[7px] pl-2.5 pr-7 bg-bg-card border border-border-secondary rounded-md text-text-primary text-xs font-medium cursor-pointer outline-none transition-colors hover:border-text-muted focus:border-accent max-w-[200px] bg-no-repeat bg-[right_10px_center] bg-[length:10px_6px] w-full"
        style={{ backgroundImage: selectBgImage }}
      >
        {selected ? (
          <>
            {selected.icon}
            <span className="truncate">{selected.label}</span>
          </>
        ) : (
          <>
            {placeholderIcon}
            <span className="text-text-secondary truncate">{placeholder}</span>
          </>
        )}
      </button>
      {open && (
        <div
          className={`absolute top-full mt-1 left-0 bg-bg-card border border-border-secondary rounded-lg shadow-xl z-50 flex flex-col ${
            searchable ? 'min-w-[240px] max-w-[320px] max-h-[320px]' : 'min-w-[200px] max-h-[280px]'
          }`}
        >
          {searchable && (
            <div className="px-2 pt-2 pb-1.5 border-b border-border-primary shrink-0">
              <div className="relative flex items-center">
                <svg
                  className="absolute left-2 text-text-muted pointer-events-none"
                  width="12"
                  height="12"
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
                <input
                  ref={searchInputRef}
                  type="text"
                  role="combobox"
                  aria-expanded={open}
                  aria-controls={listboxId}
                  aria-autocomplete="list"
                  aria-activedescendant={activeOptionId}
                  aria-label={searchPlaceholder}
                  value={query}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="w-full h-7 pl-7 pr-6 bg-bg-primary border border-border-primary rounded-md text-text-primary text-xs outline-none transition-colors hover:border-border-secondary focus:border-accent placeholder:text-text-muted"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      handleQueryChange('');
                      searchInputRef.current?.focus();
                    }}
                    className="absolute right-1.5 flex items-center justify-center w-4 h-4 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
                    aria-label="Clear search"
                    tabIndex={-1}
                  >
                    <svg
                      width="10"
                      height="10"
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
              </div>
            </div>
          )}

          <div
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel || placeholder}
            className="overflow-y-auto py-1 flex-1"
          >
            {/* "All" option — hidden when required or when actively filtering */}
            {showClearOption && (
              <button
                ref={(el) => {
                  optionRefs.current[0] = el;
                }}
                id={`${listboxId}-opt-0`}
                type="button"
                role="option"
                aria-selected={!value}
                onMouseEnter={() => setHighlightedIndex(0)}
                onClick={() => selectValue('')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left cursor-pointer transition-colors ${
                  !value
                    ? activeHighlightIndex === 0
                      ? 'bg-accent/15 text-accent'
                      : 'bg-accent/10 text-accent'
                    : activeHighlightIndex === 0
                      ? 'bg-bg-hover text-text-primary'
                      : 'text-text-primary hover:bg-bg-hover'
                }`}
              >
                {placeholderIcon}
                <span className="truncate flex-1">{placeholder}</span>
              </button>
            )}

            {filteredOptions.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-text-muted">{emptyMessage}</div>
            ) : (
              filteredOptions.map((opt, idx) => {
                const itemIndex = idx + optionOffset;
                const isSelected = value === opt.value;
                const isHighlighted = activeHighlightIndex === itemIndex;
                return (
                  <button
                    key={opt.value}
                    ref={(el) => {
                      optionRefs.current[itemIndex] = el;
                    }}
                    id={`${listboxId}-opt-${itemIndex}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    title={opt.label}
                    onMouseEnter={() => setHighlightedIndex(itemIndex)}
                    onClick={() => selectValue(opt.value)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left cursor-pointer transition-colors ${
                      isSelected
                        ? isHighlighted
                          ? 'bg-accent/15 text-accent'
                          : 'bg-accent/10 text-accent'
                        : isHighlighted
                          ? 'bg-bg-hover text-text-primary'
                          : 'text-text-primary hover:bg-bg-hover'
                    }`}
                  >
                    {opt.icon}
                    <span className="truncate flex-1">{opt.label}</span>
                    {isSelected && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0 text-accent"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
