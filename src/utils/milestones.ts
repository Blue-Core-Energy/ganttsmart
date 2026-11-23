/**
 * Utilities for positioning and laying out milestones on the pinned milestone row.
 */

import { MILESTONE_ROW_HEIGHT } from './ganttLayout';

export { MILESTONE_ROW_HEIGHT };

/** Estimated width reserved for a milestone label when calculating overlap */
export function estimateMilestoneWidth(name: string): number {
  return Math.max(70, Math.min(160, name.length * 7 + 24));
}

/**
 * Decides whether the milestone name should flip to the left of the diamond
 * so it is not clipped off the right edge of the timeline.
 * Also guards against flipping left when the left side has less space than the right.
 */
export function isMilestoneLabelFlipped(x: number, timelineWidth: number, labelWidth = 140): boolean {
  return x + labelWidth > timelineWidth && x > timelineWidth - x;
}

/**
 * Assigns each milestone to lane 0 or 1 within the pinned milestone row.
 * Default is lane 0; milestones that would collide with the previous milestone
 * in lane 0 are assigned to lane 1. If both lanes overlap, they strictly alternate
 * based on the previous assignment so mixed-length labels alternate 0, 1, 0, 1.
 */
export function assignMilestoneLanes(
  milestones: Array<{ id: string; name: string; dayOffset: number }>,
  dayWidth: number,
  timelineWidth: number,
): Map<string, 0 | 1> {
  const lanes = new Map<string, 0 | 1>();
  if (milestones.length === 0) return lanes;

  const sorted = [...milestones].sort((a, b) => a.dayOffset - b.dayOffset || a.id.localeCompare(b.id));

  const laneEnds: [number, number] = [-Infinity, -Infinity];
  let lastLane: 0 | 1 = 1;

  for (const m of sorted) {
    const x = m.dayOffset * dayWidth + dayWidth / 2;
    const width = estimateMilestoneWidth(m.name);
    const flipped = isMilestoneLabelFlipped(x, timelineWidth, width);

    const footprintStart = flipped ? x - width - 8 : x - 8;
    const footprintEnd = flipped ? x + 8 : x + width + 8;

    let assignedLane: 0 | 1;
    if (footprintStart >= laneEnds[0]) {
      assignedLane = 0;
    } else if (footprintStart >= laneEnds[1]) {
      assignedLane = 1;
    } else {
      // Both lanes overlap: strictly alternate from the previous milestone's lane
      assignedLane = lastLane === 0 ? 1 : 0;
    }

    lanes.set(m.id, assignedLane);
    lastLane = assignedLane;
    laneEnds[assignedLane] = Math.max(laneEnds[assignedLane], footprintEnd);
  }

  return lanes;
}
