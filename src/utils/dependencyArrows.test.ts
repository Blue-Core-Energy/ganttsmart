import { describe, expect, it } from 'vitest';
import {
  ARROW_DIRECT_MIN_GAP,
  ARROW_LANE_OFFSET,
  ARROW_STUB,
  buildArrowPath,
  type ArrowEndpoints,
} from './dependencyArrows';

/** Mirrors the Tailwind sizes in GanttRow.tsx: `h-[28px]` bars in `h-[56px]` rows */
const BAR_HEIGHT = 28;
const ROW_HEIGHT = 56;

/** Longest arrowhead, in px — `markerWidth` 8 at userSpaceOnUse in DependencyArrows.tsx */
const ARROW_HEAD = 8;

/** Every x and y coordinate referenced by a path, in order */
function points(path: string): { x: number; y: number }[] {
  const result: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  for (const cmd of path.trim().split(/\s(?=[MHV])/)) {
    const [op, ...args] = cmd.split(/\s+/);
    const nums = args.map(Number);
    if (op === 'M') [x, y] = nums;
    else if (op === 'H') x = nums[0];
    else if (op === 'V') y = nums[0];
    else throw new Error(`unexpected command ${op}`);
    result.push({ x, y });
  }
  return result;
}

/** Each step moves along exactly one axis — no diagonals, no curves */
function isOrthogonal(path: string): boolean {
  if (/[CSQTAcsqta]/.test(path)) return false;
  const pts = points(path);
  return pts.every((p, i) => i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y);
}

describe('buildArrowPath', () => {
  const forward: ArrowEndpoints = { fromX: 100, fromY: 50, toX: 300, toY: 94 };

  it('draws a straight line between bars on the same row', () => {
    const path = buildArrowPath({ fromX: 100, fromY: 50, toX: 300, toY: 50 });
    expect(path).toBe('M 100 50 H 300');
    expect(isOrthogonal(path)).toBe(true);
  });

  it('turns once, halfway between the bars, when the target starts later', () => {
    const path = buildArrowPath(forward);
    expect(path).toBe('M 100 50 H 200 V 94 H 300');
    expect(isOrthogonal(path)).toBe(true);
  });

  it('routes around through the lane beside the source row when the target starts first', () => {
    const path = buildArrowPath({ fromX: 300, fromY: 50, toX: 100, toY: 94 });
    expect(path).toBe('M 300 50 H 312 V 70 H 88 V 94 H 100');
    expect(isOrthogonal(path)).toBe(true);
  });

  it('puts the lane on the side the target is on, so it never runs along another row', () => {
    const below = buildArrowPath({ fromX: 300, fromY: 150, toX: 100, toY: 262 });
    const above = buildArrowPath({ fromX: 300, fromY: 150, toX: 100, toY: 38 });
    expect(points(below).some((p) => p.y === 150 + ARROW_LANE_OFFSET)).toBe(true);
    expect(points(above).some((p) => p.y === 150 - ARROW_LANE_OFFSET)).toBe(true);
    // The midpoint of a two-row gap lands on the row between them — avoid it
    expect(points(below).some((p) => p.y === 206)).toBe(false);
    expect(points(above).some((p) => p.y === 94)).toBe(false);
  });

  it('offsets the lane below the row when a dependency doubles back within one row', () => {
    const fromY = 50;
    const path = buildArrowPath({ fromX: 300, fromY, toX: 100, toY: fromY });
    expect(points(path).some((p) => p.y === fromY + ARROW_LANE_OFFSET)).toBe(true);
    expect(isOrthogonal(path)).toBe(true);
  });

  it('keeps a forward dependency moving forwards as the gap narrows', () => {
    // Just too narrow to centre the turn: it moves up against the target instead,
    // which keeps a full-length final approach without ever doubling back
    expect(buildArrowPath({ fromX: 100, fromY: 50, toX: 100 + ARROW_DIRECT_MIN_GAP, toY: 94 })).toBe(
      'M 100 50 H 112 V 94 H 124',
    );
    expect(buildArrowPath({ fromX: 100, fromY: 50, toX: 123, toY: 94 })).toBe('M 100 50 H 111 V 94 H 123');
    expect(buildArrowPath({ fromX: 100, fromY: 50, toX: 100 + ARROW_STUB, toY: 94 })).toBe('M 100 50 H 100 V 94 H 112');

    for (let gap = ARROW_STUB; gap <= 40; gap++) {
      const xs = points(buildArrowPath({ fromX: 100, fromY: 50, toX: 100 + gap, toY: 94 })).map((p) => p.x);
      // Never travels left of the source, and always approaches over a full stub
      expect(Math.min(...xs)).toBe(100);
      expect(100 + gap - xs[xs.length - 2]).toBeGreaterThanOrEqual(ARROW_STUB);
    }
  });

  it('routes around only when there is no room to enter the target at all', () => {
    // Below one stub, an elbow would bury the arrowhead behind the source bar
    expect(points(buildArrowPath({ fromX: 100, fromY: 50, toX: 100 + ARROW_STUB - 1, toY: 94 }))).toHaveLength(6);
    expect(points(buildArrowPath({ fromX: 100, fromY: 50, toX: 100 + ARROW_STUB, toY: 94 }))).toHaveLength(4);
  });

  it('leaves room for the arrowhead on the final approach of every route', () => {
    const cases: ArrowEndpoints[] = [
      { fromX: 100, fromY: 50, toX: 400, toY: 94 },
      { fromX: 100, fromY: 50, toX: 112, toY: 94 },
      { fromX: 300, fromY: 50, toX: 100, toY: 94 },
      { fromX: 100, fromY: 50, toX: 105, toY: 50 },
    ];
    for (const endpoints of cases) {
      const pts = points(buildArrowPath(endpoints));
      const approach = Math.abs(pts[pts.length - 1].x - pts[pts.length - 2].x);
      expect(approach).toBeGreaterThanOrEqual(ARROW_HEAD);
    }
  });

  it('runs its lane clear of the source bar but inside the row gap', () => {
    expect(ARROW_LANE_OFFSET).toBeGreaterThan(BAR_HEIGHT / 2);
    expect(ARROW_LANE_OFFSET).toBeLessThan(ROW_HEIGHT - BAR_HEIGHT / 2);
  });

  it('never overshoots either endpoint by more than one stub', () => {
    const cases: ArrowEndpoints[] = [
      forward,
      { fromX: 300, fromY: 50, toX: 100, toY: 94 }, // backwards
      { fromX: 300, fromY: 94, toX: 100, toY: 50 }, // backwards, upwards
      { fromX: 100, fromY: 50, toX: 100, toY: 94 }, // exactly overlapping edges
      { fromX: 100, fromY: 50, toX: 110, toY: 50 }, // same row, tight gap
      { fromX: 100, fromY: 300, toX: 900, toY: 50 }, // far apart, upwards
    ];

    for (const endpoints of cases) {
      const { fromX, fromY, toX, toY } = endpoints;
      const path = buildArrowPath(endpoints);
      const pts = points(path);
      const xs = pts.map((p) => p.x);
      expect(isOrthogonal(path)).toBe(true);
      expect(Math.max(...xs)).toBeLessThanOrEqual(Math.max(fromX, toX) + ARROW_STUB);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(Math.min(fromX, toX) - ARROW_STUB);

      // Vertically a path only ever sits on one of the two rows, or on the single
      // lane beside the source row — never anywhere else
      const allowedY = [fromY, toY, fromY + ARROW_LANE_OFFSET, fromY - ARROW_LANE_OFFSET];
      for (const p of pts) expect(allowedY).toContain(p.y);
    }
  });

  it('starts on the source and ends on the target', () => {
    for (const endpoints of [forward, { fromX: 300, fromY: 50, toX: 100, toY: 94 }]) {
      const pts = points(buildArrowPath(endpoints));
      expect(pts[0]).toEqual({ x: endpoints.fromX, y: endpoints.fromY });
      expect(pts[pts.length - 1]).toEqual({ x: endpoints.toX, y: endpoints.toY });
    }
  });
});
