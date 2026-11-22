/** Height of every schedule row, in px (including its 1px bottom border) */
export const ROW_HEIGHT = 40;

/** Height of a task bar on the timeline, in px */
export const BAR_HEIGHT = 24;

/** Height of the `sm` avatar (see `utils/avatar.tsx`), the tallest control in a cell that opens a menu */
export const CELL_CONTROL_HEIGHT = 20;

/**
 * Vertical padding that stretches a menu-opening cell to the full row, so the whole row height
 * is clickable. Pair it with an equal negative margin so the row height doesn't change.
 */
export const CELL_HIT_PAD = (ROW_HEIGHT - CELL_CONTROL_HEIGHT) / 2;
