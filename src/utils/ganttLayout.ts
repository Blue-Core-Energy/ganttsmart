/** Height of every schedule row, in px (including its 1px bottom border) */
export const ROW_HEIGHT = 40;

/** Height of a task bar on the timeline, in px */
export const BAR_HEIGHT = 24;

/** Horizontal indent per sub-issue nesting level in the Issue column, in px */
export const INDENT_PER_DEPTH = 18;

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
