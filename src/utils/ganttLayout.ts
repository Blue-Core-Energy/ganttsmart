/** Height of every schedule row, in px (including its 1px bottom border) */
export const ROW_HEIGHT = 40;

/** Height of the pinned milestone row, in px */
export const MILESTONE_ROW_HEIGHT = 44;

/** Height of a task bar on the timeline, in px */
export const BAR_HEIGHT = 24;

/** Horizontal indent per sub-issue nesting level in the Issue column, in px */
export const INDENT_PER_DEPTH = 18;

/** Horizontal indent per sub-issue nesting level on narrow screens (< 768px), in px */
export const INDENT_PER_DEPTH_NARROW = 10;

/**
 * Maximum visual indent in px on narrow screens.
 * At 200px column width: 1px border-r and 36px padding leave 163px content width.
 * With the reorder grip (12px), tree gutter + gap (-ml-0.5 is -2px: 16 + 4 = 20px),
 * warning (10px) + gap (6px) + status dot (8px) + gap (6px) = 30px,
 * total fixed chrome is 62px.
 * An 84px indent leaves 163 - 84 - 62 = 17px (18px without border-r) for the title to truncate
 * cleanly without clipping the status dot, and ~47px during title rename when warning and dot hide.
 */
export const MAX_TASK_INDENT_NARROW = 84;

export interface TaskIndentOptions {
  isNarrow?: boolean;
  colWidth?: number;
}

/**
 * Calculates horizontal padding in px for the task cell based on hierarchy depth.
 * On desktop (wide viewports), indent scales linearly at 18px per level.
 * On narrow viewports (e.g. mobile 375px where the Issue column is 200px), indent uses
 * a compact step (10px) up to depth 5, then tapers (6px per depth) up to MAX_TASK_INDENT_NARROW (84px),
 * ensuring distinct visual hierarchy while leaving room for the gutter, reorder grip, warning icon,
 * title, and status dot so they never clip.
 */
export function computeTaskIndent(depth: number, options?: boolean | TaskIndentOptions): number {
  if (depth <= 0) return 0;
  const isNarrow =
    typeof options === 'boolean'
      ? options
      : (options?.isNarrow ?? (options?.colWidth !== undefined ? options.colWidth <= 200 : false));

  if (!isNarrow) {
    return depth * INDENT_PER_DEPTH;
  }

  if (depth <= 5) {
    return depth * INDENT_PER_DEPTH_NARROW;
  }

  return Math.min(MAX_TASK_INDENT_NARROW, 5 * INDENT_PER_DEPTH_NARROW + (depth - 5) * 6);
}

/** Height of the `sm` avatar (see `utils/avatar.tsx`), the tallest control in the status and assignee cells */
export const CELL_CONTROL_HEIGHT = 20;

/**
 * Vertical padding that stretches a menu-opening cell to the full row, so the whole row height
 * is clickable. Pair it with an equal negative margin so the row height doesn't change.
 * The row's 1px bottom border is outside the content box, so it is subtracted first.
 *
 * Sized for the tallest control across both cells (the assignee's avatar). The status cell's
 * tallest item is its ~17px text line, so it is slightly under-filled (about 36px of the 39px
 * content box), which is harmless.
 */
export const CELL_HIT_PAD = (ROW_HEIGHT - 1 - CELL_CONTROL_HEIGHT) / 2;
