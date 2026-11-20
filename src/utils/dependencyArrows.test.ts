import { describe, expect, it } from 'vitest';
import { ARROW_LANE_OFFSET, ARROW_STUB, buildArrowPath, type ArrowEndpoints } from './dependencyArrows';

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

  it('routes around rather than squeezing an elbow into a gap too small for the arrowhead', () => {
    const path = buildArrowPath({ fromX: 100, fromY: 50, toX: 110, toY: 94 });
    expect(points(path)).toHaveLength(6);
    expect(isOrthogonal(path)).toBe(true);
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
      const path = buildArrowPath(endpoints);
      const xs = points(path).map((p) => p.x);
      const ys = points(path).map((p) => p.y);
      expect(isOrthogonal(path)).toBe(true);
      expect(Math.max(...xs)).toBeLessThanOrEqual(Math.max(endpoints.fromX, endpoints.toX) + ARROW_STUB);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(Math.min(endpoints.fromX, endpoints.toX) - ARROW_STUB);
      expect(Math.max(...ys)).toBeLessThanOrEqual(Math.max(endpoints.fromY, endpoints.toY) + ARROW_LANE_OFFSET);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(Math.min(endpoints.fromY, endpoints.toY) - ARROW_LANE_OFFSET);
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
