export interface FilterableOption {
  value: string;
  label: string;
  keywords?: string;
}

/**
 * Filter dropdown options case-insensitively by matching all whitespace-separated
 * query tokens against each option's label (and optional keywords).
 */
export function filterDropdownOptions<T extends FilterableOption>(options: readonly T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...options];
  const tokens = normalized.split(/\s+/);
  return options.filter((opt) => {
    const haystack = opt.keywords ? `${opt.label} ${opt.keywords}`.toLowerCase() : opt.label.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/**
 * Determine the initial keyboard-highlighted index in the rendered option list.
 * When `showClearOption` is true, index 0 is the "All"/clear option and `options` start at index 1.
 */
export function getInitialHighlightIndex<T extends { value: string }>(
  options: readonly T[],
  selectedValue: string,
  showClearOption: boolean,
): number {
  const offset = showClearOption ? 1 : 0;
  if (selectedValue) {
    const matchIdx = options.findIndex((o) => o.value === selectedValue);
    if (matchIdx >= 0) return matchIdx + offset;
  }
  if (showClearOption) return 0;
  return options.length > 0 ? 0 : -1;
}

export type HighlightDirection = 'next' | 'prev' | 'first' | 'last';

/**
 * Compute the next highlighted index with wrap-around for next/prev navigation.
 */
export function getNextHighlightIndex(currentIndex: number, totalItems: number, direction: HighlightDirection): number {
  if (totalItems <= 0) return -1;
  switch (direction) {
    case 'first':
      return 0;
    case 'last':
      return totalItems - 1;
    case 'next':
      return currentIndex < 0 ? 0 : (currentIndex + 1) % totalItems;
    case 'prev':
      return currentIndex < 0 ? totalItems - 1 : (currentIndex - 1 + totalItems) % totalItems;
  }
}
