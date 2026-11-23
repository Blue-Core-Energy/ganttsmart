/**
 * Semantic colours are defined once as themed custom properties in `src/index.css`. These maps
 * only name the token each concept uses, so inline styles follow the theme the same way the
 * Tailwind classes below do.
 */

/** Anything with no colour of its own: the same muted grey in both themes. */
export const NEUTRAL_COLOR = 'var(--color-none-dark)';

/** Priority colour, keyed by the class names `priorityClass` returns. */
export const priorityColors: Record<string, string> = {
  urgent: 'var(--color-urgent)',
  high: 'var(--color-high)',
  medium: 'var(--color-medium)',
  low: 'var(--color-low)',
  none: 'var(--color-none)',
};

/**
 * Status dot colour per Linear workflow state type, reusing the semantic tokens: the accent for
 * work in flight, success for completed, the triage amber, and the two greys for everything
 * waiting (`unstarted` / `backlog` muted, `canceled` / `duplicate` lighter).
 */
export const statusDotColors: Record<string, string> = {
  started: 'var(--color-accent)',
  unstarted: NEUTRAL_COLOR,
  completed: 'var(--color-success)',
  canceled: 'var(--color-none)',
  duplicate: 'var(--color-none)',
  triage: 'var(--color-medium)',
  backlog: NEUTRAL_COLOR,
};

export const priorityBadgeClasses: Record<string, string> = {
  urgent: 'bg-urgent/15 text-urgent border border-urgent/25',
  high: 'bg-high/15 text-high border border-high/25',
  medium: 'bg-medium/15 text-medium border border-medium/25',
  low: 'bg-low/15 text-low border border-low/25',
  none: 'bg-none/15 text-none border border-none/25',
};

export function priorityClass(val: number): string {
  if (val === 1) return 'urgent';
  if (val === 2) return 'high';
  if (val === 3) return 'medium';
  if (val === 4) return 'low';
  return 'none';
}

/** Priority colour from the name Linear gives it ("Urgent", "High", "None", …). */
export function priorityColorFor(priority: string): string {
  return priorityColors[priority.trim().toLowerCase()] ?? NEUTRAL_COLOR;
}

/** Inline pill styling for a priority badge, matching `priorityBadgeClasses` via CSS custom properties. */
export function priorityBadgeStyle(priority: string) {
  const color = priorityColorFor(priority);
  return {
    backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
    color,
    border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
  };
}

/** Status dot colour from a Linear workflow state type, for types we do not know about. */
export function statusDotColorFor(statusType: string): string {
  return statusDotColors[statusType.trim().toLowerCase()] ?? NEUTRAL_COLOR;
}
