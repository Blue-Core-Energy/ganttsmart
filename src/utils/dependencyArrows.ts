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
  /** Absolute x of a forward arrow's vertical run. Defaults to the turn nearest the source bar. */
  turnX?: number;
  /** Absolute x of a backwards arrow's drop from the source bar to its lane */
  exitX?: number;
  /** Absolute x of a backwards arrow's run from its lane up/down into the target row */
  entryX?: number;
  /** Absolute y of a backwards arrow's horizontal lane */
  laneY?: number;
}

export interface DependencyArrowEdge extends ArrowEndpoints {
  sourceId: string;
  targetId: string;
  [key: string]: unknown;
}

export interface RoutedDependencyArrow extends DependencyArrowEdge {
  path: string;
  /** How far the arrow's vertical run was moved from its own default column (exit column for backwards arrows) */
  midXOffset: number;
  /** How far the arrow's lane was moved from its default, away from the source bar */
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
 * Explicit `turnX` / `exitX` / `entryX` / `laneY` options (assigned by `routeDependencyArrows`)
 * are used as given, never recomputed.
 */
export function buildArrowPath({ fromX, fromY, toX, toY }: ArrowEndpoints, options?: ArrowPathOptions): string {
  const dx = toX - fromX;
  const sameRow = Math.abs(toY - fromY) < 0.05;
  const cornerRadius = options?.cornerRadius ?? ARROW_CORNER_RADIUS;

  if (dx >= ARROW_STUB) {
    if (sameRow) {
      return `M ${round(fromX)} ${round(fromY)} H ${round(toX)}`;
    }
    const turnX = options?.turnX ?? defaultTurnX({ fromX, toX });
    const points: Point[] = [
      { x: fromX, y: fromY },
      { x: turnX, y: fromY },
      { x: turnX, y: toY },
      { x: toX, y: toY },
    ];
    return buildRoundedPath(points, cornerRadius);
  }

  // Backwards or tight forward overlap: route around through the lane beside the source row
  const laneY = options?.laneY ?? fromY + laneDirection({ fromY, toY }) * ARROW_LANE_OFFSET;
  const exitX = options?.exitX ?? fromX + ARROW_STUB;
  const entryX = options?.entryX ?? toX - ARROW_STUB;

  const points: Point[] = [
    { x: fromX, y: fromY },
    { x: exitX, y: fromY },
    { x: exitX, y: laneY },
    { x: entryX, y: laneY },
    { x: entryX, y: toY },
    { x: toX, y: toY },
  ];
  return buildRoundedPath(points, cornerRadius);
}

/**
 * Column a forward arrow turns at. With room to spare it hugs the source bar; between one
 * and two stubs of gap it sits a full stub short of the target to leave room for the arrowhead.
 */
function defaultTurnX({ fromX, toX }: { fromX: number; toX: number }): number {
  return toX - fromX >= ARROW_DIRECT_MIN_GAP ? fromX + ARROW_STUB : toX - ARROW_STUB;
}

/** -1 when a backwards arrow's lane runs above its source bar, +1 when below */
function laneDirection({ fromY, toY }: { fromY: number; toY: number }): 1 | -1 {
  return toY < fromY ? -1 : 1;
}

/** A vertical run of an arrow, tagged with the endpoints that allow it to merge with others */
interface VerticalSpan {
  y1: number;
  y2: number;
  sourceId: string;
  targetId: string;
}

/** A vertical run already fixed at its final x */
interface PlacedSpan extends VerticalSpan {
  x: number;
}

/**
 * A set of vertical runs that must share one x (one source's exit trunk, one target's entry
 * column) and is therefore shifted as a single unit when it collides with unrelated arrows.
 */
interface Column {
  baseX: number;
  /** Candidate x values (after shifting) are clamped into [minX, maxX] */
  minX: number;
  maxX: number;
  /** Which way to try shifting first */
  firstSign: 1 | -1;
  maxSteps: number;
  spans: VerticalSpan[];
}

/** A horizontal lane of a backwards arrow, shared by every backwards arrow of one source and side */
interface Lane {
  baseY: number;
  /** +1 below the source bar, -1 above; staggering only ever moves away from the bar */
  direction: 1 | -1;
  sourceId: string;
  /** One x-extent per arrow, tagged with its target */
  spans: { x1: number; x2: number; targetId: string }[];
}

const overlapLength = (a1: number, a2: number, b1: number, b2: number) => Math.min(a2, b2) - Math.max(a1, b1);

/** Overlap needed (in px) before two runs count as the same track */
const MIN_TRACK_OVERLAP = 2;

/** Arrows from one source, or into one target, are allowed to share a track exactly */
const mayShareTrack = (a: { sourceId: string; targetId: string }, b: { sourceId: string; targetId: string }) =>
  a.sourceId === b.sourceId || a.targetId === b.targetId;

/**
 * Route multiple dependency arrows:
 * - Forward arrows from the same source share one exit column (the tightest turn in the group).
 * - Backwards arrows from the same source share one exit column and one lane per side; backwards
 *   arrows into the same target share one entry column.
 * - Any two vertical runs, forward or backwards, that overlap on the same column are staggered
 *   unless they share a `sourceId` or a `targetId`. Candidates are tested against the final x of
 *   every run already placed, and clamping happens before the test.
 * - Overlapping backwards lanes are staggered away from the source bar.
 */
export function routeDependencyArrows<T extends DependencyArrowEdge>(
  arrows: T[],
  options?: { cornerRadius?: number; staggerStep?: number },
): (T & { path: string; midXOffset: number; laneYOffset: number })[] {
  const cornerRadius = options?.cornerRadius ?? ARROW_CORNER_RADIUS;
  const staggerStep = options?.staggerStep ?? ARROW_STAGGER_STEP;
  /** Tracks closer than this (px) read as one line */
  const minSeparation = staggerStep - 1;

  type Kind = 'straight' | 'forward' | 'backward';
  const kindOf = (a: T): Kind => {
    const dx = a.toX - a.fromX;
    const sameRow = Math.abs(a.toY - a.fromY) < 0.05;
    if (sameRow && dx >= 0) return 'straight';
    if (dx >= ARROW_STUB && !sameRow) return 'forward';
    return 'backward';
  };

  const forwardBySource = new Map<string, T[]>();
  const backward: T[] = [];
  for (const arrow of arrows) {
    const kind = kindOf(arrow);
    if (kind === 'forward') {
      const list = forwardBySource.get(arrow.sourceId);
      if (list) list.push(arrow);
      else forwardBySource.set(arrow.sourceId, [arrow]);
    } else if (kind === 'backward') {
      backward.push(arrow);
    }
  }

  // 1. Lanes: one per source and side, staggered away from the source bar
  const laneKey = (a: T) => `${a.sourceId}|${laneDirection(a)}`;
  const lanes = new Map<string, Lane>();
  for (const arrow of backward) {
    const key = laneKey(arrow);
    const direction = laneDirection(arrow);
    let lane = lanes.get(key);
    if (!lane) {
      lane = { baseY: arrow.fromY + direction * ARROW_LANE_OFFSET, direction, sourceId: arrow.sourceId, spans: [] };
      lanes.set(key, lane);
    }
    const exitX = arrow.fromX + ARROW_STUB;
    const entryX = arrow.toX - ARROW_STUB;
    lane.spans.push({ x1: Math.min(exitX, entryX), x2: Math.max(exitX, entryX), targetId: arrow.targetId });
  }

  const laneList = Array.from(lanes.entries()).sort(([ka, a], [kb, b]) => {
    if (Math.abs(a.baseY - b.baseY) > 0.1) return a.baseY - b.baseY;
    const minXa = Math.min(...a.spans.map((s) => s.x1));
    const minXb = Math.min(...b.spans.map((s) => s.x1));
    if (minXa !== minXb) return minXa - minXb;
    return ka.localeCompare(kb);
  });

  const placedLanes: { y: number; x1: number; x2: number; sourceId: string; targetId: string }[] = [];
  const laneY = new Map<string, number>();
  for (const [key, lane] of laneList) {
    const collides = (y: number) =>
      lane.spans.some((span) =>
        placedLanes.some(
          (p) =>
            !mayShareTrack(p, { sourceId: lane.sourceId, targetId: span.targetId }) &&
            Math.abs(p.y - y) < minSeparation &&
            overlapLength(span.x1, span.x2, p.x1, p.x2) > MIN_TRACK_OVERLAP,
        ),
      );
    let chosen = lane.baseY;
    for (let step = 0; step <= 3; step++) {
      const candidate = lane.baseY + lane.direction * step * staggerStep;
      if (!collides(candidate)) {
        chosen = candidate;
        break;
      }
    }
    laneY.set(key, chosen);
    for (const span of lane.spans) {
      placedLanes.push({ y: chosen, ...span, sourceId: lane.sourceId });
    }
  }

  // 2. Vertical columns for forward turns, backwards exits and backwards entries share one system
  const columns = new Map<string, Column>();

  for (const [sourceId, group] of forwardBySource) {
    const minToX = Math.min(...group.map((a) => a.toX));
    const fromX = group[0].fromX;
    // Every forward arrow from a source leaves along one trunk: the tightest valid turn in the group
    const baseX = Math.min(...group.map((a) => defaultTurnX(a)));
    columns.set(`forward|${sourceId}`, {
      baseX,
      minX: Math.min(baseX, fromX + 4),
      maxX: Math.max(baseX, minToX - 8),
      firstSign: 1,
      maxSteps: 5,
      spans: group.map((a) => ({
        y1: Math.min(a.fromY, a.toY),
        y2: Math.max(a.fromY, a.toY),
        sourceId: a.sourceId,
        targetId: a.targetId,
      })),
    });
  }

  for (const arrow of backward) {
    const lY = laneY.get(laneKey(arrow))!;

    const exitKey = `exit|${arrow.sourceId}`;
    const exitX = arrow.fromX + ARROW_STUB;
    let exit = columns.get(exitKey);
    if (!exit) {
      exit = {
        baseX: exitX,
        minX: arrow.fromX + 4,
        maxX: exitX + 3 * staggerStep,
        firstSign: 1,
        maxSteps: 4,
        spans: [],
      };
      columns.set(exitKey, exit);
    }
    exit.spans.push({
      y1: Math.min(arrow.fromY, lY),
      y2: Math.max(arrow.fromY, lY),
      sourceId: arrow.sourceId,
      targetId: arrow.targetId,
    });

    const entryKey = `entry|${arrow.targetId}`;
    const entryX = arrow.toX - ARROW_STUB;
    let entry = columns.get(entryKey);
    if (!entry) {
      entry = {
        baseX: entryX,
        minX: entryX - 4 * staggerStep,
        maxX: arrow.toX - 8,
        // Shifting left lengthens the final approach; shifting right would squeeze the arrowhead
        firstSign: -1,
        maxSteps: 4,
        spans: [],
      };
      columns.set(entryKey, entry);
    }
    entry.spans.push({
      y1: Math.min(lY, arrow.toY),
      y2: Math.max(lY, arrow.toY),
      sourceId: arrow.sourceId,
      targetId: arrow.targetId,
    });
  }

  const columnList = Array.from(columns.entries()).sort(([ka, a], [kb, b]) => {
    if (Math.abs(a.baseX - b.baseX) > 0.1) return a.baseX - b.baseX;
    const minYa = Math.min(...a.spans.map((s) => s.y1));
    const minYb = Math.min(...b.spans.map((s) => s.y1));
    if (minYa !== minYb) return minYa - minYb;
    return ka.localeCompare(kb);
  });

  const placed: PlacedSpan[] = [];
  const columnX = new Map<string, number>();

  for (const [key, column] of columnList) {
    const collides = (x: number) =>
      column.spans.some((span) =>
        placed.some(
          (p) =>
            !mayShareTrack(p, span) &&
            Math.abs(p.x - x) < minSeparation &&
            overlapLength(span.y1, span.y2, p.y1, p.y2) > MIN_TRACK_OVERLAP,
        ),
      );

    let chosen = column.baseX;
    if (collides(column.baseX)) {
      const tried = new Set<number>([column.baseX]);
      search: for (let step = 1; step <= column.maxSteps; step++) {
        for (const sign of [column.firstSign, -column.firstSign]) {
          // Clamp first so the collision test sees the x that would actually be drawn
          const candidate = Math.max(column.minX, Math.min(column.maxX, column.baseX + sign * step * staggerStep));
          if (tried.has(candidate)) continue;
          tried.add(candidate);
          if (!collides(candidate)) {
            chosen = candidate;
            break search;
          }
        }
      }
      // Narrow ranges (tight gaps) may not fit whole steps: fall back to the nearest free pixel
      if (chosen === column.baseX) {
        const span = Math.ceil(column.maxX - column.minX);
        for (let delta = 1; delta <= span; delta++) {
          const free = [column.baseX + delta, column.baseX - delta].find(
            (x) => x >= column.minX && x <= column.maxX && !collides(x),
          );
          if (free !== undefined) {
            chosen = free;
            break;
          }
        }
      }
    }

    columnX.set(key, chosen);
    for (const span of column.spans) placed.push({ ...span, x: chosen });
  }

  // 3. Build paths from the assigned tracks
  return arrows.map((arrow) => {
    const kind = kindOf(arrow);
    let midXOffset = 0;
    let laneYOffset = 0;
    let pathOptions: ArrowPathOptions = { cornerRadius };

    if (kind === 'forward') {
      const turnX = columnX.get(`forward|${arrow.sourceId}`)!;
      midXOffset = turnX - defaultTurnX(arrow);
      pathOptions = { cornerRadius, turnX };
    } else if (kind === 'backward') {
      const lane = lanes.get(laneKey(arrow))!;
      const y = laneY.get(laneKey(arrow))!;
      const exitX = columnX.get(`exit|${arrow.sourceId}`)!;
      const entryX = columnX.get(`entry|${arrow.targetId}`)!;
      laneYOffset = y - lane.baseY;
      midXOffset = exitX - (arrow.fromX + ARROW_STUB);
      pathOptions = { cornerRadius, exitX, entryX, laneY: y };
    }

    return {
      ...arrow,
      path: buildArrowPath(arrow, pathOptions),
      midXOffset,
      laneYOffset,
    };
  });
}
