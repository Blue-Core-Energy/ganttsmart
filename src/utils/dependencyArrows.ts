/** Horizontal run leaving a source bar and entering a target bar */
export const ARROW_STUB = 12;

/**
 * Smallest horizontal gap that fits a direct approach with room for an arrowhead.
 * Below this, the turn is pushed up against the target instead, and below a single
 * stub there is no room to enter the target directly so it loops around through a lane.
 */
export const ARROW_DIRECT_MIN_GAP = 2 * ARROW_STUB;

/**
 * Vertical offset of the lane a backwards dependency travels along. Bars are 28px
 * tall in a 56px row, so 20px clears the source bar and still sits inside the gap
 * next to it rather than across a neighbouring row.
 */
export const ARROW_LANE_OFFSET = 20;

/** Default corner radius for rounded elbows in px */
export const ARROW_CORNER_RADIUS = 6;

/** Offset step for staggering unrelated overlapping arrow tracks in px */
export const ARROW_STAGGER_STEP = 6;

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

export interface ArrowPathOptions {
  /** Maximum corner radius for rounded elbows in px. Defaults to ARROW_CORNER_RADIUS (6). */
  cornerRadius?: number;
  /** Horizontal offset applied to the vertical segment (for staggering unrelated arrows) */
  midXOffset?: number;
  /** Vertical offset applied to the horizontal return lane in backwards arrows (for staggering) */
  laneYOffset?: number;
}

export interface DependencyArrowEdge extends ArrowEndpoints {
  sourceId: string;
  targetId: string;
  [key: string]: unknown;
}

export interface RoutedDependencyArrow extends DependencyArrowEdge {
  path: string;
  midXOffset: number;
  laneYOffset: number;
}

interface Point {
  x: number;
  y: number;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Build an SVG path with rounded 90-degree elbows between an orthogonal sequence of points.
 * Corner radii are clamped dynamically so adjacent corners on short segments never
 * collide, invert, or overshoot.
 */
export function buildRoundedPath(points: Point[], maxRadius = ARROW_CORNER_RADIUS): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${round(points[0].x)} ${round(points[0].y)}`;

  // Filter out redundant consecutive duplicate points
  const pts: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = pts[pts.length - 1];
    const curr = points[i];
    if (Math.abs(curr.x - prev.x) < 0.05 && Math.abs(curr.y - prev.y) < 0.05) {
      continue;
    }
    pts.push(curr);
  }

  // Simplify collinear segments (e.g. horizontal-horizontal or vertical-vertical)
  const simplified: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0 || i === pts.length - 1) {
      simplified.push(pts[i]);
      continue;
    }
    const prev = simplified[simplified.length - 1];
    const curr = pts[i];
    const next = pts[i + 1];
    const isCollinearX = Math.abs(prev.x - curr.x) < 0.05 && Math.abs(curr.x - next.x) < 0.05;
    const isCollinearY = Math.abs(prev.y - curr.y) < 0.05 && Math.abs(curr.y - next.y) < 0.05;
    if (!isCollinearX && !isCollinearY) {
      simplified.push(curr);
    }
  }

  if (simplified.length <= 1) {
    return `M ${round(points[0].x)} ${round(points[0].y)}`;
  }
  if (simplified.length === 2) {
    if (Math.abs(simplified[0].y - simplified[1].y) < 0.05) {
      return `M ${round(simplified[0].x)} ${round(simplified[0].y)} H ${round(simplified[1].x)}`;
    }
    if (Math.abs(simplified[0].x - simplified[1].x) < 0.05) {
      return `M ${round(simplified[0].x)} ${round(simplified[0].y)} V ${round(simplified[1].y)}`;
    }
    return `M ${round(simplified[0].x)} ${round(simplified[0].y)} L ${round(simplified[1].x)} ${round(simplified[1].y)}`;
  }

  // Compute segment lengths
  const segLens: number[] = [];
  for (let i = 0; i < simplified.length - 1; i++) {
    const dx = simplified[i + 1].x - simplified[i].x;
    const dy = simplified[i + 1].y - simplified[i].y;
    segLens.push(Math.hypot(dx, dy));
  }

  // Clamped corner radius for each interior vertex i (from 1 to simplified.length - 2).
  // Each segment j can have at most segLens[j] total radius consumed by its two endpoints.
  // By capping radius at vertex i to <= segLens[i-1] / 2 and <= segLens[i] / 2,
  // the sum of radii along segment j is at most segLens[j]/2 + segLens[j]/2 = segLens[j].
  const n = simplified.length;
  const radii: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    const inLen = segLens[i - 1];
    const outLen = segLens[i];
    const r = Math.max(0, Math.min(maxRadius, inLen / 2, outLen / 2));
    radii.push(r);
  }

  // Build the SVG path commands
  const parts: string[] = [`M ${round(simplified[0].x)} ${round(simplified[0].y)}`];
  let curX = simplified[0].x;
  let curY = simplified[0].y;

  for (let i = 1; i < n - 1; i++) {
    const prev = simplified[i - 1];
    const vertex = simplified[i];
    const next = simplified[i + 1];
    const r = radii[i - 1];

    const inDx = vertex.x - prev.x;
    const inDy = vertex.y - prev.y;
    const inLen = segLens[i - 1];
    const inUx = inDx / inLen;
    const inUy = inDy / inLen;

    const outDx = next.x - vertex.x;
    const outDy = next.y - vertex.y;
    const outLen = segLens[i];
    const outUx = outDx / outLen;
    const outUy = outDy / outLen;

    if (r > 0.05) {
      const startX = vertex.x - r * inUx;
      const startY = vertex.y - r * inUy;
      const endX = vertex.x + r * outUx;
      const endY = vertex.y + r * outUy;

      if (Math.abs(curX - startX) > 0.05 || Math.abs(curY - startY) > 0.05) {
        if (Math.abs(curY - startY) < 0.05) {
          parts.push(`H ${round(startX)}`);
        } else if (Math.abs(curX - startX) < 0.05) {
          parts.push(`V ${round(startY)}`);
        } else {
          parts.push(`L ${round(startX)} ${round(startY)}`);
        }
      }

      parts.push(`Q ${round(vertex.x)} ${round(vertex.y)}, ${round(endX)} ${round(endY)}`);
      curX = endX;
      curY = endY;
    } else {
      if (Math.abs(curY - vertex.y) < 0.05) {
        parts.push(`H ${round(vertex.x)}`);
      } else if (Math.abs(curX - vertex.x) < 0.05) {
        parts.push(`V ${round(vertex.y)}`);
      } else {
        parts.push(`L ${round(vertex.x)} ${round(vertex.y)}`);
      }
      curX = vertex.x;
      curY = vertex.y;
    }
  }

  // Final segment to end point
  const dest = simplified[n - 1];
  if (Math.abs(curX - dest.x) > 0.05 || Math.abs(curY - dest.y) > 0.05) {
    if (Math.abs(curY - dest.y) < 0.05) {
      parts.push(`H ${round(dest.x)}`);
    } else if (Math.abs(curX - dest.x) < 0.05) {
      parts.push(`V ${round(dest.y)}`);
    } else {
      parts.push(`L ${round(dest.x)} ${round(dest.y)}`);
    }
  }

  return parts.join(' ');
}

/**
 * Build an orthogonal finish-to-start connector between two task bars with rounded elbows.
 *
 * Forward arrows turn close to the source bar (`fromX + ARROW_STUB`) so vertical drops
 * stay near bars instead of cutting across unrelated tasks in the middle of the chart.
 */
export function buildArrowPath({ fromX, fromY, toX, toY }: ArrowEndpoints, options?: ArrowPathOptions): string {
  const dx = toX - fromX;
  const sameRow = Math.abs(toY - fromY) < 0.05;
  const cornerRadius = options?.cornerRadius ?? ARROW_CORNER_RADIUS;

  if (dx >= ARROW_STUB) {
    if (sameRow) {
      return `M ${round(fromX)} ${round(fromY)} H ${round(toX)}`;
    }
    // Forward arrow: near-bar turn
    // When dx >= ARROW_DIRECT_MIN_GAP (24px), turn at fromX + ARROW_STUB (near the source bar).
    // When ARROW_STUB <= dx < ARROW_DIRECT_MIN_GAP (12px to 24px), turn at toX - ARROW_STUB
    // to preserve at least ARROW_STUB for the final approach into the target arrowhead.
    let baseMidX = dx >= ARROW_DIRECT_MIN_GAP ? fromX + ARROW_STUB : toX - ARROW_STUB;
    if (options?.midXOffset) {
      baseMidX += options.midXOffset;
      baseMidX = Math.max(fromX + 4, Math.min(toX - 8, baseMidX));
    }
    const points: Point[] = [
      { x: fromX, y: fromY },
      { x: baseMidX, y: fromY },
      { x: baseMidX, y: toY },
      { x: toX, y: toY },
    ];
    return buildRoundedPath(points, cornerRadius);
  }

  // Backwards or tight forward overlap: route around through the lane beside the source row
  const baseLaneOffset = toY < fromY ? -ARROW_LANE_OFFSET : ARROW_LANE_OFFSET;
  let laneY = fromY + baseLaneOffset;
  if (options?.laneYOffset) {
    laneY += options.laneYOffset;
  }

  const points: Point[] = [
    { x: fromX, y: fromY },
    { x: fromX + ARROW_STUB, y: fromY },
    { x: fromX + ARROW_STUB, y: laneY },
    { x: toX - ARROW_STUB, y: laneY },
    { x: toX - ARROW_STUB, y: toY },
    { x: toX, y: toY },
  ];
  return buildRoundedPath(points, cornerRadius);
}

/**
 * Route multiple dependency arrows:
 * - Arrows sharing the same source (`sourceId`) share the exact same exit trunk and turn.
 * - Arrows sharing the same destination (`targetId`) converge onto the exact same final approach.
 * - Unrelated arrows (different sourceId AND different targetId) that would overlap along the same
 *   vertical column (`midX`) or horizontal lane (`laneY`) have their tracks staggered.
 */
export function routeDependencyArrows<T extends DependencyArrowEdge>(
  arrows: T[],
  options?: { cornerRadius?: number; staggerStep?: number },
): (T & { path: string; midXOffset: number; laneYOffset: number })[] {
  const cornerRadius = options?.cornerRadius ?? ARROW_CORNER_RADIUS;
  const staggerStep = options?.staggerStep ?? ARROW_STAGGER_STEP;

  // 1. Group forward arrows by sourceId
  interface ForwardGroup {
    sourceId: string;
    baseMidX: number;
    minY: number;
    maxY: number;
    targets: Set<string>;
    arrows: T[];
  }

  const forwardGroups = new Map<string, ForwardGroup>();
  const backwardArrows: T[] = [];

  for (const arrow of arrows) {
    const dx = arrow.toX - arrow.fromX;
    const sameRow = Math.abs(arrow.toY - arrow.fromY) < 0.05;

    if (sameRow && dx >= 0) {
      continue;
    }

    if (dx >= ARROW_STUB && !sameRow) {
      const baseMidX = dx >= ARROW_DIRECT_MIN_GAP ? arrow.fromX + ARROW_STUB : arrow.toX - ARROW_STUB;
      const arrowMinY = Math.min(arrow.fromY, arrow.toY);
      const arrowMaxY = Math.max(arrow.fromY, arrow.toY);

      let group = forwardGroups.get(arrow.sourceId);
      if (!group) {
        group = {
          sourceId: arrow.sourceId,
          baseMidX,
          minY: arrowMinY,
          maxY: arrowMaxY,
          targets: new Set([arrow.targetId]),
          arrows: [arrow],
        };
        forwardGroups.set(arrow.sourceId, group);
      } else {
        group.minY = Math.min(group.minY, arrowMinY);
        group.maxY = Math.max(group.maxY, arrowMaxY);
        group.targets.add(arrow.targetId);
        group.arrows.push(arrow);
      }
    } else {
      backwardArrows.push(arrow);
    }
  }

  // Assign midXOffset for each forward group
  const forwardGroupList = Array.from(forwardGroups.values()).sort((a, b) => {
    if (Math.abs(a.baseMidX - b.baseMidX) > 0.1) return a.baseMidX - b.baseMidX;
    if (a.minY !== b.minY) return a.minY - b.minY;
    return a.sourceId.localeCompare(b.sourceId);
  });

  const assignedForwardOffsets = new Map<string, number>();

  for (let i = 0; i < forwardGroupList.length; i++) {
    const group = forwardGroupList[i];
    const conflicting = forwardGroupList.slice(0, i).filter((other) => {
      if (other.sourceId === group.sourceId) return false;
      const sharesTarget = Array.from(group.targets).some((t) => other.targets.has(t));
      if (sharesTarget) return false;
      if (Math.abs(other.baseMidX - group.baseMidX) > 4) return false;
      const overlap = Math.min(group.maxY, other.maxY) - Math.max(group.minY, other.minY);
      return overlap > 2;
    });

    if (conflicting.length === 0) {
      assignedForwardOffsets.set(group.sourceId, 0);
      continue;
    }

    let chosenOffset = 0;
    for (let mult = 0; mult <= 5; mult++) {
      const candidates = mult === 0 ? [0] : [mult * staggerStep, -mult * staggerStep];
      let found = false;
      for (const cand of candidates) {
        const effectiveMidX = group.baseMidX + cand;
        const hasCollision = conflicting.some((other) => {
          const otherOffset = assignedForwardOffsets.get(other.sourceId) ?? 0;
          const otherEffectiveMidX = other.baseMidX + otherOffset;
          return Math.abs(effectiveMidX - otherEffectiveMidX) < staggerStep - 1;
        });
        if (!hasCollision) {
          chosenOffset = cand;
          found = true;
          break;
        }
      }
      if (found) break;
    }
    assignedForwardOffsets.set(group.sourceId, chosenOffset);
  }

  // 2. Group backward arrows by sourceId
  interface BackwardGroup {
    sourceId: string;
    baseLaneY: number;
    minX: number;
    maxX: number;
    targets: Set<string>;
    arrows: T[];
  }

  const backwardGroups = new Map<string, BackwardGroup>();
  for (const arrow of backwardArrows) {
    const baseLaneOffset = arrow.toY < arrow.fromY ? -ARROW_LANE_OFFSET : ARROW_LANE_OFFSET;
    const baseLaneY = arrow.fromY + baseLaneOffset;
    const arrowMinX = Math.min(arrow.toX - ARROW_STUB, arrow.fromX + ARROW_STUB);
    const arrowMaxX = Math.max(arrow.toX - ARROW_STUB, arrow.fromX + ARROW_STUB);

    let group = backwardGroups.get(arrow.sourceId);
    if (!group) {
      group = {
        sourceId: arrow.sourceId,
        baseLaneY,
        minX: arrowMinX,
        maxX: arrowMaxX,
        targets: new Set([arrow.targetId]),
        arrows: [arrow],
      };
      backwardGroups.set(arrow.sourceId, group);
    } else {
      group.minX = Math.min(group.minX, arrowMinX);
      group.maxX = Math.max(group.maxX, arrowMaxX);
      group.targets.add(arrow.targetId);
      group.arrows.push(arrow);
    }
  }

  const backwardGroupList = Array.from(backwardGroups.values()).sort((a, b) => {
    if (Math.abs(a.baseLaneY - b.baseLaneY) > 0.1) return a.baseLaneY - b.baseLaneY;
    if (a.minX !== b.minX) return a.minX - b.minX;
    return a.sourceId.localeCompare(b.sourceId);
  });

  const assignedBackwardOffsets = new Map<string, number>();

  for (let i = 0; i < backwardGroupList.length; i++) {
    const group = backwardGroupList[i];
    const conflicting = backwardGroupList.slice(0, i).filter((other) => {
      if (other.sourceId === group.sourceId) return false;
      const sharesTarget = Array.from(group.targets).some((t) => other.targets.has(t));
      if (sharesTarget) return false;
      if (Math.abs(other.baseLaneY - group.baseLaneY) > 4) return false;
      const overlap = Math.min(group.maxX, other.maxX) - Math.max(group.minX, other.minX);
      return overlap > 2;
    });

    if (conflicting.length === 0) {
      assignedBackwardOffsets.set(group.sourceId, 0);
      continue;
    }

    let chosenOffset = 0;
    for (let mult = 0; mult <= 3; mult++) {
      const candidates = mult === 0 ? [0] : [mult * staggerStep, -mult * staggerStep];
      let found = false;
      for (const cand of candidates) {
        const effectiveLaneY = group.baseLaneY + cand;
        const hasCollision = conflicting.some((other) => {
          const otherOffset = assignedBackwardOffsets.get(other.sourceId) ?? 0;
          const otherEffectiveLaneY = other.baseLaneY + otherOffset;
          return Math.abs(effectiveLaneY - otherEffectiveLaneY) < staggerStep - 1;
        });
        if (!hasCollision) {
          chosenOffset = cand;
          found = true;
          break;
        }
      }
      if (found) break;
    }
    assignedBackwardOffsets.set(group.sourceId, chosenOffset);
  }

  // 3. Build paths for all arrows
  return arrows.map((arrow) => {
    const dx = arrow.toX - arrow.fromX;
    const sameRow = Math.abs(arrow.toY - arrow.fromY) < 0.05;

    let midXOffset = 0;
    let laneYOffset = 0;

    if (dx >= ARROW_STUB && !sameRow) {
      midXOffset = assignedForwardOffsets.get(arrow.sourceId) ?? 0;
    } else if (!sameRow || dx < 0) {
      laneYOffset = assignedBackwardOffsets.get(arrow.sourceId) ?? 0;
    }

    const path = buildArrowPath(arrow, {
      cornerRadius,
      midXOffset,
      laneYOffset,
    });

    return {
      ...arrow,
      path,
      midXOffset,
      laneYOffset,
    };
  });
}
