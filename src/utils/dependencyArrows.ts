/** Horizontal run leaving a source bar and entering a target bar */
export const ARROW_STUB = 12;

/**
 * Smallest horizontal gap that fits a centred elbow — one stub either side of the
 * turn. Below this the turn is pushed up against the target instead, and below a
 * single stub there is no room to enter the target at all.
 */
export const ARROW_DIRECT_MIN_GAP = 2 * ARROW_STUB;

/**
 * Vertical offset of the lane a backwards dependency travels along. Bars are 28px
 * tall in a 56px row, so 20px clears the source bar and still sits inside the gap
 * next to it rather than across a neighbouring row.
 */
export const ARROW_LANE_OFFSET = 20;

export interface ArrowEndpoints {
  /** Right edge of the source bar */
  fromX: number;
  /** Vertical center of the source bar */
  fromY: number;
  /** Left edge of the target bar */
  toX: number;
  /** Vertical center of the target bar */
  toY: number;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Build an orthogonal finish-to-start connector between two task bars.
 *
 * Every segment is horizontal or vertical, and the path never travels further
 * right than one stub past the source, nor further left than one stub before the
 * target, so an arrow always lands on its target instead of looping past it.
 */
export function buildArrowPath({ fromX, fromY, toX, toY }: ArrowEndpoints): string {
  const dx = toX - fromX;
  // Below a tenth of a pixel the two rows round to the same coordinate anyway
  const sameRow = Math.abs(toY - fromY) < 0.05;

  if (dx >= ARROW_STUB) {
    // Enough room ahead of the target to turn and still approach it horizontally
    if (sameRow) return `M ${round(fromX)} ${round(fromY)} H ${round(toX)}`;
    // Turn halfway between the bars where there is room, otherwise as late as a
    // full-length final approach allows. Never turns behind the source.
    const midX = dx >= ARROW_DIRECT_MIN_GAP ? fromX + dx / 2 : toX - ARROW_STUB;
    return `M ${round(fromX)} ${round(fromY)} H ${round(midX)} V ${round(toY)} H ${round(toX)}`;
  }

  // The target starts before the source ends, or the bars are so close that there
  // is no room to enter the target: leave the source to the right, drop into the
  // lane beside its row, run back, and enter the target from its left. The lane
  // sits on the side the target is on, so the return run stays in a row gap
  // instead of crossing a row of bars.
  const laneY = fromY + (toY < fromY ? -ARROW_LANE_OFFSET : ARROW_LANE_OFFSET);
  return [
    `M ${round(fromX)} ${round(fromY)}`,
    `H ${round(fromX + ARROW_STUB)}`,
    `V ${round(laneY)}`,
    `H ${round(toX - ARROW_STUB)}`,
    `V ${round(toY)}`,
    `H ${round(toX)}`,
  ].join(' ');
}
